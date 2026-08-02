'use strict';

/**
 * 011-task-loops — 任务级循环状态机 (loop engineering)。
 *
 * harness 此前只有"门禁"(一次性 PASS/FAIL 判决) 和"观测"(离线报表), 没有任何
 * 组件持有一个任务的迭代状态: 迭代预算、收敛判据、上一轮失败指纹、这一轮该换
 * 什么策略。于是"没收敛就继续干"只能靠模型自觉。这两张表就是那个缺失的载体。
 *
 * task_loops       — 一个待收敛的目标: 判据 + 预算 + 状态
 * loop_iterations  — 每一轮的动作、判定、失败指纹与策略切换
 *
 * 语义边界 (与 docs/rules/05-harness.md 一致):
 *   - 收敛只能由**显式判据全绿**得出; 判据读不出结果算未收敛, 不算通过;
 *   - 预算耗尽是 exhausted, 不是 converged —— 两者绝不能混为一谈;
 *   - 只存派生状态与指纹, 不存会话正文。
 */
module.exports = {
  name: '011-task-loops',
  up: `
    CREATE TABLE IF NOT EXISTS task_loops (
      id            TEXT PRIMARY KEY,          -- <scopeId>-<时间戳>-<序号>
      scope_id      TEXT NOT NULL,             -- project-scope.scopeId(projectRoot)
      session_id    TEXT NOT NULL DEFAULT '',
      goal          TEXT NOT NULL,
      exit_criteria TEXT NOT NULL,             -- JSON 数组, 见 loop-controller.cjs
      budget_iters  INTEGER NOT NULL DEFAULT 5,
      iteration     INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','converged','exhausted','abandoned')),
      last_verdict  TEXT,                      -- JSON: 最近一次判据评估结果
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      closed_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_task_loops_active
      ON task_loops(scope_id, session_id, status);

    CREATE TABLE IF NOT EXISTS loop_iterations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      loop_id        TEXT NOT NULL REFERENCES task_loops(id) ON DELETE CASCADE,
      iteration      INTEGER NOT NULL,
      action_summary TEXT,
      failure_fp     TEXT,                     -- lib/failure-signature.cjs 指纹
      failure_family TEXT,
      evidence_sha   TEXT,                     -- 关联 verification-ledger 条目
      verdict        TEXT NOT NULL DEFAULT 'unknown'
                     CHECK(verdict IN ('pass','fail','unknown')),
      unmet          TEXT,                     -- JSON: 未满足的判据
      strategy       TEXT,                     -- 本轮给出的换方法建议
      created_at     INTEGER NOT NULL,
      UNIQUE(loop_id, iteration)
    );
    CREATE INDEX IF NOT EXISTS idx_loop_iterations_loop
      ON loop_iterations(loop_id, iteration);
  `,
};
