/**
 * dsh-trigger-prompts — 宿主侧
 *
 * 目标：把「模型实际看到的工具描述」原样汇总出来，供人查看 / 复制。
 *
 * 数据来源（不执行、不调用任何工具）：
 *   1. ctx.tools.schemas() —— 运行时工具注册表里每个工具的 name / description / parameters，
 *      这就是模型每次推理时看到的那份「触发提示词」。
 *   2. 各 profile 的 dsh.profile.bundles —— 用来把这些工具归属到具体插件：
 *      在插件包自己的 JS 里找工具名字符串，命中即认为该插件注册了它（启发式，标“推测”）。
 *      会扫描所有 profile，同一物理包只读一次（pnpm store 里是同一份）。
 *
 * 对外只提供一个只读 HTTP 接口：GET /plugins/dsh-trigger-prompts/list
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PLUGIN_ID = 'dsh-trigger-prompts';
export const LIST_ROUTE = '/plugins/dsh-trigger-prompts/list';
export const DICT_ROUTE = '/plugins/dsh-trigger-prompts/zh-cn.json';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DICT_FILE = path.join(HERE, '..', 'data', 'zh-cn.json');

const ATTRIBUTION_TTL_MS = 60 * 1000;
const PAYLOAD_TTL_MS = 8 * 1000;
/** 单个插件包参与字符串扫描的文本上限，防止把几 MB 的 bundle 全读进内存。 */
const PACKAGE_TEXT_BUDGET = 8 * 1024 * 1024;

let attributionCache = null; // { at, signature, map, missed, packages, warnings, profile }
let payloadCache = null;     // { at, body }

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeStat(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function isDir(target) {
  return safeStat(target)?.isDirectory() === true;
}

function realPathOf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function profilesRoot() {
  return path.join(os.homedir(), '.dsh', 'profiles');
}

/** 所有候选 profile 目录：环境变量指定的排第一，其余按修改时间倒序。 */
export function listProfileDirs() {
  const root = profilesRoot();
  const found = [];
  const push = (dir) => {
    if (!found.includes(dir) && isDir(dir)) found.push(dir);
  };

  const explicit = process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME;
  if (explicit) push(path.join(root, explicit));

  const rest = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
    rest.push(dir);
  }
  rest.sort((a, b) => {
    const ta = safeStat(path.join(a, 'package.json'))?.mtimeMs ?? 0;
    const tb = safeStat(path.join(b, 'package.json'))?.mtimeMs ?? 0;
    return tb - ta;
  });
  for (const dir of rest) push(dir);
  return found;
}

function bundleIds(profileDir) {
  const manifest = readJson(path.join(profileDir, 'package.json'));
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return [];
  return bundles.filter((id) => typeof id === 'string' && id.length > 0);
}

function packageDir(profileDir, id) {
  const dir = path.join(profileDir, 'node_modules', id);
  return isDir(dir) ? dir : null;
}

/** 收一个插件包里可读的 JS/JSON 文本，带上限与深度保护。 */
function collectPackageTexts(dir, budget = PACKAGE_TEXT_BUDGET) {
  const texts = [];
  let used = 0;

  const walk = (current, depth) => {
    if (depth > 4 || used >= budget) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (used >= budget) return;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      // data / docs 不是注册代码：中文注释表、文档里会出现一堆工具名，不能参与归属匹配
      if (entry.name === 'data' || entry.name === 'docs' || entry.name === 'test' || entry.name === 'tests') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.(?:js|mjs|cjs|json)$/i.test(entry.name)) continue;
      const stat = safeStat(full);
      if (!stat || stat.size > 3 * 1024 * 1024) continue;
      try {
        const text = fs.readFileSync(full, 'utf8');
        texts.push(text);
        used += text.length;
      } catch {
        /* 读不到就跳过 */
      }
    }
  };

  walk(dir, 0);
  return texts;
}

function mentionsTool(texts, toolName) {
  const quoted = [`"${toolName}"`, `'${toolName}'`, `\`${toolName}\``];
  return texts.some((text) => quoted.some((needle) => text.includes(needle)));
}

/**
 * 归属推测：在所有 profile 的 bundle 源码中查找工具名字符串。
 * 纯字符串匹配，不执行插件代码；同一物理包（pnpm store 里同一路径）只读一次。
 */
