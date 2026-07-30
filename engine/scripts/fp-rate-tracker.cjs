#!/usr/bin/env node
/**
 * engine/scripts/fp-rate-tracker.cjs — 假阳性/假阴性率追踪器
 *
 * 🔍 P1-1: 假阳性率仪表盘
 * 参照: [7] Brundage et al. — "评估需要关注假阳性/假阴性率"
 *
 * 追踪三道闸门的拦截准确率。人工确认后，记录 gate 判断是否正确。
 *
 * 用法:
 *   node engine/scripts/fp-rate-tracker.cjs init               # 初始化
 *   node engine/scripts/fp-rate-tracker.cjs record --gate=verification --correct=true --note="确实需要验证"
 *   node engine/scripts/fp-rate-tracker.cjs report             # 查看报告
 *   node engine/scripts/fp-rate-tracker.cjs report --json      # JSON 输出
 */

'use strict';

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = HARNESS_ROOT;
const STORE_FILE = path.join(HOME, 'var', 'fp-rate-log.jsonl');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// ── 数据文件结构 ────────────────────────────────────────────────────────────
// 每行 JSON: { gate, action, correct, note, timestamp, sessionId }

const GATES = ['verification', 'commit', 'bash-safety', 'file-protection', 'diff-size', 'resource-budget', 'hdl'];

function init() {
  ensureDir(path.dirname(STORE_FILE));
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, '', 'utf8');
    console.log('[fp-rate-tracker] ✅ 初始化 (空文件)');
  } else {
    const lines = fs.readFileSync(STORE_FILE, 'utf8').trim().split('\n').filter(Boolean);
    console.log(`[fp-rate-tracker] ✅ 已存在, ${lines.length} 条记录`);
  }
}

function record(args) {
  const gate = args.gate || 'unknown';
  const correct = args.correct === 'true' || args.correct === true;
  const action = args.action || 'block';
  const note = args.note || '';

  if (!GATES.includes(gate)) {
    console.warn(`[fp-rate-tracker] ⚠️  未知 gate "${gate}"，已知: ${GATES.join(', ')}`);
  }

  const entry = {
    gate,
    action,
    correct,
    note,
    timestamp: new Date().toISOString(),
    sessionId: process.env.CLAUDE_SESSION_ID || 'unknown',
  };

  ensureDir(path.dirname(STORE_FILE));
  fs.appendFileSync(STORE_FILE, JSON.stringify(entry) + '\n', 'utf8');
  console.log(`[fp-rate-tracker] ✅ 记录: gate=${gate} correct=${correct} action=${action}`);
}

function report(jsonOutput) {
  if (!fs.existsSync(STORE_FILE)) {
    console.log('[fp-rate-tracker] 暂无数据。运行 record 命令添加记录。');
    return;
  }

  const lines = fs.readFileSync(STORE_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const records = lines.map(l => JSON.parse(l));

  if (records.length === 0) {
    console.log('[fp-rate-tracker] 空记录集');
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ records, summary: computeSummary(records), generatedAt: new Date().toISOString() }, null, 2));
    return;
  }

  const summary = computeSummary(records);

  console.log('\n━━━ 假阳性/假阴性率报告 ━━━');
  console.log(`📊 总评估数: ${summary.total}`);
  console.log(`✅ 准确拦截: ${summary.correctBlock}`);
  console.log(`❌ 假阳性:   ${summary.falsePositive} (${summary.fpRate}%) — 不应对的拦截`);
  console.log(`⚠️  假阴性:   ${summary.falseNegative} (${summary.fnRate}%) — 应拦未拦`);
  console.log(`🎯 总准确率:  ${summary.accuracy}%`);
  console.log('');

  if (Object.keys(summary.byGate).length > 0) {
    console.log('按 Gate:');
    for (const [gate, stats] of Object.entries(summary.byGate)) {
      const bar = stats.total > 0 ? '█'.repeat(Math.round(stats.correct / stats.total * 20)) : '';
      console.log(`  ${gate.padEnd(18)} ${bar} ${stats.correct}/${stats.total} (${stats.rate}%)`);
    }
    console.log('');
  }

  if (summary.recent.length > 0) {
    console.log('最近 5 条:');
    for (const r of summary.recent) {
      const icon = r.correct ? '✅' : '❌';
      console.log(`  ${icon} [${r.gate}] ${r.action} — ${r.note.slice(0, 50)} (${r.timestamp.slice(0, 19)})`);
    }
    console.log('');
  }
}

