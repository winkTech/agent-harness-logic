'use strict';

/**
 * engine/scripts/transport/workbuddy.cjs — WorkBuddy transport 适配器
 *
 * 职责：把 WorkBuddy 插件 hook 的原始 payload 归一化为 harness-event-v1。
 *
 * WorkBuddy 插件机制与 Claude Code 同构（`.workbuddy-plugin/hooks/hooks.json`
 * 事件名 PreToolUse/PostToolUse/PostToolUseFailure/SessionStart/Stop/
 * SubagentStop/PreCompact/UserPromptSubmit 八类已实测触发），但字段名/形状
 * 需按真实载荷对齐 —— 本适配器对字段名做**容错归一化**（多候选键），
 * 以承受 payload 形状差异；真实载荷样例待冻结后收紧。
 *
 * D1：PostToolUseFailure → failed（事件名即失败证据）；payload 带显式
 * status/success 字段时映射 succeeded/failed；其余一律 unknown，不臆测。
 */

const crypto = require('node:crypto');

const ADAPTER = 'workbuddy-hook-v1';
const EVENT_SCHEMA = 'harness.event';
const EVENT_VERSION = 1;

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

/** 从 payload 中提取显式结果证据；无证据返回 null（→ unknown） */
function explicitStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.status === 'string') {
    const normalized = payload.status.toLowerCase();
    if (normalized === 'success' || normalized === 'succeeded' || normalized === 'ok') return 'succeeded';
    if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'failed';
  }
  if (typeof payload.success === 'boolean') return payload.success ? 'succeeded' : 'failed';
  const result = payload.result;
  if (result && typeof result === 'object' && typeof result.status === 'string') {
    const normalized = result.status.toLowerCase();
    if (normalized === 'success' || normalized === 'succeeded' || normalized === 'ok') return 'succeeded';
    if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'failed';
  }
  return null;
}

function normalizeWorkbuddyEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const error = new Error('workbuddy transport: payload must be a JSON object');
    error.code = 'EVENT_INVALID';
    throw error;
  }

  const nativeEventName = pickString(raw, ['hook_event_name', 'hookEventName', 'eventName', 'name']) || 'unknown';
  const eventType = EVENT_TYPE_BY_NATIVE[nativeEventName] || 'unknown';
  const sessionId = pickString(raw, ['session_id', 'sessionId', 'session']) || 'unknown-session';
  const cwd = pickString(raw, ['cwd', 'workspaceRoot', 'projectRoot']) || '';
  const toolName = pickString(raw, ['tool_name', 'toolName', 'tool']);
  const toolUseId = pickString(raw, ['tool_use_id', 'toolUseId', 'toolCallId', 'tool_call_id']);
  const toolInput =
    raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input
    : raw.toolInput && typeof raw.toolInput === 'object' ? raw.toolInput
    : raw.input && typeof raw.input === 'object' ? raw.input
    : null;

  const rawTimestamp = pickString(raw, ['timestamp', 'occurredAt', 'created_at', 'time']);
  const occurredAt = rawTimestamp || new Date().toISOString();
  const timestampInferred = rawTimestamp === null;

  // D1 判定顺序：事件名失败证据 → 载荷显式结果 → unknown
  const status = nativeEventName === 'PostToolUseFailure' ? 'failed' : explicitStatus(raw) || 'unknown';

  return {
    schema: EVENT_SCHEMA,
    version: EVENT_VERSION,
    eventId: deriveEventId({ transport: 'workbuddy', nativeEventName, sessionId, toolUseId, cwd, occurredAt }),
    eventType,
    transport: 'workbuddy',
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

module.exports = { ADAPTER, EVENT_SCHEMA, EVENT_VERSION, explicitStatus, normalizeWorkbuddyEvent };
