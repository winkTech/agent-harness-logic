'use strict';

/**
 * core/engine/scripts/transport/render.cjs — 中立判定 → transport 输出渲染层
 *
 * 职责：把门禁产出的中立判定（allow / block + additionalContext + diagnostics）
 * 渲染成目标 transport 的输出协议。纯函数：**不写 stdout / stderr、不设 exitCode**，
 * 只返回 { stdout, exitCode }，由入口脚本落地。
 *
 * 逐字节兼容基线（M3 不可破坏约束 2）：
 *   - preflight-router.cjs emit()：block → 只写 stderr 诊断、exitCode 2、无 stdout；
 *     否则有 additionalContext 才写 JSON.stringify({hookSpecificOutput:{hookEventName, additionalContext}})。
 *   - postflight-router.cjs emit()：诊断始终写 stderr（由调用方负责）；有 additionalContext
 *     即写同形 JSON（block 时也写）；block 再置 exitCode 2 —— 对应 emitContextOnBlock: true。
 * 键顺序固定为 hookEventName、additionalContext，与两个 emit() 的对象字面量一致。
 */

const HOOK_TRANSPORTS = new Set(['claude-code', 'workbuddy']);
const VERDICT_SCHEMA = 'harness.verdict';
const VERDICT_VERSION = 1;

/** preflight-router emit() 的既有事件名兜底 */
const DEFAULT_HOOK_EVENT_NAME = 'PreToolUse';

function invalidTransport(name) {
  const error = new Error(`render: unsupported transport '${name}' (expected one of claude-code, workbuddy, codex)`);
  error.code = 'EVENT_INVALID';
  return error;
}

/**
 * 把中立判定渲染为该 transport 的输出。
 *
 * @param {string} transport 'claude-code' | 'workbuddy' | 'codex'
 * @param {object} decisionInput
 * @param {'allow'|'block'} decisionInput.decision 中立判定（非 'block' 一律按 allow 处理）
 * @param {string} [decisionInput.eventName] 原生事件名（用于 hookEventName；缺省 'PreToolUse'）
 * @param {string} [decisionInput.additionalContext] 注入上下文；空串/缺省表示无上下文
 * @param {string[]} [decisionInput.diagnostics] 诊断行（hook transport 下由调用方写 stderr；codex 下入 JSON）
 * @param {boolean} [decisionInput.emitContextOnBlock=false] block 时是否仍输出 additionalContext
 *   （postflight-router emit() 的既有行为；preflight-router 为 false）
 * @returns {{stdout: string|null, exitCode: number}}
 * @throws {Error} code=EVENT_INVALID — 未知 transport（fail-closed）
 */
function renderDecision(transport, {
  decision,
  eventName,
  additionalContext,
  diagnostics,
  emitContextOnBlock = false,
} = {}) {
  const blocked = decision === 'block';
  const context = typeof additionalContext === 'string' ? additionalContext : '';
  const lines = Array.isArray(diagnostics)
    ? diagnostics.map((item) => (typeof item === 'string' ? item : String(item)))
    : [];

  if (transport === 'codex') {
    return {
      stdout: JSON.stringify({
        schema: VERDICT_SCHEMA,
        version: VERDICT_VERSION,
        decision: blocked ? 'block' : 'allow',
        eventName: typeof eventName === 'string' && eventName ? eventName : null,
        additionalContext: context,
        diagnostics: lines,
      }),
      exitCode: blocked ? 2 : 0,
    };
  }

  if (!HOOK_TRANSPORTS.has(transport)) throw invalidTransport(transport);

  const emitContext = context.length > 0 && (!blocked || emitContextOnBlock === true);
  return {
    stdout: emitContext
      ? JSON.stringify({
        hookSpecificOutput: {
          hookEventName: typeof eventName === 'string' && eventName ? eventName : DEFAULT_HOOK_EVENT_NAME,
          additionalContext: context,
        },
      })
      : null,
    exitCode: blocked ? 2 : 0,
  };
}

module.exports = {
  HOOK_TRANSPORTS,
  VERDICT_SCHEMA,
  VERDICT_VERSION,
  DEFAULT_HOOK_EVENT_NAME,
  renderDecision,
};
