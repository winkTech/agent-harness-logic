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

/**
 * auto-record — 从 SQLite runtime_events 自动推断门禁准确率.
 * 读取当前 session 的 tool_fail 事件，解析 payload 判断是哪道门禁触发的，
 * 自动写入 fp-rate-log.jsonl.
 */
function autoRecord() {
  try {
    const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
    const wright = openDb();
    if (!wright || !wright.db) {
      console.log('[fp-rate-tracker] auto-record: SQLite 不可用，跳过');
      return;
    }
    const db = wright.db;

    const sessionId = process.env.CLAUDE_SESSION_ID || 'unknown';

    // 查询当前 session 的 tool_fail 事件
    const events = db.prepare(`
      SELECT payload, created_at FROM runtime_events
      WHERE type = 'tool_fail' AND session_id = ?
      ORDER BY event_id
    `).all(sessionId);

    if (!events || events.length === 0) {
      console.log(`[fp-rate-tracker] auto-record: 无 tool_fail 事件 (session=${sessionId})`);
      return;
    }

    let recorded = 0;
    for (const ev of events) {
      let payload;
      try { payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload; } catch { continue; }

      // 解析 tool_name/error 推断门禁
      const toolName = (payload?.tool_name || payload?.tool || '').toLowerCase();
      const error = (payload?.error || payload?.stderr || '').toLowerCase();
      const command = (payload?.command || payload?.tool_input?.command || '').toLowerCase();

      let gate = null;
      if (error.includes('verification gate') || error.includes('verify first')) gate = 'verification';
      else if (error.includes('commit gate') || error.includes('commit-gate')) gate = 'commit';
      else if (error.includes('bash safety') || error.includes('bash-safety')) gate = 'bash-safety';
      else if (error.includes('file protection') || error.includes('file-protection')) gate = 'file-protection';
      else if (error.includes('diff size') || error.includes('diff-size')) gate = 'diff-size';
      else if (error.includes('resource budget') || error.includes('resource-budget')) gate = 'resource-budget';
      else if (error.includes('hdl gate') || error.includes('hdl-gate')) gate = 'hdl';
      else if (error.includes('python gate') || error.includes('python-gate')) gate = 'verification';
      else if (error.includes('matlab gate') || error.includes('matlab-gate')) gate = 'verification';
      else if (error.includes('coverage gate') || error.includes('coverage-gate')) gate = 'verification';

      if (gate) {
        const entry = {
          gate,
          action: 'block',
          correct: true, // 默认假设正确，人工可后续纠正
          note: `auto: ${gate} 触发拦截`,
          timestamp: ev.created_at || new Date().toISOString(),
          sessionId,
        };

        ensureDir(path.dirname(STORE_FILE));
        fs.appendFileSync(STORE_FILE, JSON.stringify(entry) + '\n', 'utf8');
        recorded++;
      }
    }

    console.log(`[fp-rate-tracker] auto-record: ✅ 记录了 ${recorded} 条门禁事件 (session=${sessionId})`);
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

main();
