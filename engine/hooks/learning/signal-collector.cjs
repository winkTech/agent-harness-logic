#!/usr/bin/env node

/**
 * Hook: signal-collector.cjs — v2.0
 *
 * 统一信号采集器。从多个 hook 时机采集运行时信号，写入 SQLite event 表。
 * 轻量 + 静默失败：从不阻塞 hook 链。
 *
 * v2.0 新增:
 *   - 6 种新信号类型（rule_load / context_pressure / mode_switch / memory_cross_ref / session_handoff / loop_skip）
 *   - 导出 emit() 函数，供其他模块直接导入调用（无需走 CLI）
 *
 * 用法 (settings.local.json 中注册):
 *
 *   PostToolUseFailure:
 *     node engine/hooks/learning/signal-collector.cjs tool_fail
 *
 *   PostMessage:
 *     node engine/hooks/learning/signal-collector.cjs drift_stuck {检测到"不对"/"又错了"关键词}
 *
 * 程序内调用:
 *   const { emit } = require('./engine/hooks/learning/signal-collector.cjs');
 *   await emit('rule_load', { file: '01-hdl.md', priority: 'L1' });
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

// 检测 sentinel
const FRUSTRATION_PATTERNS = [
  /\b不对\b/, /\b又错了\b/, /\b还是不行\b/, /\b没用\b/,
  /\b错了\b/, /\b错误\b/, /\b失败\b/, /\b怎么又\b/,
  /\bwrong\b/i, /\bfail\b/i, /\bincorrect\b/i, /\bstill not\b/i,
  /\bnot working\b/i, /\bdidn't work\b/i,
];

const MEMORY_QUERY_PATTERNS = [
  /\b我记得\b/, /\b以前\b/, /\b之前做过\b/, /\b之前怎么\b/,
  /\b我记得有个\b/, /\b查一下\b/, /\b我记得有\b/,
];

// ── 信号类型定义 v2.0 ──────────────────────────────────────────────────────

const SIGNAL_TYPES = {
  // 原有
  tool_fail:       { label: '工具失败' },
  drift_stuck:     { label: '卡住/挫败' },
  user_correct:    { label: '用户纠正' },
  hard_problem:    { label: '攻克难题' },
  memory_miss:     { label: '记忆未命中' },

  // v2.0 新增 — 来自本次审计修复的新模块
  rule_load:       { label: '规则加载' },
  context_pressure:{ label: '上下文压力' },
  mode_switch:     { label: '推理模式切换' },
  memory_cross_ref:{ label: '记忆交叉检索' },
  session_handoff: { label: 'Session交接' },
  loop_skip:       { label: '循环跳过' },
};

// ── 工具函数 ───────────────────────────────────────────────────────────────

function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || `s-${Date.now()}`;
}

// ── emitSync() — 同步版，供 CLI hook 脚本使用 ─────────────────────────────

/**
 * 同步版 emit。CLI hook 脚本可以直接调用，无需 await。
 * 底层 SQLite 操作是同步的（node:sqlite），所以 emitSync 是可行的。
 *
 * @param {string} type
 * @param {object} [payload={}]
 * @param {object} [opts]
 * @returns {boolean}
 */
function emitSync(type, payload = {}, opts = {}) {
  if (!type || !SIGNAL_TYPES[type]) return false;

  try {
    const { record } = require('../../sqlite/store-events.cjs');
    const { openDb } = require('../../sqlite/index.cjs');

    const wDb = openDb();
    record({
      sessionId: opts.sessionId || getSessionId(),
      type,
      payload: { ...payload, _v: 2 },
    }, null, { db: wDb.db });
    wDb.close();
    return true;
  } catch {
    return false;
  }
}

// ── emit() — 异步版 ────────────────────────────────────────────────────────

/**
 * 轻量发射信号。供其他模块直接导入调用。
 *
 * @param {string} type - 信号类型，必须是 SIGNAL_TYPES 的 key
 * @param {object} [payload={}] - 信号负载（会被写入 events.payload）
 * @param {object} [opts]
 * @param {string} [opts.sessionId] - 默认从环境变量读
 * @returns {Promise<boolean>} 是否成功写入
 */
async function emit(type, payload = {}, opts = {}) {
  if (!type || !SIGNAL_TYPES[type]) return false;

  try {
    const { record } = require('../../sqlite/store-events.cjs');
    const { openDb } = require('../../sqlite/index.cjs');

    const wDb = openDb();
    record({
      sessionId: opts.sessionId || getSessionId(),
      type,
      payload: { ...payload, _v: 2 },
    }, null, { db: wDb.db });
    wDb.close();
    return true;
  } catch {
    return false; // 静默失败
  }
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const signalType = args[0];
  const extraInfo = args[1] || '';

  if (!signalType || !SIGNAL_TYPES[signalType]) {
    return; // 静默忽略
  }

  try {
    const { record } = require('../../sqlite/store-events.cjs');
    const { openDb } = require('../../sqlite/index.cjs');

    let stdin = '';
    try {
      stdin = fs.readFileSync(0, 'utf8');
    } catch { /* ignore */ }

    let payload = { extra: extraInfo, _v: 2 };

    if (signalType === 'tool_fail') {
      const toolMatch = stdin.match(/"tool"\s*:\s*"([^"]+)"/);
      const errorMatch = stdin.match(/"error"\s*:\s*"([^"]+)"/);
      if (toolMatch) payload.tool = toolMatch[1];
      if (errorMatch) payload.error = errorMatch[1].slice(0, 200);
      payload.stdinPreview = stdin.slice(0, 500);
    }

    if (signalType === 'drift_stuck' && extraInfo) {
      payload.matchedPattern = extraInfo.slice(0, 100);
    }

    const wDb = openDb();
    record({
      sessionId: getSessionId(),
      type: signalType,
      payload,
    }, null, { db: wDb.db });
    wDb.close();
  } catch {
    // 静默失败
  }
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

// 直接运行 → CLI 模式
if (require.main === module) {
  main();
}

// 被 require → 导出 emit() 供程序内调用
module.exports = { emit, emitSync, SIGNAL_TYPES };
