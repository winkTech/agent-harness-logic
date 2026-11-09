#!/usr/bin/env node
'use strict';

/**
 * evidence-delivery-attribution-contract.cjs — 交付事件归因与账本证据回填契约。
 *
 * 锁定 (2026-11 实测缺陷回归):
 *   1. delivery_events 1,227 条 duration_sec/retry_count 全 0: 可达处
 *      (hdl-evidence-gate 进程内 elapsed) 必须落真实值; 不可达处 (PostToolUse
 *      观察路径无墙钟、门禁路径无重试语义) 留 0, 不编造。
 *   2. partial 占 54.9% 却没有"缺了什么证据"的归因: partial 事件必须携带
 *      uncovered (要求项 - 已满足项), 由 verificationVerdict 计算。
 *   3. 账本 500 条 exitCodeKnown 仅 1%、timingKnown 为 0: 载荷带退出码/耗时的
 *      完成条目必须回填 (exitCodeKnown/timingKnown=true); 载荷不带时保持 false。
 *
 * schema 决策: 归因走统一迁移账本 migrations/013-delivery-events.cjs 加
 * uncovered TEXT 列 (JSON 数组字符串), 不编码进 error_msg —— 加列可查询可聚合;
 * error_msg 是自由文本且写入端截断到 200 字符, 编码进它会随截断丢失。
 * (013 收编了 delivery-tracker 曾私有的 _delivery_migration 账本; 本测试第 1 节
 *  锁定旧库升级语义: 004 时代的库经统一迁移升到最新, uncovered 列补齐且幂等。)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-attribution-'));
// 账本/门禁状态路径先隔离再 require; NO_PERSIST 只挡图边与遥测, 账本写入不受其影响。
process.env.CLAUDE_HARNESS_NO_PERSIST = '1';
process.env.CLAUDE_VERIFY_GATE_STATE_FILE = path.join(TMP, 'verify-gate.json');
process.env.CLAUDE_VERIFICATION_LEDGER_FILE = path.join(TMP, 'verification-ledger.json');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* cleanup */ } });

const { openDb } = require(path.join(ROOT, 'engine/sqlite/index.cjs'));
const delivery = require(path.join(ROOT, 'engine/scripts/delivery-tracker.cjs'));
const router = require(path.join(ROOT, 'engine/scripts/hooks/postflight-router.cjs'));
const verificationGate = require(path.join(ROOT, 'engine/scripts/hooks/verification-gate.cjs'));
const evidenceGate = require(path.join(ROOT, 'engine/scripts/hdl-evidence-gate.cjs'));

const LEDGER_FILE = process.env.CLAUDE_VERIFICATION_LEDGER_FILE;

/**
 * recordDeliveryFromVerdict / recordPhaseDelivery 受三个只读环境变量守卫;
 * 本测试的落点全部是注入的捕获器, 临时解除守卫以驱动真实写入路径。
 */
function withPersistence(fn) {
  const saved = {};
  for (const key of ['CLAUDE_HARNESS_NO_PERSIST', 'CLAUDE_HARNESS_VERIFY_READONLY', 'CLAUDE_NO_DIAGNOSTIC_WRITES']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try { return fn(); }
  finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function gatePayload(toolResponse) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    session_id: 'attribution-contract',
    cwd: TMP,
    tool_input: { command: 'pytest -q' },
    tool_response: { interrupted: false, ...toolResponse },
  };
}

