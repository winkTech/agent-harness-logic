#!/usr/bin/env node
'use strict';

/**
 * engine/sqlite/test-fixtures/build-legacy-fixture.cjs — 旧库升级回归 fixture 构建。
 *
 * 流程 (Phase 0.3, 重构安全网):
 *   1. backupDb() (VACUUM INTO) 导出真实库 (~/.claude/.wright/memory.db);
 *   2. 裁剪: 保留完整 schema + 每表 ≤50 行**合成替换数据**;
 *   3. 脱敏: TEXT 字段按类别替换 —— 分类/枚举列 (status/type/kind/...) 保留取值域,
 *      时间戳换成合成日期, JSON 换成 '{}', 其余一律 'syn:<表>#<行号>';
 *      不原样保留任何真实行, 数值列 (计数/耗时/成本) 保留;
 *   4. _migrations 删除 013 行 → fixture 定格在"013 待升级"的旧形态;
 *   5. 输出 legacy-2026-11.db + sha256 清单 (git 跟踪)。
 *
 * 用法:
 *   node engine/sqlite/test-fixtures/build-legacy-fixture.cjs
 *
 * 可复现: 输出确定性 (同一真实库状态 → 同一 fixture); sha256 清单同时用于
 * 回归测试守卫 (fixture 被意外改动即失败)。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const FIXTURE_DIR = __dirname;
const OUT_PATH = path.join(FIXTURE_DIR, 'legacy-2026-11.db');
const SHA_PATH = path.join(FIXTURE_DIR, 'legacy-2026-11.db.sha256');
const MAX_ROWS = 50;

// 分类/枚举列名: 取值域本身是 schema 语义, 无个人信息, 保留以满足 CHECK 约束
const CATEGORICAL_COLUMNS = new Set([
  'status', 'type', 'kind', 'verdict', 'state', 'level', 'severity', 'tier',
  'phase', 'consumer', 'model', 'role', 'action', 'namespace', 'scope_kind',
  'trigger_kind', 'verification_state', 'event_type', 'source', 'rel',
  'node_kind', 'edge_kind', 'language', 'status_basis', 'workflow_name',
  'journal_mode', 'basis',
]);

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

/**
 * 从 CREATE TABLE DDL 提取全部单引号字面量 (CHECK IN 列表 / CHECK 等值 / DEFAULT)
 * ——这些字面量是 schema 语义 (取值域), 可原样保留; 真实行必然满足其 CHECK,
 * 故原值命中集合时保留即可通过约束。
 */
function extractCheckAllowedValues(ddl) {
  const allowed = new Set();
  for (const lit of ddl.matchAll(/'((?:[^']|'')*)'/g)) {
    allowed.add(lit[1].replace(/''/g, "'"));
  }
  return allowed;
}

function q(name) { return `"${String(name).replace(/"/g, '""')}"`; }

/** 单个字段脱敏; checkAllowed 为该表 CHECK IN 允许值集合 */
function anonymizeValue(table, column, value, rowIndex, checkAllowed) {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number' || t === 'bigint') return value; // 计数/耗时/成本/epoch, 非个人信息
  if (t !== 'string') return value;                    // BLOB: 原样 (库内无此类个人信息载体)
  if (value === '') return '';
  if (checkAllowed && checkAllowed.has(value)) return value; // CHECK 枚举字面量: schema 语义
  if (CATEGORICAL_COLUMNS.has(column) && value.length <= 64 && !value.includes(' ')) return value;
  if (value.startsWith('{') || value.startsWith('[')) {
    try { JSON.parse(value); return '{}'; } catch { /* 非 JSON, 走通用替换 */ }
  }
  if (TIMESTAMP_RE.test(value)) {
    // 合成时间戳: 保持 'YYYY-MM-DD HH:MM:SS' 形态, 按行号偏移保证多样性
    const base = Date.UTC(2026, 0, 1, 0, 0, 0) + rowIndex * 60_000;
    return new Date(base).toISOString().replace('T', ' ').slice(0, 19);
  }
  return `syn:${table}#${rowIndex}`;
}

