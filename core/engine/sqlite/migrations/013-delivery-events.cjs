'use strict';

/**
 * 013-delivery-events — 收编 delivery-tracker 的野生迁移 (_delivery_migration 私有账本)。
 *
 * 此前 engine/scripts/delivery-tracker.cjs 自带 _delivery_migration 追踪表, 在统一
 * 迁移账本 (_migrations) 之外私自管理 delivery_events 的 DDL (原 004-delivery-tracking
 * 建表 + 005-delivery-uncovered 加归因列)。本迁移把那段 DDL 原样收编进统一账本,
 * 语义保持:
 *   - 建表/索引全部 IF NOT EXISTS, 与原私有迁移逐字一致;
 *   - uncovered 列沿用原 ensureColumn 语义: SQLite 的 ADD COLUMN 不支持
 *     IF NOT EXISTS, 经原私有 005 加过该列的旧库直接 ALTER 会抛
 *     duplicate column name, 故先查 PRAGMA table_info 再决定是否 ALTER。
 *
 * 旧库里的 _delivery_migration 表与追踪行原样保留 (只读考古), 不删不改。
 */
module.exports = {
  name: '013-delivery-events',
  up(db) {
    db.exec(`
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
    `);

    // 原 005-delivery-uncovered: partial 事件的归因列 —— 未满足的证据类型列表
    // (JSON 数组字符串)。ensureColumn 语义: 容忍旧库被私有迁移加过列。
    const columns = db.prepare('PRAGMA table_info(delivery_events)').all().map((col) => col.name);
    if (!columns.includes('uncovered')) {
      db.exec('ALTER TABLE delivery_events ADD COLUMN uncovered TEXT');
    }
  },
};
