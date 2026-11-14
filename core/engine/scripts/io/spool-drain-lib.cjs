'use strict';

/**
 * core/engine/scripts/io/spool-drain-lib.cjs — spool 搬运核心（Phase 2.5）
 *
 * 独立于 CLI 壳，供 SessionStart/Stop 维护路径直接调用（无子进程开销）：
 *   const { drainSpool } = require('../io/spool-drain-lib.cjs');
 *   drainSpool({ consumerId: 'telemetry-spool-drain' });
 *
 * consumerRegistry 五件套语义见 telemetry-spool-drain.cjs 头注。
 * 全部 IO 失败 fail-soft：spool 是兜底通道，消费失败不阻塞宿主事件路径；
 * 错误细节进 errors[] 并写 failConsumerRun 心跳。
 */

const {
  listSpoolFiles, readSpoolLines, markConsumed,
} = require('./telemetry-spool.cjs');
const fs = require('node:fs');

/** 行级续搬：spool 文件的已消费字节偏移记在伴生 .pos 文件（同目录 + '.pos'）。 */
function readOffset(posFile) {
  try { return Number(fs.readFileSync(posFile, 'utf8').trim()) || 0; } catch { return 0; }
}

function writeOffset(posFile, offset) {
  try { fs.writeFileSync(posFile, String(offset), 'utf8'); } catch { /* 尽力而为 */ }
}

/** 逐行产出 { event, lineStart, lineEnd }——line* 供部分消费后续搬。 */
function* readSpoolLinesWithOffset(file, fromOffset = 0) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  let pos = fromOffset;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    const lineEnd = end + 1; // 含换行
    if (line.trim()) {
      let event;
      try { event = JSON.parse(line); } catch { event = { __bad: true, line: line.slice(0, 200) }; }
      yield { event, lineStart: pos, lineEnd };
    }
    pos = lineEnd;
  }
}

function defaultDeps() {
  const events = require('../../sqlite/store-events.cjs');
  const { openDb } = require('../../sqlite/index.cjs');
  return { events, openDb };
}

/**
 * 搬运 spool → events。
 * @param {object} opts
 * @param {string} [opts.consumerId='telemetry-spool-drain'] — 心跳记账键
 * @param {boolean} [opts.dryRun] — 只读：不写库、不心跳、不截断
 * @param {number} [opts.batchLimit=500] — 单次搬运上限
 * @param {number} [opts.msBudget=2000] — 单次时间预算（超时收工，保留余量）
 * @param {object} [opts.deps] — 注入测试（events/openDb）
 * @param {string} [opts.spoolDir] — 注入测试 spool 目录
 */
function drainSpool(opts = {}) {
  const consumerId = opts.consumerId || 'telemetry-spool-drain';
  const batchLimit = opts.batchLimit || 500;
  const msBudget = opts.msBudget || 2000;
  const dryRun = Boolean(opts.dryRun);
  const deps = opts.deps || defaultDeps();
  const startedAt = Date.now();

  const result = {
    ok: true, moved: 0, dropped: 0, watermark: null,
    heartbeat: dryRun ? 'dry-run' : 'none', files: 0, errors: [],
  };
  const files = listSpoolFiles(opts.spoolDir ? { dir: opts.spoolDir } : {});
  if (dryRun && files.length === 0) return result;

  let handle = null;
  const runId = `spool-drain-${startedAt}-${process.pid}`;
  try {
    if (!dryRun) handle = deps.openDb({});
    const dbopt = handle ? { db: handle, runId } : { runId };

    if (!dryRun) {
      deps.events.beginConsumerRun(consumerId, dbopt);
    }
    if (files.length === 0) {
      // 空转也要闭合心跳+水位——消费者健康语义是"跑过"，不是"有活干"。
      if (!dryRun) {
        const current = deps.events.getWatermark(handle ? { db: handle, consumer: consumerId } : { consumer: consumerId });
        deps.events.setWatermark(current, handle ? { db: handle, consumer: consumerId } : { consumer: consumerId });
        result.watermark = current;
        deps.events.completeConsumerRun(consumerId, {
          status: 'success', runId, processedThrough: current,
          processed: 0, pending: 0,
          ...(handle ? { db: handle } : {}),
        });
        result.heartbeat = 'completed';
      }
      return result;
    }

    let consumedAll = true;
    outer: for (const file of files) {
      result.files += 1;
      const posFile = `${file}.pos`;
      const startOffset = readOffset(posFile);
      let offset = startOffset;
      for (const { event: line, lineEnd } of readSpoolLinesWithOffset(file, startOffset)) {
        if (result.moved >= batchLimit || Date.now() - startedAt > msBudget) {
          consumedAll = false;
          // 预算/批量耗尽——先固化本文件进度再退出（break 跳过后面的统一写）。
          if (!dryRun) writeOffset(posFile, offset);
          break outer;
        }
        offset = lineEnd;
        if (line.__bad) { result.dropped += 1; continue; }
        if (dryRun) { result.moved += 1; continue; }
        try {
          deps.events.record(
            {
              sessionId: line.sessionId || 'spool-anonymous',
              type: line.type || 'spool.unknown',
              payload: line.payload !== undefined ? line.payload : line,
            },
            line.timestamp || line.ts,
            dbopt,
          );
          result.moved += 1;
        } catch (e) {
          result.dropped += 1;
          result.errors.push(`record failed: ${e.message}`);
        }
      }
      // 行级续搬：已消费到 offset——全消费清空文件与偏移，部分消费保留偏移。
      if (!dryRun) {
        if (offset >= (fs.existsSync(file) ? fs.statSync(file).size : 0)) {
          markConsumed(file);
          try { fs.rmSync(posFile, { force: true }); } catch { /* */ }
        } else {
          writeOffset(posFile, offset);
        }
      }
    }

    if (!dryRun) {
      // 水位推进：本 consumer 名下 watermark = 搬运入库后的最大 event_id。
      const maxRow = handle.db
        ? handle.db.prepare('SELECT COALESCE(MAX(event_id), 0) m FROM runtime_events').get()
        : handle.prepare('SELECT COALESCE(MAX(event_id), 0) m FROM runtime_events').get();
      result.watermark = Number(maxRow.m || 0);
      deps.events.setWatermark(result.watermark, handle ? { db: handle, consumer: consumerId } : { consumer: consumerId });
      deps.events.completeConsumerRun(consumerId, {
        status: 'success',
        runId,
        processedThrough: result.watermark,
        processed: result.moved,
        pending: result.dropped,
        ...(handle ? { db: handle } : {}),
      });
      result.heartbeat = 'completed';
    }
  } catch (e) {
    result.ok = false;
    result.errors.push(e.message);
    if (!dryRun && handle) {
      try {
        deps.events.failConsumerRun(consumerId, { error: e.message, runId, db: handle });
        result.heartbeat = 'failed';
      } catch { /* 心跳失败不掩盖主错误 */ }
    }
  } finally {
    if (handle) { try { handle.close(); } catch { /* 已关 */ } }
  }
  return result;
}

module.exports = { drainSpool };
