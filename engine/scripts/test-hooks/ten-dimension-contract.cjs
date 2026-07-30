#!/usr/bin/env node
'use strict';

/**
 * ten-dimension-contract.cjs — 十维仪表盘契约 (D10.3)。
 *
 * 仪表盘是月度复评的**唯一证据源**, 所以它自己的性质要被锁住:
 *   1. 十维全在, 每维都有 metric / threshold / source / status 四件套
 *   2. no-data 与 fail 严格区分 (没积累到数据 ≠ 数据说不达标)
 *   3. 单个数据源坏掉不影响其余维度 (仪表盘抗断)
 *   4. 判定函数的方向语义正确 (min = 越大越好, max = 越小越好)
 *   5. 只读: 运行仪表盘不得写库/写文件
 *   6. delivery 口径: "判定不可读"落 partial, 不进成功率分母 (否则度量的是
 *      有没有用管道截断输出, 而不是交付质量)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.CLAUDE_HARNESS_NO_PERSIST = '1';

const dashboard = require(path.join(ROOT, 'engine/scripts/ten-dimension-dashboard.cjs'));
const postflight = require(path.join(ROOT, 'engine/scripts/hooks/postflight-router.cjs'));

const REQUIRED_DIMENSIONS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10'];

function main() {
  // ── 4. 判定方向语义 ──
  assert.equal(dashboard.judge(0.9, 0.8, 'min'), 'pass');
  assert.equal(dashboard.judge(0.7, 0.8, 'min'), 'fail');
  assert.equal(dashboard.judge(0.01, 0.05, 'max'), 'pass');
  assert.equal(dashboard.judge(0.2, 0.05, 'max'), 'fail');
  assert.equal(dashboard.judge(null, 0.8, 'min'), 'no-data', 'missing data must never be reported as pass');
  assert.equal(dashboard.judge(undefined, 0.8, 'max'), 'no-data');
  assert.equal(dashboard.judge(0, 0.05, 'max'), 'pass', 'zero must be a real value, not treated as missing');

  // ── 5. 只读: 用哨兵路径判定, 而不是比生产文件的 mtime ──
  // 生产文件可能被别的进程并发写, mtime 比对会变成不稳定断言。改为把证据账本
  // 指到一个不存在的临时路径: 仪表盘若在取数过程中触发了任何证据写入, 该文件
  // 就会被创建。这同时锁住 2026-07-30 的真实缺陷 —— 账本路径曾在模块加载时
  // 固化, 于是评测执行器把合成判定写进了生产账本。
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ten-dim-sentinel-'));
  const sentinelLedger = path.join(sentinelDir, 'verification-ledger.json');
  const savedLedgerEnv = process.env.CLAUDE_VERIFICATION_LEDGER_FILE;
  process.env.CLAUDE_VERIFICATION_LEDGER_FILE = sentinelLedger;
  let report;
  try {
    report = dashboard.buildTenDimensionReport({});
    assert.equal(fs.existsSync(sentinelLedger), false,
      'the dashboard (and the evaluators it runs) must not write verification evidence');
  } finally {
    if (savedLedgerEnv === undefined) delete process.env.CLAUDE_VERIFICATION_LEDGER_FILE;
    else process.env.CLAUDE_VERIFICATION_LEDGER_FILE = savedLedgerEnv;
    try { fs.rmSync(sentinelDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  }

  // ── 1. 十维齐全且字段完整 ──
  assert.equal(report.dimensions.length, 10);
  assert.deepEqual(report.dimensions.map((row) => row.dimension), REQUIRED_DIMENSIONS);
  for (const row of report.dimensions) {
    assert.ok(row.name, `${row.dimension}: name is required`);
    assert.ok(row.metric, `${row.dimension}: metric is required`);
    assert.ok(row.source, `${row.dimension}: 数据源必须写明, 否则这一维不可复核`);
    assert.ok(['min', 'max'].includes(row.direction), `${row.dimension}: direction must be min or max`);
    assert.ok(['pass', 'fail', 'warn', 'no-data'].includes(row.status), `${row.dimension}: bad status ${row.status}`);
    assert.ok(row.threshold !== undefined, `${row.dimension}: threshold is required`);
    assert.ok(row.detail && typeof row.detail === 'object', `${row.dimension}: detail is required`);
  }

  // ── 2. 汇总计数与逐维状态一致 ──
  const counted = report.dimensions.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  assert.equal(report.summary.pass, counted.pass || 0);
  assert.equal(report.summary.fail, counted.fail || 0);
  assert.equal(report.summary.noData, counted['no-data'] || 0);
  assert.equal(report.summary.total, 10);

  // ── 3. 抗断: 文本渲染对缺值维度也不能抛 ──
  const text = dashboard.formatText({
    generatedAt: 'x',
    summary: { pass: 0, fail: 0, noData: 1, healthScore: null },
    dimensions: [{
      dimension: 'D1', name: 'x', metric: 'm', value: null, threshold: 0.8,
      direction: 'min', status: 'no-data', source: 's', detail: {},
    }],
  });
  assert.ok(text.includes('n/a'), 'missing values must render as n/a rather than crash');

  // ── 6. delivery 口径: 不可读判定 → partial ──
  const recorded = [];
  const deps = { deliveryTracker: { recordDelivery: (args) => { recorded.push(args); return true; } } };
  // 落库分支受三个环境守卫保护 (套件会同时设上三个)。本段要验证的是**状态映射**,
  // 因此临时全部解除; recordDelivery 已被注入替换, 不会碰真实库。
  const GUARDS = ['CLAUDE_HARNESS_NO_PERSIST', 'CLAUDE_HARNESS_VERIFY_READONLY', 'CLAUDE_NO_DIAGNOSTIC_WRITES'];
  const savedGuards = Object.fromEntries(GUARDS.map((key) => [key, process.env[key]]));
  for (const key of GUARDS) delete process.env[key];
  const cases = [
    [{ ok: true, reason: 'exit code 0 with explicit PASS evidence' }, 'pass'],
    [{ ok: false, reason: 'no explicit PASS evidence in output' }, 'partial'],
    [{ ok: false, reason: 'verification command produced no log evidence' }, 'partial'],
    [{ ok: false, reason: 'failed test count in output' }, 'fail'],
    [{ ok: false, reason: 'RESULT: FAIL in output' }, 'fail'],
    [{ ok: false, reason: 'command interrupted' }, 'fail'],
  ];
  try {
    for (const [verification, expected] of cases) {
      recorded.length = 0;
      postflight.recordDeliveryFromVerdict({ session_id: 's', cwd: ROOT }, { verification }, deps);
      assert.equal(recorded.length, 1, `no delivery recorded for ${verification.reason}`);
      assert.equal(recorded[0].status, expected,
        `${verification.reason} → expected ${expected}, got ${recorded[0].status}`);
    }
    assert.equal(postflight.UNREADABLE_VERDICT_REASONS.size, 2,
      'the unreadable-verdict family must stay explicit and minimal');

    // 三个守卫任一为 1 都必须跳过落库
    for (const guard of GUARDS) {
      for (const key of GUARDS) delete process.env[key];
      process.env[guard] = '1';
      recorded.length = 0;
      const skipped = postflight.recordDeliveryFromVerdict(
        { session_id: 's', cwd: ROOT }, { verification: { ok: true, reason: 'x' } }, deps,
      );
      assert.equal(skipped.skipped, true, `${guard} must disable delivery recording`);
      assert.equal(recorded.length, 0, `${guard} must not record delivery events`);
    }
  } finally {
    for (const key of GUARDS) {
      if (savedGuards[key] === undefined) delete process.env[key];
      else process.env[key] = savedGuards[key];
    }
  }

  console.log(`ten-dimension-contract: pass=${report.summary.pass} fail=${report.summary.fail} `
    + `no-data=${report.summary.noData}; all assertions passed`);
}

main();
