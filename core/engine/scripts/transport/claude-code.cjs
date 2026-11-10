'use strict';

/**
 * core/engine/scripts/transport/claude-code.cjs — Claude Code transport 适配器
 *
 * 职责：把 Claude Code hook 的原始 stdin payload 归一化为 harness-event-v1
 * 事件对象（契约见 core/engine/schemas/harness-event-v1.schema.json）。
 *
 * D1 真实事件语义（本适配器是守门人）：
 *   - PostToolUseFailure → status=failed（事件名本身即失败证据，不算臆测）
 *   - PostToolUse → status=unknown（payload 无 status 字段，绝不臆测成功；
 *     hook 层如 progress-watchdog 再按输出证据细化判定）
 *   - 其余事件 → status=unknown
 *
 * fail-closed：非法载荷（非对象/数组）抛 EVENT_INVALID，调用方必须处理，
 * 绝不静默吞掉或产出伪造成功。
 */

const crypto = require('node:crypto');

const ADAPTER = 'claude-hook-v1';
const EVENT_SCHEMA = 'harness.event';
const EVENT_VERSION = 1;

/** Claude Code 事件名 → 中性 eventType（不含结果语义，结果由 status 承载） */
const EVENT_TYPE_BY_NATIVE = {
  PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post',
  PostToolUseFailure: 'tool.post',
  SessionStart: 'session.start',
  Stop: 'session.stop',
  SubagentStop: 'subagent.stop',
  PreCompact: 'session.precompact',
  UserPromptSubmit: 'prompt.submit',
};

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function deriveEventId(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * 收集 schema 顶层字段之外、但门禁真实读取的载荷片段（extras），键名 camelCase
 * 写入 event.extensions（schema 对 extensions 允许任意键，无需放宽 additionalProperties）。
 * 只在键存在时写入，缺席即缺席（不写 null 占位，避免与"显式 null"混淆）。
 */
function collectExtras(raw) {
  const extras = {};
  const toolResponse = raw.tool_response !== undefined ? raw.tool_response
    : raw.toolResponse !== undefined ? raw.toolResponse
    : raw.result !== undefined ? raw.result
    : raw.output !== undefined ? raw.output
    : undefined;
  if (toolResponse !== undefined) extras.toolResponse = toolResponse;
  if (raw.prompt !== undefined) extras.prompt = raw.prompt;
  const transcriptPath = raw.transcript_path !== undefined ? raw.transcript_path : raw.transcriptPath;
  if (transcriptPath !== undefined) extras.transcriptPath = transcriptPath;
  if (raw.trigger !== undefined) extras.trigger = raw.trigger;
  const stopHookActive = raw.stop_hook_active !== undefined ? raw.stop_hook_active : raw.stopHookActive;
  if (stopHookActive !== undefined) extras.stopHookActive = stopHookActive;
  if (raw.error !== undefined) extras.error = raw.error;
  return extras;
}

function normalizeClaudeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const error = new Error('claude-code transport: payload must be a JSON object');
    error.code = 'EVENT_INVALID';
    throw error;
  }

  const nativeEventName = pickString(raw, ['hook_event_name', 'hookEventName']) || 'unknown';
  const eventType = EVENT_TYPE_BY_NATIVE[nativeEventName] || 'unknown';
  const sessionId = pickString(raw, ['session_id', 'sessionId']) || 'unknown-session';
  const cwd = pickString(raw, ['cwd', 'workspaceRoot']) || '';
  const toolName = pickString(raw, ['tool_name', 'toolName']);
  const toolUseId = pickString(raw, ['tool_use_id', 'toolUseId']);
  const toolInput =
    raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input
    : raw.toolInput && typeof raw.toolInput === 'object' ? raw.toolInput
    : null;

  const rawTimestamp = pickString(raw, ['timestamp', 'occurredAt', 'created_at']);
  const occurredAt = rawTimestamp || new Date().toISOString();
  const timestampInferred = rawTimestamp === null;

  // D1：只有事件名本身构成失败证据时判定 failed；否则一律 unknown，不臆测。
  const status = nativeEventName === 'PostToolUseFailure' ? 'failed' : 'unknown';

  return {
    schema: EVENT_SCHEMA,
    version: EVENT_VERSION,
    eventId: deriveEventId({ transport: 'claude-code', nativeEventName, sessionId, toolUseId, cwd, occurredAt }),
    eventType,
    transport: 'claude-code',
    occurredAt,
    receivedAt: new Date().toISOString(),
    sessionId,
    cwd,
    status,
    toolName,
    toolInput,
    toolUseId,
    actor: null,
    source: {
      nativeEventName,
      adapter: ADAPTER,
      statusInferred: status === 'unknown',
      timestampInferred,
      payloadHash: `sha256:${crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`,
    },
    raw: null,
    extensions: collectExtras(raw),
  };
}

module.exports = { ADAPTER, EVENT_SCHEMA, EVENT_VERSION, EVENT_TYPE_BY_NATIVE, collectExtras, normalizeClaudeEvent };
