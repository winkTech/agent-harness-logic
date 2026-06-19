#!/usr/bin/env node
/**
 * engine/scripts/context-monitor-gate.cjs — 上下文监测门禁 (P2)
 *
 * 实时监测上下文使用情况，在阈值处自动报警/触发压缩。
 * 这是实现"上下文不得超过 50% 红线"的监控层。
 *
 * 工作原理:
 *   1. 读取 session 转录文件大小 + 工具调用计数
 *   2. 计算估算的上下文占比
 *   3. 对比阈值: >50% → 报警 | >60% → 红 X + 强制
 *   4. 输出 JSON 注入到 Claude 上下文
 *
 * 代理指标（因为无法直接读取 Claude 内部 context usage）:
 *   - 工具调用计数 / 消息轮数（runtime-state.json toolCalls[]）
 *   - 会话转录文件大小（CLAUDE_SESSION_DIR/transcript.jsonl）
 *   - 距上次压缩的消息数（ctx-checkpoint 时间戳）
 *   - 上次压缩后的工具调用数
 *
 * 注册:
 *   settings.local.json PostMessage — 每次用户消息后评估
 *
 * 阈值:
 *   GREEN  < 50%: 正常，无输出
 *   YELLOW 50-60%: 输出压缩建议
 *   RED    > 60%: 输出红 X + 强制压缩信号
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── 配置 ────────────────────────────────────────────────────────────────────

const HOMEDIR = os.homedir();
const HARNESS = path.join(HOMEDIR, '.claude');
const STATE_FILE = path.join(HARNESS, 'var', 'index', 'runtime-state.json');
const COMPACT_LOG = path.join(HARNESS, 'var', 'sessions', 'compaction-log.txt');

// 阈值配置（上下文占比估算）
// 与 engine/hooks/safety/context-monitor.cjs 统一
// 更新说明: 2026-06-19, 与 hook 对齐为 40%/60%/80%
const THRESHOLDS = {
  YELLOW: 0.40,  // ≥40% → 黄色预警，注意安排关键操作
  RED: 0.60,     // ≥60% → 红 X + 强制压缩信号
  CRITICAL: 0.80, // ≥80% → 紧急，立即收尾并压缩
};

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { console.error('[context-monitor-gate] 错误:', e.message); }
  return null;
}

/**
 * 获取 session 转录文件的路径和大小。
 * Claude Code 环境变量: CLAUDE_SESSION_DIR 或根据 session ID 推断。
 */
function getTranscriptInfo() {
  const sessionId = process.env.CLAUDE_SESSION_ID || '';
  const sessionDir = process.env.CLAUDE_SESSION_DIR || '';

  let transcriptPath = '';
  if (sessionDir && fs.existsSync(sessionDir)) {
    // 尝试常见的转录文件名
    const candidates = ['transcript.jsonl', 'conversation.jsonl', 'messages.jsonl'];
    for (const f of candidates) {
      const p = path.join(sessionDir, f);
      if (fs.existsSync(p)) { transcriptPath = p; break; }
    }
  }

  if (!transcriptPath) {
    // fallback: 在 var/sessions/ 下按时间找最近的文件
    const sessionsDir = path.join(HARNESS, 'var', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.jsonl') || f.endsWith('.log'))
        .map(f => ({ name: f, path: path.join(sessionsDir, f), mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) transcriptPath = files[0].path;
    }
  }

  let sizeBytes = 0;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    sizeBytes = fs.statSync(transcriptPath).size;
  }

  return { transcriptPath, sizeBytes };
}

/**
 * 计算估算的上下文占比。
 *
 * 算法:
 *   使用多个代理指标加权计算:
 *   1. 文件大小指数: sizeKB / 500KB (假设 500KB ≈ 100%)
 *   2. 工具调用指数: toolCalls / 200  (假设 200 次 ≈ 100%)
 *   3. 距上次压缩: lastCompactAgo / 100 工具调用
 *
 *   最终结果 = max(指标1, 指标2, 指标3)，但 clamped 到 [0, 1]
 *   如果系统已自动压缩，默认低水位。
 *
 * @returns {{ ratio: number, details: object }}
 */
function estimateContextRatio() {
  const state = readJSON(STATE_FILE);
  const transcript = getTranscriptInfo();

  // 指标1: 转录文件大小指数
  const transcriptKB = transcript.sizeBytes / 1024;
  const SIZE_BASELINE_KB = 500; // 500KB ≈ 100% context
  const fileRatio = Math.min(transcriptKB / SIZE_BASELINE_KB, 1.0);

  // 指标2: 工具调用指数
  const toolCalls = state?.toolCalls?.length || 0;
  const CALL_BASELINE = 200; // 200 calls ≈ 100% context
  const callRatio = Math.min(toolCalls / CALL_BASELINE, 1.0);

  // 指标3: 距上次压缩
  let compactAgo = toolCalls; // 默认: 从未压缩
  try {
    if (fs.existsSync(COMPACT_LOG)) {
      const logContent = fs.readFileSync(COMPACT_LOG, 'utf8');
      const lines = logContent.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        // 取最后一次压缩后的工具调用数作为"距上次压缩的消息数"
        // 这里简化: 用工具调用数 - 压缩日志条数 * 20（假设每次压缩重置计数）
        compactAgo = Math.max(0, toolCalls - lines.length * 20);
      }
    }
  } catch (e) { console.error('[context-monitor-gate] 错误:', e.message); }
  const compactRatio = Math.min(compactAgo / 100, 1.0);

  // 综合: 取最大值（最悲观的估计）
  const ratio = Math.max(fileRatio, callRatio, compactRatio);

  return {
    ratio,
    details: {
      transcriptKB: Math.round(transcriptKB * 10) / 10,
      toolCalls,
      compactAgo,
      fileRatio: Math.round(fileRatio * 100) / 100,
      callRatio: Math.round(callRatio * 100) / 100,
      compactRatio: Math.round(compactRatio * 100) / 100,
    },
  };
}

