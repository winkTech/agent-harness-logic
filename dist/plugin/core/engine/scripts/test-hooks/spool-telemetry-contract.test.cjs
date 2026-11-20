#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/spool-telemetry-contract.test.cjs — H-5 前置合同
 *
 * Phase 2.5 验收（除 H-5 bench 外的行为面）：
 *   1. writer：append-only / 按日滚动 / 大小上限滚动 / 防写开关跳过 / 巨行截断
 *   2. drain：spool→events 搬运 / watermark 推进 / heartbeat 闭合 / 有界批量 /
 *      dry-run 不写库不截断 / 坏行 drop 不重试
 *   3. 100 合成事件损失 0（H-5 行为口径的合同版）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 本套件验证的是 spool「写入/搬运」路径本身——全程临时目录 + 临时 DB 隔离，
// 显式清掉 runner 注入的防写开关（与 codegraph-sync-contract 同款语义；
// 只读跳过行为由「writer: 防写开关命中静默跳过」用例内的局部 env 模拟覆盖）。
const GATE_VARS = [
  'HARNESS_NO_PERSIST', 'HARNESS_VERIFY_READONLY', 'HARNESS_NO_DIAGNOSTIC_WRITES',
  'HARNESS_NO_PERSIST', 'HARNESS_VERIFY_READONLY', 'HARNESS_NO_DIAGNOSTIC_WRITES',
];
const savedGates = Object.fromEntries(GATE_VARS.map((k) => [k, process.env[k]]));
for (const k of GATE_VARS) delete process.env[k];

const spool = require('../io/telemetry-spool.cjs');
const { drainSpool } = require('../io/spool-drain-lib.cjs');
const { openDb } = require('../../sqlite/index.cjs');
const events = require('../../sqlite/store-events.cjs');

