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
  listSpoolFiles, markConsumed,
} = require('./telemetry-spool.cjs');
const fs = require('node:fs');

/** .pos 保留以 UTF-16 代码单元计数的偏移，与已写入的断点兼容。 */
function readOffset(posFile) {
  try {
    const offset = Number(fs.readFileSync(posFile, 'utf8').trim());
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return 0;
  }
}

function writeOffset(posFile, offset) {
  fs.writeFileSync(posFile, String(offset), 'utf8');
}

/** 逐行产出 { event, lineEnd }，用于从部分消费的文件续搬。 */
function* readSpoolLinesWithOffset(text, fromOffset) {
  let pos = fromOffset;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    const lineEnd = nl === -1 ? end : end + 1;
    if (line.trim()) {
      let event;
      try { event = JSON.parse(line); } catch { event = { __bad: true, line: line.slice(0, 200) }; }
      yield { event, lineEnd };
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
  let handle = null;
  let pending = 0;
  const runId = `spool-drain-${startedAt}-${process.pid}`;
  try {
    if (!dryRun) handle = deps.openDb({});
    const dbopt = handle ? { db: handle, runId } : { runId };

    if (!dryRun) {
      deps.events.beginConsumerRun(consumerId, dbopt);
    }
    const files = listSpoolFiles({ dir: opts.spoolDir, strict: true });
    outer: for (const file of files) {
      result.files += 1;
      const posFile = `${file}.pos`;
      const text = fs.readFileSync(file, 'utf8');
      const savedOffset = readOffset(posFile);
      const startOffset = savedOffset <= text.length ? savedOffset : 0;
      let offset = startOffset;
      for (const { event: line, lineEnd } of readSpoolLinesWithOffset(text, startOffset)) {
        if (result.moved >= batchLimit || Date.now() - startedAt > msBudget) {
          pending = 1;
          // 预算/批量耗尽——先固化本文件进度再退出（break 跳过后面的统一写）。
          if (!dryRun) writeOffset(posFile, offset);
          break outer;
        }
        if (line.__bad || dryRun) {
          offset = lineEnd;
          if (line.__bad) result.dropped += 1;
          else result.moved += 1;
          continue;
        }
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
        } catch (e) {
          pending = 1;
          if (offset !== startOffset) writeOffset(posFile, offset);
          throw new Error(`record failed: ${e.message}`, { cause: e });
        }
        offset = lineEnd;
        result.moved += 1;
      }
      // 行级续搬：已消费到 offset——全消费清空文件与偏移，部分消费保留偏移。
      if (!dryRun) {
        if (fs.statSync(file).size === Buffer.byteLength(text, 'utf8')) {
          if (text.length > 0 && !markConsumed(file)) {
            writeOffset(posFile, text.length);
            throw new Error(`cannot clear drained spool file: ${file}`);
          }
          fs.rmSync(posFile, { force: true });
        } else {
          pending = 1;
          writeOffset(posFile, text.length);
        }
      }
    }

    if (!dryRun) {
      const checkpoint = { db: handle, consumer: consumerId };
      const current = deps.events.getWatermark(checkpoint);
      result.watermark = current;
      if (pending === 0) {
        // Spool 只向 SQLite 写入，来源是文件。确认 spool 已清空后才记录 SQLite 高水位快照。
        const db = handle.db || handle;
        const maxRow = db.prepare('SELECT COALESCE(MAX(event_id), 0) m FROM runtime_events').get();
        result.watermark = Math.max(current, Number(maxRow.m || 0));
      }
      deps.events.setWatermark(result.watermark, checkpoint);
      deps.events.completeConsumerRun(consumerId, {
        status: 'success',
        runId,
        processedThrough: result.watermark,
        processed: result.moved,
        pending,
        ...(handle ? { db: handle } : {}),
      });
      result.heartbeat = 'completed';
    }
  } catch (e) {
    result.ok = false;
    result.errors.push(e.message);
    if (!dryRun && handle) {
      try {
        deps.events.failConsumerRun(consumerId, { error: e.message, runId, db: handle, pending });
        result.heartbeat = 'failed';
      } catch { /* 心跳失败不掩盖主错误 */ }
    }
  } finally {
    if (handle) { try { handle.close(); } catch { /* 已关 */ } }
  }
  return result;
}

module.exports = { drainSpool };
