#!/usr/bin/env node
/**
 * Hook: analysis-paralysis-guard.cjs
 *
 * PreToolUse hook: 检测分析瘫痪模式 — 连续 3 轮只读操作(Read/Grep/Glob 等)
 * 不产生代码产出时，注入提醒要求收敛。
 *
 * 定义: rules/00-core.md — 分析收敛检查
 *   "连续 3 轮分析没有产出代码 → 暂停，输出已确认事实+未解决问题"
 *
 * 注册 (hook-config.json):
 *   "session/analysis-paralysis-guard.cjs": { enabled: true, frequency: "high", ... }
 */

'use strict';

const p = require('node:path');
const f = require('node:fs');

const HOME = p.join(require('node:os').homedir(), '.claude');
const STATE_FILE = p.join(HOME, 'var', 'index', 'analysis-paralysis-state.json');

// "只读"工具列表 — 这些工具的连续使用表示"分析模式"
const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'AskUserQuestion',
]);

// "产出"工具列表 — 这些工具表示有实际进展
const PRODUCTION_TOOLS = new Set([
  'Write', 'Edit', 'Bash', 'NotebookEdit',
]);

const MAX_ANALYSIS_TURNS = 3;

/**
 * 读取计数器状态，静默降级。
 */
function readState() {
  try {
    if (f.existsSync(STATE_FILE)) {
      return JSON.parse(f.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* 静默降级 */ }
  return { counter: 0, lastTool: null };
}

/**
 * 写入计数器状态。
 */
function writeState(state) {
  try {
    const dir = p.dirname(STATE_FILE);
    if (!f.existsSync(dir)) f.mkdirSync(dir, { recursive: true });
    f.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch { /* 静默降级 */ }
}

/**
 * 主入口。
 * @param {object} [toolUse] — 当前工具调用信息（可选）
 * @param {object} [context] — 上下文对象（可选）
 */
function main(toolUse) {
  try {
    const state = readState();
    const toolName = (toolUse && toolUse.name) || '';

    if (PRODUCTION_TOOLS.has(toolName)) {
      // 产生代码的工具 → 重置计数器
      state.counter = 0;
      state.lastTool = toolName;
      writeState(state);
      return;
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      // 只读工具 → 递增计数器
      state.counter = (state.counter || 0) + 1;
      state.lastTool = toolName;
      writeState(state);

      if (state.counter >= MAX_ANALYSIS_TURNS) {
        console.error(JSON.stringify({
          source: 'analysis-paralysis-guard',
          type: 'warning',
          severity: 'medium',
          message: '⚠️ 检测到连续 ' + state.counter + ' 轮只读操作（分析模式），尚未产生代码。'
            + ' 规则 00-core.md 要求：连续 3 轮分析没有产出 → 暂停并收敛。'
            + ' 建议：输出已确认事实和未解决问题，切换到实施模式，或向用户确认方向。',
          constraint: '当前触发分析收敛检查。请在继续之前：'
            + '1) 总结已发现的事实 2) 列出未解决的关键问题 3) 明确下一步是继续分析还是开始实施。',
        }));
      }
      return;
    }

    // 其他工具（如 Agent、Workflow 等）— 不增减计数器
    state.lastTool = toolName;
    writeState(state);

  } catch { /* 静默降级：不阻止主流程 */ }
}

if (require.main === module) {
  // CLI 模式：重置计数器（用于手动清理）
  writeState({ counter: 0, lastTool: null, resetAt: new Date().toISOString() });
  console.error(JSON.stringify({ source: 'analysis-paralysis-guard', type: 'reset', message: '计数器已重置' }));
}

module.exports = { main };