process.on('exit', () => {
  for (const [k, v] of Object.entries(savedGates)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function makeDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── writer ─────────────────────────────────────────────────────────────────

test('writer: append-only 逐行追加 jsonl', (t) => {
  const dir = makeDir(t, 'spool-w1-');
  const r1 = spool.appendToSpool({ type: 'tool_fail', ts: '2026-01-01T00:00:00Z' }, { dir });
  const r2 = spool.appendToSpool({ type: 'user_correct', ts: '2026-01-01T00:00:01Z' }, { dir });
  assert.equal(r1.wrote, true);
  assert.equal(r2.wrote, true);
  assert.equal(r1.file, r2.file, '同日同文件（append-only）');
  const lines = fs.readFileSync(r1.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).type, 'user_correct');
});

test('writer: 大小上限滚动序号文件', (t) => {
  const dir = makeDir(t, 'spool-w2-');
  // 注入小上限（64B）：已写 64B 的当日文件视为满 → 滚动 -1
  const date = spool.localDateStamp();
  const big = path.join(dir, `spool-${date}.jsonl`);
  fs.writeFileSync(big, 'x'.repeat(64), 'utf8');
  const rolled = spool.currentSpoolFile(dir, date, 64);
  assert.notEqual(rolled, big, '上限文件不再命中，滚动到 -1');
  assert.match(path.basename(rolled), /-1\.jsonl$/);
  // 真实上限下的常规路径仍命中当日文件（64B < 20MB）
  assert.equal(spool.currentSpoolFile(dir, date), big);
});

test('writer: 巨行截断为占位记录', (t) => {
  const dir = makeDir(t, 'spool-w3-');
  const huge = { type: 'big', blob: 'y'.repeat(spool.MAX_LINE_BYTES + 1000) };
  const r = spool.appendToSpool(huge, { dir });
  assert.equal(r.truncated, true);
  const parsed = JSON.parse(fs.readFileSync(r.file, 'utf8').trim());
  assert.equal(parsed.truncated, true);
});

test('writer: 防写开关命中静默跳过', (t) => {
  const prev = process.env.HARNESS_NO_PERSIST;
  process.env.HARNESS_NO_PERSIST = '1';
  try {
    const r = spool.appendToSpool({ type: 'x' }, { dir: makeDir(t, 'spool-w4-') });
    assert.deepEqual(r, { skipped: true, wrote: false });
  } finally {
    if (prev === undefined) delete process.env.HARNESS_NO_PERSIST;
    else process.env.HARNESS_NO_PERSIST = prev;
  }
});

// ── drain ──────────────────────────────────────────────────────────────────

function makeDbFixture(t) {
  const dir = makeDir(t, 'spool-d-');
  const dbPath = path.join(dir, 'test.db');
  const handle = openDb({ path: dbPath });
  t.after(() => { try { handle.close(); } catch { /* */ } });
  return { dir, dbPath, handle };
}

test('drain: 搬运 + watermark 推进 + heartbeat 闭合', (t) => {
  const { dir, dbPath } = makeDbFixture(t);
  for (let i = 0; i < 5; i += 1) {
    spool.appendToSpool({ type: 'tool_fail', sessionId: `s-${i}`, payload: { n: i } }, { dir });
  }
  const r = drainSpool({
    spoolDir: dir,
    deps: { events, openDb: () => openDb({ path: dbPath }) },
  });
  assert.equal(r.ok, true);
  assert.equal(r.moved, 5);
  assert.equal(r.heartbeat, 'completed');
  // 库内可见（events 总量口径——getWatermark 是 per-consumer 值）
  const h2 = openDb({ path: dbPath });
  const rows = events.sinceWatermark(0, 100, { db: h2 });
  h2.close();
  assert.equal(rows.length, 5);
  assert.equal(rows[0].type, 'tool_fail');
  // spool 文件已截断
  const files = spool.listSpoolFiles({ dir });
  assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(files[0], 'utf8'), '');
});

test('drain: 100 合成事件损失 0（H-5 合同口径）', (t) => {
  const { dir, dbPath } = makeDbFixture(t);
  for (let i = 0; i < 100; i += 1) {
    spool.appendToSpool({ type: 'bench_event', sessionId: `bench-${i}`, payload: { i } }, { dir });
  }
  const r = drainSpool({
    spoolDir: dir,
    deps: { events, openDb: () => openDb({ path: dbPath }) },
  });
  assert.equal(r.moved + r.dropped, 100);
  assert.equal(r.dropped, 0, `损失必须为 0，实际 dropped=${r.dropped}`);
  assert.equal(r.moved, 100);
});

test('drain: dry-run 只读——不写库不截断不心跳', (t) => {
  const { dir, dbPath } = makeDbFixture(t);
  spool.appendToSpool({ type: 'probe', sessionId: 'x' }, { dir });
  const before = fs.readFileSync(spool.listSpoolFiles({ dir })[0], 'utf8');
  const r = drainSpool({
    dryRun: true,
    spoolDir: dir,
    deps: { events, openDb: () => openDb({ path: dbPath }) },
  });
  assert.equal(r.moved, 1);
  assert.equal(r.heartbeat, 'dry-run');
  const after = fs.readFileSync(spool.listSpoolFiles({ dir })[0], 'utf8');
  assert.equal(after, before, 'dry-run 不得截断 spool');
  const h = openDb({ path: dbPath });
  assert.equal(events.sinceWatermark(0, 10, { db: h }).length, 0, 'dry-run 不得写库');
  h.close();
});

test('drain: 坏行 drop 不重试不阻塞', (t) => {
  const { dir, dbPath } = makeDbFixture(t);
  const date = spool.localDateStamp();
  fs.writeFileSync(path.join(dir, `spool-${date}.jsonl`),
    '{"type":"good","sessionId":"g1"}\n{broken json\n{"type":"good2","sessionId":"g2"}\n', 'utf8');
  const r = drainSpool({
    spoolDir: dir,
    deps: { events, openDb: () => openDb({ path: dbPath }) },
  });
  assert.equal(r.moved, 2);
  assert.equal(r.dropped, 1);
  assert.equal(r.ok, true);
});

test('drain: 入库失败保留有效记录并从失败行重试', (t) => {
  const { dir, dbPath } = makeDbFixture(t);
  const openFixture = () => openDb({ path: dbPath });
  for (const sessionId of ['先写入', 'retry', 'tail']) {
    spool.appendToSpool({ type: 'probe', sessionId }, { dir });
  }
  const [file] = spool.listSpoolFiles({ dir });
  const original = fs.readFileSync(file, 'utf8');
  const failure = drainSpool({
    spoolDir: dir,
    deps: {
      openDb: openFixture,
      events: {
        ...events,
        record(event, ...args) {
          if (event.sessionId === 'retry') throw new Error('fixture: database is busy');
          return events.record(event, ...args);
        },
      },
    },
  });

  assert.equal(failure.ok, false);
  assert.equal(failure.heartbeat, 'failed');
  assert.equal(failure.moved, 1);
  assert.equal(failure.dropped, 0);
  assert.match(failure.errors[0], /database is busy/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);

  const failedDb = openFixture();
  assert.equal(events.getConsumerRun('telemetry-spool-drain', { db: failedDb }).status, 'failed');
  assert.equal(events.getWatermark({ db: failedDb, consumer: 'telemetry-spool-drain' }), 0);
  failedDb.close();

  const retried = drainSpool({ spoolDir: dir, deps: { openDb: openFixture, events } });
  assert.equal(retried.moved, 2);
  assert.equal(retried.heartbeat, 'completed');
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  const finishedDb = openFixture();
  assert.deepEqual(events.sinceWatermark(0, 10, { db: finishedDb }).map((row) => row.sessionId), ['先写入', 'retry', 'tail']);
  assert.equal(events.getConsumerRun('telemetry-spool-drain', { db: finishedDb }).status, 'success');
  finishedDb.close();
});

test('drain: 有界批量——batchLimit 截断后保留余量续搬', (t) => {
  const { dir, dbPath } = makeDbFixture(t);
  for (let i = 0; i < 10; i += 1) {
    spool.appendToSpool({ type: 't', sessionId: `s${i}` }, { dir });
  }
  const deps = { events, openDb: () => openDb({ path: dbPath }) };
  const r1 = drainSpool({ spoolDir: dir, deps, batchLimit: 4 });
  assert.equal(r1.moved, 4);
  assert.equal(r1.watermark, 0, '有待搬运记录时不确认数据库高水位');
  assert.notEqual(fs.readFileSync(spool.listSpoolFiles({ dir })[0], 'utf8'), '', '半途不截断');
  const r2 = drainSpool({ spoolDir: dir, deps });
  assert.equal(r2.moved, 6, '余量续搬');
  assert.equal(r2.watermark, 10);
});

test('drain: 空目录确认数据库高水位，读取失败保留原水位', (t) => {
  const { dir, dbPath, handle } = makeDbFixture(t);
  const id = events.record({ sessionId: 'review', type: 'probe' }, '2025-01-01T00:00:00.000Z', { db: handle });
  const deps = { events, openDb: () => openDb({ path: dbPath }) };
  for (const spoolDir of [dir, path.join(dir, 'missing')]) {
    const empty = drainSpool({ spoolDir, deps });
    assert.equal(empty.ok, true);
    assert.equal(empty.files, 0);
    assert.equal(empty.moved, 0);
    assert.equal(empty.watermark, id);
  }

  const db = openDb({ path: dbPath });
  events.record({ sessionId: 'review', type: 'probe' }, null, { db });
  const { consumerRegistry } = require('../../hooks/manifest.json');
  for (const { id: consumer } of consumerRegistry.filter((entry) => entry.active && entry.requiresWatermark)) {
    if (!['fp-rate', 'telemetry-spool-drain'].includes(consumer)) events.setWatermark(id, { db, consumer });
  }
  assert.equal(events.purgeConsumedEvents(30, { db }).deleted, 0, '其他消费者未处理的事件仍应保留');
  db.close();

  const unreadable = drainSpool({ spoolDir: dbPath, deps });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.heartbeat, 'failed');
  const failedDb = openDb({ path: dbPath });
  assert.equal(events.getWatermark({ db: failedDb, consumer: 'telemetry-spool-drain' }), id);
  failedDb.close();
});
