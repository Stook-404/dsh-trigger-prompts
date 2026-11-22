/**
 * dsh-trigger-prompts — 宿主侧
 *
 * 目标：把「模型实际看到的工具描述」原样汇总出来，供人查看 / 复制。
 *
 * 数据来源（不执行、不调用任何工具）：
 *   1. ctx.tools.schemas() —— 运行时工具注册表里每个工具的 name / description / parameters，
 *      这就是模型每次推理时看到的那份「触发提示词」。
 *   2. 当前 profile 的 dsh.profile.bundles —— 用来把这些工具归属到具体插件：
 *      在插件包自己的 JS 里找工具名字符串，命中即认为该插件注册了它（启发式，标“推测”）。
 *
 * 对外只提供一个只读 HTTP 接口：GET /plugins/dsh-trigger-prompts/list
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PLUGIN_ID = 'dsh-trigger-prompts';
export const LIST_ROUTE = '/plugins/dsh-trigger-prompts/list';

const ATTRIBUTION_TTL_MS = 60 * 1000;
const PAYLOAD_TTL_MS = 8 * 1000;
/** 单个插件包参与字符串扫描的文本上限，防止把几 MB 的 bundle 全读进内存。 */
const PACKAGE_TEXT_BUDGET = 8 * 1024 * 1024;

let attributionCache = null; // { at, profileDir, map: Map<toolName, pluginId>, packages, warnings }
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

function profilesRoot() {
  return path.join(os.homedir(), '.dsh', 'profiles');
}

/** 找到当前正在用的 profile 目录：优先环境变量，否则取最近修改过的那个。 */
export function currentProfileDir() {
  const root = profilesRoot();
  const explicit = process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME;
  if (explicit) {
    const direct = path.join(root, explicit);
    if (safeStat(direct)?.isDirectory()) return direct;
  }
  if (!safeStat(root)?.isDirectory()) return null;

  let best = null;
  let bestTime = -1;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = path.join(dir, 'package.json');
    const stat = safeStat(manifest);
    if (!stat) continue;
    if (stat.mtimeMs > bestTime) {
      bestTime = stat.mtimeMs;
      best = dir;
    }
  }
  return best;
}

function bundleIds(profileDir) {
  const manifest = readJson(path.join(profileDir, 'package.json'));
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return [];
  return bundles.filter((id) => typeof id === 'string' && id.length > 0);
}

function packageDir(profileDir, id) {
  const dir = path.join(profileDir, 'node_modules', id);
  return safeStat(dir)?.isDirectory() ? dir : null;
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
 * 归属推测：在 profile 里每个 bundle 的源码中查找工具名字符串。
 * 纯字符串匹配，不执行插件代码；同名工具（如多个生图工具）也能各自落到正确包。
 */
export function attributeTools(profileDir, toolNames) {
  const now = Date.now();
  if (
    attributionCache &&
    attributionCache.profileDir === profileDir &&
    now - attributionCache.at < ATTRIBUTION_TTL_MS &&
    toolNames.every((name) => attributionCache.map.has(name) || attributionCache.missed.has(name))
  ) {
    return attributionCache;
  }

  const map = new Map();
  const missed = new Set();
  const packages = [];
  const warnings = [];
  const remaining = new Set(toolNames);

  for (const id of bundleIds(profileDir)) {
    const dir = packageDir(profileDir, id);
    if (!dir) {
      warnings.push(`bundle 未安装：${id}`);
      continue;
    }
    const manifest = readJson(path.join(dir, 'package.json')) ?? {};
    packages.push({
      id,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      description: typeof manifest.description === 'string' ? manifest.description : null,
    });
    if (remaining.size === 0) continue;

    const texts = collectPackageTexts(dir);
    for (const name of [...remaining]) {
      if (mentionsTool(texts, name)) {
        map.set(name, id);
        remaining.delete(name);
      }
    }
  }

  for (const name of remaining) missed.add(name);

  attributionCache = { at: now, profileDir, map, missed, packages, warnings };
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
  const profileDir = currentProfileDir();
  const tools = schemas
    .filter((schema) => schema && typeof schema.name === 'string')
    .map((schema) => ({
      name: schema.name,
      description: typeof schema.description === 'string' ? schema.description : '',
      parameters: schema.parameters && typeof schema.parameters === 'object' ? schema.parameters : {},
    }));

  const attribution = toolSchemas(scope).length && profileDir
    ? attributeTools(profileDir, tools.map((tool) => tool.name))
    : { map: new Map(), packages: [], warnings: [] };

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
    profile: profileDir ? path.basename(profileDir) : null,
    profilePath: profileDir,
    tools: withOwner,
    plugins: attribution.packages.map((pkg) => ({
      ...pkg,
      count: counts.get(pkg.id) ?? 0,
    })),
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
