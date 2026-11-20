#!/usr/bin/env node
'use strict';

/**
 * legacy-upgrade-contract.cjs — 旧库升级回归契约 (Phase 0.3 安全网)。
 *
 * 锁定三条升级路径, 保证 013-delivery-events 收编野生迁移后旧库能无损升到最新:
 *   1. fixture 路径: test-fixtures/legacy-2026-11.db (真实库脱敏裁剪副本,
 *      _migrations 定格在 013 待应用) 经统一迁移升到最新 —— sha256 清单守卫
 *      fixture 不被意外改动;
 *   2. 程序化路径: 按迁移链重放 001→012 构造旧形态 :memory: 库 (证明迁移链
 *      自身可从零重放), 再注入 004 时代的野生 delivery 表 (无 uncovered 列,
 *      带 _delivery_migration 私有账本) 后升到最新;
 *   3. 采样行无损: 升级前后的 delivery_events 行逐字段相等, 升级后可继续
 *      写入带 uncovered 归因的新行。
 *
 * fixture 只在临时目录打开副本 —— 绝不原地打开跟踪文件 (openDb 会写入迁移记录)。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FIXTURE = path.join(ROOT, 'core/engine/sqlite/test-fixtures/legacy-2026-11.db');
const FIXTURE_SHA = path.join(ROOT, 'core/engine/sqlite/test-fixtures/legacy-2026-11.db.sha256');
const REAL_MIGRATIONS = path.join(ROOT, 'core/engine/sqlite/migrations');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-upgrade-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* cleanup */ } });

const { openDb } = require(path.join(ROOT, 'core/engine/sqlite/index.cjs'));
const { applyPendingMigrations } = require(path.join(ROOT, 'core/engine/sqlite/schema.cjs'));

function snapshotDeliveryRows(db, limit = 50) {
  return db.prepare('SELECT * FROM delivery_events ORDER BY id LIMIT ?').all(limit);
}

/** 004 时代 (野生账本期) 的 delivery_events DDL —— 无 uncovered 列 */
const ERA_004_DDL = `
  CREATE TABLE IF NOT EXISTS delivery_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_name TEXT    NOT NULL DEFAULT 'hdl-coding-dag-workflow',
    phase         TEXT    NOT NULL,
    status        TEXT    NOT NULL CHECK(status IN ('pass','fail','partial')),
    module_count  INTEGER DEFAULT 0,
    retry_count   INTEGER DEFAULT 0,
    duration_sec  INTEGER DEFAULT 0,
    error_msg     TEXT,
    project       TEXT,
    timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
    session_id    TEXT
  );
`;

