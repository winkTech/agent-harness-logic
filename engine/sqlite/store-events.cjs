'use strict';

/**
 * engine/sqlite/store-events.cjs — 运行时事件仓库 (Dream 自学习的输入源)。
 *
 * 用法:
 *   const events = require('./store-events.cjs');
 *   events.record({ sessionId: 's1', type: 'tool_fail', payload: { tool: 'vlog', error: '...' } });
 *   const items = events.sinceWatermark(0, 20);
 *   events.setWatermark(42);
 */

const { openDb, resolveDb } = require('./index.cjs');

/**
 * 记录一条运行时事件。
 *
 * @param {object} signal
 * @param {string} signal.sessionId      — session 标识
 * @param {string} signal.type           — 'drift_stuck'|'tool_fail'|'user_correct'|'hard_problem'|'memory_miss'|'skill_trigger'
 * @param {object} [signal.payload]       — 事件详情 (JSON 对象)
 * @param {string} [createdAt]            — 测试用注入时间
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 * @returns {number} event_id
 */
function record(signal, createdAt, opts = {}) {
  const db = resolveDb(opts);
  const at = createdAt || new Date().toISOString();

  const stmt = db.prepare(
    'INSERT INTO runtime_events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)',
  );
  const result = stmt.run(signal.sessionId, signal.type, JSON.stringify(signal.payload || {}), at);
  return Number(result.lastInsertRowid);
}

/**
 * 从指定水印之后拉取事件。
 *
 * @param {number} watermark  — 上次消费的 event_id
 * @param {number} [limit]    — 最多拉取条数 (默认 50)
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 * @returns {Array<{ eventId: number; sessionId: string; type: string; payload: object; createdAt: string }>}
 */
function sinceWatermark(watermark, limit = 50, opts = {}) {
  const db = resolveDb(opts);
  const rows = db.prepare(
    'SELECT event_id, session_id, type, payload, created_at FROM runtime_events WHERE event_id > ? ORDER BY event_id ASC LIMIT ?',
  ).all(watermark, limit);

  return rows.map(r => ({
    eventId: r.event_id,
    sessionId: r.session_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
  }));
}

/**
 * 获取当前水印。
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 * @returns {number}
 */
function getWatermark(opts = {}) {
  const db = resolveDb(opts);
  const row = db.prepare('SELECT watermark FROM runtime_watermark WHERE id = 1').get();
  return row ? row.watermark : 0;
}

/**
 * 设置水印。
 * @param {number} eventId
 */
function setWatermark(eventId, opts = {}) {
  const db = resolveDb(opts);
  db.prepare('UPDATE runtime_watermark SET watermark = ? WHERE id = 1').run(eventId);
}

/**
 * 按类型统计事件数。
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 * @returns {Array<{ type: string; count: number }>}
 */
function countByType(opts = {}) {
  const db = resolveDb(opts);
  return db.prepare(
    'SELECT type, COUNT(*) AS count FROM runtime_events GROUP BY type ORDER BY count DESC',
  ).all();
}

/**
 * 过去 N 小时内的事件摘要。
 * @param {number} [hours] — 回溯小时数 (默认 24)
 * @returns {Array<{ type: string; count: number }>}
 */
function recentSummary(hours = 24, opts = {}) {
  const db = resolveDb(opts);
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  return db.prepare(
    'SELECT type, COUNT(*) AS count FROM runtime_events WHERE created_at > ? GROUP BY type ORDER BY count DESC',
  ).all(cutoff);
}

module.exports = {
  record,
  sinceWatermark,
  getWatermark,
  setWatermark,
  countByType,
  recentSummary,
};
