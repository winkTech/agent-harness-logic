#!/usr/bin/env node
'use strict';

/**
 * memory-retirement-contract.cjs — 归因驱动记忆退役契约 (D5.4)。
 *
 * 锁定:
 *   1. negative-outcome: 30d 内 ≥2 fail 且 0 pass → TTL 14d; 有 pass 的不动
 *   2. exposed-never-applied: ≥5 次暴露无 application → TTL 30d
 *   3. never-exposed 有遥测在线门槛: 暴露仪表历史 <90d 时不判存量事实
 *   4. execute 只缩短 ttl_until 不延长
 *   5. dry-run 不调用退役写接口 (05-harness 规则 4)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CLAUDE_HARNESS_NO_PERSIST = '1';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openDb } = require(path.join(ROOT, 'engine/sqlite/index.cjs'));
const storeMemory = require(path.join(ROOT, 'engine/sqlite/store-memory.cjs'));
const maintenance = require(path.join(ROOT, 'engine/scripts/memory-knowledge-maintenance.cjs'));

const DAY = 86_400_000;
const NOW = Date.now();

function seedFact(db, name, { createdAt = NOW - 10 * DAY, ttlUntil = null } = {}) {
  const { id } = storeMemory.writeMemory({
    namespace: 'learnings',
    name,
    content: `退役契约事实 ${name}`,
    description: name,
    source: 'manual',
    confidence: 0.7,
  }, { db });
  db.prepare('UPDATE facts SET created_at = ?, ttl_until = ? WHERE id = ?').run(createdAt, ttlUntil, id);
  return id;
}

function seedExposure(db, memoryId, index, emittedAt) {
  db.prepare(`
    INSERT INTO memory_retrieval_exposures (
      exposure_id, retrieval_id, correlation_id, session_id, project_id, memory_id,
      trigger_kind, query_sha256, rank, confidence, emitted_at, expires_at
    ) VALUES (?, ?, ?, 'retire-test', 'project:test', ?, 'user-query', ?, 1, 0.7, ?, ?)
  `).run(
    `mx_${memoryId}_${index}`, `mr_${memoryId}_${index}`, `mc_${memoryId}_${index}`,
    memoryId, 'a'.repeat(64), emittedAt, emittedAt + 30 * 60 * 1000,
  );
}

function seedOutcome(db, memoryId, index, verdict, observedAt) {
  const exposureId = `mx_o_${memoryId}_${index}`;
  seedExposureRaw(db, exposureId, `mr_o_${memoryId}_${index}`, memoryId, observedAt);
  db.prepare(`
    INSERT INTO memory_applications (
      application_id, exposure_id, retrieval_id, correlation_id, session_id, project_id,
      memory_id, event_name, tool_name, action_sha256, evidence_kind, evidence_strength, observed_at
    ) VALUES (?, ?, ?, ?, 'retire-test', 'project:test', ?, 'PostToolUse', 'Bash', ?, 'observed-followup', 'weak', ?)
  `).run(`ma_${memoryId}_${index}`, exposureId, `mr_o_${memoryId}_${index}`, `mc_o_${memoryId}_${index}`, memoryId, 'b'.repeat(64), observedAt);
  db.prepare(`
    INSERT INTO memory_outcomes (
      outcome_id, application_id, exposure_id, retrieval_id, correlation_id, session_id,
      project_id, memory_id, verdict, accepted, reason, command_sha256, stdout_sha256,
      stderr_sha256, evidence_source, observed_at
    ) VALUES (?, ?, ?, ?, ?, 'retire-test', 'project:test', ?, ?, ?, 'contract seed', ?, ?, ?, 'verification-gate', ?)
  `).run(
    `mo_${memoryId}_${index}`, `ma_${memoryId}_${index}`, exposureId, `mr_o_${memoryId}_${index}`,
    `mc_o_${memoryId}_${index}`, memoryId, verdict, verdict === 'pass' ? 1 : 0,
    'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), observedAt,
  );
}

function seedExposureRaw(db, exposureId, retrievalId, memoryId, emittedAt) {
  db.prepare(`
    INSERT INTO memory_retrieval_exposures (
      exposure_id, retrieval_id, correlation_id, session_id, project_id, memory_id,
      trigger_kind, query_sha256, rank, confidence, emitted_at, expires_at
    ) VALUES (?, ?, ?, 'retire-test', 'project:test', ?, 'user-query', ?, 1, 0.7, ?, ?)
  `).run(exposureId, retrievalId, `mc_o_${exposureId}`, memoryId, 'a'.repeat(64), emittedAt, emittedAt + 30 * 60 * 1000);
}

/**
 * openDb 按 path+mode 缓存连接, defaultRetireAttribution 结束时会 close 掉
 * 与本测试共享的写连接 —— 断言一律现取现用, 不持有长句柄。
 */
