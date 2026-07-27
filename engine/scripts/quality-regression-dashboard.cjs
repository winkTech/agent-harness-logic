#!/usr/bin/env node
/**
 * engine/scripts/quality-regression-dashboard.cjs — 质量退化仪表盘
 *
 * 🔍 P2-2: 质量退化仪表盘
 * 参照: [6] LangSmith — 追踪 + 可观测性
 *
 * 跨 session 追踪质量指标趋势:
 *   - Fmax (若有时序报告)
 *   - 资源使用 (LUT/DSP/BRAM)
 *   - 错误率
 *   - hook 拦截率
 *   - 交付通过率
 *
 * 用法:
 *   node engine/scripts/quality-regression-dashboard.cjs record --metric=fmax --value=250 --unit=MHz
 *   node engine/scripts/quality-regression-dashboard.cjs record --metric=lut --value=1234 --project=ofdm
 *   node engine/scripts/quality-regression-dashboard.cjs report [--json]
 *   node engine/scripts/quality-regression-dashboard.cjs trend --metric=fmax --days=30
 */

'use strict';

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = HARNESS_ROOT;
const DB_FILE = path.join(HOME, 'var', 'quality-metrics.json');
const MAX_HISTORY = 200;

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// ── 数据存储 ────────────────────────────────────────────────────────────────

function readMetrics() {
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeMetrics(metrics) {
  ensureDir(path.dirname(DB_FILE));
  // 保留最近 MAX_HISTORY 条
  if (metrics.length > MAX_HISTORY) metrics = metrics.slice(metrics.length - MAX_HISTORY);
  fs.writeFileSync(DB_FILE, JSON.stringify(metrics, null, 2), 'utf8');
}

// ── 指标定义 ─────────────────────────────────────────────────────────────────

const METRICS = {
  fmax:             { unit: 'MHz', desc: '最大时钟频率', higher: true },
  lut:              { unit: '',     desc: 'LUT 使用',     higher: false },
  dsp:              { unit: '',     desc: 'DSP 使用',     higher: false },
  bram:             { unit: '',     desc: 'BRAM 使用',    higher: false },
  error_rate:       { unit: '%',    desc: '错误率',       higher: false },
  hook_block_rate:  { unit: '%',    desc: 'Hook 拦截率',  higher: false },
  delivery_pass:    { unit: '%',    desc: '交付通过率',   higher: true },
  module_count:     { unit: '',     desc: '模块数',       higher: false },
  retry_count:      { unit: '',     desc: '重试次数',     higher: false },
};

// ── 记录 ────────────────────────────────────────────────────────────────────

function recordMetric(args) {
  const metric = args.metric || 'unknown';
  const value = parseFloat(args.value);
  const unit = args.unit || METRICS[metric]?.unit || '';
  const project = args.project || path.basename(process.cwd());

  if (isNaN(value)) {
    console.error('[quality-dashboard] 无效 value，必须为数字');
    return;
  }

  if (!METRICS[metric]) {
    console.warn(`[quality-dashboard] ⚠️  未知指标 "${metric}"，已知: ${Object.keys(METRICS).join(', ')}`);
  }

  const entry = {
    metric,
    value,
    unit,
    project,
    timestamp: new Date().toISOString(),
    sessionId: process.env.CLAUDE_SESSION_ID || 'unknown',
    note: args.note || '',
  };

  const metrics = readMetrics();
  metrics.push(entry);
  writeMetrics(metrics);

  console.log(`[quality-dashboard] ✅ ${metric}=${value}${unit} (${project})`);
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function generateReport(jsonOutput) {
  const metrics = readMetrics();
  if (metrics.length === 0) {
    console.log('[quality-dashboard] 暂无数据。运行 record 命令记录指标。');
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      totalRecords: metrics.length,
      generatedAt: new Date().toISOString(),
      metrics,
      summary: computeSummary(metrics),
    }, null, 2));
    return;
  }

  const summary = computeSummary(metrics);

  console.log('\n━━━ 质量退化仪表盘 ━━━');
  console.log(`📊 总记录数: ${metrics.length}`);
  console.log('');

  for (const [name, info] of Object.entries(summary.byMetric)) {
    const arrow = METRICS[name]?.higher ? '↑(好)' : '↓(好)';
    console.log(`  ${name.padEnd(14)} ${info.count}次  ${arrow}`);
    if (info.count >= 2) {
      const diff = info.latest - info.avg;
      const sigil = diff > 0 ? (METRICS[name]?.higher ? '🟢' : '🔴') : (METRICS[name]?.higher ? '🔴' : '🟢');
      console.log(`                最新: ${info.latest}${METRICS[name]?.unit || ''}  |  平均: ${info.avg.toFixed(1)}${METRICS[name]?.unit || ''}  ${sigil} ${diff > 0 ? '+' : ''}${diff.toFixed(1)}`);
    } else {
      console.log(`                最新: ${info.latest}${METRICS[name]?.unit || ''}  (需更多数据)`);
    }
  }

  if (summary.degradations.length > 0) {
    console.log('\n⚠️  退化警报:');
    for (const d of summary.degradations) {
      console.log(`  🔴 ${d.metric}: ${d.prev} → ${d.current} (${d.change > 0 ? '+' : ''}${d.change.toFixed(1)})`);
    }
  }

  if (summary.improvements.length > 0) {
    console.log('\n🟢 改进:');
    for (const d of summary.improvements) {
      console.log(`  🟢 ${d.metric}: ${d.prev} → ${d.current} (${d.change > 0 ? '+' : ''}${d.change.toFixed(1)})`);
    }
  }

  console.log('');
}

