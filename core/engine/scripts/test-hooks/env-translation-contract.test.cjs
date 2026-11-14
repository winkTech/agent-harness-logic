#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/env-translation-contract.test.cjs — env 翻译层合同
 *
 * Phase 2.4 验收：core 与宿主 env 命名空间解耦。
 * 覆盖：
 *   1. envOf：HARNESS_* 优先 / 宿主别名兜底 / 布尔三态归一
 *   2. translateHostEnv：物化幂等、不覆盖已有 HARNESS_*、返回写入清单
 *   3. openDb 求值时点：同进程 env 切换生效（require 期求值缺陷的回归测试）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { envOf, envValue, translateHostEnv, ALIASES } = require('../io/env.cjs');

test('envOf: HARNESS_SESSION_ID 优先于 CLAUDE_SESSION_ID', () => {
  const view = envOf({ HARNESS_SESSION_ID: 'h-1', CLAUDE_SESSION_ID: 'c-1' });
  assert.equal(view.sessionId, 'h-1');
});

test('envOf: 宿主别名兜底（HARNESS_* 缺席）', () => {
  assert.equal(envOf({ CLAUDE_SESSION_ID: 'c-42' }).sessionId, 'c-42');
  assert.equal(envOf({ CODEBUDDY_SESSION_ID: 'wb-7' }).sessionId, 'wb-7');
});

test('envOf: 两名皆缺 → 空串/false（fail-soft）', () => {
  const view = envOf({});
  assert.equal(view.sessionId, '');
  assert.equal(view.noPersist, false);
  assert.equal(view.userMessage, '');
});

test('envOf: 布尔归一——1/true/yes 真，其余假；空串视为缺席', () => {
  assert.equal(envOf({ HARNESS_NO_PERSIST: '1' }).noPersist, true);
  assert.equal(envOf({ HARNESS_NO_PERSIST: 'true' }).noPersist, true);
  assert.equal(envOf({ HARNESS_NO_PERSIST: 'YES' }).noPersist, true);
  assert.equal(envOf({ HARNESS_NO_PERSIST: '0' }).noPersist, false);
  assert.equal(envOf({ HARNESS_NO_PERSIST: '' }).noPersist, false);
  assert.equal(envOf({ CLAUDE_HARNESS_NO_PERSIST: '1' }).noPersist, true);
});

test('envValue: 通用 canonical 读取（未列入语义视图的变量）', () => {
  assert.equal(envValue({ HARNESS_SQLITE_PATH: '/a.db' }, 'HARNESS_SQLITE_PATH'), '/a.db');
  assert.equal(envValue({ CLAUDE_SQLITE_PATH: '/b.db' }, 'HARNESS_SQLITE_PATH'), '/b.db');
  assert.equal(envValue({}, 'HARNESS_SQLITE_PATH'), undefined);
});

test('translateHostEnv: 物化宿主变量并返回写入清单', () => {
  const env = { CLAUDE_SESSION_ID: 's-9', CLAUDE_USER_MESSAGE: 'hello' };
  const written = translateHostEnv(env);
  assert.equal(env.HARNESS_SESSION_ID, 's-9');
  assert.equal(env.HARNESS_USER_MESSAGE, 'hello');
  assert.ok(written.includes('HARNESS_SESSION_ID'));
  assert.ok(written.includes('HARNESS_USER_MESSAGE'));
});

test('translateHostEnv: 幂等且不覆盖已有 HARNESS_*', () => {
  const env = { HARNESS_SESSION_ID: 'keep', CLAUDE_SESSION_ID: 'drop' };
  const written = translateHostEnv(env);
  assert.equal(env.HARNESS_SESSION_ID, 'keep');
  assert.ok(!written.includes('HARNESS_SESSION_ID'));
  // 二次调用无新写入
  assert.deepEqual(translateHostEnv(env), []);
});

test('ALIASES: 映射表冻结且覆盖方案点名的核心变量', () => {
  assert.throws(() => { 'use strict'; ALIASES.HARNESS_SESSION_ID = []; }, TypeError);
  for (const canonical of [
    'HARNESS_SESSION_ID', 'HARNESS_NO_PERSIST', 'HARNESS_NO_DIAGNOSTIC_WRITES',
    'HARNESS_VERIFY_READONLY', 'HARNESS_USER_MESSAGE', 'HARNESS_SQLITE_PATH',
    'HARNESS_RUNTIME_STATE_FILE', 'HARNESS_ROOT',
  ]) {
    assert.ok(ALIASES[canonical], `ALIASES missing ${canonical}`);
  }
});

test('openDb 求值时点：同进程 env 切换即时生效（回归 require 期缺陷）', (t) => {
  // 用子进程验证（避免污染本进程 env）
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-eval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `
    const { openDb, closeAll } = require(${JSON.stringify(path.resolve(__dirname, '..', '..', 'sqlite', 'index.cjs'))});
    const a = openDb({ path: ':memory:' });
    process.env.HARNESS_SQLITE_PATH = ${JSON.stringify(path.join(dir, 'x.db'))};
    const b = openDb({});
    closeAll();
    console.log(b.path);
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(dir, 'x.db'), 'openDb 应在调用期读 env（require 期求值会让此测试失败）');
});
