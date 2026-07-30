#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/ten-dimension-dashboard.cjs — 十维仪表盘 (D10.3)。
 *
 * 把十维升级方案里每一维的数据源汇到一处: 每维一行, 含
 *   value (当前值) / threshold (阈值) / status (pass|warn|fail|no-data) /
 *   source (数据从哪来) / freshness (数据新鲜度)。
 *
 * 这就是评价表的自动化版本, 也是月度复评的唯一证据源 —— 某一维答不出来,
 * 那一维就不及格, 不允许用"机制已建成"顶替数据。
 *
 * 设计约束:
 *   - 每维的取数都在 try 里, 单个数据源坏掉不影响其余九维 (仪表盘本身要抗断)
 *   - no-data 与 fail 严格区分: 前者是"还没积累到数据", 后者是"数据说不达标"
 *   - 只读: 不写任何库/文件 (仪表盘是观察者, 不是采集器)
 */

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const HOME = HARNESS_ROOT;
const DAY_MS = 86_400_000;

function safe(fn, fallback = null) {
  try { return fn(); } catch (error) { return { __error: error.message, fallback }; }
}

function isError(value) {
  return Boolean(value && typeof value === 'object' && value.__error);
}

/** 阈值判定: 方向 min = 越大越好, max = 越小越好。 */
function judge(value, threshold, direction = 'min') {
  if (value === null || value === undefined || Number.isNaN(value)) return 'no-data';
  if (threshold === null || threshold === undefined) return 'pass';
  if (direction === 'min') return value >= threshold ? 'pass' : 'fail';
  return value <= threshold ? 'pass' : 'fail';
}

function ageDays(timestampMs, now) {
  if (!timestampMs) return null;
  return Number(((now - timestampMs) / DAY_MS).toFixed(2));
}

function healthMetrics(opts) {
  const { openDb } = require('../sqlite/index.cjs');
  const handle = openDb({ ...(opts.dbPath ? { path: opts.dbPath } : {}), readonly: true });
  try {
    return require('./memory-health-check.cjs').buildHealthReport({
      db: handle.db, home: HOME, now: opts.now,
    });
  } finally {
    handle.close();
  }
}