function main() {
  // ── 1. 旧库迁移: 004 时代 (无 uncovered 列, 私有 _delivery_migration 账本) 的库
  //        必须经统一迁移账本升到最新, uncovered 列补齐, 且重开库幂等 ──
  const legacyPath = path.join(TMP, 'legacy.db');
  const seed = new (require('node:sqlite').DatabaseSync)(legacyPath);
  seed.exec(`CREATE TABLE delivery_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_name TEXT NOT NULL DEFAULT 'hdl-coding-dag-workflow',
    phase TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pass','fail','partial')),
    module_count INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    duration_sec INTEGER DEFAULT 0,
    error_msg TEXT,
    project TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    session_id TEXT
  )`);
  seed.exec(`CREATE TABLE _delivery_migration (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  seed.prepare("INSERT INTO _delivery_migration (name) VALUES ('004-delivery-tracking')").run();
  seed.close();
  // openDb() 自动跑统一迁移: 013 应对旧形态 delivery_events 补出 uncovered 列
  const legacyHandle = openDb({ path: legacyPath });
  const legacyCols = legacyHandle.db.prepare('PRAGMA table_info(delivery_events)').all().map((col) => col.name);
  assert.ok(legacyCols.includes('uncovered'), 'unified migration 013 must add the uncovered column to a 004-era database');
  assert.ok(
    legacyHandle.db.prepare("SELECT name FROM _migrations WHERE name='013-delivery-events'").get(),
    '013-delivery-events must be recorded in the unified _migrations ledger',
  );
  legacyHandle.close();
  const reopened = openDb({ path: legacyPath });
  assert.ok(
    reopened.db.prepare("SELECT name FROM _migrations WHERE name='013-delivery-events'").get(),
    'reopening the upgraded database must not re-run or fail migration 013 (idempotent)',
  );
  reopened.close();

  // ── 2. partial 交付事件携带 uncovered 归因 (端到端: 门禁判定 → delivery 参数) ──
  const recorded = [];
  const gateResult = verificationGate.evaluate(gatePayload({
    stdout: 'simulation finished at 1200 ns', stderr: '',
  }));
  assert.equal(gateResult.verification.ok, false, 'no exit code + no PASS marker must not pass');
  withPersistence(() => router.recordDeliveryFromVerdict(
    { session_id: 'attribution-contract', cwd: TMP },
    gateResult,
    { deliveryTracker: { recordDelivery: (args) => { recorded.push(args); return true; } } },
  ));
  assert.equal(recorded.length, 1, 'partial verdict must reach the delivery tracker');
  assert.equal(recorded[0].status, 'partial', 'unreadable verdict must be recorded as partial');
  assert.deepEqual(recorded[0].uncovered, ['exit-code', 'pass-marker'],
    'partial event must attribute exactly which evidence requirements were unmet');
  assert.equal(recorded[0].duration, undefined,
    'PostToolUse context has no wall clock — duration must not be fabricated');
  assert.equal(recorded[0].retries, undefined,
    'gate path has no retry semantics — retries must not be fabricated');

  // pass 事件不携带归因 (没有缺失项)
  recorded.length = 0;
  const passGate = verificationGate.evaluate(gatePayload({
    status: 0, stdout: 'RESULT: PASS 3/3', stderr: '',
  }));
  assert.equal(passGate.verification.ok, true);
  withPersistence(() => router.recordDeliveryFromVerdict(
    { session_id: 'attribution-contract', cwd: TMP },
    passGate,
    { deliveryTracker: { recordDelivery: (args) => { recorded.push(args); return true; } } },
  ));
  assert.equal(recorded[0].status, 'pass');
  assert.equal(recorded[0].uncovered, undefined, 'pass events must not carry uncovered attribution');

  // ── 3. uncovered 落库: JSON 数组字符串持久化进 uncovered 列 ──
  const handle = openDb({ path: path.join(TMP, 'fresh.db') });
  const db = handle.db;
  delivery.recordDelivery({
    workflow: 'verification-gate', phase: 'verification', status: 'partial',
    uncovered: ['exit-code', 'pass-marker'],
  }, { db });
  const partialRow = db.prepare("SELECT uncovered FROM delivery_events WHERE status='partial'").get();
  assert.deepEqual(JSON.parse(partialRow.uncovered), ['exit-code', 'pass-marker'],
    'uncovered must persist as a JSON array string in the uncovered column');

  // ── 4. 完成命令账本条目: 载荷带退出码 → exitCodeKnown=true; 带耗时 → timingKnown=true ──
  const accepted = verificationGate.evaluate(gatePayload({
    status: 0, stdout: 'RESULT: PASS', stderr: '', durationMs: 1234,
  }));
  assert.equal(accepted.verification.ok, true);
  let ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  // 取最后一条 accepted: 本测试前面已写过无 durationMs 的 pass 条目
  const knownEntry = [...ledger.entries].reverse()
    .find((entry) => entry.verification?.accepted === true);
  assert.ok(knownEntry, 'accepted verification must be written to the ledger');
  assert.equal(knownEntry.exitCode, 0);
  assert.equal(knownEntry.exitCodeKnown, true,
    'a payload-carried exit code must be backfilled into the completed entry');
  assert.equal(knownEntry.timingKnown, true,
    'a payload-carried duration must set timingKnown on the completed entry');
  assert.equal(knownEntry.durationMs, 1234);

  // 载荷不带退出码/耗时的观察型条目: 保持 false —— 缺口在平台载荷, 不在本层编造
  verificationGate.evaluate(gatePayload({ stdout: 'RESULT: PASS', stderr: '' }));
  ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  const observedEntry = ledger.entries.at(-1);
  assert.equal(observedEntry.exitCodeKnown, false,
    'observed entries must not fabricate an exit code');
  assert.equal(observedEntry.timingKnown, false,
    'observed entries must not fabricate timing');

  // ── 5. hdl-evidence-gate: elapsed 进程内可达 → 真实 duration 落库 ──
  const phaseDeliveries = [];
  const phaseResult = withPersistence(() => evidenceGate.recordPhaseDelivery(
    { ok: true, failures: [] },
    { arch: true, modules: ['foo'], projectRoot: TMP },
    { deliveryTracker: { recordDelivery: (args) => { phaseDeliveries.push(args); return true; } } },
  ));
  assert.equal(phaseResult.recorded, true, 'phase delivery must reach the tracker');
  assert.equal(phaseDeliveries[0].status, 'pass');
  assert.ok(Number.isInteger(phaseDeliveries[0].duration) && phaseDeliveries[0].duration >= 0,
    `hdl gate elapsed is measurable in-process and must be recorded, got ${phaseDeliveries[0].duration}`);
  assert.equal(phaseDeliveries[0].retries, undefined,
    'hdl gate has no retry path — retries must not be fabricated');
  handle.close();

  console.log('evidence-delivery-attribution-contract: all assertions passed');
}

main();
