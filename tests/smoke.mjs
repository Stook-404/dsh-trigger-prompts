/**
 * 冒烟测试：不启动 DSH，直接构造一个假 ctx 跑通「汇总 + 归属 + HTTP 响应」。
 *   node tests/smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import plugin, { LIST_ROUTE, buildPayload } from '../lib/index.js';

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
process.env.DSH_PROFILE = 'testprofile';
// 让 currentProfileDir() 指向临时目录：覆盖 homedir 不便，改为直接给 profileDir 传参不现实，
// 所以这里把临时 profiles 根挂到 HOME 下的一种简单做法：用 DSH_HOME 覆盖不生效时跳过归属断言。
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, '.dsh', 'profiles'), { recursive: true });
fs.cpSync(profileDir, path.join(home, '.dsh', 'profiles', 'testprofile'), { recursive: true });
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

assert.equal(registeredRoutes.length, 1, '应恰好注册一个路由');
assert.equal(registeredRoutes[0].kind, 'exact');
assert.equal(registeredRoutes[0].path, LIST_ROUTE);

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
  registeredRoutes[0].handler({ method: 'GET', url: LIST_ROUTE }, res);
});

assert.equal(response.status, 200);
const parsed = JSON.parse(response.body);
assert.equal(parsed.tools.length, 3);

os.homedir = originalHome;
fs.rmSync(tmp, { recursive: true, force: true });

console.log('smoke ok:', JSON.stringify({
  route: LIST_ROUTE,
  tools: parsed.tools.map((t) => `${t.name}@${t.plugin ?? 'builtin'}`),
  plugins: parsed.plugins.map((p) => `${p.id}#${p.count}`),
}, null, 2));
