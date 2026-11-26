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
 *   3. ctx.skills.snapshot({ cwd }) —— 技能（skill）注册表。skill 不是 tool：它不注册成
 *      工具，而是把 name + description 渲染进上下文里的 <available_skills> 目录；正文加载
 *      走唯一的 skill 工具。项目级技能根（<workspace>/.dsh/skills 等）要按 cwd 才能发现，
 *      所以按「DSH 记录过的工作区 + 当前 cwd」逐个快照，再按名字合并。
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

const WORKSPACE_STORES = [path.join(os.homedir(), '.dsh', 'storages')];
/** 最多同时取几个工作区的技能快照，避免工作区很多时每次都把整棵树扫一遍。 */
const MAX_SKILL_CWDS = 6;

/** DSH 记录过的工作区路径（~/.dsh/storages/workspace.json 的 tables.workspaces）。 */
function workspaceCwds() {
  const found = [];
  for (const dir of WORKSPACE_STORES) {
    const store = readJson(path.join(dir, 'workspace.json'));
    const table = store?.tables?.workspaces;
    if (!table || typeof table !== 'object') continue;
    for (const entry of Object.values(table)) {
      const workspace = typeof entry?.path === 'string' ? entry.path : null;
      if (workspace && !found.includes(workspace) && isDir(workspace)) found.push(workspace);
    }
  }
  return found;
}

/**
 * 技能注册表快照。项目级技能根只在给了 cwd 时才被发现，所以按候选工作区逐个取再按名字合并；
 * 服务不可用时返回空清单，不影响工具清单这条主路径。
 */
const SKILL_ROOTS = [
  [path.join('.dsh', 'skills'), 'project-dsh'],
  [path.join('.agents', 'skills'), 'project-agents'],
];

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRUE_RE = /^(true|yes|on|1)$/i;
const FALSE_RE = /^(false|no|off|0)$/i;

/** 极简 frontmatter 解析：只取面板要用的 name / description / whenToUse 与两个 invocation 布尔键。 */
function parseSkillFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const lines = text.slice(3, end).split(/\r?\n/);
  const fields = {};
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? '';
    if (/^[>|][-+]?$/.test(value.trim())) {
      const block = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === '') { block.push(''); continue; }
        if (!/^\s+\S/.test(lines[j])) break;
        block.push(lines[j].trim());
      }
      value = block.join(' ').replace(/\s+/g, ' ').trim();
      i = j - 1;
    } else {
      value = value.replace(/^["']|["']$/g, '').trim();
    }
    fields[key] = value;
  }
  return fields;
}

/**
 * 兜底扫描：不带 scope 的注册表快照只认识 bundled 等全局根，项目级 `<cwd>/.dsh/skills`
 * 拿不到，所以自己按根目录读一遍（发现规则与 DSH 一致：一层深、`<name>/SKILL.md`）。
 * 与注册表结果按 name 合并，注册表优先。
 */
export function scanWorkspaceSkills(cwd) {
  const found = [];
  for (const [rel, source] of SKILL_ROOTS) {
    const root = path.join(cwd, rel);
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = path.join(root, entry.name, 'SKILL.md');
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const fields = parseSkillFrontmatter(text);
      if (!fields) continue;
      if (!SKILL_NAME_RE.test(fields.name ?? '') || !fields.description) continue;
      found.push({
        name: fields.name,
        description: fields.description,
        whenToUse: fields.whenToUse,
        invocation: {
          modelInvocable: !TRUE_RE.test(fields['disable-model-invocation'] ?? ''),
          userInvocable: !FALSE_RE.test(fields['user-invocable'] ?? ''),
        },
        source,
        provider: 'local-scan',
        path: file,
        cwd,
      });
    }
  }
  return found;
}

export async function collectSkills(service) {
  const cwds = [];
  const push = (dir) => {
    if (typeof dir === 'string' && dir.length > 0 && !cwds.includes(dir)) cwds.push(dir);
  };
  for (const dir of workspaceCwds()) push(dir);
  push(process.cwd());

  const merged = new Map();
  const warnings = [];
  let complete = true;
  const hasService = Boolean(service && typeof service.snapshot === 'function');
  if (!hasService) warnings.push('技能服务不可用：技能一节只列出本地扫描结果');
  for (const cwd of cwds.slice(0, MAX_SKILL_CWDS)) {
    if (hasService) {
      try {
        const snapshot = await service.snapshot({ cwd });
        if (snapshot) {
          if (snapshot.complete === false) complete = false;
          for (const skill of snapshot.skills ?? []) {
            if (!skill || typeof skill.name !== 'string' || merged.has(skill.name)) continue;
            merged.set(skill.name, { ...skill, cwd });
          }
        }
      } catch (error) {
        warnings.push('技能清单读取失败（' + cwd + '）：' + String(error?.message ?? error));
      }
    }
    for (const skill of scanWorkspaceSkills(cwd)) {
      if (merged.has(skill.name)) continue;
      merged.set(skill.name, skill);
    }
  }
  const skills = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, complete, warnings };
}

function toolSchemas(scope) {
  try {
    const schemas = scope.tools?.schemas?.();
    return Array.isArray(schemas) ? schemas : [];
  } catch {
    return [];
  }
}

/** 组装接口响应：工具清单 + 插件归属 + 技能清单 + 统计。 */
export async function buildPayload(scope, skillsService) {
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

  const skillInfo = await collectSkills(skillsService);

  const body = {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    profile: attribution.profile,
    tools: withOwner,
    plugins: attribution.packages
      .map((pkg) => ({ ...pkg, count: counts.get(pkg.id) ?? 0 }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    skills: skillInfo.skills,
    skillsComplete: skillInfo.complete,
    warnings: [...(attribution.warnings ?? []), ...skillInfo.warnings],
    note: '工具描述为运行时注册表原样输出；插件归属由源码字符串匹配推测，未命中的归入「内置 / 其它」；技能优先取技能注册表快照，并按项目级技能根（<工作区>/.dsh/skills、.agents/skills）补扫一遍后按名字合并。',
  };

  payloadCache = { at: now, body };
  return body;
}

export function apply(ctx) {
  // skills 服务缺失时只是少一节数据，工具清单这条主路径照旧。
  let skillsService = null;
  ctx.inject(['skills'], (scope) => {
    skillsService = scope.skills ?? null;
    scope.effect(
      () => () => {
        skillsService = null;
      },
      'dsh-trigger-prompts: skills service',
    );
  });

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
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
              return;
            }
            let body;
            try {
              body = await buildPayload(scope, skillsService);
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
