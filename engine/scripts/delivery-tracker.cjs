#!/usr/bin/env node
/**
 * engine/scripts/delivery-tracker.cjs — 交付率追踪器
 *
 * 🔍 P0-2: 交付率追踪
 * 参照: [8] "The Harness Gap" — 测量产出→交付的转化效率
 *
 * 记录 DAG 工作流每次运行的阶段完成率、失败位置、重试次数。
 * 数据写入 SQLite store-events 表，供 Dashboard 查询。
 *
 * 用法:
 *   node engine/scripts/delivery-tracker.cjs init           # 初始化迁移 (首次)
 *   node engine/scripts/delivery-tracker.cjs record         # 记录一次交付事件 + 交互式输入
 *   node engine/scripts/delivery-tracker.cjs record --phase=P4 --status=pass --modules=3 --retries=1
 *   node engine/scripts/delivery-tracker.cjs report         # 生成交付报告
 *   node engine/scripts/delivery-tracker.cjs report --json  # JSON 格式
 *
 * 自动触发: 在 hdl-coding-dag-workflow 的 Phase 8 收尾时自动调用。
 */

'use strict';

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = HARNESS_ROOT;

// ── SQLite 接口 ─────────────────────────────────────────────────────────────

function getDb() {
  try {
    const { openDb } = require(path.join(HOME, 'engine/sqlite/index.cjs'));
    const wright = openDb();
    return wright && wright.db ? wright.db : null;
  } catch (e) {
    return null;
  }
}

// ── 迁移: 创建交付追踪表 ────────────────────────────────────────────────────

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS delivery_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_name TEXT    NOT NULL DEFAULT 'hdl-coding-dag-workflow',
    phase         TEXT    NOT NULL,
    status        TEXT    NOT NULL CHECK(status IN ('pass','fail','partial')),
    module_count  INTEGER DEFAULT 0,
    retry_count   INTEGER DEFAULT 0,
    duration_sec  INTEGER DEFAULT 0,
    error_msg     TEXT,
    project       TEXT,
    timestamp     TEXT    NOT NULL DEFAULT (datetime('now')),
    session_id    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_phase ON delivery_events(phase);
  CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_events(status);
  CREATE INDEX IF NOT EXISTS idx_delivery_ts ON delivery_events(timestamp);
`;

function ensureMigration(db) {
  if (!db) return false;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _delivery_migration (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const row = db.prepare("SELECT name FROM _delivery_migration WHERE name = '004-delivery-tracking'").all();
    if (row.length === 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(MIGRATION_SQL);
        db.prepare("INSERT INTO _delivery_migration (name) VALUES ('004-delivery-tracking')").run();
        db.exec('COMMIT');
        console.log('[delivery-tracker] 迁移 004-delivery-tracking 已应用');
      } catch (txErr) {
        db.exec('ROLLBACK');
        throw txErr;
      }
    }
    return true;
  } catch (e) {
    console.error('[delivery-tracker] 迁移失败:', e.message);
    return false;
  }
}

// ── 记录交付事件 ────────────────────────────────────────────────────────────

function recordEvent(args) {
  const ok = recordDelivery(args);
  if (ok) console.log(`[delivery-tracker] ✅ 记录: phase=${args.phase} status=${args.status}`);
  return ok;
}

/**
 * 静默 lib 入口 (hook/router 内调用, 不污染 hook 协议的 stdout)。
 * opts.db 可注入连接; 缺 SQLite 时落 JSONL 后备文件。
 */
function recordDelivery(args, opts = {}) {
  const db = opts.db || getDb();
  if (!db) {
    // SQLite 不可用 → 写 JSON 文件作为后备
    return recordEventFile(args);
  }
  ensureMigration(db);

  const stmt = db.prepare(`
    INSERT INTO delivery_events (workflow_name, phase, status, module_count, retry_count, duration_sec, error_msg, project, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sessionId = args.sessionId || process.env.CLAUDE_SESSION_ID || 'unknown';

  stmt.run(
    args.workflow || 'hdl-coding-dag-workflow',
    args.phase || 'unknown',
    args.status || 'pass',
    parseInt(args.modules) || 0,
    parseInt(args.retries) || 0,
    parseInt(args.duration) || 0,
    args.error || null,
    args.project || path.basename(args.cwd || process.cwd()),
    sessionId,
  );
  return true;
}

// ── 文件后备存储 ────────────────────────────────────────────────────────────

const FILE_STORE = path.join(HOME, 'var', 'delivery-log.jsonl');

