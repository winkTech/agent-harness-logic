'use strict';

/**
 * engine/scripts/transport/codex.cjs — Codex transport 适配器
 *
 * 职责：为 Codex（无 hook 机制）构造 harness-event-v1 事件。
 *
 * Codex 没有实时 hook，运行时门禁降级为**提交前门禁**（pre-commit 阶段）。
 * 因此本适配器是 stdin-less 的：调用方（门禁包装脚本）以结构化参数构造事件，
 * 或从 checkpoint / 会话文件读取信息后构造。
 *
 * D1：调用方必须显式给出 status（succeeded/failed/unknown）；缺省一律
 * unknown，不因"走到了提交前"就臆测成功。
 */

const crypto = require('node:crypto');

const ADAPTER = 'codex-precommit-v1';
const EVENT_SCHEMA = 'harness.event';
const EVENT_VERSION = 1;

const ALLOWED_EVENT_TYPES = new Set([
  'session.start',
  'prompt.submit',
  'tool.pre',
  'tool.post',
  'session.stop',
  'session.precompact',
  'subagent.stop',
  'unknown',
]);

const ALLOWED_STATUS = new Set(['succeeded', 'failed', 'unknown']);

function normalizeCodexEvent(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    const error = new Error('codex transport: options must be a JSON object');
    error.code = 'EVENT_INVALID';
    throw error;
  }
  const eventType = options.eventType || 'unknown';
  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    const error = new Error(`codex transport: unsupported eventType '${eventType}'`);
    error.code = 'EVENT_INVALID';
    throw error;
  }
  const status = options.status || 'unknown';
  if (!ALLOWED_STATUS.has(status)) {
    const error = new Error(`codex transport: unsupported status '${status}'`);
    error.code = 'EVENT_INVALID';
    throw error;
  }
  const sessionId = typeof options.sessionId === 'string' && options.sessionId ? options.sessionId : 'unknown-session';
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : '';
  const toolName = typeof options.toolName === 'string' && options.toolName ? options.toolName : null;
  const toolUseId = typeof options.toolUseId === 'string' && options.toolUseId ? options.toolUseId : null;
  const occurredAt = typeof options.occurredAt === 'string' && options.occurredAt ? options.occurredAt : new Date().toISOString();

  return {
    schema: EVENT_SCHEMA,
    version: EVENT_VERSION,
    eventId: deriveEventId({ transport: 'codex', eventType, sessionId, toolUseId, cwd, occurredAt }),
    eventType,
    transport: 'codex',
    occurredAt,
    receivedAt: new Date().toISOString(),
    sessionId,
    cwd,
    status,
    toolName,
    toolInput: options.toolInput && typeof options.toolInput === 'object' ? options.toolInput : null,
    toolUseId,
    actor: options.actor && typeof options.actor === 'object' ? options.actor : null,
    source: {
      nativeEventName: options.nativeEventName || eventType,
      adapter: ADAPTER,
      statusInferred: status === 'unknown',
      timestampInferred: !options.occurredAt,
      payloadHash: null,
    },
    raw: null,
    extensions: {},
  };
}

function deriveEventId(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

module.exports = { ADAPTER, EVENT_SCHEMA, EVENT_VERSION, normalizeCodexEvent };