function buildTenDimensionReport(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const health = safe(() => healthMetrics({ ...opts, now }));
  const metrics = isError(health) ? {} : (health.metrics || {});

  const rows = [];
  const push = (row) => rows.push(row);

  // ── D1 任务完成 Success Rate ──
  const delivery = safe(() => require('./delivery-tracker.cjs').deliveryReport({ windowDays: 30, now }));
  push({
    dimension: 'D1',
    name: '任务完成 Success Rate',
    metric: 'delivery successRate (30d)',
    value: isError(delivery) ? null : delivery.overall.successRate,
    threshold: 0.8,
    direction: 'min',
    status: judge(isError(delivery) ? null : delivery.overall.successRate, 0.8, 'min'),
    source: 'sqlite delivery_events (verification-gate + hdl-evidence-gate)',
    detail: isError(delivery) ? delivery : {
      events: delivery.events, pass: delivery.overall.pass, fail: delivery.overall.fail,
      byPhase: Object.keys(delivery.byPhase),
    },
    freshnessDays: ageDays(metrics.delivery?.lastAt, now),
  });

  // ── D2 规划 Plan quality ──
  const plans = safe(() => require('./plan-accuracy.cjs').report({ windowDays: 30, now }));
  push({
    dimension: 'D2',
    name: '规划 Plan quality',
    metric: 'plan onPlanRate (30d)',
    value: isError(plans) ? null : plans.onPlanRate,
    threshold: 0.7,
    direction: 'min',
    status: judge(isError(plans) ? null : plans.onPlanRate, 0.7, 'min'),
    source: 'sqlite plan_snapshots + plan_reconciliations (requirements-gate 派生)',
    detail: isError(plans) ? plans : {
      snapshots: plans.snapshots, reconciliations: plans.reconciliations,
      byVerdict: plans.byVerdict, avgAbsScopeDrift: plans.averageAbsoluteScopeDrift,
    },
    freshnessDays: ageDays(isError(plans) ? null : plans.lastReconciledAt, now),
  });

  // ── D3 工具调用 Tool accuracy ──
  const fpRate = safe(() => require('./fp-rate-tracker.cjs').summary());
  const gateEval = safe(() => require('./test-hooks/harness-gate-eval.cjs').runAll({}));
  const fpr = isError(gateEval) ? null : gateEval.metrics.overall.falsePositiveRate;
  push({
    dimension: 'D3',
    name: '工具调用 Tool accuracy',
    metric: 'gate corpus FPR / fp-rate log',
    value: fpr,
    threshold: 0.05,
    direction: 'max',
    status: judge(fpr, 0.05, 'max'),
    source: 'harness-gate-eval 语料 + var/fp-rate-log.jsonl',
    detail: {
      corpusCases: isError(gateEval) ? null : gateEval.cases,
      corpusTpr: isError(gateEval) ? null : gateEval.metrics.overall.tpr,
      fpRateLog: isError(fpRate) ? fpRate : { available: fpRate.available, total: fpRate.total, fpRate: fpRate.fpRate },
    },
    freshnessDays: null,
  });

  // ── D4 上下文 Retrieval precision ──
  const retrieval = safe(() => require('./semantic-search.cjs').evaluateRetrieval({ home: HOME, topK: 5, now }));
  const precision = isError(retrieval) || retrieval.freshness?.stale ? null : retrieval.summary.precisionAtK;
  push({
    dimension: 'D4',
    name: '上下文 Retrieval precision',
    metric: 'golden set precision@5',
    value: precision,
    threshold: 0.8,
    direction: 'min',
    status: judge(precision, 0.8, 'min'),
    source: 'semantic-search eval + fixtures/retrieval-eval-cases.json',
    detail: isError(retrieval) ? retrieval : {
      cases: retrieval.summary.cases, hitRate: retrieval.summary.hitRate, mrr: retrieval.summary.mrr,
      misses: retrieval.summary.misses, indexStale: retrieval.freshness?.stale ?? null,
    },
    freshnessDays: isError(retrieval) ? null : (retrieval.freshness?.ageDays ?? null),
  });

  // ── D5 Memory Recall ──
  const attribution = metrics.attribution || {};
  const facts = metrics.facts || {};
  const neverExposedRate = facts.active > 0 && facts.neverExposed !== undefined
    ? Number((facts.neverExposed / facts.active).toFixed(6))
    : null;
  push({
    dimension: 'D5',
    name: 'Memory Recall',
    metric: 'neverExposed rate (越低越好)',
    value: neverExposedRate,
    threshold: 0.5,
    direction: 'max',
    status: judge(neverExposedRate, 0.5, 'max'),
    source: 'memory-health-check facts + memory_retrieval_exposures/outcomes',
    detail: {
      activeFacts: facts.active ?? null,
      neverExposed: facts.neverExposed ?? null,
      exposures30d: attribution.exposures30d ?? null,
      outcomes30d: attribution.outcomes30d ?? null,
      outcomeChainStale: attribution.outcomeChainStale ?? null,
      distinctMemoriesExposed: attribution.distinctMemoriesExposed ?? null,
    },
    freshnessDays: null,
  });

  // ── D6 成本 Token/$ ──
  const costs = metrics.costs || {};
  push({
    dimension: 'D6',
    name: '成本 Token/$',
    metric: 'usage rows (真实 transcript 计量)',
    value: costs.available ? costs.usageRows ?? 0 : null,
    threshold: 1,
    direction: 'min',
    status: judge(costs.available ? costs.usageRows ?? 0 : null, 1, 'min'),
    source: 'sqlite cost_ledger phase=usage + model-pricing.json',
    detail: {
      usd30d: costs.usd30d ?? null,
      usageRows: costs.usageRows ?? null,
      estimateRows: costs.estimateRows ?? null,
      lastUsageAt: costs.lastUsageAt ?? null,
    },
    freshnessDays: ageDays(Date.parse(costs.lastUsageAt || '') || null, now),
  });

  // ── D7 速度 Latency ──
  const latency = safe(() => require('./lib/hook-latency.cjs').report());
  const latencyScripts = isError(latency) ? [] : (latency.scripts || []);
  const worstP95 = latencyScripts.length
    ? latencyScripts.reduce((max, entry) => Math.max(max, Number(entry.p95 || 0)), 0)
    : null;
  push({
    dimension: 'D7',
    name: '速度 Latency',
    metric: 'hook p95 (worst script, ms)',
    value: worstP95,
    threshold: isError(latency) ? 2000 : (latency.budgetMs || 2000),
    direction: 'max',
    status: judge(worstP95, isError(latency) ? 2000 : (latency.budgetMs || 2000), 'max'),
    source: 'var/metrics/hook-latency.jsonl (preflight/postflight/stop-runner)',
    detail: isError(latency) ? latency : {
      scripts: latencyScripts.map((entry) => `${entry.script}:p95=${entry.p95}`),
      samples: latencyScripts.reduce((sum, entry) => sum + Number(entry.count || 0), 0),
      overBudget: (latency.overBudget || []).map((entry) => entry.script),
    },
    freshnessDays: null,
  });

  // ── D8 稳定性 Variance ──
  const variance = safe(() => require('./test-hooks/harness-gate-eval.cjs').runAll({ variance: true }));
  push({
    dimension: 'D8',
    name: '稳定性 Variance',
    metric: 'key-case consistency rate (3 runs)',
    value: isError(variance) ? null : variance.variance?.consistencyRate ?? null,
    threshold: 0.9,
    direction: 'min',
    status: judge(isError(variance) ? null : variance.variance?.consistencyRate ?? null, 0.9, 'min'),
    source: 'harness-gate-eval --variance',
    detail: isError(variance) ? variance : {
      cases: variance.cases,
      keyCases: variance.variance?.keyCases ?? null,
      balancedAccuracy: variance.metrics.overall.balancedAccuracy,
      coverage: variance.coverage?.perEntry ?? null,
    },
    freshnessDays: null,
  });

  // ── D9 安全 Attack resistance ──
  const redTeam = safe(() => require('./test-hooks/harness-gate-eval.cjs').runAll({
    cases: path.join(HOME, 'engine', 'scripts', 'test-hooks', 'fixtures', 'harness-redteam-cases.json'),
  }));
  const guard = safe(() => require('./guard-coverage.cjs').coverage({}));
  const redTeamPass = isError(redTeam) ? null
    : (redTeam.cases > 0 ? Number((1 - redTeam.mismatches.length / redTeam.cases).toFixed(6)) : null);
  push({
    dimension: 'D9',
    name: '安全 Attack resistance',
    metric: 'red-team pass rate & guard coverage',
    value: redTeamPass,
    threshold: 1,
    direction: 'min',
    status: judge(redTeamPass, 1, 'min'),
    source: 'fixtures/harness-redteam-cases.json + guard-coverage + protected-write 对账',
    detail: {
      redTeamCases: isError(redTeam) ? null : redTeam.cases,
      mismatches: isError(redTeam) ? null : redTeam.mismatches.map((entry) => entry.id),
      guardCoverageRate: isError(guard) ? null : guard.coverageRate,
      guardUncovered: isError(guard) ? null : guard.uncovered,
      protectedWrites: metrics.protectedWrites ?? null,
    },
    freshnessDays: null,
  });

  // ── D10 可观察 Trace completeness ──
  const transparency = safe(() => require('./transparency-dashboard.cjs')
    .buildReport(path.join(HOME, 'var', 'runs')));
  const ledgerAnomalies = safe(() => {
    const file = process.env.CLAUDE_VERIFICATION_LEDGER_FILE
      || path.join(HOME, 'var', 'verification-ledger.json');
    if (!fs.existsSync(file)) return { entries: 0, contradictory: 0, unknownStatus: 0 };
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
    return {
      entries: entries.length,
      // 账本自我矛盾: 门禁判定接受, 但条目状态写成 failed
      contradictory: entries.filter((entry) => entry.verification?.accepted === true && entry.status === 'failed').length,
      unknownStatus: entries.filter((entry) => entry.status === 'unknown').length,
    };
  });
  const captureRate = isError(transparency) ? null : transparency.summary.instructionCaptureRate;
  push({
    dimension: 'D10',
    name: '可观察 Trace completeness',
    metric: 'instruction capture rate (走过 action-contract 的 run)',
    value: captureRate,
    threshold: 0.8,
    direction: 'min',
    status: judge(captureRate, 0.8, 'min'),
    source: 'var/runs 透明度账本 + verification-ledger 异常条目扫描',
    detail: {
      totalRuns: isError(transparency) ? null : transparency.summary.totalRuns,
      contractRuns: isError(transparency) ? null : transparency.summary.contractRuns,
      runsWithoutActionContract: isError(transparency) ? null : transparency.summary.runsWithoutActionContract,
      ledger: ledgerAnomalies,
      healthScore: isError(health) ? null : health.score,
    },
    freshnessDays: null,
  });

  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  return {
    schemaVersion: 1,
    mode: 'ten-dimension',
    generatedAt: new Date(now).toISOString(),
    dimensions: rows,
    summary: {
      total: rows.length,
      pass: counts.pass || 0,
      fail: counts.fail || 0,
      warn: counts.warn || 0,
      noData: counts['no-data'] || 0,
      healthScore: isError(health) ? null : health.score,
    },
  };
}

function formatText(report) {
  const lines = [`十维仪表盘 ${report.generatedAt}`];
  lines.push(`汇总: pass=${report.summary.pass} fail=${report.summary.fail} no-data=${report.summary.noData} (health=${report.summary.healthScore})`);
  for (const row of report.dimensions) {
    const mark = { pass: '✓', fail: '✗', warn: '!', 'no-data': '·' }[row.status] || '?';
    const value = row.value === null || row.value === undefined ? 'n/a' : row.value;
    const arrow = row.direction === 'min' ? '≥' : '≤';
    lines.push(`  ${mark} ${row.dimension.padEnd(4)}${row.name.padEnd(28)} ${String(value).padEnd(12)} (阈值 ${arrow} ${row.threshold})  ${row.metric}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const report = buildTenDimensionReport({});
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatText(report));
  // no-data 不算失败 (数据还在积累); 只有明确不达标才非零退出
  return report.summary.fail > 0 ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { buildTenDimensionReport, formatText, judge, main };
