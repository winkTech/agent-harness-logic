#!/usr/bin/env node
'use strict';

/**
 * memory-outcome-loop-contract.cjs — 记忆归因闭环端到端契约 (D5.3 outcome 断链修复)。
 *
 * 锁定的行为链: 检索注入落 exposure → 验证命令 PostToolUse 经 postflight-router
 * → verification-gate 产出 verdict → application + outcome 落库 → exposure 状态翻转。
 *
 * 根因回归 (2026-07-30): 旧 verification-gate 只在 pending 非空时产出 verdict,
 * 而 pending 只收 .sv/.py/.c 等编辑 —— harness 会话编辑 .cjs 永不进 pending,
 * outcome 与 delivery 两条自动喂数链整体空转 (实测 applications=364, outcomes=0)。
 * 本契约用**空 pending** 的 cwd 断言 verdict 照常产出并走完全链。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 全链持久化由注入的临时 DB 承载, 环境守卫必须清掉, 否则 delivery 分支静默跳过。
delete process.env.CLAUDE_HARNESS_NO_PERSIST;
delete process.env.CLAUDE_HARNESS_VERIFY_READONLY;
delete process.env.CLAUDE_NO_DIAGNOSTIC_WRITES;
delete process.env.CLAUDE_HOOK_NO_WRITE;

const ROOT = path.resolve(__dirname, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-loop-'));
// verification-gate 的证据账本在模块加载时解析 env, 必须先设再 require。
process.env.CLAUDE_VERIFICATION_LEDGER_FILE = path.join(tmp, 'verification-ledger.json');

const { openDb } = require(path.join(ROOT, 'engine/sqlite/index.cjs'));
const storeMemory = require(path.join(ROOT, 'engine/sqlite/store-memory.cjs'));
const attribution = require(path.join(ROOT, 'engine/sqlite/store-memory-attribution.cjs'));
const { retrieveContext } = require(path.join(ROOT, 'engine/scripts/memory-retrieve-hook.cjs'));
const postflight = require(path.join(ROOT, 'engine/scripts/hooks/postflight-router.cjs'));
const verificationGate = require(path.join(ROOT, 'engine/scripts/hooks/verification-gate.cjs'));

function seedVerifiedFact(db, name) {
  const now = Date.now();
  const { id } = storeMemory.writeMemory({
    namespace: 'learnings',
    name,
    content: `FSM 状态机复位时序经验 ${name}: 三段式状态机的输出寄存必须挂在时钟沿`,
    description: `FSM 复位经验 ${name}`,
    source: 'manual',
    confidence: 0.8,
  }, { db });
  db.prepare(`
    UPDATE facts SET verification_state = 'verified', evidence_ref = 'var/evidence/x.json',
                     trigger_kind = 'user_query', valid_until = ?, scope_kind = 'global_harness'
    WHERE id = ?
  `).run(now + 90 * 86400000, id);
  return id;
}

/** 检索注入 + exposure 落库 (临时 DB 全注入, 不碰真实库)。 */
function inject(db, sessionId, cwd) {
  return retrieveContext(
    { hook_event_name: 'UserPromptSubmit', prompt: '查一下 FSM 状态机复位的既往经验', session_id: sessionId, cwd },
    {
      openDb: () => ({ db, close() { /* shared handle */ } }),
      openAttributionDb: () => ({ db, close() { /* shared handle */ } }),
      attribution,
      attributionPersistenceDisabled: () => false,
      recentlyInjected: () => false,
      markInjected: () => {},
      warn: (e) => { throw e; },
    },
  );
}

