'use strict';

/**
 * engine/sqlite/index.cjs — 统一 SQLite 持久层入口。
 *
 * 用法:
 *   const { openDb, closeDb } = require('./engine/sqlite');
 *   const db = openDb();              // singleton, WAL 模式
 *   const db2 = openDb(':memory:');   // 测试用独立连接
 *
 * 设计原则:
 *   - node:sqlite (DatabaseSync) 内置, 零依赖
 *   - 默认路径 ~/.claude/.wright/memory.db (git 不可见)
 *   - 单例缓存 (path→DatabaseSync), 重复 openDb() 返回同一实例
 *   - 注射式 opts.db 让多个 store 共享同一连接
 *   - WAL 模式 + 外键约束自动启用
 *   - 迁移系统: _migrations 表追踪已应用变更
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── 默认路径 ──────────────────────────────────────────────────────────────

/** ~/.claude/.wright/ 下的默认数据库文件名 */
const DEFAULT_DB_DIR = path.join(os.homedir(), '.claude', '.wright');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'memory.db');

// ── 连接缓存 ──────────────────────────────────────────────────────────────

/** Map<resolvedPath, DatabaseSync> — 确保同一路径复用同一实例 */
const connectionCache = new Map();

// ── 导出类型 ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WrightDb
 * @property {DatabaseSync} db     — 底层 DatabaseSync 实例
 * @property {string} path         — 解析后的数据库路径
 * @property {boolean} isMemory    — 是否 :memory:
 * @property {() => void} close    — 关闭连接, 清除缓存
 * @property {() => object} stats  — 内存/文件大小统计
 */

// ── 核心函数 ──────────────────────────────────────────────────────────────

/**
 * 打开 (或获取缓存) 一个 SQLite 数据库连接。
 *
 * @param {object} [opts]
 * @param {string} [opts.path]         — 数据库路径, 默认 ~/.claude/.wright/memory.db
 * @param {boolean} [opts.readonly]    — true = 只读模式 (backup/检查用, 不建表)
 * @param {boolean} [opts.noInit]      — true = 跳过 WAL/外键/迁移 (给内部迁移脚本用)
 * @returns {WrightDb}
 */
function openDb(opts = {}) {
  const dbPath = opts.path || DEFAULT_DB_PATH;
  const isMemory = dbPath === ':memory:';
  const resolvedPath = isMemory ? ':memory:' : path.resolve(dbPath);

  // 缓存命中
  const cached = connectionCache.get(resolvedPath);
  if (cached && !cached._closed) {
    return cached;
  }

  // 确保目录存在 (非 :memory:)
  if (!isMemory) {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // 创建连接
  let db;
  try {
    db = new DatabaseSync(resolvedPath, opts.readonly ? { readOnly: true } : {});
  } catch (err) {
    throw new Error(`[sqlite] 无法打开数据库 ${resolvedPath}: ${err.message}`);
  }

  // 非只读 / 非 noInit: 启用 WAL + 外键
  if (!opts.readonly && !opts.noInit) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    // 运行待迁移 (由 schema.cjs 统一管理)
    const { applyPendingMigrations } = require('./schema.cjs');
    applyPendingMigrations(db);
  }

  /** @type {WrightDb} */
  const wrightDb = {
    db,
    path: resolvedPath,
    isMemory,
    _closed: false,

    close() {
      if (this._closed) return;
      db.close();
      this._closed = true;
      connectionCache.delete(resolvedPath);
    },

    stats() {
      if (this._closed) return { status: 'closed' };
      const size = isMemory ? 0 : (fs.existsSync(resolvedPath) ? fs.statSync(resolvedPath).size : 0);
      const mem = db.prepare("SELECT SUM('memory') AS mem FROM pragma_page_count").get();
      return {
        path: resolvedPath,
        sizeBytes: size,
        pageCount: mem ? mem.mem : 0,
        walMode: !isMemory,
      };
    },
  };

  connectionCache.set(resolvedPath, wrightDb);
  return wrightDb;
}

/**
 * 获取默认数据库 (等价于 openDb() 但明确语义)。
 * 方便 require('./engine/sqlite').defaultDb 单行引用。
 */
function defaultDb() {
  return openDb();
}

/**
 * 关闭所有缓存的数据库连接 (通常在 session 结束或测试 teardown 时调用)。
 */
function closeAll() {
  for (const [key, wrightDb] of connectionCache.entries()) {
    try {
      if (!wrightDb._closed) wrightDb.db.close();
    } catch { /* 忽略关闭时的错误 */ }
    connectionCache.delete(key);
  }
}

/**
 * 备份数据库到指定路径 (VACUUM INTO)。
 * 仅对文件数据库有效, :memory: 跳过。
 *
 * @param {string} [dest]  — 备份目标路径, 默认 ~/.claude/.wright/backups/{timestamp}-memory.db
 * @param {object} [opts]
 * @param {string} [opts.sourcePath]  — 源数据库路径, 默认 DEFAULT_DB_PATH
 * @returns {string} 备份文件路径
 */
function backupDb(dest, opts = {}) {
  const src = openDb({ path: opts.sourcePath, noInit: true });
  if (src.isMemory) {
    throw new Error('[sqlite] :memory: 数据库不支持 VACUUM INTO 备份');
  }

  const backupPath = dest || path.join(
    path.dirname(DEFAULT_DB_PATH),
    'backups',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-memory.db`,
  );

  const backupDir = path.dirname(backupPath);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  src.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  return backupPath;
}

/**
 * 检查 SQLite 是否可用 (node:sqlite 内置, 总是 true, 但保留接口兼容)。
 */
function isAvailable() {
  return true;
}

module.exports = {
  openDb,
  defaultDb,
  closeAll,
  backupDb,
  isAvailable,
  DEFAULT_DB_PATH,
};