/**
 * 获取上下文健康级别。
 * @returns { 'GREEN' | 'YELLOW' | 'RED' | 'CRITICAL' }
 */
function getHealthLevel(ratio) {
  if (ratio >= THRESHOLDS.CRITICAL) return 'CRITICAL';
  if (ratio >= THRESHOLDS.RED) return 'RED';
  if (ratio >= THRESHOLDS.AUTO_COMPACT) return 'AUTO_COMPACT';
  if (ratio >= THRESHOLDS.YELLOW) return 'YELLOW';
  return 'GREEN';
}

/**
 * 生成人类可读的状态条。
 */
function statusBar(ratio, width = 20) {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(empty, 0));
  const pct = Math.round(ratio * 100);
  return `${bar} ${pct}%`;
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 评估当前上下文状态。
 * @returns {object|null} GREEN → null (不注入), YELLOW/RED → 报警对象
 */
function evaluate() {
  const { ratio, details } = estimateContextRatio();
  const level = getHealthLevel(ratio);

  // GREEN: 无需输出
  if (level === 'GREEN') return null;

  const bar = statusBar(ratio);
  const toolCalls = details.toolCalls;

  let flag, message, suggestion, instruction;
  if (ratio >= THRESHOLDS.CRITICAL) {
    level = 'CRITICAL';
    flag = '🚨';
    message = `上下文使用率 ${Math.round(ratio * 100)}%，超过 80% 紧急红线！`;
    suggestion = '立即执行 /compact。当前会话已接近极限，继续操作将导致严重的质量下降。先保存状态，然后压缩。';
    instruction = '【紧急指令】上下文超过 80%。立即执行 node engine/hooks/session/pre-compact.cjs save 保存状态，然后 /compact。压缩后执行 node engine/hooks/session/pre-compact.cjs read 恢复上下文。';
  } else if (level === 'RED') {
    flag = '❌';
    message = `上下文使用率 ${Math.round(ratio * 100)}%，超过 60% 红线！`;
    suggestion = '建议立即执行 /compact 或启动新的 session。当前会话上下文已接近满载，继续执行可能导致质量下降或幻觉。';
    instruction = '【强制指令】上下文超过 60% 红线。保存状态后立即 /compact。压缩前禁止开始新任务。';
  } else {
    flag = '⚠️';
    message = `上下文使用率 ${Math.round(ratio * 100)}%，超过 40% 警戒线。`;
    suggestion = '建议在下次阶段切换时执行 /compact。当前上下文仍有空间，但建议控制 prompt 长度，优先完成当前阶段。';
    instruction = '【上下文提醒】使用率超过 40%。注意控制后续操作，在阶段切换时执行 /compact。';
  }

  // Emit signal: 上下文压力事件
  try {
    const { emitSync } = require('../hooks/learning/signal-collector.cjs');
    emitSync('context_pressure', {
      level,
      estimatedRatio: Math.round(ratio * 100),
      toolCalls: details.toolCalls,
      transcriptKB: details.transcriptKB,
    });
  } catch (e) { console.error('[context-monitor-gate] 错误:', e.message); }

  var result = {
    source: 'context-monitor-gate',
    type: 'context-pressure',
    level,
    estimatedRatio: Math.round(ratio * 100),
    details,
    statusBar: bar,
    flag,
    message,
    suggestion,
    compactHint,
    instruction,
  };

  // Subagent 溢出: AUTO_COMPACT 且有足够工作量时，派子 agent 继续
  if (level === 'AUTO_COMPACT' && autoSpawnSubagent) {
    result.autoAction = 'subagent';
    result.continuationPrompt = '上下文超过 55%，主 session 即将压缩。请接收当前上下文中的进度摘要、文件列表和待办事项，在全新的上下文中继续当前任务。完成后返回结果摘要。';
  }

  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    const { ratio, details } = estimateContextRatio();
    const level = getHealthLevel(ratio);
    const bar = statusBar(ratio);
    console.log(`状态: ${level} ${bar}`);
    console.log(`转录文件: ${details.transcriptKB} KB`);
    console.log(`工具调用: ${details.toolCalls} 次`);
    console.log(`距上次压缩: ${details.compactAgo} 次调用`);
    console.log(`文件指数: ${details.fileRatio} | 调用指数: ${details.callRatio} | 压缩指数: ${details.compactRatio}`);
    process.exit(0);
  }

  if (args.includes('--force')) {
    // 强制输出评估（绕过 GREEN 静默）
    const { ratio, details } = estimateContextRatio();
    const level = getHealthLevel(ratio);
    const bar = statusBar(ratio);
    console.log(JSON.stringify({
      source: 'context-monitor-gate',
      type: 'context-pressure',
      level,
      estimatedRatio: Math.round(ratio * 100),
      details,
      statusBar: bar,
      force: true,
    }));
    process.exit(0);
  }

  // 默认模式: PostMessage hook 调用，输出 JSON 或静默
  const result = evaluate();
  if (result) {
    console.log(JSON.stringify(result));
  }
  // GREEN → 无输出 (0 token 开销)
}

if (require.main === module) {
  main();
}

module.exports = {
  estimateContextRatio,
  getHealthLevel,
  evaluate,
  THRESHOLDS,
};
