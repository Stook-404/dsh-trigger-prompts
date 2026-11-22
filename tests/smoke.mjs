/**
 * 冒烟测试：不启动 DSH，直接构造一个假 ctx 跑通「汇总 + 归属 + 两个 HTTP 接口」。
 *   node tests/smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin, { LIST_ROUTE, DICT_ROUTE, buildPayload } from '../lib/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tp-'));
const profileDir = path.join(tmp, 'profiles', 'testprofile');
fs.mkdirSync(path.join(profileDir, 'node_modules', 'fake-plugin', 'lib'), { recursive: true });
fs.writeFileSync(
  path.join(profileDir, 'package.json'),
  JSON.stringify({
    name: 'test-profile',
    dsh: { profile: { bundles: ['fake-plugin', 'missing-plugin'] } },
  }),
);
fs.writeFileSync(
  path.join(profileDir, 'node_modules', 'fake-plugin', 'package.json'),
  JSON.stringify({ name: 'fake-plugin', version: '1.2.3', description: '假插件，用于测试' }),
);
fs.writeFileSync(
  path.join(profileDir, 'node_modules', 'fake-plugin', 'lib', 'index.js'),
  'export function apply(ctx) { ctx.tools.register({ name: "fake_paint", description: "画一只假鲸鱼" }); }\n',
);

const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.dsh', 'profiles'), { recursive: true });
fs.cpSync(profileDir, path.join(home, '.dsh', 'profiles', 'testprofile'), { recursive: true });
process.env.DSH_PROFILE = 'testprofile';
const originalHome = os.homedir;
os.homedir = () => home;

const schemas = [
  { name: 'fake_paint', description: '画一只假鲸鱼', parameters: { type: 'object' } },
  { name: 'fake_status', description: '查看假鲸鱼状态', parameters: { type: 'object' } },
  { name: 'builtin_thing', description: '系统自带工具', parameters: { type: 'object' } },
];

const registeredRoutes = [];
const fakeScope = {
  tools: { schemas: () => schemas },
  webServer: {
    register: (route) => {
      registeredRoutes.push(route);
      return () => {};
    },
  },
  effect: (factory) => factory(),
  logger: () => ({ info: () => {} }),
};

const ctx = {
  inject: (_deps, callback) => callback(fakeScope),
  effect: (factory) => factory(),
  logger: () => ({ info: () => {} }),
};

plugin.apply(ctx);

assert.equal(registeredRoutes.length, 2, '应注册工具清单与中文注释表两个路由');
const listRoute = registeredRoutes.find((route) => route.path === LIST_ROUTE);
const dictRoute = registeredRoutes.find((route) => route.path === DICT_ROUTE);
assert.ok(listRoute && dictRoute, '两个路由都要注册');
assert.equal(listRoute.kind, 'exact');

const payload = buildPayload(fakeScope);
assert.equal(payload.ok, true);
assert.equal(payload.tools.length, 3);
assert.equal(payload.tools.find((t) => t.name === 'fake_paint').plugin, 'fake-plugin');
assert.equal(payload.tools.find((t) => t.name === 'builtin_thing').plugin, null);
assert.equal(payload.plugins.find((p) => p.id === 'fake-plugin').count, 1);
assert.match(payload.warnings.join(','), /missing-plugin/);

const response = await new Promise((resolve) => {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (code) => { status = code; },
    write: (chunk) => { body += chunk; },
    end: (chunk) => resolve({ status, body: body + (chunk ?? '') }),
    setHeader: () => {},
  };
  listRoute.handler({ method: 'GET', url: LIST_ROUTE }, res);
});

assert.equal(response.status, 200);
const parsed = JSON.parse(response.body);
assert.equal(parsed.tools.length, 3);

const dictResponse = await new Promise((resolve) => {
  let status = 0;
  let body = '';
  const res = {
    writeHead: (code) => { status = code; },
    write: () => {},
    end: (chunk) => resolve({ status, body: String(chunk ?? '') }),
  };
  dictRoute.handler({ method: 'GET', url: DICT_ROUTE }, res);
});
assert.equal(dictResponse.status, 200);
const dict = JSON.parse(dictResponse.body);
assert.ok(dict.tools && Object.keys(dict.tools).length > 10, '中文注释表应有条目');
assert.equal(typeof dict.tools.generate_image, 'string', '工具条目应为一句话说明');
assert.equal(typeof dict.plugins['dsh-image-gen'].intro, 'string', '插件条目应带 3 行简介');
assert.equal(dict.plugins['dsh-image-gen'].name, '图像生成');

os.homedir = originalHome;
fs.rmSync(tmp, { recursive: true, force: true });

console.log('smoke ok:', JSON.stringify({
  routes: registeredRoutes.map((route) => route.path),
  tools: parsed.tools.map((t) => `${t.name}@${t.plugin ?? 'builtin'}`),
  plugins: parsed.plugins.map((p) => `${p.id}#${p.count}`),
  dictEntries: Object.keys(dict.tools).length,
}, null, 2));
