#!/usr/bin/env node
/**
 * engine/scripts/hooks/context-pressure-warn.cjs — 上下文压力警告 (P2)
 *
 * PostToolUse/Stop hook: 检查上下文使用压力，在达到阈值时
 * 输出压缩建议。
 *
 * 依赖: node engine/scripts/context-monitor-gate.cjs 做实际告警，
 *       本脚本作为辅助检测，针对性输出用户可操作的建议。
 *
 * 退出码: 0 (仅建议，不阻断)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const HARNESS = HARNESS_ROOT;
const PRESSURE_FILE = path.join(HARNESS, 'var', 'sessions', '.compact-needed');

/**
 * 检查是否有压缩信号文件。
 */
function hasPressureSignal() {
  try {
    if (fs.existsSync(PRESSURE_FILE)) {
      const raw = fs.readFileSync(PRESSURE_FILE, 'utf8');
      const signal = JSON.parse(raw);
      const age = Date.now() - new Date(signal.timestamp).getTime();
      const ageMinutes = Math.floor(age / 60000);

      // 清除超过 30 分钟的旧信号
      if (ageMinutes > 30) {
        fs.unlinkSync(PRESSURE_FILE);
        return false;
      }

      return { timestamp: signal.timestamp, ageMinutes, reason: signal.reason };
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 读取上下文监控状态。
 */
function getContextStatus() {
  try {
    const stateFile = path.join(HARNESS, 'var', 'index', 'runtime-state.json');
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const state = JSON.parse(raw);
      return {
        toolCalls: (state.toolCalls || []).length,
        lastCompact: state.lastCompactCheckpoint,
        compactCount: state.compactCount || 0,
        troubleFlags: state.troubleFlags || [],
      };
    }
  } catch { /* ignore */ }
  return null;
}

function main() {
  const pressure = hasPressureSignal();
  const ctx = getContextStatus();

  if (!pressure && !ctx) {
    process.exit(0); // 无压力信号，安静退出
  }

  const suggestions = [];

  if (pressure) {
    suggestions.push(
      `📊 上下文压力信号已触发 (${pressure.ageMinutes} 分钟前)`,
      `   原因: ${pressure.reason || '自动阈值'}`,
      `   建议: 运行 /compact 压缩上下文，释放工作台空间`,
      `         或运行 /clear 切换到新任务`
    );
  }

  // 只在统计确实可信时才报。runtime-state.json 的 compactCount 是**全局
  // 累加**且从不按会话复位 (实测 2391), 而 toolCalls 数组全仓没有写入方
  // (恒为 0) —— 于是会打印 "已压缩 2391 次 / 工具调用 0 次" 这种自相矛盾
  // 的假统计。数据源不可信时保持沉默。
  const statsTrustworthy = ctx && ctx.compactCount > 0 && ctx.toolCalls > 0;
  if (statsTrustworthy) {
    suggestions.push(
      `📈 会话统计: 已压缩 ${ctx.compactCount} 次`,
      `   上次压缩: ${ctx.lastCompact || '未知'}`,
      ctx.toolCalls > 50
        ? `   工具调用: ${ctx.toolCalls} 次 — 考虑 /clear 或新会话`
        : `   工具调用: ${ctx.toolCalls} 次`
    );
  }

  if (ctx && ctx.troubleFlags && ctx.troubleFlags.length > 0) {
    suggestions.push(
      `⚠️  检测到 ${ctx.troubleFlags.length} 个异常标记:`,
      ...ctx.troubleFlags.map(f => `   - ${f}`)
    );
  }

  if (suggestions.length > 0) {
    console.error('');
    console.error('┌─ Context Monitor ──────────────────────────────────────────┐');
    for (const s of suggestions) {
      console.error(`│ ${s.padEnd(67)}│`);
    }
    console.error('└────────────────────────────────────────────────────────────┘');
  }

  process.exit(0);
}

main();
