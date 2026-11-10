#!/usr/bin/env node
/**
 * engine/scripts/dream-startup-inject.cjs — P3+P4: Dream 调度修复 + 闭环注入
 *
 * 在 SessionStart 时执行:
 *   1. 检查是否有未处理的事件（since watermark）
 *   2. 如果事件数 ≥ 阈值，有界运行 dream-consolidate 并推进 Dream 独立水印
 *   3. 检索最近 90 天内的 Dream 待审候选
 *   4. 输出摘要注入到当前 session 上下文
 *
 * 每次 Claude 启动时自动检查、消费和注入，不依赖外部 cron。
 *
 * 注册:
 *   settings.local.json SessionStart
 *
 * 输出格式 (JSON 行):
 *   { source: "dream-startup-inject", type: "dream-check", ... }
 *
 * 无新事件 + 无近期产出 → 无输出 (0 token 开销)
 */

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const HARNESS = HARNESS_ROOT;
const DREAM_SCRIPT = path.join(HARNESS, 'engine', 'scripts', 'dream-consolidate.cjs');
const EVENTS_STORE = path.join(HARNESS, 'engine', 'sqlite', 'store-events.cjs');
const DB_INDEX = path.join(HARNESS, 'engine', 'sqlite', 'index.cjs');

// 最少事件数才触发 Dream 运行 (v2: 10→5, 日均 ~5 条事件的节奏下每 session 都有机会触发)
const MIN_EVENTS_THRESHOLD = 5;

// ── 检查未处理事件数 ─────────────────────────────────────────────────────────

function getUnprocessedEventCount(opts = {}) {
  let wDb = null;
  try {
    const { openDb } = require(DB_INDEX);
    const { countSinceWatermark, getWatermark } = require(EVENTS_STORE);
    if (!opts.db) wDb = openDb(opts.dbPath ? { path: opts.dbPath } : {});
    const db = opts.db || wDb.db;
    const watermark = getWatermark({ db, consumer: 'dream' });
    return { count: countSinceWatermark(watermark, { db }), watermark };
  } catch {
    return { count: 0, watermark: 0 };
  } finally {
    if (wDb) wDb.close();
  }
}

// ── 获取近期 Dream 学习产出 ──────────────────────────────────────────────────