/** Bash 验证命令的 PostToolUse 经 postflight-router 全链路由。 */
async function routeVerification(db, sessionId, cwd, stdout, deliveries, eventName = 'PostToolUse') {
  return postflight.route({
    hook_event_name: eventName,
    tool_name: 'Bash',
    session_id: sessionId,
    cwd,
    tool_use_id: `toolu_${sessionId}_${eventName}`,
    tool_input: { command: 'node engine/scripts/test-hooks/self-check.cjs' },
    tool_response: { stdout, stderr: '', interrupted: false },
  }, {
    verificationGate,
    memoryAttribution: attribution,
    openAttributionDb: () => ({ db, close() { /* shared handle */ } }),
    deliveryTracker: { recordDelivery: (args) => { deliveries.push(args); return { recorded: true }; } },
    progressWatchdog: { updateProgress: () => ({ status: 'ok' }) },
    toolchainHealth: { evaluatePayload: () => ({ decision: 'allow' }) },
    crossLinkMemory: { evaluatePayload: () => ({ decision: 'allow' }) },
  });
}

function rows(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}

async function main() {
  const handle = openDb({ path: path.join(tmp, 'memory.db') });
  const db = handle.db;
  const cwd = fs.mkdtempSync(path.join(tmp, 'proj-'));
  const deliveries = [];
  try {
    seedVerifiedFact(db, 'outcome-loop-fact');

    // ── 1. 检索注入必须落 exposure (status=emitted) ──
    const out = inject(db, 'outcome-loop-pass', cwd);
    assert.ok(out, 'trigger message must inject memory');
    const exposures = rows(db, "SELECT * FROM memory_retrieval_exposures WHERE session_id = 'outcome-loop-pass'");
    assert.equal(exposures.length, 1, `expected 1 exposure, got ${exposures.length}`);
    assert.equal(exposures[0].status, 'emitted');

    // ── 2. 空 pending 下验证命令 PASS → verdict 产出 + application + outcome pass ──
    const passResult = await routeVerification(db, 'outcome-loop-pass', cwd, 'RESULT: PASS 全部断言通过', deliveries);
    const gateResult = passResult.results.find(r => r.source === 'verification-gate');
    assert.ok(gateResult, 'verification-gate must run for Bash PostToolUse');
    assert.equal((gateResult.pending || []).length, 0, 'contract precondition: pending must be empty');
    assert.ok(gateResult.verification, 'verdict must be produced even with empty pending (D5.3 regression)');
    assert.equal(gateResult.verification.ok, true);
    assert.equal(gateResult.decision, 'allow');

    const apps = rows(db, "SELECT * FROM memory_applications WHERE session_id = 'outcome-loop-pass'");
    assert.ok(apps.length >= 1, `application must be recorded, got ${apps.length}`);
    const outcomes = rows(db, "SELECT * FROM memory_outcomes WHERE session_id = 'outcome-loop-pass'");
    assert.equal(outcomes.length, 1, `expected 1 outcome, got ${outcomes.length}`);
    assert.equal(outcomes[0].verdict, 'pass');
    assert.equal(Number(outcomes[0].accepted), 1);
    assert.equal(outcomes[0].evidence_source, 'verification-gate');
    assert.equal(outcomes[0].exposure_id, exposures[0].exposure_id, 'outcome must chain back to the exposure');

    const flipped = rows(db, "SELECT status FROM memory_retrieval_exposures WHERE session_id = 'outcome-loop-pass'");
    assert.equal(flipped[0].status, 'verified-pass', 'exposure status must flip to verified-pass');

    // delivery 自动喂数同链产生
    assert.equal(deliveries.length, 1, 'delivery record must be fed from the same verdict');
    assert.equal(deliveries[0].status, 'pass');
    assert.equal(deliveries[0].workflow, 'verification-gate');

    // ── 3. 失败路径: RESULT: FAIL → warn + outcome fail + exposure verified-fail ──
    const out2 = inject(db, 'outcome-loop-fail', cwd);
    assert.ok(out2, 'second session must inject');
    const failResult = await routeVerification(db, 'outcome-loop-fail', cwd, 'RESULT: FAIL 断言失败', deliveries);
    const failGate = failResult.results.find(r => r.source === 'verification-gate');
    assert.equal(failGate.verification.ok, false);
    assert.equal(failGate.decision, 'warn', 'failed verdict must surface as warn for outcome validity');

    const failOutcomes = rows(db, "SELECT * FROM memory_outcomes WHERE session_id = 'outcome-loop-fail'");
    assert.equal(failOutcomes.length, 1);
    assert.equal(failOutcomes[0].verdict, 'fail');
    assert.equal(Number(failOutcomes[0].accepted), 0);
    const failExposure = rows(db, "SELECT status FROM memory_retrieval_exposures WHERE session_id = 'outcome-loop-fail'");
    assert.equal(failExposure[0].status, 'verified-fail');
    assert.equal(deliveries[1].status, 'fail');

    // ── 3b. 判定不可读 → inconclusive, 且 exposure 不得翻成 verified-fail ──
    // 真实事故: 输出被 `| tail -3` 截断时门禁看不到 PASS 判据, 旧实现记成
    // fail outcome, 退役规则据此把两条无辜记忆的 TTL 砍到 14 天。
    const out3 = inject(db, 'outcome-loop-unreadable', cwd);
    assert.ok(out3, 'third session must inject');
    // 注意 fixture 里不能出现任何正面标记字样 (含 "PASS" 三个字母本身),
    // 否则会被 PASS_MARKERS 命中而变成通过判定。
    await routeVerification(db, 'outcome-loop-unreadable', cwd, '输出的最后三行被管道截断了', deliveries);
    const unreadable = rows(db, "SELECT * FROM memory_outcomes WHERE session_id = 'outcome-loop-unreadable'");
    assert.equal(unreadable.length, 1);
    assert.equal(unreadable[0].verdict, 'inconclusive',
      `unreadable verdict must not be recorded as fail: ${unreadable[0].verdict} (${unreadable[0].reason})`);
    assert.equal(Number(unreadable[0].accepted), 0, 'inconclusive must never be accepted');
    const unreadableExposure = rows(db, "SELECT status FROM memory_retrieval_exposures WHERE session_id = 'outcome-loop-unreadable'");
    assert.equal(unreadableExposure[0].status, 'unverified',
      'an unreadable verdict must leave the exposure unverified, not verified-fail');
    assert.equal(deliveries[2].status, 'partial',
      'the same verdict must land as a partial delivery, not a failure');

    // ── 4. 非验证命令不产出 verdict, 不喂 outcome/delivery ──
    const before = rows(db, 'SELECT COUNT(*) n FROM memory_outcomes')[0].n;
    const deliveriesBefore = deliveries.length;
    const plain = await postflight.route({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      session_id: 'outcome-loop-pass',
      cwd,
      tool_input: { command: 'git status' },
      tool_response: { stdout: 'clean', stderr: '', interrupted: false },
    }, {
      verificationGate,
      memoryAttribution: attribution,
      openAttributionDb: () => ({ db, close() { /* shared handle */ } }),
      deliveryTracker: { recordDelivery: (args) => { deliveries.push(args); return { recorded: true }; } },
      progressWatchdog: { updateProgress: () => ({ status: 'ok' }) },
      toolchainHealth: { evaluatePayload: () => ({ decision: 'allow' }) },
      crossLinkMemory: { evaluatePayload: () => ({ decision: 'allow' }) },
    });
    const plainGate = plain.results.find(r => r.source === 'verification-gate');
    assert.ok(!plainGate.verification, 'non-verification command must not fabricate a verdict');
    assert.equal(rows(db, 'SELECT COUNT(*) n FROM memory_outcomes')[0].n, before, 'no outcome for non-verification command');
    assert.equal(deliveries.length, deliveriesBefore,
      'non-verification command must not add a delivery record');
    assert.deepEqual(deliveries.map((entry) => entry.status), ['pass', 'fail', 'partial'],
      '三条判定各自映射一条 delivery: 通过 / 真失败 / 判定不可读');

    console.log('memory-outcome-loop-contract: all assertions passed');
  } finally {
    try { handle.close(); } catch { /* test cleanup */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* test cleanup */ }
  }
}

main().catch((error) => {
  console.error(error && error.stack || String(error));
  process.exit(1);
});
