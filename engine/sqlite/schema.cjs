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
 *   - 每个迁移导出: module.exports = { name, up: 'SQL DDL ...' }
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
 * 扫描并应用所有未执行的迁移。
 * 幂等: 已存在的迁移自动跳过。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function applyPendingMigrations(db) {
  ensureMigrationTable(db);

  // 扫描迁移文件
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return; // 无迁移目录, 跳过
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.cjs') || f.endsWith('.js'))
    .sort(); // 按文件名排序确保顺序

  if (files.length === 0) return;

  // 已应用的迁移集合
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((/** @type {any} */ r) => r.name),
  );

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
      const migration = require(path.join(MIGRATIONS_DIR, file));

      if (!migration || !migration.up) {
        console.warn(`[sqlite/schema] 迁移 ${file} 无 up 字段, 跳过`);
        continue;
      }

      // 事务内执行迁移
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration.up);
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
 * @returns {{ name: string, applied: boolean, applied_at: string|null }[]}
 */
function listMigrations(db) {
  ensureMigrationTable(db);

  const applied = new Map(
    db.prepare('SELECT name, applied_at FROM _migrations ORDER BY name').all()
      .map((/** @type {any} */ r) => [r.name, r.applied_at]),
  );

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return Array.from(applied.entries()).map(([name, applied_at]) => ({
      name, applied: true, applied_at,
    }));
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
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
};
