'use strict';

/**
 * engine/sqlite/store-costs.cjs — 成本记账 (每 session 估算)。
 *
 * 用法:
 *   const costs = require('./store-costs.cjs');
 *   costs.recordSession({ sessionId, tokensIn, tokensOut, notes });
 *   costs.sessionReport('s1');
 *   costs.summary();
 *
 * 依赖: cost_ledger 表 (001-init 已创建)
 */

const { openDb, resolveDb } = require('./index.cjs');

/**
 * 记录一条成本条目。
 */
function recordSession(entry, opts = {}) {
  const db = resolveDb(opts);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cost_ledger (session_id, phase, tokens_in, tokens_out, cost_credits, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionId,
    entry.phase || 'general',
    entry.tokensIn || 0,
    entry.tokensOut || 0,
    entry.costCredits || 0,
    entry.notes || null,
    now,
  );
}

/**
 * 查询 session 级别汇总。
 */
function sessionReport(sessionId, opts = {}) {
  const db = resolveDb(opts);
  return db.prepare(`
    SELECT
      COUNT(*) AS calls,
      SUM(tokens_in) AS totalIn,
      SUM(tokens_out) AS totalOut,
      SUM(cost_credits) AS totalCost,
      MIN(created_at) AS firstAt,
      MAX(created_at) AS lastAt
    FROM cost_ledger WHERE session_id = ?
  `).get(sessionId);
}

/**
 * 全局汇总 (按日/按阶段)。
 */
function summary(opts = {}) {
  const db = resolveDb(opts);
  return {
    daily: db.prepare(`
      SELECT DATE(created_at) AS day, SUM(tokens_in) AS in_, SUM(tokens_out) AS out_,
             SUM(cost_credits) AS cost, COUNT(*) AS calls
      FROM cost_ledger GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 30
    `).all(),
    byPhase: db.prepare(`
      SELECT phase, SUM(tokens_in) AS in_, SUM(tokens_out) AS out_,
             SUM(cost_credits) AS cost, COUNT(*) AS calls
      FROM cost_ledger GROUP BY phase ORDER BY cost DESC
    `).all(),
    total: db.prepare(`
      SELECT SUM(tokens_in) AS in_, SUM(tokens_out) AS out_, SUM(cost_credits) AS cost
      FROM cost_ledger
    `).get(),
  };
}

/**
 * 为当前 session 做一个快速估算 (在 Stop hook 中调用)。
 * 实际用量取决于 Claude Code 的 token 计数, 此处按输入+输出字符数估算。
 * @param {string} sessionId
 * @param {string} responseText — Claude 的本次响应文本
 * @param {object} [opts]
 */
function estimate(sessionId, responseText, opts = {}) {
  const db = resolveDb(opts);
  const tokensIn = Math.ceil((responseText.length || 0) * 0.4); // 粗略: 1 token ≈ 2.5 chars
  const tokensOut = Math.ceil((responseText.length || 0) * 0.3);
  const costCredits = (tokensIn + tokensOut) * 0.000003; // Claude Opus 粗估值

  db.prepare(`
    INSERT INTO cost_ledger (session_id, phase, tokens_in, tokens_out, cost_credits, notes, created_at)
    VALUES (?, 'estimate', ?, ?, ?, 'auto-estimate', ?)
  `).run(sessionId, tokensIn, tokensOut, costCredits, new Date().toISOString());
}

module.exports = { recordSession, sessionReport, summary, estimate };
