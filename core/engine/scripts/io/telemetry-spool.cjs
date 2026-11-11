'use strict';

/**
 * core/engine/scripts/io/telemetry-spool.cjs — 遥测 spool writer（Phase 2.5 / §3.6）
 *
 * hook 入口同步短超时下的"快事"：原始事件 JSON 追加写
 * `<stateRoot>/telemetry/spool-<YYYY-MM-DD>.jsonl`（append-only、按日滚动、
 * 单文件大小上限滚动序号）。亚毫秒级——一次 appendFileSync，无 DB、无索引。
 *
 * 消费侧（telemetry-spool-drain 消费者）负责 spool→events 搬运与水位推进；
 * 本模块只写。防写开关（NO_PERSIST/VERIFY_READONLY/NO_DIAGNOSTIC_WRITES）命中时
 * 静默跳过（返回 { skipped: true }），与既有 hook 遥测守卫语义一致。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 单文件大小上限（字节）。超过后当日滚动为 spool-<date>-N.jsonl。
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// 每行 payload 序列化截断上限（防单条巨事件拖垮 append）。
const MAX_LINE_BYTES = 256 * 1024;

function localDateStamp(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 解析 spool 目录。优先级：opts.dir → env.HARNESS_TELEMETRY_SPOOL_DIR →
 * <stateRoot>/telemetry（harness-state 的 varPath 惰性求值，测试可注入 dir）。
 */
function spoolDir(opts = {}) {
  if (opts.dir) return path.resolve(opts.dir);
  const fromEnv = process.env.HARNESS_TELEMETRY_SPOOL_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  const { varPath } = require('../lib/harness-state.cjs');
  return varPath('telemetry');
}

/** 当日 spool 文件路径（存在超限文件时滚动 -N 序号）。只读探测，不创建。 */
function currentSpoolFile(dir, dateStamp = localDateStamp(), maxBytes = MAX_FILE_BYTES) {
  const base = path.join(dir, `spool-${dateStamp}.jsonl`);
  let candidate = base;
  let seq = 1;
  while (fs.existsSync(candidate)) {
    let size = 0;
    try { size = fs.statSync(candidate).size; } catch { break; }
    if (size < maxBytes) return candidate;
    candidate = path.join(dir, `spool-${dateStamp}-${seq}.jsonl`);
    seq += 1;
  }
  return candidate;
}

/**
 * 追加一条遥测事件到 spool（热路径）。
 * @param {object} event — 任意可 JSON 序列化对象（建议含 type/timestamp/sessionId）
 * @param {object} [opts] — { dir, now } 注入测试
 * @returns {{ skipped?: true, wrote: boolean, file?: string, bytes?: number, truncated?: boolean }}
 */
function appendToSpool(event, opts = {}) {
  if (persistenceDisabled()) return { skipped: true, wrote: false };
  let line;
  try {
    line = JSON.stringify(event && typeof event === 'object' ? event : { event: String(event) });
  } catch {
    line = JSON.stringify({ event: 'unserializable', ts: isoNow(opts.now) });
  }
  let truncated = false;
  if (line.length > MAX_LINE_BYTES) {
    line = JSON.stringify({ truncated: true, type: event?.type, ts: isoNow(opts.now) });
    truncated = true;
  }
  const dir = spoolDir(opts);
  const file = currentSpoolFile(dir, localDateStamp(opts.now));
  let wrote = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
    wrote = true;
  } catch {
    // spool 是尽力而为的兜底通道：磁盘不可写时不拖垮 hook 主路径。
    return { wrote: false, truncated };
  }
  return { wrote: true, file, bytes: line.length + 1, truncated };
}

/** 列出 spool 目录全部文件（升序——日期字典序即消费顺序）。 */
function listSpoolFiles(opts = {}) {
  const dir = spoolDir(opts);
  try {
    return fs.readdirSync(dir)
      .filter((n) => /^spool-\d{4}-\d{2}-\d{2}(-\d+)?\.jsonl$/.test(n))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * 逐行读取一个 spool 文件（惰性生成器）。坏行（非法 JSON）产出
 * { __bad: true, line }，由消费侧决定跳过策略。
 */
function* readSpoolLines(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { yield { __bad: true, line: line.slice(0, 200) }; }
  }
}

/** 把文件截断为已消费（消费成功后调用；保留文件避免 writer/consumer 竞争重建同名混淆）。 */
function markConsumed(file) {
  try {
    fs.writeFileSync(file, '', 'utf8');
    return true;
  } catch { return false; }
}

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function persistenceDisabled() {
  // 双名兼容读（Phase 2.4：宿主名映射集中在 io/env.cjs）。
  const { envValue } = require('./env.cjs');
  const flag = (name) => {
    const v = envValue(process.env, name);
    return v === '1' || v === 'true';
  };
  return flag('HARNESS_NO_PERSIST') || flag('HARNESS_VERIFY_READONLY')
    || flag('HARNESS_NO_DIAGNOSTIC_WRITES');
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  localDateStamp,
  spoolDir,
  currentSpoolFile,
  appendToSpool,
  listSpoolFiles,
  readSpoolLines,
  markConsumed,
};
