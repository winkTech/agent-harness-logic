'use strict';

/**
 * core/engine/scripts/transport/index.cjs — transport 归一化层统一入口
 *
 * 职责：把各 agent/工具（Claude Code / WorkBuddy / Codex）的原始事件载荷
 * 归一化为 harness-event-v1 事件对象（契约见 core/engine/schemas/harness-event-v1.schema.json）。
 *
 * 这是 D1「真实事件语义」的守门层：
 *   - status 只在有明确证据时判定（事件名失败证据 / 载荷显式结果字段）；
 *   - 缺 status 一律 unknown，绝不因"走到这里了"而臆测成功；
 *   - 未知 transport / 非法载荷抛 EVENT_INVALID（fail-closed），调用方必须处理。
 *
 * 用法：
 *   const { normalize } = require('./core/engine/scripts/transport/index.cjs');
 *   const event = normalize(JSON.parse(stdin), 'workbuddy');
 *
 *   // 边界入口（M3）：一次识别运行时，拿到事件 + 规范载荷
 *   const { transport, event, payload } = ingest(JSON.parse(stdin), { argv: process.argv });
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

/**
 * eventType → Claude 原生事件名的逆映射（首个声明者胜出，故 tool.post → PostToolUse）。
 * 失败语义单独由 status 承载：tool.post + failed → PostToolUseFailure（见 nativeEventNameFor）。
 */
const NATIVE_BY_EVENT_TYPE = (() => {
  const inverse = {};
  for (const [native, eventType] of Object.entries(EVENT_TYPE_BY_NATIVE)) {
    if (!(eventType in inverse)) inverse[eventType] = native;
  }
  return inverse;
})();

const DEFAULT_TRANSPORT = 'claude-code';

function invalidTransport(name) {
  const error = new Error(`transport: unsupported transport '${name}' (expected one of ${TRANSPORTS.join(', ')})`);
  error.code = 'EVENT_INVALID';
  return error;
}

/**
 * 解析 transport 名：显式 > argv `--transport <name>` / `--transport=<name>` >
 * env HARNESS_TRANSPORT > 'claude-code'。
 *
 * 纯函数语义：argv / env 由参数注入（默认绑定 process.argv / process.env，
 * 便于契约测试）。非法名抛 EVENT_INVALID（fail-closed，绝不静默降级）。
 *
 * @returns {string} TRANSPORTS 之一
 * @throws {Error} code=EVENT_INVALID
 */
function resolveTransport({ explicit, argv = process.argv, env = process.env } = {}) {
  const fromArgv = (() => {
    const list = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < list.length; i += 1) {
      const token = String(list[i] === undefined || list[i] === null ? '' : list[i]);
      if (token === '--transport') return list[i + 1] === undefined ? '' : String(list[i + 1]);
      if (token.startsWith('--transport=')) return token.slice('--transport='.length);
    }
    return null;
  })();
  const fromEnv = env && typeof env === 'object' && typeof env.HARNESS_TRANSPORT === 'string'
    ? env.HARNESS_TRANSPORT
    : null;

  for (const candidate of [explicit, fromArgv, fromEnv]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    if (typeof candidate !== 'string' || !TRANSPORTS.includes(candidate)) throw invalidTransport(candidate);
    return candidate;
  }
  return DEFAULT_TRANSPORT;
}

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * 归一化失败时的 fallback 事件：形状与 progress-watchdog 的 normalizePayload
 * fallback 一致（eventId='fallback'、adapter='fallback'、status='unknown'、
 * statusInferred/timestampInferred=true、payloadHash=null）。
 * 与之不同的是本函数保持纯粹：不读 env、不读 process.cwd()，缺字段用空值兜底。
 */
function fallbackEvent(raw, transportName) {
  const now = new Date().toISOString();
  return {
    schema: EVENT_SCHEMA,
    version: EVENT_VERSION,
    eventId: 'fallback',
    eventType: 'unknown',
    transport: transportName,
    occurredAt: now,
    receivedAt: now,
    sessionId: pickString(raw, ['session_id', 'sessionId', 'thread_id', 'threadId']) || 'unknown-session',
    cwd: pickString(raw, ['cwd', 'workspaceRoot', 'projectRoot']) || '',
    status: 'unknown',
    toolName: pickString(raw, ['tool_name', 'toolName', 'tool']),
    toolInput: null,
    toolUseId: null,
    actor: null,
    source: {
      nativeEventName: pickString(raw, ['hook_event_name', 'hookEventName', 'eventName', 'event']) || 'unknown',
      adapter: 'fallback',
      statusInferred: true,
      timestampInferred: true,
      payloadHash: null,
    },
    raw: null,
    extensions: {},
  };
}

/**
 * 规范载荷已映射的原始键（含各适配器的容错别名）：这些键的信息已进入规范载荷的
 * snake_case 字段，不再原样透传，避免同义键重复；未列入者一律原样保留。
 */
const MAPPED_RAW_KEYS = new Set([
  'hook_event_name', 'hookEventName', 'eventName', 'eventType', 'nativeEventName',
  'tool_name', 'toolName', 'tool',
  'tool_input', 'toolInput', 'input',
  'tool_use_id', 'toolUseId', 'tool_call_id', 'toolCallId',
  'session_id', 'sessionId', 'session',
  'cwd', 'workspaceRoot', 'projectRoot',
  'tool_response', 'toolResponse', 'result', 'output',
  'prompt',
  'transcript_path', 'transcriptPath',
  'source',
  'trigger',
  'stop_hook_active', 'stopHookActive',
  'error',
  'status',
]);

