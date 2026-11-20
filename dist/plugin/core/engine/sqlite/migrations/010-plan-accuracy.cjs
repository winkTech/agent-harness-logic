'use strict';

/**
 * 010-plan-accuracy — 计划快照与"计划 vs 实际"对账 (D2 规划质量)。
 *
 * plan_snapshots: 过需求门禁的任务留一份结构化计划 (目标/验收/预计范围/风险)。
 * plan_reconciliations: 任务收尾时与实际结果对账 —— 实际改动范围、交付判定、
 *   返工信号 (drift_stuck)、门禁失败次数。同一 (plan_id, reconciled_at) 幂等。
 *
 * 只存派生指标, 不存计划正文之外的会话内容 (transparency retention 边界)。
 */
module.exports = {
  name: '010-plan-accuracy',
  up: `
    CREATE TABLE IF NOT EXISTS plan_snapshots (
      plan_id       TEXT PRIMARY KEY,
      task          TEXT NOT NULL,
      plan_ref      TEXT,
      goal          TEXT NOT NULL,
      acceptance    TEXT NOT NULL,
      expected_scope INTEGER NOT NULL DEFAULT 0,
      expected_scope_files TEXT,
      risks         TEXT,
      source_gate   TEXT,
      approved_by   TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_reconciliations (
      plan_id        TEXT NOT NULL,
      reconciled_at  INTEGER NOT NULL,
      session_id     TEXT,
      actual_scope   INTEGER NOT NULL DEFAULT 0,
      scope_drift    REAL,
      delivery_pass  INTEGER NOT NULL DEFAULT 0,
      delivery_fail  INTEGER NOT NULL DEFAULT 0,
      rework_signals INTEGER NOT NULL DEFAULT 0,
      verdict        TEXT NOT NULL,
      detail         TEXT,
      PRIMARY KEY (plan_id, reconciled_at),
      FOREIGN KEY (plan_id) REFERENCES plan_snapshots(plan_id)
    );

    CREATE INDEX IF NOT EXISTS idx_plan_reconciliations_at
      ON plan_reconciliations(reconciled_at);
  `,
};
