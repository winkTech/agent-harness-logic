'use strict';

/**
 * 002-fix-events-check — 修复 runtime_events 表 CHECK 约束。
 *
 * 问题:
 *   signal-collector.cjs v2.0 定义了 13 种事件类型 (原始 7 + 新增 6)，
 *   但 runtime_events 表的 CHECK 只允许 7 种原始类型，导致新增类型的
 *   信号写入被静默拒绝，自学习数据流断裂。
 *
 * 修复:
 *   移除 CHECK 约束，由应用层 (signal-collector.cjs 的 SIGNAL_TYPES) 管理。
 *
 * 安全:
 *   - SQLite 3.35+ 支持 ALTER TABLE DROP CHECK
 *   表为空 (0 events) → 用 DROP/RECREATE 更简单且对旧版本兼容
 */
module.exports = {
  name: '002-fix-events-check',

  up: `
    -- 保存现有数据 (如果有)
    CREATE TABLE IF NOT EXISTS runtime_events_backup AS SELECT * FROM runtime_events;

    -- 重建 runtime_events: 移除 CHECK 约束
    DROP TABLE IF EXISTS runtime_events;

    CREATE TABLE runtime_events (
      event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    -- 从备份恢复 (如果有)
    INSERT OR IGNORE INTO runtime_events (event_id, session_id, type, payload, created_at)
    SELECT event_id, session_id, type, payload, created_at FROM runtime_events_backup;

    -- 重建索引
    CREATE INDEX IF NOT EXISTS idx_events_type ON runtime_events(type);
    CREATE INDEX IF NOT EXISTS idx_events_session ON runtime_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON runtime_events(created_at);

    -- 清理备份 (数据已恢复后删除)
    DROP TABLE IF EXISTS runtime_events_backup;
  `,
};