export function attributeTools(toolNames) {
  const signature = [...toolNames].sort().join('\n');
  const now = Date.now();
  if (
    attributionCache &&
    attributionCache.signature === signature &&
    now - attributionCache.at < ATTRIBUTION_TTL_MS
  ) {
    return attributionCache;
  }

  const profiles = listProfileDirs();
  const map = new Map();
  const missed = new Set();
  const packages = new Map();
  const warnings = [];
  const scannedDirs = new Set();
  const remaining = new Set(toolNames);

  for (let index = 0; index < profiles.length; index += 1) {
    const profileDir = profiles[index];
    const preferred = index === 0;
    for (const id of bundleIds(profileDir)) {
      const dir = packageDir(profileDir, id);
      if (!dir) {
        if (preferred) warnings.push(`bundle 未安装：${id}`);
        continue;
      }
      if (!packages.has(id)) {
        const manifest = readJson(path.join(dir, 'package.json')) ?? {};
        packages.set(id, {
          id,
          version: typeof manifest.version === 'string' ? manifest.version : null,
          description: typeof manifest.description === 'string' ? manifest.description : null,
        });
      }
      if (remaining.size === 0) continue;

      const real = realPathOf(dir);
      if (scannedDirs.has(real)) continue;
      scannedDirs.add(real);

      const texts = collectPackageTexts(dir);
      for (const name of [...remaining]) {
        if (mentionsTool(texts, name)) {
          map.set(name, id);
          remaining.delete(name);
        }
      }
    }
  }

  for (const name of remaining) missed.add(name);

  attributionCache = {
    at: now,
    signature,
    map,
    missed,
    packages: [...packages.values()],
    warnings,
    profile: profiles[0] ? path.basename(profiles[0]) : null,
  };
  return attributionCache;
}

function toolSchemas(scope) {
  try {
    const schemas = scope.tools?.schemas?.();
    return Array.isArray(schemas) ? schemas : [];
  } catch {
    return [];
  }
}

/** 组装接口响应：工具清单 + 插件归属 + 统计。 */
export function buildPayload(scope) {
  const now = Date.now();
  if (payloadCache && now - payloadCache.at < PAYLOAD_TTL_MS) return payloadCache.body;

  const schemas = toolSchemas(scope);
  const tools = schemas
    .filter((schema) => schema && typeof schema.name === 'string')
    .map((schema) => ({
      name: schema.name,
      description: typeof schema.description === 'string' ? schema.description : '',
      parameters: schema.parameters && typeof schema.parameters === 'object' ? schema.parameters : {},
    }));

  const attribution = attributeTools(tools.map((tool) => tool.name));

  const withOwner = tools.map((tool) => ({
    ...tool,
    plugin: attribution.map.get(tool.name) ?? null,
  }));

  const counts = new Map();
  for (const tool of withOwner) {
    const key = tool.plugin ?? '__builtin__';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const body = {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    profile: attribution.profile,
    tools: withOwner,
    plugins: attribution.packages
      .map((pkg) => ({ ...pkg, count: counts.get(pkg.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    warnings: attribution.warnings ?? [],
    note: '工具描述为运行时注册表原样输出；插件归属由源码字符串匹配推测，未命中的归入「内置 / 其它」。',
  };

  payloadCache = { at: now, body };
  return body;
}

export function apply(ctx) {
  ctx.inject(['tools', 'webServer'], (scope) => {
    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: DICT_ROUTE,
          handler: (req, res) => {
            let body;
            try {
              body = fs.readFileSync(DICT_FILE, 'utf8');
            } catch (error) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'dictionary-unavailable: ' + String(error?.message ?? error) }));
              return;
            }
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(body);
          },
        }),
      'dsh-trigger-prompts: zh dictionary route',
    );

    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: LIST_ROUTE,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
              return;
            }
            let body;
            try {
              body = buildPayload(scope);
            } catch (error) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
              return;
            }
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
          },
        }),
      'dsh-trigger-prompts: list route',
    );
  });

  ctx.logger?.('dsh-trigger-prompts')?.info?.('dsh-trigger-prompts ready: ' + LIST_ROUTE);
}

export default { name: PLUGIN_ID, apply };
