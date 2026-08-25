'use strict';

/**
 * engine/scripts/transport/claude-code.cjs — Claude Code transport 适配器
 *
 * 职责：把 Claude Code hook 的原始 stdin payload 归一化为 harness-event-v1
 * 事件对象（契约见 engine/schemas/harness-event-v1.schema.json）。
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
    extensions: {},
  };
}

module.exports = { ADAPTER, EVENT_SCHEMA, EVENT_VERSION, normalizeClaudeEvent };
