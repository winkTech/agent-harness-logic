'use strict';

/**
 * core/engine/scripts/transport/grok.cjs — Grok transport 适配器（Phase 3.4）
 *
 * Grok 经 claude 式 hooks 注册（§3.2 契约 3），载荷为 Claude snake_case 形，
 * 差异只在两处（HOST_DIALECTS.grok）：
 *   1. 工具名：Grok 工具面用 run_terminal_command，引擎读 canonical Bash
 *   2. 事件名：SessionStart matcher 词汇（new|load vs startup|resume）——
 *      该差异在注册面翻译（render-grok-hooks），载荷侧 Grok 直供 Claude 事件名。
 *
 * 因此本适配器 = claude-code normalize + 工具名别名归一（进引擎前翻译一次）。
 * 遥测只走 spool（§3.6）——Grok 剖面 async 剥离后无同步遥测路径。
 */

const claudeCode = require('./claude-code.cjs');
const { canonicalToolName } = require('../lib/host-concepts.cjs');

/** Grok 载荷归一化：claude 形 normalize 前先把工具别名翻成 canonical。 */
function normalizeGrokEvent(raw) {
  const translated = { ...raw };
  if (translated && typeof translated === 'object' && !Array.isArray(translated)) {
    if (typeof translated.tool_name === 'string') {
      translated.tool_name = canonicalToolName(translated.tool_name, 'grok');
    }
    if (translated.tool && typeof translated.tool === 'object' && typeof translated.tool.name === 'string') {
      translated.tool = { ...translated.tool, name: canonicalToolName(translated.tool.name, 'grok') };
    }
  }
  const event = claudeCode.normalizeClaudeEvent(translated);
  event.transport = 'grok';
  return event;
}

module.exports = {
  normalizeGrokEvent,
};
