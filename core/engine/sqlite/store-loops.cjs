'use strict';

/**
 * engine/sqlite/store-loops.cjs — 任务循环状态仓库。
 *
 * 用法:
 *   const loops = require('./store-loops.cjs');
 *   const loop = loops.createLoop({ scopeId, sessionId, goal, exitCriteria, budgetIters });
 *   const active = loops.getActiveLoop({ scopeId, sessionId });
 *   loops.recordIteration(loop.id, { verdict: 'fail', failureFp: 'abc', unmet: [...] });
 *   loops.closeLoop(loop.id, 'converged');
 *
 * 约定:
 *   - 一个 (scopeId, sessionId) 同一时刻只有一个 active 循环; 新建时旧的自动
 *     标记 abandoned —— 两个并发循环会让 Stop 钩子无从判断该听谁的。
 *   - 所有写操作接受 opts.db 注入, 便于契约测试用临时库。
 */

const { resolveDb } = require('./index.cjs');

/** 单调递增的本地序号, 避免同毫秒创建时 id 冲突。 */
let _seq = 0;

function makeLoopId(scopeId, now) {
  _seq = (_seq + 1) % 1000;
  return `${String(scopeId || 'scope').slice(0, 24)}-${now.toString(36)}-${_seq.toString(36)}`;
}

function toJson(value, fallback = '[]') {
  try { return JSON.stringify(value ?? JSON.parse(fallback)); } catch { return fallback; }
}

function fromJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeId: row.scope_id,
    sessionId: row.session_id,
    goal: row.goal,
    exitCriteria: fromJson(row.exit_criteria, []),
    budgetIters: row.budget_iters,
    iteration: row.iteration,
    status: row.status,
    lastVerdict: fromJson(row.last_verdict, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/**
 * 新建一个待收敛的循环。同 scope+session 的旧 active 循环会被置为 abandoned。
 * @param {object} input
 * @param {string} input.scopeId
 * @param {string} [input.sessionId]
 * @param {string} input.goal
 * @param {Array} input.exitCriteria
 * @param {number} [input.budgetIters=5]
 * @param {object} [opts]
 * @returns {object} hydrate 后的循环
 */
function createLoop(input, opts = {}) {
  const db = resolveDb(opts);
  const now = opts.now || Date.now();
  const scopeId = String(input.scopeId || '').trim();
  const goal = String(input.goal || '').trim();
  if (!scopeId) throw new TypeError('loop scopeId is required');
  if (!goal) throw new TypeError('loop goal is required');
  const criteria = Array.isArray(input.exitCriteria) ? input.exitCriteria : [];
  if (criteria.length === 0) {
    // 没有判据的循环永远无法判定收敛, 只会耗尽预算后误报"未收敛"。
    throw new TypeError('loop exitCriteria must contain at least one criterion');
  }
  const sessionId = String(input.sessionId || '');
  const budget = Number.isInteger(input.budgetIters) && input.budgetIters > 0
    ? input.budgetIters : 5;

  db.prepare(`
    UPDATE task_loops SET status = 'abandoned', updated_at = ?, closed_at = ?
    WHERE scope_id = ? AND session_id = ? AND status = 'active'
  `).run(now, now, scopeId, sessionId);

  const id = makeLoopId(scopeId, now);
  db.prepare(`
    INSERT INTO task_loops
      (id, scope_id, session_id, goal, exit_criteria, budget_iters, iteration, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)
  `).run(id, scopeId, sessionId, goal, toJson(criteria), budget, now, now);

  return getLoop(id, { db });
}

function getLoop(loopId, opts = {}) {
  const db = resolveDb(opts);
  return hydrate(db.prepare('SELECT * FROM task_loops WHERE id = ?').get(loopId));
}

/**
 * 取当前生效的循环。
 * 先按 (scopeId, sessionId) 精确匹配; 没有则退回同 scope 的 active 循环 ——
 * 会话被 /compact 或重启换了 id 时, 循环不该凭空消失。
 */
function getActiveLoop(input = {}, opts = {}) {
  const db = resolveDb(opts);
  const scopeId = String(input.scopeId || '');
  const sessionId = String(input.sessionId || '');
  if (!scopeId) return null;

  const exact = db.prepare(`
    SELECT * FROM task_loops
    WHERE scope_id = ? AND session_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(scopeId, sessionId);
  if (exact) return hydrate(exact);

  const anySession = db.prepare(`
    SELECT * FROM task_loops
    WHERE scope_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(scopeId);
  return hydrate(anySession);
}

/**
 * 记录一轮迭代并推进计数。
 * @returns {{ loop: object, iteration: number }}
 */
function recordIteration(loopId, entry = {}, opts = {}) {
  const db = resolveDb(opts);
  const now = opts.now || Date.now();
  const loop = getLoop(loopId, { db });
  if (!loop) throw new Error(`unknown loop: ${loopId}`);

  const iteration = loop.iteration + 1;
  const verdict = ['pass', 'fail', 'unknown'].includes(entry.verdict) ? entry.verdict : 'unknown';

  db.prepare(`
    INSERT OR REPLACE INTO loop_iterations
      (loop_id, iteration, action_summary, failure_fp, failure_family,
       evidence_sha, verdict, unmet, strategy, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    loopId, iteration,
    entry.actionSummary ? String(entry.actionSummary).slice(0, 500) : null,
    entry.failureFp || null,
    entry.failureFamily || null,
    entry.evidenceSha || null,
    verdict,
    entry.unmet ? toJson(entry.unmet) : null,
    entry.strategy ? String(entry.strategy).slice(0, 500) : null,
    now,
  );

  db.prepare('UPDATE task_loops SET iteration = ?, last_verdict = ?, updated_at = ? WHERE id = ?')
    .run(iteration, entry.verdictDetail ? toJson(entry.verdictDetail, 'null') : null, now, loopId);

  return { loop: getLoop(loopId, { db }), iteration };
}

/** 关闭循环。status 必须是终态之一。 */
function closeLoop(loopId, status, opts = {}) {
  const db = resolveDb(opts);
  const now = opts.now || Date.now();
  if (!['converged', 'exhausted', 'abandoned'].includes(status)) {
    throw new TypeError(`invalid terminal loop status: ${status}`);
  }
  db.prepare('UPDATE task_loops SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?')
    .run(status, now, now, loopId);
  return getLoop(loopId, { db });
}

/** 列出循环 (默认只列 active)。 */
function listLoops(filter = {}, opts = {}) {
  const db = resolveDb(opts);
  const clauses = [];
  const params = [];
  if (filter.scopeId) { clauses.push('scope_id = ?'); params.push(filter.scopeId); }
  if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 20;
  return db.prepare(`SELECT * FROM task_loops ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit).map(hydrate);
}

/** 取某个循环的迭代历史 (按轮次升序)。 */
function listIterations(loopId, opts = {}) {
  const db = resolveDb(opts);
  return db.prepare('SELECT * FROM loop_iterations WHERE loop_id = ? ORDER BY iteration')
    .all(loopId)
    .map((row) => ({
      iteration: row.iteration,
      actionSummary: row.action_summary,
      failureFp: row.failure_fp,
      failureFamily: row.failure_family,
      evidenceSha: row.evidence_sha,
      verdict: row.verdict,
      unmet: fromJson(row.unmet, null),
      strategy: row.strategy,
      createdAt: row.created_at,
    }));
}

/**
 * 统计某个失败指纹在本循环中连续重复了几轮 (从最后一轮往前数)。
 * 这是"同一方法连续失败两次就换方法"的判据来源。
 */
function repeatStreak(loopId, fingerprint, opts = {}) {
  if (!fingerprint) return 0;
  const history = listIterations(loopId, opts);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].failureFp === fingerprint) streak++;
    else break;
  }
  return streak;
}

module.exports = {
  createLoop,
  getLoop,
  getActiveLoop,
  recordIteration,
  closeLoop,
  listLoops,
  listIterations,
  repeatStreak,
};
