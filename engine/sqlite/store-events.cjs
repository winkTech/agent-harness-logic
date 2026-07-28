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

const DEFAULT_CONSUMER = 'dream';
const CONSUMER_RUN_STATES = new Set(['success', 'skipped']);

function normalizeConsumer(opts = {}) {
  const consumer = String(opts.consumer || DEFAULT_CONSUMER).trim();
  if (!consumer) throw new TypeError('event consumer must be a non-empty string');
  return consumer;
}

function normalizeRunId(value) {
  const runId = String(value || '').trim();
  if (!runId) throw new TypeError('consumer run id must be a non-empty string');
  return runId.slice(0, 160);
}

function isoTimestamp(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('consumer run timestamp is invalid');
  return date.toISOString();
}

function nonNegativeInteger(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return number;
}

/** Mark a consumer attempt as running without advancing its event watermark. */
function beginConsumerRun(consumer, opts = {}) {
  const db = resolveDb(opts);
  const name = normalizeConsumer({ consumer });
  const runId = normalizeRunId(opts.runId);
  const at = isoTimestamp(opts.at);
  const pending = nonNegativeInteger(opts.pending, 'pending');
  const processedThrough = nonNegativeInteger(
    opts.processedThrough ?? getWatermark({ db, consumer: name }),
    'processedThrough',
  );
  db.prepare(`
    INSERT INTO runtime_consumer_heartbeats (
      consumer, run_id, status, last_started_at, last_completed_at, last_exit,
      processed_through, processed_count, pending_count, next_due_at, last_error, updated_at
    ) VALUES (?, ?, 'running', ?, NULL, NULL, ?, 0, ?, NULL, NULL, ?)
    ON CONFLICT(consumer) DO UPDATE SET
      run_id = excluded.run_id,
      status = 'running',
      last_started_at = excluded.last_started_at,
      last_exit = NULL,
      processed_through = excluded.processed_through,
      processed_count = 0,
      pending_count = excluded.pending_count,
      next_due_at = NULL,
      last_error = NULL,
      updated_at = excluded.updated_at
  `).run(name, runId, at, processedThrough, pending, at);
  return getConsumerRun(name, { db });
}

/** Complete the exact active attempt; stale overlapping attempts cannot overwrite it. */
function completeConsumerRun(consumer, opts = {}) {
  const db = resolveDb(opts);
  const name = normalizeConsumer({ consumer });
  const runId = normalizeRunId(opts.runId);
  const status = String(opts.status || 'success').trim().toLowerCase();
  if (!CONSUMER_RUN_STATES.has(status)) {
    throw new TypeError('completed consumer status must be success or skipped');
  }
  const at = isoTimestamp(opts.at);
  const processedThrough = nonNegativeInteger(opts.processedThrough, 'processedThrough');
  const processed = nonNegativeInteger(opts.processed, 'processed');
  const pending = nonNegativeInteger(opts.pending, 'pending');
  const nextDueAt = opts.nextDueAt == null || opts.nextDueAt === ''
    ? null
    : isoTimestamp(opts.nextDueAt);
  const result = db.prepare(`
    UPDATE runtime_consumer_heartbeats SET
      status = ?,
      last_completed_at = ?,
      last_exit = 0,
      processed_through = ?,
      processed_count = ?,
      pending_count = ?,
      next_due_at = ?,
      last_error = NULL,
      updated_at = ?
    WHERE consumer = ? AND run_id = ? AND status = 'running'
  `).run(status, at, processedThrough, processed, pending, nextDueAt, at, name, runId);
  if (Number(result.changes || 0) !== 1) {
    throw new Error(`consumer run is stale or not running: ${name}/${runId}`);
  }
  return getConsumerRun(name, { db });
}

/** Record a bounded failure without advancing the event watermark. */
function failConsumerRun(consumer, opts = {}) {
  const db = resolveDb(opts);
  const name = normalizeConsumer({ consumer });
  const runId = normalizeRunId(opts.runId);
  const at = isoTimestamp(opts.at);
  const error = String(opts.error?.message || opts.error || 'consumer failed').trim().slice(0, 500);
  const pending = nonNegativeInteger(opts.pending, 'pending');
  const processedThrough = nonNegativeInteger(
    opts.processedThrough ?? getWatermark({ db, consumer: name }),
    'processedThrough',
  );
  const result = db.prepare(`
    UPDATE runtime_consumer_heartbeats SET
      status = 'failed',
      last_completed_at = ?,
      last_exit = 1,
      processed_through = ?,
      processed_count = 0,
      pending_count = ?,
      next_due_at = ?,
      last_error = ?,
      updated_at = ?
    WHERE consumer = ? AND run_id = ? AND status = 'running'
  `).run(at, processedThrough, pending, at, error, at, name, runId);
  if (Number(result.changes || 0) !== 1) {
    throw new Error(`consumer run is stale or not running: ${name}/${runId}`);
  }
  return getConsumerRun(name, { db });
}

