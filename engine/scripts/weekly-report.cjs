#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/weekly-report.cjs — 周报表统一汇总入口。
 *
 * 为什么要这个文件 (2026-07-30): 五张报表原先各自写在 `weekly-maintenance.sh`
 * 里, 而那个 shell 脚本**在本机没有任何调度** —— 没有 cron, 计划任务里也没有。
 * 真正被调度的是 `settings.json` 的 SessionStart 钩子调
 * `memory-knowledge-maintenance.cjs --auto --execute --interval-days 7`。
 * 于是"周报表"实际上从未自动跑过。
 *
 * 现在报表逻辑只有这一份, 两条路径共用:
 *   - 已调度路径: maintenance 的 execute 分支调 collectWeeklyReport({write:true})
 *   - 人工路径:   node engine/scripts/weekly-report.cjs [--json]
 *
 * 硬约束:
 *   - **只读采集**: 除了写自己的快照文件, 不改任何遥测/状态
 *   - 每个数据源独立 try: 单源故障降级为 {available:false, error}, 不拖垮整份报表
 *   - 在 SessionStart 路径里执行, 所以默认不打 stdout (会污染会话上下文)
 */

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const HOME = HARNESS_ROOT;
const REPORT_FILE = path.join(HOME, 'var', 'metrics', 'weekly-report.json');

/**
 * 采集一个数据源。**区分两种"没数据"**:
 *   - 抛异常 = 数据源坏了 (errored), 需要有人看
 *   - 返回 available:false = 数据源正常但还没有样本 (empty), 属于正常积累期
 * 混成一个状态会让周报表在 30 天积累期里一直虚假报错, 报错就会被忽略,
 * 那时真正的故障也一起被忽略了。
 */
function section(name, fn) {
  try {
    const value = fn() || {};
    return { available: value.available !== false, ...value };
  } catch (error) {
    return { available: false, errored: true, error: error.message, section: name };
  }
}

function collectWeeklyReport(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const windowDays = Number(opts.windowDays ?? 30);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    windowDays,
    fpRate: section('fp-rate', () => require('./fp-rate-tracker.cjs').summary()),
    delivery: section('delivery', () => require('./delivery-tracker.cjs').deliveryReport({ windowDays, now })),
    latency: section('latency', () => require('./lib/hook-latency.cjs').report()),
    guardCoverage: section('guard-coverage', () => require('./guard-coverage.cjs').coverage({})),
    planAccuracy: section('plan-accuracy', () => require('./plan-accuracy.cjs').report({ windowDays, now })),
    tenDimension: section('ten-dimension', () => {
      const full = require('./ten-dimension-dashboard.cjs').buildTenDimensionReport({ now });
      // 快照只留判定所需字段, 不把每维的 detail 全量存盘 (报表要能长期累积)
      return {
        summary: full.summary,
        dimensions: full.dimensions.map((row) => ({
          dimension: row.dimension,
          name: row.name,
          metric: row.metric,
          value: row.value,
          threshold: row.threshold,
          direction: row.direction,
          status: row.status,
          freshnessDays: row.freshnessDays ?? null,
        })),
      };
    }),
  };

  const sections = Object.entries(report)
    .filter(([, value]) => value && typeof value === 'object' && 'available' in value);
  report.erroredSections = sections.filter(([, value]) => value.errored === true).map(([key]) => key);
  report.emptySections = sections
    .filter(([, value]) => value.errored !== true && value.available === false)
    .map(([key]) => key);

  if (opts.write) {
    // 保留上一份快照做趋势对照 —— 单文件覆盖会让"上周是多少"无从查证。
    const target = opts.reportFile || REPORT_FILE;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let history = [];
    try {
      const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
      history = Array.isArray(previous.history) ? previous.history : [];
      if (previous.generatedAt) {
        history.push({
          generatedAt: previous.generatedAt,
          tenDimension: previous.tenDimension?.summary ?? null,
          deliverySuccessRate: previous.delivery?.overall?.successRate ?? null,
          planOnPlanRate: previous.planAccuracy?.onPlanRate ?? null,
        });
      }
    } catch { /* 首次写入或旧文件损坏: 从空历史开始 */ }
    fs.writeFileSync(
      target,
      `${JSON.stringify({ ...report, history: history.slice(-26) }, null, 2)}\n`,
      'utf8',
    );
    report.reportFile = target;
  }
  return report;
}

function formatText(report) {
  const lines = [`周报表 ${report.generatedAt} (窗口 ${report.windowDays} 天)`];
  const rate = (value) => (value === null || value === undefined ? 'n/a' : value);
  lines.push(`  交付率        ${rate(report.delivery?.overall?.successRate)} `
    + `(pass=${report.delivery?.overall?.pass ?? '-'} fail=${report.delivery?.overall?.fail ?? '-'} partial=${report.delivery?.overall?.partial ?? '-'})`);
  lines.push(`  门禁误报率    ${rate(report.fpRate?.fpRate)}% (样本 ${report.fpRate?.total ?? 0})`);
  lines.push(`  Hook 延迟     worst p95=${report.latency?.scripts?.[0]?.p95 ?? 'n/a'}ms `
    + `(预算 ${report.latency?.budgetMs ?? '-'}ms, 超预算 ${report.latency?.overBudget?.length ?? 0} 个)`);
  lines.push(`  守卫覆盖率    ${rate(report.guardCoverage?.coverageRate)} `
    + `(未覆盖: ${report.guardCoverage?.uncovered?.join(', ') || '无'})`);
  lines.push(`  规划对账      onPlan=${rate(report.planAccuracy?.onPlanRate)} `
    + `(快照 ${report.planAccuracy?.snapshots ?? 0} / 对账 ${report.planAccuracy?.reconciliations ?? 0})`);
  const ten = report.tenDimension?.summary;
  lines.push(`  十维汇总      pass=${ten?.pass ?? '-'} fail=${ten?.fail ?? '-'} no-data=${ten?.noData ?? '-'} (health=${ten?.healthScore ?? '-'})`);
  for (const row of report.tenDimension?.dimensions || []) {
    if (row.status === 'fail' || row.status === 'no-data') {
      const arrow = row.direction === 'min' ? '≥' : '≤';
      lines.push(`    ${row.status === 'fail' ? '✗' : '·'} ${row.dimension} ${row.name}: ${rate(row.value)} (阈值 ${arrow} ${row.threshold})`);
    }
  }
  if (report.emptySections?.length) {
    lines.push(`  尚无样本 (正常积累中): ${report.emptySections.join(', ')}`);
  }
  if (report.erroredSections?.length) {
    lines.push(`  ⚠️ 数据源故障: ${report.erroredSections.join(', ')}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const report = collectWeeklyReport({
    write: !argv.includes('--no-write'),
    windowDays: argv.includes('--window') ? Number(argv[argv.indexOf('--window') + 1]) : undefined,
  });
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatText(report));
  // 只有**数据源故障**才非零退出; "还没有样本"是正常积累期, 不报错
  return report.erroredSections.length > 0 ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { REPORT_FILE, collectWeeklyReport, formatText, main };