function main() {
  // ── 共同前置: fixture 完整性守卫 (sha256 清单) ──
  const expectedSha = fs.readFileSync(FIXTURE_SHA, 'utf8').trim().split(/\s+/)[0];
  const actualSha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex');
  assert.equal(actualSha, expectedSha, 'tracked fixture must match its sha256 manifest (never open it in place)');

  // ── 1. fixture 路径: 旧库副本升到最新 ──
  const fixtureCopy = path.join(TMP, 'fixture-copy.db');
  fs.copyFileSync(FIXTURE, fixtureCopy);
  const pre = new DatabaseSync(fixtureCopy, { readOnly: true });
  const preRows = snapshotDeliveryRows(pre);
  const preMigrations = pre.prepare('SELECT name FROM _migrations ORDER BY name').all().map((r) => r.name);
  pre.close();
  assert.ok(!preMigrations.includes('013-delivery-events'), 'fixture must represent the pre-013 legacy state');
  assert.equal(preRows.length, 50, 'fixture carries the sampled delivery rows');

  const upgraded = openDb({ path: fixtureCopy });
  const postMigrations = upgraded.db.prepare('SELECT name FROM _migrations ORDER BY name').all().map((r) => r.name);
  assert.ok(postMigrations.includes('013-delivery-events'),
    'opening the legacy fixture must backfill 013 into the unified _migrations ledger');
  // Phase 1.7 起 fixture 之上还有 014-personal-repath（及未来更多迁移）：
  // 断言放宽为"保留既有账目 + 补齐 fixture 之后的全部真实迁移"。
  assert.deepEqual(postMigrations, [...preMigrations, '013-delivery-events', '014-personal-repath'].sort(),
    'upgrade must add every post-fixture migration (013, 014) and preserve the existing ledger entries');
  assert.deepEqual(snapshotDeliveryRows(upgraded.db), preRows,
    'sampled delivery rows must survive the upgrade byte-identically');
  const cols = upgraded.db.prepare('PRAGMA table_info(delivery_events)').all().map((c) => c.name);
  assert.ok(cols.includes('uncovered'), 'upgraded database must expose the uncovered attribution column');
  // 升级后可继续写入带归因的新行 (业务读写不动)
  upgraded.db.prepare(`INSERT INTO delivery_events (workflow_name, phase, status, uncovered)
    VALUES ('legacy-upgrade-contract', 'verification', 'partial', '["exit-code"]')`).run();
  const written = upgraded.db.prepare("SELECT uncovered FROM delivery_events WHERE workflow_name='legacy-upgrade-contract'").get();
  assert.deepEqual(JSON.parse(written.uncovered), ['exit-code'],
    'post-upgrade writes must persist uncovered attribution');
  upgraded.close();

  // ── 2. 程序化路径: 迁移链 001→012 从零重放, 再注入野生表后升到最新 ──
  const replayDir = path.join(TMP, 'migrations-001-012');
  fs.mkdirSync(replayDir);
  for (const f of fs.readdirSync(REAL_MIGRATIONS).sort()) {
    if (f === '013-delivery-events.cjs' || f === '014-personal-repath.cjs') continue; // 只重放 001→012
    fs.copyFileSync(path.join(REAL_MIGRATIONS, f), path.join(replayDir, f));
  }
  const oldDb = new DatabaseSync(':memory:');
  applyPendingMigrations(oldDb, { dir: replayDir });
  const replayed = oldDb.prepare('SELECT name FROM _migrations ORDER BY name').all().map((r) => r.name);
  assert.ok(replayed.includes('012-unified-graph') && replayed.length === 13,
    'replaying 001→012 must build the old-shape schema from scratch');
  assert.ok(!oldDb.prepare("SELECT name FROM sqlite_master WHERE name='delivery_events'").get(),
    '001→012 chain must not create delivery_events (it lived in the wild private ledger)');

  // 注入 004 时代的野生状态: 无 uncovered 列 + 私有 _delivery_migration 账本 + 样本行
  oldDb.exec(ERA_004_DDL);
  oldDb.exec(`CREATE TABLE _delivery_migration (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  oldDb.prepare("INSERT INTO _delivery_migration (name) VALUES ('004-delivery-tracking')").run();
  const eraRows = [
    ['hdl-coding-dag-workflow', 'P4', 'pass', 3, 1, 42, 'legacy-row-a'],
    ['verification-gate', 'verification', 'partial', 0, 0, 0, 'legacy-row-b'],
  ];
  for (const [wf, phase, status, modules, retries, duration, project] of eraRows) {
    oldDb.prepare(`INSERT INTO delivery_events (workflow_name, phase, status, module_count, retry_count, duration_sec, project)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(wf, phase, status, modules, retries, duration, project);
  }

  // 升到最新: 真实迁移目录 (013 待应用) —— ensureColumn 语义必须补出 uncovered
  applyPendingMigrations(oldDb, { dir: REAL_MIGRATIONS });
  assert.ok(oldDb.prepare("SELECT name FROM _migrations WHERE name='013-delivery-events'").get(),
    '013 must apply on top of a replayed 001→012 + wild-ledger database');
  const upgradedCols = oldDb.prepare('PRAGMA table_info(delivery_events)').all().map((c) => c.name);
  assert.ok(upgradedCols.includes('uncovered'),
    '013 ensureColumn semantics must add uncovered to a 004-era delivery_events table');
  const survived = oldDb.prepare('SELECT workflow_name, phase, status, module_count, retry_count, duration_sec, project FROM delivery_events ORDER BY id')
    .all().map((row) => ({ ...row }));
  assert.deepEqual(survived, eraRows.map(([wf, phase, status, modules, retries, duration, project]) => ({
    workflow_name: wf, phase, status, module_count: modules, retry_count: retries,
    duration_sec: duration, project,
  })), 'era-004 sample rows must survive the upgrade losslessly');
  oldDb.prepare(`INSERT INTO delivery_events (workflow_name, phase, status, uncovered)
    VALUES ('legacy-upgrade-contract', 'P4', 'fail', '["pass-marker"]')`).run();
  oldDb.close();

  // ── 3. 幂等: 升级后的库重复跑迁移不报错不重复记账 ──
  const again = openDb({ path: fixtureCopy });
  applyPendingMigrations(again.db, { dir: REAL_MIGRATIONS });
  const count013 = again.db.prepare("SELECT COUNT(*) c FROM _migrations WHERE name='013-delivery-events'").get().c;
  assert.equal(count013, 1, 're-running migrations must not duplicate the 013 ledger entry');
  again.close();

  console.log('legacy-upgrade-contract: all assertions passed');
}

main();
