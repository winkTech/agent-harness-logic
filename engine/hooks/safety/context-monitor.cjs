#!/usr/bin/env node
/**
 * Hook: context-monitor.cjs
 *
 * PreToolUse hook: 监控上下文使用情况，在关键阈值告警。
 *
 * 由于 Claude Code 不直接暴露 token 计数，本钩子使用以下启发式指标：
 *   - 当前会话中的工具调用总数（简单代理）
 *   - 运行时状态中的压力标志 (pressureFlags)
 *   - 连续工具调用次数
 *
 * 阈值 (基于 rules/00-core.md 的上下文管理规则):
 *   - ≥40%: 建议"考虑提前安排关键操作" — 黄色预警
 *   - ≥60%: 建议"考虑简化计划或提前压缩" — 橙色预警
 *   - ≥80%: 建议"立即执行收尾工作并准备压缩" — 红色预警
 *
 * 注册 (hook-config.json):
 *   "safety/context-monitor.cjs": { enabled: true, frequency: "high", ... }
 */

'use strict';

const p = require('node:path');
const f = require('node:fs');
const os = require('node:os');

const HOME = p.join(os.homedir(), '.claude');
const STATE_DIR = p.join(HOME, 'var', 'index');
const STATE_FILE = p.join(STATE_DIR, 'context-monitor-state.json');
const RUNTIME_FILE = p.join(STATE_DIR, 'runtime-state.json');

// 工具调用的"权重"系数（粗略估计每种工具消耗的 context）
const TOOL_WEIGHTS = {
  Read: 2,       // 读取文件内容占用较多
  Write: 3,      // 写入文件内容占用最多
  Edit: 3,
  Bash: 2,
  Grep: 1,
  Glob: 1,
  Agent: 2,
  WebSearch: 1,
  WebFetch: 2,
  AskUserQuestion: 1,
  default: 1,
};

const MAX_WEIGHT = 200; // 100 次中等权重调用的总量，对应完整 context

/**
 * 读取监控状态。
 */
function readState() {
  try {
    if (f.existsSync(STATE_FILE)) {
      return JSON.parse(f.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* 静默降级 */ }
  return { toolCount: 0, totalWeight: 0, lastWarningLevel: 0, startedAt: null };
}

/**
 * 写入监控状态。
 */
function writeState(state) {
  try {
    if (!f.existsSync(STATE_DIR)) f.mkdirSync(STATE_DIR, { recursive: true });
    f.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch { /* 静默降级 */ }
}

/**
 * 读取运行时状态中的 pressure 标志。
 */
function readPressureFlags() {
  try {
    if (f.existsSync(RUNTIME_FILE)) {
      const rt = JSON.parse(f.readFileSync(RUNTIME_FILE, 'utf8'));
      return rt.pressureFlags || [];
    }
  } catch { /* 静默降级 */ }
  return [];
}

/**
 * 估算 context 使用百分比。
 * @param {object} state
 * @returns {number} 0-100 的估算值
 */
function estimateUsage(state) {
  const weightRatio = (state.totalWeight / MAX_WEIGHT) * 100;
  const countRatio = (state.toolCount / 100) * 100;
  return Math.min(95, Math.round(Math.max(weightRatio, countRatio)));
}

/**
 * 主入口。
 * @param {object} [toolUse]
 * @param {object} [context]
 */
function main(toolUse, context) {
  try {
    const state = readState();
    const toolName = (toolUse && toolUse.name) || '';

    // 初始化开始时间
    if (!state.startedAt) state.startedAt = new Date().toISOString();

    // 更新计数器
    const weight = TOOL_WEIGHTS[toolName] || TOOL_WEIGHTS.default;
    state.toolCount = (state.toolCount || 0) + 1;
    state.totalWeight = (state.totalWeight || 0) + weight;
    state.lastTool = toolName;

    const usage = estimateUsage(state);
    const pressureFlags = readPressureFlags();
    const hasExternalPressure = pressureFlags.length > 0;

    // 判断阈值级别
    let level = 0;
    let message = '';

    // 外部压力标志 + 高使用率 = 双重告警
    if (usage >= 80 || (usage >= 60 && hasExternalPressure)) {
      level = 3;
      message = '⚠️ [context-monitor] 红色预警: context 估算使用率 ' + usage + '%。'
        + '建议立即执行收尾工作并准备压缩/总结。';
    } else if (usage >= 60 || (usage >= 45 && hasExternalPressure)) {
      level = 2;
      message = '⚡ [context-monitor] 橙色预警: context 估算使用率 ' + usage + '%。'
        + '建议考虑简化计划或提前安排压缩。';
    } else if (usage >= 40) {
      level = 1;
      message = '💡 [context-monitor] 黄色提示: context 估算使用率 ' + usage + '%。'
        + '注意安排关键操作，避免在 context 不足时执行复杂任务。';
    }

    // 只在级别变化时输出告警（避免每次工具调用都输出）
    if (level > 0 && level !== state.lastWarningLevel) {
      state.lastWarningLevel = level;
      writeState(state);

      console.error(JSON.stringify({
        source: 'context-monitor',
        type: 'context-usage',
        severity: level >= 3 ? 'high' : level >= 2 ? 'medium' : 'low',
        usageEstimate: usage,
        toolCount: state.toolCount,
        message: message,
        pressureFlags: pressureFlags,
      }));

      // 高级别告警注入系统提示
      if (level >= 3 && context && typeof context.injectSystemPrompt === 'function') {
        context.injectSystemPrompt(
          '[context-monitor] 当前 context 使用率较高（约' + usage + '%）。'
          + '优先完成关键任务，减少大文件读取，考虑安排压缩。'
        );
      }
    } else {
      writeState(state);
    }

  } catch { /* 静默降级 */ }
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    const state = readState();
    const usage = estimateUsage(state);
    console.log('Context monitor status:');
    console.log('  Tool calls:', state.toolCount);
    console.log('  Total weight:', state.totalWeight);
    console.log('  Estimated usage:', usage + '%');
    console.log('  Warning level:', state.lastWarningLevel);
    console.log('  Started at:', state.startedAt);
  } else if (cmd === 'reset') {
    writeState({ toolCount: 0, totalWeight: 0, lastWarningLevel: 0, startedAt: new Date().toISOString() });
    console.error('context-monitor: 计数器已重置');
  } else {
    console.error('用法: node context-monitor.cjs [status|reset]');
  }
}

module.exports = { main, estimateUsage };
