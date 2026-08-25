'use strict';

/**
 * engine/scripts/transport/index.cjs — transport 归一化层统一入口
 *
 * 职责：把各 agent/工具（Claude Code / WorkBuddy / Codex）的原始事件载荷
 * 归一化为 harness-event-v1 事件对象（契约见 engine/schemas/harness-event-v1.schema.json）。
 *
 * 这是 D1「真实事件语义」的守门层：
 *   - status 只在有明确证据时判定（事件名失败证据 / 载荷显式结果字段）；
 *   - 缺 status 一律 unknown，绝不因"走到这里了"而臆测成功；
 *   - 未知 transport / 非法载荷抛 EVENT_INVALID（fail-closed），调用方必须处理。
 *
 * 用法：
 *   const { normalize } = require('./engine/scripts/transport/index.cjs');
 *   const event = normalize(JSON.parse(stdin), 'workbuddy');
 *
 * 归一化层是纯函数、无副作用：不落盘、不读取环境状态，便于契约测试与多目标复用。
 */

const claudeCode = require('./claude-code.cjs');
const workbuddy = require('./workbuddy.cjs');
const codex = require('./codex.cjs');

const EVENT_SCHEMA = 'harness.event';
const EVENT_VERSION = 1;

/** 与 harness-event-v1.schema.json transport 枚举保持一致 */
const TRANSPORTS = ['claude-code', 'workbuddy', 'codex'];

/**
 * 按 transport 分发归一化。
 *
 * @param {object} raw 原始载荷
 *   - claude-code / workbuddy: hook stdin payload（JSON 对象）
 *   - codex: 结构化 options（{ eventType, status, sessionId, ... }）
 * @param {string} transport 目标 transport 名（claude-code | workbuddy | codex）
 * @returns {object} harness-event-v1 事件对象
 * @throws {Error} code=EVENT_INVALID — 未知 transport 或非法载荷
 */
function normalize(raw, transport) {
  if (typeof transport !== 'string' || !TRANSPORTS.includes(transport)) {
    const error = new Error(`transport: unsupported transport '${transport}' (expected one of ${TRANSPORTS.join(', ')})`);
    error.code = 'EVENT_INVALID';
    throw error;
  }
  switch (transport) {
    case 'claude-code':
      return claudeCode.normalizeClaudeEvent(raw);
    case 'workbuddy':
      return workbuddy.normalizeWorkbuddyEvent(raw);
    case 'codex':
      return codex.normalizeCodexEvent(raw);
    /* c8 ignore next 2 */
    default:
      throw Object.assign(new Error(`transport: unreachable transport '${transport}'`), { code: 'EVENT_INVALID' });
  }
}

/**
 * 事件名 → 中性 eventType 映射（不含结果语义，结果由 status 承载）。
 * 供渲染器/门禁层在既有 hook 命名空间与新契约间映射时复用。
 */
const EVENT_TYPE_BY_NATIVE = { ...claudeCode.EVENT_TYPE_BY_NATIVE, ...workbuddy.EVENT_TYPE_BY_NATIVE };

module.exports = {
  EVENT_SCHEMA,
  EVENT_VERSION,
  TRANSPORTS,
  normalize,
  EVENT_TYPE_BY_NATIVE,
  adapters: { claudeCode, workbuddy, codex },
};