/**
 * 事件 → Claude 原生事件名（规范载荷的 hook_event_name）。
 * claude-code / workbuddy 直取 source.nativeEventName；codex 无 hook，
 * 其 nativeEventName 缺省即 eventType，故按 EVENT_TYPE_BY_NATIVE 的逆映射反推
 * （tool.post 且 status=failed → PostToolUseFailure）。
 */
function nativeEventNameFor(event) {
  const native = event && event.source ? event.source.nativeEventName : null;
  if (!event || event.transport !== 'codex') return native || 'unknown';
  if (event.eventType === 'tool.post' && event.status === 'failed') return 'PostToolUseFailure';
  if (native && Object.prototype.hasOwnProperty.call(EVENT_TYPE_BY_NATIVE, native)) return native;
  return NATIVE_BY_EVENT_TYPE[event.eventType] || native || 'unknown';
}

/**
 * 从事件 + 原始载荷生成规范载荷（Claude 形状 snake_case）：
 *   hook_event_name ← event.source.nativeEventName（codex 用 eventType 反查逆映射）
 *   tool_name / tool_input / tool_use_id / session_id / cwd ← event 对应字段
 *   tool_response ← raw.tool_response | raw.toolResponse | raw.result | raw.output（存在才写）
 *   prompt / transcript_path / source / trigger / stop_hook_active / error ← raw 的 snake 或 camel 同名键（存在才写）
 *   status ← event.status（'succeeded'|'failed'|'unknown'）
 * raw 里未被映射的其余键原样保留（不丢信息）。
 *
 * @param {object} event harness-event-v1 事件
 * @param {object} raw 原始载荷
 * @returns {object} 规范载荷（新对象，不修改入参）
 */
function toCanonicalPayload(event, raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const payload = {};
  for (const [key, value] of Object.entries(source)) {
    if (!MAPPED_RAW_KEYS.has(key)) payload[key] = value;
  }

  payload.hook_event_name = nativeEventNameFor(event);
  if (event && event.toolName !== null && event.toolName !== undefined) payload.tool_name = event.toolName;
  if (event && event.toolInput !== null && event.toolInput !== undefined) payload.tool_input = event.toolInput;
  if (event && event.toolUseId !== null && event.toolUseId !== undefined) payload.tool_use_id = event.toolUseId;
  payload.session_id = event && event.sessionId !== undefined ? event.sessionId : 'unknown-session';
  payload.cwd = event && event.cwd !== undefined ? event.cwd : '';

  const toolResponse = source.tool_response !== undefined ? source.tool_response
    : source.toolResponse !== undefined ? source.toolResponse
    : source.result !== undefined ? source.result
    : source.output !== undefined ? source.output
    : undefined;
  if (toolResponse !== undefined) payload.tool_response = toolResponse;
  if (source.prompt !== undefined) payload.prompt = source.prompt;
  const transcriptPath = source.transcript_path !== undefined ? source.transcript_path : source.transcriptPath;
  if (transcriptPath !== undefined) payload.transcript_path = transcriptPath;
  if (source.source !== undefined) payload.source = source.source;
  if (source.trigger !== undefined) payload.trigger = source.trigger;
  const stopHookActive = source.stop_hook_active !== undefined ? source.stop_hook_active : source.stopHookActive;
  if (stopHookActive !== undefined) payload.stop_hook_active = stopHookActive;
  if (source.error !== undefined) payload.error = source.error;

  payload.status = event && event.status !== undefined ? event.status : 'unknown';
  return payload;
}

/**
 * 边界入口：核心只在这里识别一次运行时。
 *
 * @param {object} raw 原始载荷（claude-code / workbuddy 为 hook stdin payload；codex 为结构化 options）
 * @param {object} [opts]
 * @param {string} [opts.transport] 显式 transport（优先级最高）
 * @param {string[]} [opts.argv] argv（用于 `--transport <name>`）
 * @param {object} [opts.env] env（用于 HARNESS_TRANSPORT）
 * @returns {{transport: string, event: object, payload: object, error: Error|null}}
 *   - event：normalize() 结果；归一化失败时为 status=unknown 的 fallback 事件
 *   - payload：规范载荷；claude-code 下**就是 raw 本身**（同一引用，恒等）
 *   - error：归一化 / transport 解析失败的原因；成功为 null
 *
 * 绝不抛：transport 解析失败或归一化失败都回落到 fallback 事件 + error，
 * 由调用方决定是否降级（fail-closed 的判定证据仍是 event.status=unknown）。
 */
function ingest(raw, { transport, argv, env } = {}) {
  let transportName = DEFAULT_TRANSPORT;
  let error = null;
  try {
    transportName = resolveTransport({ explicit: transport, argv, env });
  } catch (resolveError) {
    error = resolveError;
  }

  let event;
  if (error) {
    event = fallbackEvent(raw, transportName);
  } else {
    try {
      event = normalize(raw, transportName);
    } catch (normalizeError) {
      event = fallbackEvent(raw, transportName);
      error = normalizeError;
    }
  }

  // Claude Code 输入零行为变化：规范载荷对原始载荷是恒等（同一对象引用）。
  const payload = transportName === DEFAULT_TRANSPORT ? raw : toCanonicalPayload(event, raw);
  return { transport: transportName, event, payload, error };
}

module.exports = {
  EVENT_SCHEMA,
  EVENT_VERSION,
  TRANSPORTS,
  DEFAULT_TRANSPORT,
  normalize,
  resolveTransport,
  ingest,
  toCanonicalPayload,
  nativeEventNameFor,
  fallbackEvent,
  EVENT_TYPE_BY_NATIVE,
  NATIVE_BY_EVENT_TYPE,
  MAPPED_RAW_KEYS,
  adapters: { claudeCode, workbuddy, codex },
};
