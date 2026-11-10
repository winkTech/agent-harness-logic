#!/usr/bin/env node
'use strict';

/**
 * plan-accuracy-contract.cjs — 规划质量与交付窗口契约 (D1/D2)。
 *
 * 锁定:
 *   1. 快照从需求门禁派生: 幂等 planId、字段完整性、门禁未完成/缺字段时不写半成品
 *   2. 实际范围取自透明度账本的真实写事件形状 (file 是相对路径字符串)
 *   3. 对账 verdict 只在有客观信号时判定, 缺信号是 inconclusive 而不是 pass
 *   4. 窗口起点用**首次**快照时间, 重复 harvest 不把窗口推到"现在"
 *   5. delivery 窗口成功率按 pass/(pass+fail) 计, partial 不进分母
 *   6. hdl-evidence-gate 的阶段判定会落 delivery 记录 (DAG 阶段级交付的接入点)
 *   7. 环境守卫下 harvest 完全跳过 (dry-run / 只读模式不得写库)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openDb } = require(path.join(ROOT, 'engine/sqlite/index.cjs'));
const planAccuracy = require(path.join(ROOT, 'engine/scripts/plan-accuracy.cjs'));
const delivery = require(path.join(ROOT, 'engine/scripts/delivery-tracker.cjs'));
const evidenceGate = require(path.join(ROOT, 'engine/scripts/hdl-evidence-gate.cjs'));

const NOW = Date.parse('2026-07-30T00:00:00.000Z');
const DAY = 86_400_000;

const COMPLETED_GATE = {
  status: 'completed',
  task: '契约任务: 计划对账',
  plan: 'plans/contract.md#section',
  approvedBy: 'user',
  scope: ['a.cjs', 'b.cjs', 'c.cjs', 'd.cjs'],
  requirements: {
    D1_scope: 'confirmed — 只做对账, 不动别的',
    D3_success: 'confirmed — 契约测试通过;全量回归无退化',
    D6_risks: 'assumed — 账本形状变化时按行容错',
  },
};

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-accuracy-'));
  const dbPath = path.join(tmp, 'memory.db');
  const handle = openDb({ path: dbPath });
  const db = handle.db;
  try {
    // ── 1. 快照派生与幂等 ──
    const snapshot = planAccuracy.snapshotFromGate(COMPLETED_GATE, { now: NOW });
    assert.ok(snapshot, 'completed gate must produce a snapshot');
    assert.equal(planAccuracy.validateSnapshot(snapshot).ok, true,
      JSON.stringify(planAccuracy.validateSnapshot(snapshot).failures));
    assert.equal(snapshot.expectedScope, 4);
    assert.equal(snapshot.acceptance.length, 2, 'acceptance clauses must split on ;/；');
    assert.equal(snapshot.risks.length, 1);
    assert.equal(
      snapshot.planId,
      planAccuracy.snapshotFromGate(COMPLETED_GATE, { now: NOW + DAY }).planId,
      'planId must be stable for the same task+planRef regardless of时间',
    );

    // 门禁未完成 / 缺 D1 或 D3 → 不产出快照 (不污染 accuracy 分母)
    assert.equal(planAccuracy.snapshotFromGate({ ...COMPLETED_GATE, status: 'pending' }, {}), null);
    assert.equal(planAccuracy.snapshotFromGate({
      ...COMPLETED_GATE, requirements: { D1_scope: 'confirmed — x' },
    }, {}), null, 'missing acceptance criteria must not produce a snapshot');
    assert.equal(planAccuracy.snapshotFromGate(null, {}), null);

    // ── 2. 持久化幂等 + 首次时间为权威窗口起点 ──
    const first = planAccuracy.persistSnapshot({ ...snapshot }, { db, writeFile: false, now: NOW });
    assert.equal(first.createdAt, NOW, 'stored createdAt must be the snapshot time');
    const second = planAccuracy.persistSnapshot(
      { ...snapshot, createdAt: new Date(NOW + 5 * DAY).toISOString() },
      { db, writeFile: false, now: NOW + 5 * DAY },
    );
    assert.equal(second.createdAt, NOW, 're-snapshot must keep the original createdAt (window anchor)');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM plan_snapshots').get().n), 1,
      'snapshot persistence must be idempotent by planId');

    // ── 3. 实际范围取自真实账本形状 ──
    const sessionId = 'plan-accuracy-session';
    const runDir = path.join(ROOT, 'var', 'runs', sessionId);
    let createdRunDir = false;
    try {
      fs.mkdirSync(runDir, { recursive: true });
      createdRunDir = true;
      fs.writeFileSync(path.join(runDir, 'events.ndjson'), [
        JSON.stringify({ tool: 'Write', file: 'a.cjs', event: 'PostToolUse' }),
        JSON.stringify({ tool: 'Edit', file: 'b.cjs', event: 'PostToolUse' }),
        JSON.stringify({ tool: 'Edit', file: 'b.cjs', event: 'PostToolUse' }),
        JSON.stringify({ tool: 'Bash', command: { preview: 'git status' }, event: 'PostToolUse' }),
        'not json at all',
        JSON.stringify({ tool: 'MultiEdit', file: { path: 'legacy-shape.cjs' }, event: 'PostToolUse' }),
      ].join('\n'), 'utf8');
      const scope = planAccuracy.actualScopeFromLedger(sessionId);
      assert.equal(scope.available, true);
      assert.equal(scope.count, 3, `expected 3 distinct written files, got ${scope.count}: ${scope.files}`);
      assert.ok(!scope.files.some((f) => f.includes('git')), 'shell commands must not count as scope');

      // ── 4. 对账: 有 delivery 信号时按信号判定 ──
      // 时间戳必须显式给。默认走 datetime('now'), 于是"未来 windowStart 排除一切行"
      // 这个前提会在真实时间跨过该点的当天失效 —— 3b 的 inconclusive 断言 2026-08-02
      // 就是这么从内部塌掉的, 而 plan-accuracy.cjs 一行没错。
      const DELIVERED_AT = NOW - 12 * 3600_000;   // 落在 windowStart(NOW-DAY) 之内
      delivery.recordDelivery({ workflow: 'verification-gate', phase: 'verification', status: 'pass', timestamp: DELIVERED_AT }, { db });
      delivery.recordDelivery({ workflow: 'verification-gate', phase: 'verification', status: 'pass', timestamp: DELIVERED_AT }, { db });
      const onPlan = planAccuracy.reconcile(snapshot, {
        db, sessionId, now: NOW + DAY, windowStart: NOW - DAY, actualScope: { count: 4, available: true, source: 'test' },
      });
      assert.equal(onPlan.deliveryPass, 2, 'delivery rows inside the window must be counted');
      assert.equal(onPlan.scopeDrift, 0, 'matching scope must report zero drift');
      assert.equal(onPlan.verdict, 'on-plan');

      // 范围严重偏离 → scope-drift
      const drifted = planAccuracy.reconcile(snapshot, {
        db, sessionId, now: NOW + 2 * DAY, windowStart: NOW - DAY, actualScope: { count: 12, available: true, source: 'test' },
      });
      assert.equal(drifted.verdict, 'scope-drift', `expected scope-drift, got ${drifted.verdict} (drift=${drifted.scopeDrift})`);

      // ── 3b. 缺一切客观信号 → inconclusive, 绝不算 on-plan ──
      const blind = planAccuracy.reconcile(snapshot, {
        db, sessionId: 'no-such-session', now: NOW + 3 * DAY, windowStart: NOW + 3 * DAY,
        actualScope: { count: 0, available: false },
      });
      assert.equal(blind.verdict, 'inconclusive');

      // ── 5. delivery 窗口成功率口径 ──
      const rows = [
        { status: 'pass', timestamp: '2026-07-29 00:00:00' },
        { status: 'fail', timestamp: '2026-07-29 00:00:00' },
        { status: 'partial', timestamp: '2026-07-29 00:00:00' },
        { status: 'pass', timestamp: '2026-05-01 00:00:00' },
      ];
      const summary = delivery.summarizeDeliveries(rows, { windowDays: 30, now: NOW });
      assert.equal(summary.events, 3, 'records outside the window must be excluded');
      assert.equal(summary.overall.successRate, 0.5, 'partial must not enter the success-rate denominator');
      const allTime = delivery.summarizeDeliveries(rows, { windowDays: 0, now: NOW });
      assert.equal(allTime.events, 4, 'windowDays=0 means all time');

      // ── 6. hdl-evidence-gate 阶段判定 → delivery 记录 ──
      // 落库分支受三个环境守卫保护 (套件会同时设上三个)。本段验证的是**落库映射**,
      // 因此显式解除守卫再断言, 守卫本身的效力在第 7 段单独验证。
      const GUARDS = ['CLAUDE_HARNESS_NO_PERSIST', 'CLAUDE_HARNESS_VERIFY_READONLY', 'CLAUDE_NO_DIAGNOSTIC_WRITES'];
      const savedGuards = Object.fromEntries(GUARDS.map((key) => [key, process.env[key]]));
      const restoreGuards = () => {
        for (const key of GUARDS) {
          if (savedGuards[key] === undefined) delete process.env[key];
          else process.env[key] = savedGuards[key];
        }
      };
      for (const key of GUARDS) delete process.env[key];
      const before = Number(db.prepare('SELECT COUNT(*) AS n FROM delivery_events').get().n);
      const recorded = evidenceGate.recordPhaseDelivery(
        { ok: false, failures: ['mod_a: evidence JSON not found'] },
        { projectRoot: tmp, arch: false, modules: ['mod_a'] },
        { db },
      );
      assert.equal(recorded.skipped, false);
      assert.equal(recorded.phase, 'P4.5', 'module evidence maps to the P4.5 phase');
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM delivery_events').get().n), before + 1,
        'the module evidence verdict must land as a delivery row');
      const phaseRow = db.prepare(
        "SELECT phase, status, workflow_name FROM delivery_events WHERE phase = 'P4.5' ORDER BY id DESC LIMIT 1",
      ).get();
      assert.equal(phaseRow.status, 'fail');
      assert.equal(phaseRow.workflow_name, 'hdl-coding-dag-workflow');
      const archRecorded = evidenceGate.recordPhaseDelivery(
        { ok: true, failures: [] }, { projectRoot: tmp, arch: true, modules: [] }, { db },
      );
      assert.equal(archRecorded.phase, 'P1b', 'architecture evidence maps to the P1b phase');

      // ── 7. 环境守卫: 三个守卫任一为 1 都必须完全跳过落库 ──
      for (const guard of GUARDS) {
        for (const key of GUARDS) delete process.env[key];
        process.env[guard] = '1';
        const skipped = planAccuracy.harvestPlanAccuracy({ db, sessionId });
        assert.equal(skipped.skipped, true, `${guard} must disable plan-accuracy harvesting`);
        assert.equal(skipped.reason, 'persistence-disabled');
        const guarded = evidenceGate.recordPhaseDelivery(
          { ok: true, failures: [] }, { projectRoot: tmp, arch: true, modules: [] }, { db },
        );
        assert.equal(guarded.skipped, true, `${guard} must disable evidence-gate delivery recording`);
      }
      restoreGuards();

      // ── 报告口径 ──
      const report = planAccuracy.report({ db, now: NOW + 4 * DAY, windowDays: 30 });
      assert.equal(report.available, true);
      assert.equal(report.snapshots, 1);
      assert.ok(report.reconciliations >= 3, `expected >=3 reconciliations, got ${report.reconciliations}`);
      assert.ok(report.onPlanRate !== null, 'onPlanRate must be computable once verdicts exist');
      restoreGuards();
    } finally {
      if (createdRunDir) { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* cleanup */ } }
    }

    console.log('plan-accuracy-contract: all assertions passed');
  } finally {
    try { handle.close(); } catch { /* cleanup */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

main();
