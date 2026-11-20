#!/usr/bin/env node
'use strict';

/**
 * consumer-scheduler 契约测试（缺口 B）：
 *   1. CONSUMERS 清单与 manifest consumerRegistry 的事件流消费者一致（缺口 C 守护）
 *   2. isDue 判定四态：无心跳=到期 / failed=到期 / nextDueAt 未到=不到期 / 僵死 running=到期
 *   3. 各消费者 runner 脚本存在且超时预算有界
 *   4. 调度器永不阻塞：--auto 在未到期态 <2s 退出且 exit 0
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');
const { CONSUMERS, isDue } = require('../consumer-scheduler.cjs');
const manifest = require('../../hooks/manifest.json');

test('CONSUMERS 清单覆盖 manifest consumerRegistry 全部事件流消费者', () => {
  const eventStreamConsumers = manifest.consumerRegistry
    .filter((c) => c.kind === 'event-stream' && c.active !== false)
    .map((c) => c.id);
  const scheduled = CONSUMERS.map((c) => c.id);
  // telemetry-spool-drain 由 Stop observer 内联调度（非 SessionStart 到期型）
  const expected = eventStreamConsumers.filter((id) => id !== 'telemetry-spool-drain');
  for (const id of expected) {
    assert.ok(scheduled.includes(id), `registry 消费者 ${id} 不在调度器清单——fp-rate 类缺口复发`);
  }
});

test('isDue 四态判定', () => {
  const reDue = 24 * 3600_000;
  assert.equal(isDue(null, reDue), true, '无心跳=到期');
  assert.equal(isDue({ status: 'failed', lastStartedAt: new Date().toISOString() }, reDue), true, 'failed=到期');
  assert.equal(isDue({ status: 'success', nextDueAt: new Date(Date.now() + 3600_000).toISOString() }, reDue), false, 'nextDue 未到=不到期');
  assert.equal(isDue({ status: 'running', lastStartedAt: new Date(Date.now() - 11 * 60_000).toISOString() }, reDue), true, '僵死 running>10min=到期');
  assert.equal(isDue({ status: 'running', lastStartedAt: new Date(Date.now() - 60_000).toISOString() }, reDue), false, '正常 running=不到期');
});

test('各消费者 runner 存在且超时有界', () => {
  for (const c of CONSUMERS) {
    const script = c.runner || c.script;
    assert.ok(script && fs.existsSync(script), `${c.id} runner 缺失: ${script}`);
    assert.ok(c.timeoutMs > 0 && c.timeoutMs <= 60_000, `${c.id} 超时越界: ${c.timeoutMs}`);
    assert.ok(c.reDueAfterSuccessMs > 0, `${c.id} 缺 reDue 节奏`);
  }
});

test('startup scheduler has time for every due consumer', () => {
  const budget = CONSUMERS.reduce((sum, c) => sum + c.timeoutMs, 0);
  for (const host of ['claude-code', 'codex']) {
    const registrations = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, 'hosts', host, 'registrations.json')));
    const hook = registrations.hooks.SessionStart.flatMap(g => g.hooks).find(h => h.command.includes('consumer-scheduler.cjs'));
    assert.ok(hook.timeout * 1000 > budget, host + ' startup timeout');
    if (host === 'claude-code') assert.equal(hook.async, true);
  }
});

test('--auto skips consumers with future due dates', t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scheduler-due-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.db');
  const handle = require('../../sqlite/index.cjs').openDb({ path: file });
  const store = require('../../sqlite/store-events.cjs');
  for (const c of CONSUMERS) {
    const opts = { db: handle, runId: 'fixture' };
    store.beginConsumerRun(c.id, opts);
    store.completeConsumerRun(c.id, { ...opts, nextDueAt: new Date(Date.now() + 3600000).toISOString() });
  }
  handle.close();
  const start = Date.now();
  const r = spawnSync(process.execPath, [path.join(HARNESS_ROOT, 'core/engine/scripts/consumer-scheduler.cjs'), '--auto'], {
    env: { ...process.env, HARNESS_SQLITE_PATH: file, HARNESS_STATE_DIR: dir }, encoding: 'utf8', timeout: 2000, windowsHide: true,
  });
  assert.equal(r.status, 0, r.error?.message || r.stderr);
  assert.ok(Date.now() - start < 2000);
  assert.doesNotMatch(r.stderr, /:ran|:timeout/);
});
