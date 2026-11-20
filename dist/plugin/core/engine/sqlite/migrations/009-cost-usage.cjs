'use strict';

/**
 * 009-cost-usage — cost_ledger 从字符估算升级到真实 transcript usage。
 *
 * 新增列: model / cache_read_tokens / cache_write_tokens / cost_usd。
 * phase='usage' 行按 (session_id, model) 唯一, 存该会话累计 usage (幂等 upsert);
 * phase='estimate' 行保留为无 transcript 时的回退路径。
 */
module.exports = {
  name: '009-cost-usage',
  up: `
    ALTER TABLE cost_ledger ADD COLUMN model TEXT;
    ALTER TABLE cost_ledger ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE cost_ledger ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE cost_ledger ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_usage_session_model
      ON cost_ledger(session_id, model) WHERE phase = 'usage';
    CREATE INDEX IF NOT EXISTS idx_cost_ledger_phase_created
      ON cost_ledger(phase, created_at);
  `,
};