function ttlOf(dbPath, id) {
  return openDb({ path: dbPath }).db.prepare('SELECT ttl_until FROM facts WHERE id = ?').get(id).ttl_until;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-'));
  const dbPath = path.join(tmp, 'memory.db');
  const handle = openDb({ path: dbPath });
  const db = handle.db;
  const context = { now: new Date(NOW), dbPath, home: tmp, opts: {} };
  try {
    // Rule A: 2 fail + 0 pass → 退役; 1 fail + 1 pass → 保留
    const badFact = seedFact(db, 'bad-fact');
    seedOutcome(db, badFact, 1, 'fail', NOW - 5 * DAY);
    seedOutcome(db, badFact, 2, 'fail', NOW - 3 * DAY);
    const mixedFact = seedFact(db, 'mixed-fact');
    seedOutcome(db, mixedFact, 1, 'fail', NOW - 5 * DAY);
    seedOutcome(db, mixedFact, 2, 'pass', NOW - 3 * DAY);

    // Rule B: 5 次暴露无 application
    const unusedFact = seedFact(db, 'unused-fact');
    for (let i = 0; i < 5; i++) seedExposure(db, unusedFact, i, NOW - (i + 1) * DAY);

    // Rule C 候选: 91d 前创建, 从未暴露
    const staleFact = seedFact(db, 'stale-fact', { createdAt: NOW - 91 * DAY });

    // ── 遥测在线 <90d: never-exposed 必须被门槛挡住 ──
    let plan = maintenance.collectAttributionRetirement(context);
    const rules = Object.fromEntries(plan.actions.map(a => [a.id, a.rule]));
    assert.equal(rules[badFact], 'negative-outcome', `bad-fact must retire: ${JSON.stringify(plan.actions)}`);
    assert.ok(!(mixedFact in rules), 'fact with a pass outcome must not retire');
    assert.equal(rules[unusedFact], 'exposed-never-applied');
    assert.ok(!(staleFact in rules), 'never-exposed must be gated while telemetry history <90d');

    // ── 遥测在线 ≥90d 后: never-exposed 生效 ──
    const anchorFact = seedFact(db, 'anchor-fact');
    seedExposure(db, anchorFact, 99, NOW - 95 * DAY);
    plan = maintenance.collectAttributionRetirement(context);
    const rules2 = Object.fromEntries(plan.actions.map(a => [a.id, a.rule]));
    assert.equal(rules2[staleFact], 'never-exposed', 'never-exposed must fire once telemetry is 90d live');

    // ── execute: 只缩短不延长 ──
    const shortTtl = NOW + 1 * DAY;
    const alreadyShort = seedFact(db, 'already-short', { createdAt: NOW - 91 * DAY, ttlUntil: shortTtl });
    plan = maintenance.collectAttributionRetirement(context);
    const result = maintenance.defaultRetireAttribution({ attributionRetirement: plan }, context);
    assert.ok(result.downgraded >= 3, `expected >=3 downgraded, got ${JSON.stringify(result)}`);
    assert.equal(ttlOf(dbPath, alreadyShort), shortTtl, 'existing shorter TTL must never be extended');
    const badTtl = ttlOf(dbPath, badFact);
    assert.ok(badTtl > NOW && badTtl <= NOW + 14 * DAY + 1000, `negative-outcome TTL must be ~14d, got ${badTtl - NOW}`);
    assert.equal(ttlOf(dbPath, mixedFact), null, 'mixed fact TTL must stay null');
    // 幂等: 第二次 execute 不再有可降级行
    const again = maintenance.defaultRetireAttribution({ attributionRetirement: plan }, context);
    assert.equal(again.downgraded, 0, 'second execute must be a no-op');

    // ── dry-run 不得调用退役写接口 ──
    let retireCalls = 0;
    const dry = maintenance.runMaintenance(
      { ...maintenance.parseArgs([]), home: tmp, dbPath, execute: false, dryRun: true, auto: false, force: true },
      new Date(NOW),
      {
        home: tmp,
        retireAttribution: () => { retireCalls += 1; return {}; },
        inspectSqlite: () => ({}),
      },
    );
    assert.equal(retireCalls, 0, 'dry-run must not invoke retirement writes');
    assert.ok(dry.plan.attributionRetirement, 'dry-run plan must carry retirement plan');
    assert.equal(dry.results, null, 'dry-run must not produce execute results');

    console.log('memory-retirement-contract: all assertions passed');
  } finally {
    try { handle.close(); } catch { /* test cleanup */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* test cleanup */ }
  }
}

main();
