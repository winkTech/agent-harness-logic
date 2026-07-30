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

/**
 * 窗口化成功率 (D1, 2026-07-30)。
 * 口径: windowDays 内的记录, 按 workflow / phase 两个维度分解。
 * 只统计 pass/fail (partial 单列), 因为成功率的分母必须是有明确判定的交付。
 */
function summarizeDeliveries(rows, opts = {}) {
  const windowDays = Number(opts.windowDays ?? 30);
  const now = Number(opts.now ?? Date.now());
  const cutoff = Number.isFinite(windowDays) && windowDays > 0 ? now - windowDays * 86_400_000 : null;
  const inWindow = rows.filter((row) => {
    if (cutoff === null) return true;
    // SQLite 侧是 "YYYY-MM-DD HH:MM:SS" (UTC), 文件后备是 ISO8601
    const raw = String(row.timestamp || '');
    const parsed = Date.parse(/\dT\d/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    return Number.isFinite(parsed) ? parsed >= cutoff : false;
  });

  const bucket = () => ({ total: 0, pass: 0, fail: 0, partial: 0, retries: 0, modules: 0 });
  const add = (target, row) => {
    target.total += 1;
    if (row.status === 'pass') target.pass += 1;
    else if (row.status === 'fail') target.fail += 1;
    else if (row.status === 'partial') target.partial += 1;
    target.retries += Number(row.retry_count ?? row.retries ?? 0) || 0;
    target.modules += Number(row.module_count ?? row.modules ?? 0) || 0;
  };
  const rate = (target) => {
    const decided = target.pass + target.fail;
    return decided > 0 ? Number((target.pass / decided).toFixed(6)) : null;
  };

  const overall = bucket();
  const byPhase = {};
  const byWorkflow = {};
  for (const row of inWindow) {
    add(overall, row);
    const phase = row.phase || 'unknown';
    const workflow = row.workflow_name || row.workflow || 'unknown';
    if (!byPhase[phase]) byPhase[phase] = bucket();
    if (!byWorkflow[workflow]) byWorkflow[workflow] = bucket();
    add(byPhase[phase], row);
    add(byWorkflow[workflow], row);
  }
  const withRate = (map) => Object.fromEntries(
    Object.entries(map).map(([key, value]) => [key, { ...value, successRate: rate(value) }]),
  );
  return {
    windowDays,
    events: inWindow.length,
    eventsAllTime: rows.length,
    overall: { ...overall, successRate: rate(overall) },
    byPhase: withRate(byPhase),
    byWorkflow: withRate(byWorkflow),
  };
}

function loadDeliveryRows(opts = {}) {
  const db = opts.db || getDb();
  let rows = [];
  if (db && ensureMigration(db)) {
    try {
      rows = db.prepare('SELECT * FROM delivery_events ORDER BY timestamp DESC LIMIT ?')
        .all(Number(opts.limit || 1000));
    } catch {
      rows = [];
    }
  }
  if (rows.length === 0 && fs.existsSync(FILE_STORE)) {
    const lines = fs.readFileSync(FILE_STORE, 'utf8').trim().split('\n').filter(Boolean);
    rows = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }
  return rows;
}

function deliveryReport(opts = {}) {
  const rows = loadDeliveryRows(opts);
  return {
    schemaVersion: 1,
    generatedAt: new Date(Number(opts.now ?? Date.now())).toISOString(),
    ...summarizeDeliveries(rows, opts),
  };
}

function generateReport(jsonOutput, opts = {}) {
  const rows = loadDeliveryRows(opts);

  if (rows.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify(deliveryReport(opts), null, 2));
      return;
    }
    console.log('[delivery-tracker] 暂无交付数据。运行 node engine/scripts/delivery-tracker.cjs record 记录首次。');
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ ...deliveryReport(opts), events: rows }, null, 2));
    return;
  }

  const summary = summarizeDeliveries(rows, opts);
  console.log(`\n━━━ 窗口成功率 (最近 ${summary.windowDays} 天) ━━━`);
  console.log(`📊 窗口内记录: ${summary.events} / 全部 ${summary.eventsAllTime}`);
  console.log(`✅ 成功率: ${summary.overall.successRate ?? 'n/a'} (pass=${summary.overall.pass} fail=${summary.overall.fail} partial=${summary.overall.partial})`);
  for (const [phase, stats] of Object.entries(summary.byPhase)) {
    console.log(`  ${phase.padEnd(14)} rate=${stats.successRate ?? 'n/a'} pass=${stats.pass}/${stats.total}`);
  }

  const allTime = summarizeDeliveries(rows, { ...opts, windowDays: 0 });
  console.log('\n━━━ 全期交付率 ━━━');
  console.log(`📊 总记录: ${allTime.events}`);
  console.log(`✅ 成功率: ${allTime.overall.successRate ?? 'n/a'} (pass=${allTime.overall.pass} fail=${allTime.overall.fail} partial=${allTime.overall.partial})`);
  console.log(`🔁 重试次数: ${allTime.overall.retries}   📦 模块总数: ${allTime.overall.modules}`);
  console.log('按工作流:');
  for (const [workflow, stats] of Object.entries(allTime.byWorkflow)) {
    console.log(`  ${workflow.padEnd(26)} rate=${stats.successRate ?? 'n/a'} pass=${stats.pass}/${stats.total}`);
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
      generateReport(args.json, {
        windowDays: args.windowDays !== undefined ? Number(args.windowDays) : undefined,
      });
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

module.exports = {
  recordDelivery,
  recordEvent,
  ensureMigration,
  summarizeDeliveries,
  loadDeliveryRows,
  deliveryReport,
};

if (require.main === module) main();