function recordEventFile(args) {
  const entry = {
    workflow: args.workflow || 'hdl-coding-dag-workflow',
    phase: args.phase || 'unknown',
    status: args.status || 'pass',
    modules: parseInt(args.modules) || 0,
    retries: parseInt(args.retries) || 0,
    duration: parseInt(args.duration) || 0,
    error: args.error || null,
    project: args.project || path.basename(process.cwd()),
    timestamp: new Date().toISOString(),
    sessionId: process.env.CLAUDE_SESSION_ID || 'unknown',
  };

  const dir = path.dirname(FILE_STORE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(FILE_STORE, JSON.stringify(entry) + '\n', 'utf8');
  console.log(`[delivery-tracker] ✅ 记录(文件): phase=${args.phase} status=${args.status}`);
  return true;
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function generateReport(jsonOutput) {
  const db = getDb();

  let rows = [];
  if (db && ensureMigration(db)) {
    try {
      rows = db.prepare('SELECT * FROM delivery_events ORDER BY timestamp DESC LIMIT 100').all();
    } catch {
      rows = [];
    }
  }

  // 从文件补充
  if (rows.length === 0 && fs.existsSync(FILE_STORE)) {
    const lines = fs.readFileSync(FILE_STORE, 'utf8').trim().split('\n').filter(Boolean);
    rows = lines.map(l => JSON.parse(l));
  }

  if (rows.length === 0) {
    console.log('[delivery-tracker] 暂无交付数据。运行 node engine/scripts/delivery-tracker.cjs record 记录首次。');
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ events: rows, generatedAt: new Date().toISOString() }, null, 2));
    return;
  }

  // 文本报告
  const total = rows.length;
  const passed = rows.filter(r => r.status === 'pass').length;
  const failed = rows.filter(r => r.status === 'fail').length;
  const partial = rows.filter(r => r.status === 'partial').length;
  const totalRetries = rows.reduce((s, r) => s + (parseInt(r.retry_count) || parseInt(r.retries) || 0), 0);
  const totalModules = rows.reduce((s, r) => s + (parseInt(r.module_count) || parseInt(r.modules) || 0), 0);

  const passRate = total > 0 ? (passed / total * 100).toFixed(1) : '0.0';

  // 按阶段统计
  const byPhase = {};
  for (const r of rows) {
    const phase = r.phase || 'unknown';
    if (!byPhase[phase]) byPhase[phase] = { total: 0, pass: 0, fail: 0 };
    byPhase[phase].total++;
    if (r.status === 'pass') byPhase[phase].pass++;
    if (r.status === 'fail') byPhase[phase].fail++;
  }

  console.log('\n━━━ 交付率报告 ━━━');
  console.log(`📊 总记录: ${total}`);
  console.log(`✅ 通过:    ${passed} (${passRate}%)`);
  console.log(`❌ 失败:    ${failed}`);
  console.log(`🔄 部分:    ${partial}`);
  console.log(`🔁 重试次数: ${totalRetries}`);
  console.log(`📦 模块总数: ${totalModules}`);
  console.log('');

  console.log('按阶段:');
  for (const [phase, stats] of Object.entries(byPhase)) {
    const rate = stats.total > 0 ? (stats.pass / stats.total * 100).toFixed(0) : '-';
    const bar = stats.total > 0 ? '█'.repeat(Math.round(stats.pass / stats.total * 20)) : '';
    console.log(`  ${phase.padEnd(12)} ${bar} ${stats.pass}/${stats.total} (${rate}%)`);
  }
  console.log('');
}

// ── CLI ────────────────────────────────────────────────────────────────────

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
      const db = getDb();
      if (db && ensureMigration(db)) {
        console.log('[delivery-tracker] ✅ 迁移就绪');
      } else {
        console.log('[delivery-tracker] ⚠️  SQLite 不可用，使用文件后备存储');
      }
      break;

    case 'record':
      recordEvent(args);
      break;

    case 'report':
      generateReport(args.json);
      break;

    default:
      console.log(`
用法:
  node engine/scripts/delivery-tracker.cjs init              # 初始化
  node engine/scripts/delivery-tracker.cjs record [options]  # 记录事件
  node engine/scripts/delivery-tracker.cjs report            # 查看报告
  node engine/scripts/delivery-tracker.cjs report --json     # JSON 格式

选项:
  --phase=<名称>  阶段名 (P1a/P1b/P2/P3/P4/P4.5/P5/P6/P7/P8)
  --status=<值>   状态 (pass/fail/partial)
  --modules=<n>   模块数
  --retries=<n>   重试次数
  --duration=<s>  耗时秒数
  --error=<msg>   错误信息
`);
  }
}

module.exports = { recordDelivery, recordEvent, ensureMigration };

if (require.main === module) main();