function getRecentDreamLearnings(daysBack = 90, opts = {}) {
  let wDb = null;
  try {
    const { openDb } = require(DB_INDEX);
    const { retrieveMemorySummary } = require('../sqlite/store-memory.cjs');
    const { memoryScopeFromPayload } = require('./lib/project-scope.cjs');
    if (!opts.db) {
      wDb = openDb({ ...(opts.dbPath ? { path: opts.dbPath } : {}), readonly: true });
    }
    const db = opts.db || wDb.db;
    const requestedDays = Number(daysBack);
    const boundedDays = Number.isFinite(requestedDays) ? Math.max(0, requestedDays) : 90;
    const parsedNow = opts.now instanceof Date ? opts.now.getTime() : Date.parse(String(opts.now || ''));
    const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
    const createdCutoff = nowMs - boundedDays * 86_400_000;
    const derived = memoryScopeFromPayload(opts.payload || { cwd: opts.cwd || process.cwd() });
    const scope = opts.scope || {
      projectId: derived.projectId,
      relativePath: derived.relativePath,
      triggerKind: 'session_start',
      triggerSignature: null,
    };
    const rows = retrieveMemorySummary('Dream learning', {
      db,
      namespaces: ['learnings'],
      limit: 25,
      maxChars: 240,
      minConfidence: 0.8,
      trackHit: false,
      now: nowMs,
      scope,
    }).filter(r => r.source === 'script:dream'
      && Number(r.created_at || 0) >= createdCutoff)
      .slice(0, 5);

    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.summary,
      confidence: r.confidence,
      source: r.source,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  } finally {
    if (wDb) wDb.close();
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

function runStartup(opts = {}) {
  const { openDb } = require(DB_INDEX);
  const eventStore = require(EVENTS_STORE);
  const wDb = opts.db ? null : openDb(opts.dbPath ? { path: opts.dbPath } : {});
  const db = opts.db || wDb.db;
  const runtimeOpts = { ...opts, db };
  const runId = String(opts.runId || crypto.randomUUID());
  const threshold = Number.isFinite(Number(opts.minEvents))
    ? Math.max(1, Math.trunc(Number(opts.minEvents)))
    : MIN_EVENTS_THRESHOLD;
  const initial = getUnprocessedEventCount(runtimeOpts);
  eventStore.beginConsumerRun('dream', {
    db,
    runId,
    pending: initial.count,
    processedThrough: initial.watermark,
    at: opts.now,
  });
  let pendingEvents = initial.count;
  let dreamResult = null;
  let dreamError = '';

  try {
    if (pendingEvents >= threshold) {
      try {
        const runDream = opts.runDream || require(DREAM_SCRIPT).runDream;
        dreamResult = runDream({
          db,
          dbPath: opts.dbPath,
          maxEvents: opts.maxEvents,
          logger: typeof opts.logger === 'function' ? opts.logger : () => {},
        });
        pendingEvents = dreamResult.pending;
      } catch (err) {
        dreamError = String(err.message || err).slice(0, 200);
      }
    }

    const recentLearnings = getRecentDreamLearnings(opts.daysBack ?? 90, runtimeOpts);
    const watermarkAfter = dreamResult?.watermarkAfter ?? initial.watermark;
    if (dreamError) {
      eventStore.failConsumerRun('dream', {
        db,
        runId,
        error: dreamError,
        pending: pendingEvents,
        processedThrough: watermarkAfter,
        at: opts.now,
      });
    } else {
      const completedAt = opts.now == null ? Date.now() : new Date(opts.now).getTime();
      eventStore.completeConsumerRun('dream', {
        db,
        runId,
        status: dreamResult ? 'success' : 'skipped',
        processedThrough: watermarkAfter,
        processed: dreamResult?.processed || 0,
        pending: pendingEvents,
        nextDueAt: pendingEvents > 0 ? completedAt + 86_400_000 : null,
        at: opts.now,
      });
    }

    if (initial.count < threshold && recentLearnings.length === 0 && !dreamError) return null;

    const result = {
      source: 'dream-startup-inject',
      type: 'dream-check',
      initialPendingEvents: initial.count,
      pendingEvents,
      watermark: initial.watermark,
      dreamTriggered: Boolean(dreamResult),
    };
    if (dreamResult) result.dream = dreamResult;
    if (dreamError) result.dreamError = dreamError;
    if (recentLearnings.length > 0) {
      result.recentDreamLearnings = recentLearnings.map(learning => ({
        name: learning.name,
        desc: String(learning.description || '').replace(/^Dream candidate: /, ''),
        confidence: learning.confidence,
      }));
    }

    const briefParts = [];
    if (dreamResult) briefParts.push(`📊 Dream 已处理 ${dreamResult.processed}，剩余 ${dreamResult.pending}`);
    else if (pendingEvents > 0) briefParts.push(`📊 ${pendingEvents} 个事件待 Dream 分析`);
    if (recentLearnings.length > 0) briefParts.push(`💡 ${recentLearnings.length} 条已验证 Dream 经验`);
    result.brief = briefParts.join(' · ');
    return result;
  } catch (error) {
    try {
      const current = eventStore.getConsumerRun('dream', { db });
      if (current?.runId === runId && current.status === 'running') {
        eventStore.failConsumerRun('dream', {
          db,
          runId,
          error,
          pending: pendingEvents,
          processedThrough: initial.watermark,
          at: opts.now,
        });
      }
    } catch { /* health will expose a missing or stale heartbeat */ }
    throw error;
  } finally {
    if (wDb) wDb.close();
  }
}

function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node engine/scripts/dream-startup-inject.cjs');
    return null;
  }
  const result = runStartup();
  if (result) console.log(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  main();
}

module.exports = {
  getUnprocessedEventCount,
  getRecentDreamLearnings,
  runStartup,
  MIN_EVENTS_THRESHOLD,
};