function computeSummary(metrics) {
  const byMetric = {};
  for (const m of metrics) {
    if (!byMetric[m.metric]) byMetric[m.metric] = [];
    byMetric[m.metric].push(m.value);
  }

  const result = { byMetric: {}, degradations: [], improvements: [] };

  for (const [name, values] of Object.entries(byMetric)) {
    const latest = values[values.length - 1];
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    result.byMetric[name] = { count: values.length, latest, avg };

    // 检测退化: 最近 3 个 vs 之前所有
    if (values.length >= 5) {
      const recent = values.slice(-3);
      const prev = values.slice(0, -3);
      const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
      const prevAvg = prev.reduce((s, v) => s + v, 0) / prev.length;
      const change = recentAvg - prevAvg;
      const meta = METRICS[name] || { higher: true };

      if (Math.abs(change / (prevAvg || 1)) > 0.1) { // 10% 变化
        const entry = { metric: name, prev: prevAvg.toFixed(1), current: recentAvg.toFixed(1), change };
        if (meta.higher ? change < 0 : change > 0) {
          result.degradations.push(entry);
        } else {
          result.improvements.push(entry);
        }
      }
    }
  }

  return result;
}

// ── 趋势 ────────────────────────────────────────────────────────────────────

function showTrend(args) {
  const metricName = args.metric;
  const days = parseInt(args.days) || 30;

  if (!metricName) {
    console.error('[quality-dashboard] 需指定 --metric');
    return;
  }

  const metrics = readMetrics();
  const filtered = metrics.filter(m => m.metric === metricName);

  if (filtered.length === 0) {
    console.log(`[quality-dashboard] 指标 "${metricName}" 无数据`);
    return;
  }

  // 按时间分组 (天)
  const byDay = {};
  for (const m of filtered) {
    const day = m.timestamp.slice(0, 10);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(m.value);
  }

  const sortedDays = Object.keys(byDay).sort().slice(-days);

  console.log(`\n📈 ${metricName} (${METRICS[metricName]?.desc || ''}) 趋势 [最近 ${days} 天]:`);
  console.log('');

  const values = sortedDays.map(d => {
    const vals = byDay[d];
    return { day: d, avg: vals.reduce((s, v) => s + v, 0) / vals.length };
  });

  if (values.length === 0) return;

  const maxVal = Math.max(...values.map(v => v.avg));
  const minVal = Math.min(...values.map(v => v.avg));
  const range = maxVal - minVal || 1;
  const barWidth = 30;

  for (const v of values) {
    const barLen = Math.round((v.avg - minVal) / range * barWidth);
    const bar = '█'.repeat(Math.max(1, barLen));
    console.log(`  ${v.day} ${bar} ${v.avg.toFixed(1)}${METRICS[metricName]?.unit || ''}`);
  }
  console.log('');
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const cmd = process.argv[2];
  const args = {};

  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.replace(/^--/, '').split('=');
      args[k] = v || true;
    }
  }

  switch (cmd) {
    case 'record':
      recordMetric(args);
      break;
    case 'report':
      generateReport(args.json);
      break;
    case 'trend':
      showTrend(args);
      break;
    default:
      console.log(`
用法:
  node engine/scripts/quality-regression-dashboard.cjs record --metric=<name> --value=<n> [--unit=MHz] [--project=ofdm]
  node engine/scripts/quality-regression-dashboard.cjs report [--json]
  node engine/scripts/quality-regression-dashboard.cjs trend --metric=fmax --days=30

指标:
  fmax, lut, dsp, bram, error_rate, hook_block_rate, delivery_pass, module_count, retry_count
`);
  }
}

main();