function computeSummary(records) {
  const total = records.length;
  const correctBlock = records.filter(r => r.correct && r.action === 'block').length;

  // 假阳性: block 了但 correct=false (不该拦)
  const falsePositive = records.filter(r => !r.correct && r.action === 'block').length;
  // 假阴性: 未 block 但 correct=false (该拦没拦) — pass 但 wrong
  const falseNegative = records.filter(r => !r.correct && r.action === 'pass').length;
  // 准确: 所有 correct=true 的记录
  const correct = records.filter(r => r.correct).length;

  const fpRate = total > 0 ? (falsePositive / total * 100).toFixed(1) : '0.0';
  const fnRate = total > 0 ? (falseNegative / total * 100).toFixed(1) : '0.0';
  const accuracy = total > 0 ? (correct / total * 100).toFixed(1) : '0.0';

  const byGate = {};
  for (const r of records) {
    if (!byGate[r.gate]) byGate[r.gate] = { total: 0, correct: 0 };
    byGate[r.gate].total++;
    if (r.correct) byGate[r.gate].correct++;
  }
  for (const [gate, stats] of Object.entries(byGate)) {
    stats.rate = stats.total > 0 ? (stats.correct / stats.total * 100).toFixed(1) : '0.0';
  }

  const recent = records.slice(-5).reverse();

  return { total, correctBlock, falsePositive, falseNegative, fpRate, fnRate, accuracy, byGate, recent };
}

/** tool_fail 事件 payload → 门禁归类; 非门禁失败返回 null。 */
function inferGate(payload) {
  const error = String(payload?.error || payload?.stderr || '').toLowerCase();
  if (error.includes('verification gate') || error.includes('verify first')) return 'verification';
  if (error.includes('commit gate') || error.includes('commit-gate')) return 'commit';
  if (error.includes('bash safety') || error.includes('bash-safety')) return 'bash-safety';
  if (error.includes('file protection') || error.includes('file-protection')) return 'file-protection';
  if (error.includes('diff size') || error.includes('diff-size')) return 'diff-size';
  if (error.includes('resource budget') || error.includes('resource-budget')) return 'resource-budget';
  if (error.includes('hdl gate') || error.includes('hdl-gate')) return 'hdl';
  if (error.includes('python gate') || error.includes('python-gate')) return 'verification';
  if (error.includes('matlab gate') || error.includes('matlab-gate')) return 'verification';
  if (error.includes('coverage gate') || error.includes('coverage-gate')) return 'verification';
  return null;
}

const CONSUMER_ID = 'fp-rate';
const HARVEST_MAX_BATCH = 100;

/**
 * harvest — 注册消费者形态的 auto-record (D3 自动喂数, 2026-07-29)。
 *
 * 规则 3 合同: 独立 watermark (不与 dream/skill-evolve 共享)、真实 heartbeat、
 * 有界批量。宿主是 postflight-observer 的 Stop 路径 (与 skill-evolve 同进程)。
 * 扫过的事件无论是否命中门禁都推进水位; 失败不推进水位、留 failed 心跳。
 */