function main() {
  const { backupDb } = require(path.join(FIXTURE_DIR, '..', 'index.cjs'));

  // ── 1. VACUUM INTO 导出真实库 ──
  const tmpBackup = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'legacy-fixture-')), 'backup.db');
  const backupPath = backupDb(tmpBackup);
  const src = new DatabaseSync(backupPath, { readOnly: true });

  // ── 2. 建输出库: 先 schema 后数据 ──
  if (fs.existsSync(OUT_PATH)) fs.rmSync(OUT_PATH, { force: true });
  const out = new DatabaseSync(OUT_PATH);
  out.exec('PRAGMA foreign_keys = OFF'); // 建库期关闭, 采样裁剪后统一修剪孤儿

  const objects = src.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();

  // FTS 虚表 DDL 会自动创建 shadow 表 (xxx_data 等), 其独立 CREATE 须跳过
  const virtual = objects.filter((o) => o.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(o.sql));
  const ftsShadow = new Set();
  for (const v of virtual) {
    for (const suffix of ['_config', '_content', '_data', '_docsize', '_idx']) {
      ftsShadow.add(v.name + suffix);
    }
  }
  const schemaObjects = objects.filter((o) => !ftsShadow.has(o.name));

  // 虚表 → 表 → 索引/触发器/视图 (触发表数据时 FTS 同步触发器须已就位)
  const order = { table: 0, index: 1, trigger: 2, view: 3 };
  const plain = schemaObjects.filter((o) => o.type === 'table' && !/^CREATE VIRTUAL TABLE/i.test(o.sql));
  const rest = schemaObjects.filter((o) => o.type !== 'table');
  for (const o of [...virtual, ...plain, ...rest].sort((a, b) => order[a.type] - order[b.type])) {
    out.exec(o.sql + ';');
  }

// 账本表是 schema 元数据 (迁移名 + 时间戳, 无个人信息), 必须原样拷贝 ——
// 否则 _migrations 与 migrations/ 目录失配, fixture 不再代表真实旧库形态
const LEDGER_TABLES = new Set(['_migrations', '_delivery_migration']);

// ── 3. 逐表采样 + 脱敏 ──
  const tables = objects.filter((o) => o.type === 'table' && !ftsShadow.has(o.name)).map((o) => o.name);
  const ddlByName = new Map(objects.filter((o) => o.type === 'table').map((o) => [o.name, o.sql]));
  const report = [];
  for (const table of tables) {
    const cols = src.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name);
    const rows = src.prepare(`SELECT * FROM ${q(table)} LIMIT ?`).all(MAX_ROWS);
    const checkAllowed = LEDGER_TABLES.has(table) ? null : extractCheckAllowedValues(ddlByName.get(table) || '');
    const anonymize = LEDGER_TABLES.has(table)
      ? (table, c, v) => v
      : anonymizeValue;
    const insert = out.prepare(
      `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    let n = 0;
    for (const row of rows) {
      const values = cols.map((c) => anonymize(table, c, row[c], n, checkAllowed));
      insert.run(...values);
      n += 1;
    }
    report.push(`${table}: ${n}`);
  }

  // ── 4. _migrations 定格旧形态: 删除 013 (fixture 代表"013 待升级"的库) ──
  out.prepare("DELETE FROM _migrations WHERE name = '013-delivery-events'").run();

  // ── 5. 修剪孤儿 (FK 指向被裁剪行) ──
  const orphans = out.prepare('PRAGMA foreign_key_check').all();
  const pruned = [];
  for (const row of orphans) {
    const table = row.table ?? row['table'];
    const rowid = row.rowid ?? row['rowid'];
    const pk = out.prepare(`PRAGMA table_info(${q(table)})`).all().find((c) => c.pk);
    if (pk && rowid !== undefined) {
      const child = out.prepare(`SELECT ${q(pk.name)} AS v FROM ${q(table)} WHERE rowid = ?`).get(rowid);
      if (child) {
        out.prepare(`DELETE FROM ${q(table)} WHERE ${q(pk.name)} = ?`).run(child.v);
        pruned.push(table);
      }
    }
  }

  out.close();
  src.close();
  fs.rmSync(path.dirname(tmpBackup), { recursive: true, force: true });

  // ── 6. sha256 清单 ──
  const hash = crypto.createHash('sha256').update(fs.readFileSync(OUT_PATH)).digest('hex');
  fs.writeFileSync(SHA_PATH, `${hash}  legacy-2026-11.db\n`, 'utf8');

  const size = fs.statSync(OUT_PATH).size;
  console.log(`fixture: ${OUT_PATH}`);
  console.log(`size: ${(size / 1024).toFixed(1)} KB  sha256: ${hash}`);
  console.log('rows per table:', report.join(', '));
  if (pruned.length > 0) console.log('pruned orphan rows in:', [...new Set(pruned)].join(', '));
}

main();
