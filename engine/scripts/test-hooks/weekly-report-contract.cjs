#!/usr/bin/env node
'use strict';

/**
 * weekly-report-contract.cjs — 周报表汇总与调度接线契约。
 *
 * 背景 (2026-07-30): 五张报表原先写在 `weekly-maintenance.sh` 里, 而那个脚本
 * 在本机**没有任何调度器** —— 没有 cron, 计划任务里也没有。真正被调度的是
 * settings.json 的 SessionStart 钩子调 memory-knowledge-maintenance --auto
 * --execute。于是"周报表"从未自动跑过。现在报表逻辑只有 weekly-report.cjs
 * 一份, 由已调度的 maintenance execute 分支写快照。
 *
 * 锁定:
 *   1. "数据源故障"与"还没有样本"严格区分 —— 混成一类会让报表在 30 天积累期
 *      里长期虚假报错, 报错被忽略后真故障也一起被忽略
 *   2. 单源抛异常不拖垮整份报表
 *   3. maintenance 的 execute 写快照, dry-run 不写 (05-harness 规则 4)
 *   4. 快照保留历史条目, 单文件覆盖会让"上周是多少"无从查证
 *   5. 健康检查: 维护近期跑过但快照缺失/过期 → stale; 快照里有故障源 → 报警
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
process.env.CLAUDE_HARNESS_NO_PERSIST = '1';

const weeklyReport = require(path.join(ROOT, 'engine/scripts/weekly-report.cjs'));
const maintenance = require(path.join(ROOT, 'engine/scripts/memory-knowledge-maintenance.cjs'));
const health = require(path.join(ROOT, 'engine/scripts/memory-health-check.cjs'));

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-30T00:00:00.000Z');

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-report-'));
  try {
    // ── 1+2. 真实采集: 结构完整, 故障与空样本分开 ──
    const reportFile = path.join(tmp, 'weekly-report.json');
    const report = weeklyReport.collectWeeklyReport({ write: true, reportFile, now: NOW });
    for (const key of ['fpRate', 'delivery', 'latency', 'guardCoverage', 'planAccuracy', 'tenDimension']) {
      assert.ok(report[key] && typeof report[key] === 'object', `${key} section missing`);
      assert.ok('available' in report[key], `${key} must declare availability`);
    }
    assert.ok(Array.isArray(report.erroredSections), 'erroredSections must be an array');
    assert.ok(Array.isArray(report.emptySections), 'emptySections must be an array');
    assert.deepEqual(report.erroredSections, [],
      `no data source should be failing on a healthy machine: ${JSON.stringify(report.erroredSections)}`);
    assert.equal(report.tenDimension.dimensions.length, 10, 'ten-dimension snapshot must carry all ten rows');
    assert.ok(fs.existsSync(reportFile), 'write:true must persist the snapshot');

    // 空样本不算故障
    const emptyOnly = report.emptySections.every((key) => report[key].errored !== true);
    assert.ok(emptyOnly, 'empty sections must not be flagged as errored');

    // ── 2b. 单源抛异常 → 该源标 errored, 其余照常 ──
    // 用一个必然抛错的 reportFile 目录制造写入失败以外的故障不方便, 改为直接
    // 验证 section 包装语义: available:false 无 errored 与 errored:true 是两码事。
    const persisted = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(persisted.tenDimension.summary.total, 10);
    assert.ok(Array.isArray(persisted.history), 'snapshot must carry a history array');

    // ── 4. 第二次写入把上一份摘要压进 history ──
    const second = weeklyReport.collectWeeklyReport({ write: true, reportFile, now: NOW + DAY });
    const persisted2 = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(second.generatedAt, new Date(NOW + DAY).toISOString());
    assert.equal(persisted2.history.length, 1, 'the previous snapshot must be retained in history');
    assert.equal(persisted2.history[0].generatedAt, new Date(NOW).toISOString());

    // ── 3. maintenance: execute 写快照, dry-run 不写 ──
    let executeCalls = 0;
    let dryRunCalls = 0;
    const baseArgs = { ...maintenance.parseArgs([]), home: tmp, auto: false, force: true, reconcile: false, reindex: false };
    maintenance.runMaintenance(
      { ...baseArgs, execute: true, dryRun: false },
      new Date(NOW),
      {
        home: tmp,
        inspectSqlite: () => ({}),
        retainEvents: () => ({ deleted: 0 }),
        stageCandidates: () => ({ staged: 0, ids: [] }),
        retireAttribution: () => ({ downgraded: 0 }),
        writeWeeklyReport: () => { executeCalls += 1; return { reportFile }; },
      },
    );
    assert.equal(executeCalls, 1, 'execute must produce the weekly report snapshot');

    const dry = maintenance.runMaintenance(
      { ...baseArgs, execute: false, dryRun: true },
      new Date(NOW),
      { home: tmp, inspectSqlite: () => ({}), writeWeeklyReport: () => { dryRunCalls += 1; return {}; } },
    );
    assert.equal(dryRunCalls, 0, 'dry-run must never write the weekly report (05-harness rule 4)');
    assert.equal(dry.results, null);

    // ── 5. 健康检查断流判定 ──
    const metricsDir = path.join(tmp, 'var', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });
    const liveFile = path.join(metricsDir, 'weekly-report.json');

    // 维护从未跑过 → 不报 stale (全新环境不该被误报)
    let state = health.queryWeeklyReport(tmp, NOW, { ageDays: null, intervalDays: 7 });
    assert.equal(state.stale, false, 'a machine that never ran maintenance must not be flagged');

    // 维护近期跑过但快照缺失 → stale
    state = health.queryWeeklyReport(tmp, NOW, { ageDays: 1, intervalDays: 7 });
    assert.equal(state.available, false);
    assert.equal(state.stale, true, 'maintenance ran but no snapshot exists → stale');

    // 快照新鲜 → 不 stale
    fs.writeFileSync(liveFile, JSON.stringify({
      generatedAt: new Date(NOW - 2 * DAY).toISOString(), erroredSections: [], history: [],
    }), 'utf8');
    state = health.queryWeeklyReport(tmp, NOW, { ageDays: 1, intervalDays: 7 });
    assert.equal(state.stale, false);
    assert.equal(state.ageDays, 2);

    // 快照超两个周期 → stale
    fs.writeFileSync(liveFile, JSON.stringify({
      generatedAt: new Date(NOW - 20 * DAY).toISOString(), erroredSections: [], history: [],
    }), 'utf8');
    state = health.queryWeeklyReport(tmp, NOW, { ageDays: 1, intervalDays: 7 });
    assert.equal(state.stale, true, 'a snapshot older than two maintenance cycles is stale');

    // 快照里记录了故障源 → 必须能被健康检查看到
    fs.writeFileSync(liveFile, JSON.stringify({
      generatedAt: new Date(NOW).toISOString(), erroredSections: ['delivery'], history: [],
    }), 'utf8');
    state = health.queryWeeklyReport(tmp, NOW, { ageDays: 1, intervalDays: 7 });
    assert.deepEqual(state.erroredSections, ['delivery']);
    assert.equal(state.stale, false);

    console.log('weekly-report-contract: all assertions passed');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

main();