function harvestFpRate(opts = {}) {
  if (process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1') return { skipped: true };
  const crypto = require('node:crypto');
  const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
  const events = require(path.join(HOME, 'engine/sqlite/store-events.cjs'));
  const wright = opts.db ? { db: opts.db, close() { /* injected */ } } : openDb();
  const db = wright.db;
  const runId = crypto.randomUUID();
  const watermark = events.getWatermark({ db, consumer: CONSUMER_ID });
  const pending = events.countSinceWatermark(watermark, { db });
  events.beginConsumerRun(CONSUMER_ID, { db, runId, pending });
  try {
    const batch = events.sinceWatermark(watermark, HARVEST_MAX_BATCH, { db });
    let processedThrough = watermark;
    let recorded = 0;
    for (const ev of batch) {
      processedThrough = ev.eventId;
      if (ev.type !== 'tool_fail') continue;
      const gate = inferGate(ev.payload);
      if (!gate) continue;
      const entry = {
        gate,
        action: 'block',
        correct: true, // 默认假设拦截正确; override/挫败信号或人工复核可改判
        note: `auto: ${gate} 触发拦截`,
        timestamp: ev.createdAt || new Date().toISOString(),
        sessionId: ev.sessionId,
        eventId: ev.eventId,
      };
      ensureDir(path.dirname(STORE_FILE));
      fs.appendFileSync(STORE_FILE, JSON.stringify(entry) + '\n', 'utf8');
      recorded += 1;
    }
    events.setWatermark(processedThrough, { db, consumer: CONSUMER_ID });
    events.completeConsumerRun(CONSUMER_ID, {
      db,
      runId,
      status: batch.length === 0 ? 'skipped' : 'success',
      processedThrough,
      processed: batch.length,
      pending: events.countSinceWatermark(processedThrough, { db }),
    });
    return { recorded, scanned: batch.length, processedThrough };
  } catch (error) {
    try {
      events.failConsumerRun(CONSUMER_ID, { db, runId, error, pending });
    } catch { /* heartbeat best-effort */ }
    throw error;
  }
}

/** CLI 入口: 跑一次 harvest 并打印结果。 */
function autoRecord() {
  try {
    const result = harvestFpRate();
    if (result.skipped) console.log('[fp-rate-tracker] auto-record: 只读环境，跳过');
    else console.log(`[fp-rate-tracker] auto-record: ✅ 扫描 ${result.scanned} 条事件, 记录 ${result.recorded} 条门禁拦截 (watermark→${result.processedThrough})`);
  } catch (e) {
    console.error(`[fp-rate-tracker] auto-record: ⚠️ ${e.message}`);
  }
}

function main() {
  const cmd = process.argv[2] || 'report';
  const args = {};

  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.replace(/^--/, '').split('=');
      args[k] = v || true;
    }
  }

  switch (cmd) {
    case 'init':
      init();
      break;
    case 'record':
      record(args);
      break;
    case 'auto-record':
      autoRecord();
      break;
    case 'report':
      report(args.json);
      break;
    default:
      console.log(`
用法:
  node engine/scripts/fp-rate-tracker.cjs init
  node engine/scripts/fp-rate-tracker.cjs record --gate=<name> --correct=true/false [--note="..."]
  node engine/scripts/fp-rate-tracker.cjs auto-record
  node engine/scripts/fp-rate-tracker.cjs report [--json]

参数:
  --gate     verification | commit | bash-safety | file-protection | diff-size | resource-budget | hdl
  --correct  true=Gate判断正确, false=误判
  --action   block | pass
  --note     备注
`);
  }
}

/** 结构化摘要入口 (供十维仪表盘取用, 不打印)。 */
function summary() {
  if (!fs.existsSync(STORE_FILE)) return { available: false, total: 0 };
  const records = fs.readFileSync(STORE_FILE, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  if (records.length === 0) return { available: false, total: 0 };
  return { available: true, ...computeSummary(records) };
}

module.exports = {
  harvestFpRate, inferGate, autoRecord, computeSummary, summary, STORE_FILE,
};

if (require.main === module) main();