function getConsumerRun(consumer, opts = {}) {
  const db = resolveDb(opts);
  const name = normalizeConsumer({ consumer });
  const row = db.prepare(`
    SELECT consumer, run_id, status, last_started_at, last_completed_at, last_exit,
      processed_through, processed_count, pending_count, next_due_at, last_error, updated_at
    FROM runtime_consumer_heartbeats WHERE consumer = ?
  `).get(name);
  if (!row) return null;
  return {
    consumer: row.consumer,
    runId: row.run_id,
    status: row.status,
    lastStartedAt: row.last_started_at,
    lastCompletedAt: row.last_completed_at,
    lastExit: row.last_exit,
    processedThrough: Number(row.processed_through || 0),
    processed: Number(row.processed_count || 0),
    pending: Number(row.pending_count || 0),
    nextDueAt: row.next_due_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function listConsumerRuns(opts = {}) {
  const db = resolveDb(opts);
  return db.prepare('SELECT consumer FROM runtime_consumer_heartbeats ORDER BY consumer').all()
    .map((row) => getConsumerRun(row.consumer, { db }));
}

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

/** Count every event after the supplied watermark without loading payloads. */
function countSinceWatermark(watermark, opts = {}) {
  const db = resolveDb(opts);
  const row = db.prepare(
    'SELECT COUNT(*) AS count FROM runtime_events WHERE event_id > ?',
  ).get(watermark);
  return Number(row?.count || 0);
}

/**
 * 获取当前水印。
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 * @returns {number}
 */
function getWatermark(opts = {}) {
  const db = resolveDb(opts);
  const consumer = normalizeConsumer(opts);
  const row = db.prepare(
    'SELECT watermark FROM runtime_consumer_watermarks WHERE consumer = ?',
  ).get(consumer);
  return row ? row.watermark : 0;
}

/**
 * 设置水印。
 * @param {number} eventId
 */
function setWatermark(eventId, opts = {}) {
  const db = resolveDb(opts);
  const consumer = normalizeConsumer(opts);
  const watermark = Number(eventId);
  if (!Number.isInteger(watermark) || watermark < 0) {
    throw new TypeError('event watermark must be a non-negative integer');
  }
  db.prepare(`
    INSERT INTO runtime_consumer_watermarks (consumer, watermark, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(consumer) DO UPDATE SET
      watermark = excluded.watermark,
      updated_at = excluded.updated_at
  `).run(consumer, watermark);
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

/**
 * Delete events only when every registered consumer has advanced past them
 * and their age exceeds the requested retention window.
 */
function purgeConsumedEvents(retentionDays = 30, opts = {}) {
  const db = resolveDb(opts);
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 0) {
    throw new TypeError('event retention days must be a non-negative number');
  }
  const state = db.prepare(`
    SELECT COUNT(1) AS consumers, MIN(watermark) AS safe_watermark
    FROM runtime_consumer_watermarks
  `).get();
  const consumers = Number(state?.consumers || 0);
  const safeWatermark = consumers > 0 ? Number(state.safe_watermark || 0) : 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  if (consumers === 0 || safeWatermark <= 0) {
    return { deleted: 0, safeWatermark, consumers, cutoff };
  }
  const result = db.prepare(`
    DELETE FROM runtime_events
    WHERE event_id <= ? AND created_at < ?
  `).run(safeWatermark, cutoff);
  return { deleted: Number(result.changes || 0), safeWatermark, consumers, cutoff };
}

module.exports = {
  record,
  sinceWatermark,
  countSinceWatermark,
  getWatermark,
  setWatermark,
  countByType,
  recentSummary,
  purgeConsumedEvents,
  beginConsumerRun,
  completeConsumerRun,
  failConsumerRun,
  getConsumerRun,
  listConsumerRuns,
  DEFAULT_CONSUMER,
};
