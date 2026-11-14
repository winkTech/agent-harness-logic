'use strict';

/**
 * core/engine/scripts/lib/hook-health.cjs — hook 健康遥测（错误遏制面）。
 *
 * 背景：progress-watchdog 的 varPath ReferenceError 曾被包装成工具错误存活 11 天、
 * 造成 302 次工具调用失败。本模块给 hot-path hook 提供统一的健康事件流：
 * 每次调用一行 JSONL（ok / error / fail-open），让"hook 内部错误"从不可见的
 * 工具错误包装变成可观测的一等信号。
 *
 * 设计约束（遥测不得反噬 hook）：
 *   - recordHealth 整体包 try/catch —— 任何输入/IO 异常下遥测自身绝不抛出；
 *   - 热路径只做一次 JSONL append（目录缺失时才 mkdir+重试一次）；
 *   - 只读环境（NO_PERSIST 等）零写入，判据与 hook-latency.cjs 完全一致。
 */

const fs = require('node:fs');
const path = require('node:path');
const { varPath } = require('./harness-state.cjs');

// Phase 2.4：防写开关双名兼容（宿主名映射集中在 io/env.cjs，本文件不出现宿主词）。
const { envValue } = require('../io/env.cjs');
function envFlag(name) {
  const v = envValue(process.env, name);
  return v === '1' || v === 'true';
}

const STORE_FILE = varPath('metrics', 'hook-health.jsonl');
/** 单条 error 文本截断上限，防止超长 stack 撑爆 JSONL。 */
const ERROR_TEXT_LIMIT = 2000;
const OUTCOMES = new Set(['ok', 'error', 'fail-open']);

function persistenceDisabled() {
  return envFlag('HARNESS_NO_PERSIST')
    || envFlag('HARNESS_VERIFY_READONLY')
    || envFlag('HARNESS_NO_DIAGNOSTIC_WRITES')
    || process.env.CLAUDE_HOOK_NO_WRITE === '1';
}

/**
 * 记一条 hook 健康事件。任何失败静默 —— 遥测绝不能影响 hook 本体。
 * @param {{hook?: string, event?: string, outcome?: string, ms?: number|null, error?: string|null}} entry
 * @param {{file?: string}} [opts] file 覆盖仅供契约测试注入临时目录。
 */
function recordHealth(entry, opts = {}) {
  try {
    if (persistenceDisabled()) return;
    const source = entry && typeof entry === 'object' ? entry : {};
    const record = {
      ts: new Date().toISOString(),
      hook: String(source.hook || 'unknown'),
      event: String(source.event || ''),
      outcome: OUTCOMES.has(source.outcome) ? source.outcome : 'error',
      ms: Number.isFinite(source.ms) ? Math.max(0, Math.round(source.ms)) : null,
      error: source.error == null ? null : String(source.error).slice(0, ERROR_TEXT_LIMIT),
    };
    const file = String(opts.file || STORE_FILE);
    const line = `${JSON.stringify(record)}\n`;
    try {
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, 'utf8');
    }
  } catch { /* 静默 —— 遥测绝不抛异常 */ }
}

/** 按文件顺序读取健康事件（损坏行跳过）。诊断与契约测试用。 */
function readHealthLog(opts = {}) {
  const file = String(opts.file || STORE_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch { /* 跳过损坏行 */ }
  }
  return entries;
}

module.exports = {
  recordHealth,
  readHealthLog,
  STORE_FILE,
};
