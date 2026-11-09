'use strict';

/**
 * engine/sqlite/schema.cjs — 全系统 DDL 管理。
 *
 * 职责:
 *   1. 维护 _migrations 追踪表 (自动建)
 *   2. 从 migrations/ 目录扫描待应用迁移
 *   3. 按文件名排序, 幂等执行未应用的迁移
 *
 * 用法:
 *   const { applyPendingMigrations } = require('./schema.cjs');
 *   applyPendingMigrations(db);   // 自动扫描 + 执行
 *
 * 约定:
 *   - 迁移文件命名: {序号}-{名称}.cjs, 如 001-init.cjs
 *   - 每个迁移导出: module.exports = { name, up } — up 是 SQL 字符串,
 *     或 (收编野生 DDL 时) 接收 db 的函数, 用于 ADD COLUMN 这类
 *     SQLite 原生不支持 IF NOT EXISTS 的语句需自行查 PRAGMA 容错
 *   - 序号递增, 永不回退 (回滚用新迁移逆向操作)
 *   - 迁移幂等: 所有 CREATE 用 IF NOT EXISTS
 */

const path = require('node:path');
const fs = require('node:fs');

/** migrations/ 目录路径 (相对本文件) */
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * 确保 _migrations 追踪表存在。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * 提取迁移文件的数字前缀。无前缀返回 null (不参与编号账本)。
 * @param {string} file
 * @returns {string|null}
 */
function migrationPrefix(file) {
  const m = file.match(/^(\d+)/);
  return m ? m[1] : null;
}

/**
 * 迁移编号防撞守卫 (fail-closed): 同一数字前缀出现多个文件即拒绝加载。
 *
 * 规则 (详见 README.md "迁移编号纪律"):
 *   - 编号冻结: 新迁移必须用下一个未占用序号;
 *   - 已应用文件永不改名/删除, 回滚用新迁移逆向操作;
 *   - 历史冻结例外: 守卫上线前已存在的双 002 (002-cjk-fts5 / 002-fix-events-check)
 *     按文件名精确冻结 —— 只容忍这两个文件原样共存, 新增任何 002-* 或其他重复
 *     前缀立即抛错。按文件名而非按库内 applied 状态判定: 全新库的 _migrations
 *     为空, 历史例外不能依赖每库状态, 否则 fresh 开库即炸。
 *
 * @param {string[]} files — 扫描到的迁移文件名 (已排序)
 */
const HISTORICAL_FROZEN_DUPLICATES = ['002-cjk-fts5.cjs', '002-fix-events-check.cjs'];

function assertUniqueMigrationPrefixes(files) {
  const byPrefix = new Map();
  for (const file of files) {
    const prefix = migrationPrefix(file);
    if (prefix === null) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(file);
  }

  const conflicts = [];
  for (const [prefix, group] of byPrefix) {
    if (group.length < 2) continue;
    const isFrozenHistory = group.length === HISTORICAL_FROZEN_DUPLICATES.length &&
      HISTORICAL_FROZEN_DUPLICATES.every((f) => group.includes(f));
    if (isFrozenHistory) continue; // 历史冻结: 按文件名精确容忍, 不可扩充
    conflicts.push(`前缀 ${prefix}: ${group.join(', ')}`);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `[sqlite/schema] 迁移编号前缀冲突 (fail-closed): ${conflicts.join('; ')}。` +
      '编号已冻结: 新迁移必须用下一个未占用序号; 已应用文件永不改名/删除。',
    );
  }
}

/**
 * 扫描并应用所有未执行的迁移。
 * 幂等: 已存在的迁移自动跳过。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @param {string} [opts.dir] — 迁移目录 (默认 engine/sqlite/migrations; fixture 测试用)
 */
function applyPendingMigrations(db, opts = {}) {
  ensureMigrationTable(db);

  const migrationsDir = opts.dir || MIGRATIONS_DIR;

  // 扫描迁移文件
  if (!fs.existsSync(migrationsDir)) {
    return; // 无迁移目录, 跳过
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.cjs') || f.endsWith('.js'))
    .sort(); // 按文件名排序确保顺序

  if (files.length === 0) return;

  // 已应用的迁移集合
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((/** @type {any} */ r) => r.name),
  );

  // 编号防撞守卫 (fail-closed): 重复数字前缀且非历史冻结组 → 拒绝加载
  assertUniqueMigrationPrefixes(files);

  const getApplied = db.prepare('SELECT name FROM _migrations');
  /** @type {string[]} */
  const existing = [];
  for (const r of getApplied.all()) {
    existing.push(r.name);
  }
  const appliedSet = new Set(existing);

  for (const file of files) {
    const migrationName = file.replace(/\.(cjs|js)$/, '');
    if (appliedSet.has(migrationName)) continue;

    try {
      const migration = require(path.join(migrationsDir, file));

      if (!migration || !migration.up) {
        console.warn(`[sqlite/schema] 迁移 ${file} 无 up 字段, 跳过`);
        continue;
      }

      // 事务内执行迁移
      db.exec('BEGIN IMMEDIATE');
      try {
        if (typeof migration.up === 'function') migration.up(db);
        else db.exec(migration.up);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migrationName);
        db.exec('COMMIT');
        // 必须走 stderr: 迁移会在 hook 进程里首次开库时触发, 而 hook 的 stdout
        // 被 Claude Code 当作协议输出解析 —— 打到 stdout 会污染 hook 返回值。
        console.error(`[sqlite/schema] 迁移 ${migrationName} 已应用`);
      } catch (txErr) {
        db.exec('ROLLBACK');
        throw txErr;
      }
    } catch (err) {
      console.error(`[sqlite/schema] 迁移 ${file} 失败:`, err.message);
      throw err;
    }
  }
}

/**
 * 列出所有迁移状态。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @param {string} [opts.dir] — 迁移目录 (默认 engine/sqlite/migrations)
 * @returns {{ name: string, applied: boolean, applied_at: string|null }[]}
 */
function listMigrations(db, opts = {}) {
  ensureMigrationTable(db);

  const applied = new Map(
    db.prepare('SELECT name, applied_at FROM _migrations ORDER BY name').all()
      .map((/** @type {any} */ r) => [r.name, r.applied_at]),
  );

  const migrationsDir = opts.dir || MIGRATIONS_DIR;
  if (!fs.existsSync(migrationsDir)) {
    return Array.from(applied.entries()).map(([name, applied_at]) => ({
      name, applied: true, applied_at,
    }));
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.cjs') || f.endsWith('.js'))
    .sort();

  return files.map(f => {
    const name = f.replace(/\.(cjs|js)$/, '');
    const appliedAt = applied.get(name) || null;
    return { name, applied: !!appliedAt, applied_at: appliedAt };
  });
}

module.exports = {
  applyPendingMigrations,
  listMigrations,
  ensureMigrationTable,
  assertUniqueMigrationPrefixes,
  migrationPrefix,
};
