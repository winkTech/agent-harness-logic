#!/usr/bin/env node

/**
 * Hook: signal-collector.cjs
 *
 * 统一信号采集器。从多个 hook 时机采集运行时信号, 写入 SQLite event 表。
 * 轻量 + 静默失败: 从不阻塞 hook 链。
 *
 * 用法 (settings.local.json 中注册):
 *
 *   PostToolUseFailure:
 *     node engine/hooks/learning/signal-collector.cjs tool_fail
 *
 *   PostMessage:
 *     node engine/hooks/learning/signal-collector.cjs drift_stuck {检测到"不对"/"又错了"关键词}
 *
 *   PostToolUse:
 *     node engine/hooks/learning/signal-collector.cjs memory_miss {用户说"我记得"但检索空}
 *
 *   Stop:
 *     node engine/hooks/learning/signal-collector.cjs hard_problem {diff检测}
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

// 检测 sentinel: 用于 PostMessage 检测挫败信号
const FRUSTRATION_PATTERNS = [
  /\b不对\b/, /\b又错了\b/, /\b还是不行\b/, /\b没用\b/,
  /\b错了\b/, /\b错误\b/, /\b失败\b/, /\b怎么又\b/,
  /\bwrong\b/i, /\bfail\b/i, /\bincorrect\b/i, /\bstill not\b/i,
  /\bnot working\b/i, /\bdidn't work\b/i,
];

// 记忆检索关键词
const MEMORY_QUERY_PATTERNS = [
  /\b我记得\b/, /\b以前\b/, /\b之前做过\b/, /\b之前怎么\b/,
  /\b我记得有个\b/, /\b查一下\b/, /\b我记得有\b/,
];

// ── 信号类型定义 ──────────────────────────────────────────────────────────

const SIGNAL_TYPES = {
  tool_fail:   { label: '工具失败' },
  drift_stuck: { label: '卡住/挫败' },
  user_correct:{ label: '用户纠正' },
  hard_problem:{ label: '攻克难题' },
  memory_miss: { label: '记忆未命中' },
};

// ── 工具函数 ──────────────────────────────────────────────────────────────

function getSessionId() {
  // 从环境变量获取 session ID (Claude Code 设置)
  return process.env.CLAUDE_SESSION_ID || `s-${Date.now()}`;
}

// ── 主逻辑 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const signalType = args[0]; // 'tool_fail' | 'drift_stuck' | ...
  const extraInfo = args[1] || '';

  if (!signalType || !SIGNAL_TYPES[signalType]) {
    return; // 未知信号类型 → 静默忽略
  }

  try {
    const { record } = require('../../sqlite/store-events.cjs');
    const { openDb } = require('../../sqlite/index.cjs');

    // 读取 stdin (如果是 tool_fail, stdin 包含工具返回的错误信息)
    let stdin = '';
    try {
      stdin = fs.readFileSync(0, 'utf8');
    } catch { /* stdin not available */ }

    let payload = { extra: extraInfo };

    if (signalType === 'tool_fail') {
      // 从 stdin 中提取工具名和错误
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

main();
