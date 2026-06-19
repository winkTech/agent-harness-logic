#!/usr/bin/env node
/**
 * Hook: cognition-mode-enforcer.cjs
 *
 * PreToolUse hook: 根据当前推理模式向 AI 注入行为约束。
 *
 * 读取 var/index/runtime-state.json 的 currentMode 字段，
 * 输出对应的模式约束字符串。约束定义见 rules/00-core.md 和 rules/06-cognition.md。
 *
 * 支持两种调用方式：
 *   1. 模块方式: require('.../cognition-mode-enforcer.cjs').main(toolUse, context)
 *   2. CLI 方式: node cognition-mode-enforcer.cjs
 *
 * 注册 (hook-config.json):
 *   "cognition/cognition-mode-enforcer.cjs": { ... }
 */

'use strict';

const p = require('node:path');
const f = require('node:fs');
const os = require('node:os');

const HOME = p.join(os.homedir(), '.claude');
const STATE_FILE = p.join(HOME, 'var', 'index', 'runtime-state.json');

// 各模式的约束映射 (定义见 rules/00-core.md + rules/06-cognition.md)
const MODE_CONSTRAINTS = new Map([
  ['根因分析', '当前模式：根因分析。要求：每次 Edit/Write 前必须输出根因分析结论，确认修改目标。'],
  ['第一性原理', '当前模式：第一性原理。要求：删除非本质功能，保持最小方案。每次修改前先问：这个真的必要吗？'],
  ['减法',        '当前模式：减法。要求：每次只做删除操作，不添加任何新代码。修改前先确认能否删除。'],
  ['搜索优先',    '当前模式：搜索优先。要求：先搜索代码库和知识库，确认没有现成方案再考虑新建。'],
  ['倒推',        '当前模式：倒推设计。要求：先定义接口/输出，再实现内部逻辑。每次修改前确认接口定义。'],
  ['证据驱动',    '当前模式：证据驱动。要求：每次修改前建立 baseline，修改后提供对比数据。'],
]);

const DEFAULT_CONSTRAINT = '当前模式：闭环模式。按照 目标→过程→结果→复盘 循环推进。';

/**
 * 读取 runtime-state.json，静默降级。
 * @returns {object|null}
 */
function readState() {
  try {
    return JSON.parse(f.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 获取当前模式对应的约束字符串。
 * @param {string} mode
 * @returns {string}
 */
function getConstraint(mode) {
  if (!mode) return DEFAULT_CONSTRAINT;
  return MODE_CONSTRAINTS.get(mode) || DEFAULT_CONSTRAINT;
}

/**
 * 主入口：读取 runtime-state，输出约束字符串到 stderr。
 *
 * @param {object} [toolUse]  - 当前工具调用信息（可选，模块调用时传入）
 * @param {object} [context]  - 上下文对象（可选，模块调用时传入）
 */
function main(toolUse, context) {
  try {
    const state = readState();
    if (!state) return; // 文件不存在或格式错误，静默退出

    const mode = state.currentMode || '';
    const constraint = getConstraint(mode);
    const modeLabel = mode || '闭环';

    // 输出到 stderr，hook 框架将其捕获并注入到系统提示中
    console.error(JSON.stringify({
      source: 'cognition-mode-enforcer',
      type: 'mode-constraint',
      mode: modeLabel,
      constraint,
    }));

    // 如果提供了 context，也尝试注入
    if (context && typeof context.injectSystemPrompt === 'function') {
      context.injectSystemPrompt(constraint);
    }
  } catch {
    // 静默降级：任何错误都不阻止主流程
  }
}

// CLI 直接运行
if (require.main === module) {
  main();
}

module.exports = { main, getConstraint };
