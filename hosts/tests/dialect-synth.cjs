'use strict';

/**
 * hosts/tests/dialect-synth.cjs — 方言感知合成器（Phase 3.4，限 PreToolUse）
 *
 * canonical 样例（hosts/tests/malicious-samples.jsonl）→ 四宿主载荷形态：
 *   - claude-code: { hook_event_name:'PreToolUse', tool_name, tool_input, ... } snake_case
 *   - workbuddy:   { hookEventName:'PreToolUse', toolName, toolInput, ... } camelCase
 *   - grok:        claude 形 + 工具别名（Bash → run_terminal_command——HOST_DIALECTS 逆表）
 *   - codex:       结构化 options（{ eventType:'tool.pre', toolName, toolInput, ... }）
 *
 * 引擎侧经 transport/{claude-code,workbuddy,codex,grok}.cjs normalize 归一后，
 * 同一样本四路径必须同判（H-4 = 100%）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { HOST_DIALECTS } = require('../../core/engine/scripts/lib/host-concepts.cjs');

/** canonical → grok 工具名（逆别名表）。 */
const CANONICAL_TO_GROK = (() => {
  const inverse = {};
  for (const [native, canonical] of Object.entries(HOST_DIALECTS.grok.toolAliases)) {
    inverse[canonical] = native;
  }
  return inverse;
})();

const BASE = {
  session_id: 'h4-equivalence',
  cwd: process.cwd(),
};

/** 样例 → 指定宿主的 PreToolUse 原始载荷。 */
function synth(sample, host) {
  const tool = sample.tool;
  const input = sample.toolInput;
  switch (host) {
    case 'claude-code':
      return {
        ...BASE, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input,
      };
    case 'workbuddy':
      return {
        ...BASE,
        hookEventName: 'PreToolUse', toolName: tool, toolInput: input,
        sessionId: BASE.session_id, workspaceRoot: BASE.cwd,
      };
    case 'grok':
      return {
        ...BASE,
        hook_event_name: 'PreToolUse',
        tool_name: CANONICAL_TO_GROK[tool] || tool,
        tool_input: input,
      };
    case 'codex':
      return {
        eventType: 'tool.pre',
        sessionId: BASE.session_id,
        cwd: BASE.cwd,
        toolName: tool,
        toolInput: input,
        status: 'unknown',
      };
    default:
      throw new Error(`dialect-synth: unknown host '${host}'`);
  }
}

/** 读样例集。 */
function loadSamples(file = __dirname) {
  const jsonl = typeof file === 'string' && file.endsWith('.jsonl')
    ? file : path.join(file, 'malicious-samples.jsonl');
  return fs.readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

module.exports = { synth, loadSamples, CANONICAL_TO_GROK };
