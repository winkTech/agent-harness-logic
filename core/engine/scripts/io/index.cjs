'use strict';

/**
 * core/engine/scripts/io/index.cjs — hook 输入/输出三通道编码器（Phase 2.2）
 *
 * 把「每个脚本自己拼 stdout」改为「声明通道 + 单点编码」：
 *
 *   normalizePayload(raw)  唯一入口：收编 14 处 tool_input||tool.input||input||
 *                          arguments 多形态探测；BOM 剥离内建；非对象 fail-closed。
 *   emitBlock(reason)      阻断通道：exit_code=2 + stderr 理由（Claude Code 阻断语义）。
 *   emitInject(context)    注入通道：hookSpecificOutput.additionalContext JSON。
 *   emitTelemetry(event)   遥测通道：结构化 JSON 行到 stderr（宿主日志面，不进上下文）。
 *
 * 通道语义与 transport/render.cjs（M3 决策渲染）的关系：renderDecision 负责
 * 「门禁判定 → 方言输出」；本模块负责「裸通道编码」——stdin/stderr 的字节形态
 * 只在这里定义一次。热路径无额外分配：emitBlock 是 process.exit(2) 的包装。
 */

// ── 输入归一 ────────────────────────────────────────────────────────────────

/**
 * 归一化 hook stdin 载荷。
 * @param {string|Buffer|object} raw 原始输入（字符串/Buffer 会剥 BOM 后 JSON.parse）
 * @returns {{ ok: true, payload: object, toolName: string, toolInput: object }}
 * @throws {{ ok: false, error: string }} 非对象/非法 JSON
 */
function normalizePayload(raw) {
  let payload = raw;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    const text = String(raw).replace(/^\uFEFF/, '');
    try {
      payload = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: `invalid JSON payload: ${e.message}` };
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload must be a JSON object' };
  }
  return {
    ok: true,
    payload,
    toolName: String(payload.tool_name || payload.tool?.name || payload.name || ''),
    toolInput: toolInputOf(payload),
  };
}

/** 工具入参多形态探测（原 14 处内联副本的唯一实现）。 */
function toolInputOf(payload) {
  const input = payload.tool_input ?? payload.tool?.input ?? payload.input ?? payload.arguments;
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

// ── 输出通道 ────────────────────────────────────────────────────────────────

/**
 * 阻断通道：exit_code=2 语义（Claude Code 把 stderr 展示给模型并阻止工具执行）。
 * 调用即终止进程；返回 never。
 */
function emitBlock(reason) {
  if (reason) process.stderr.write(`${String(reason).replace(/\s+$/, '')}\n`);
  process.exit(2);
}

/**
 * 注入通道：additionalContext（Claude Code hookSpecificOutput JSON 协议）。
 * 返回 JSON 字符串（含尾换行）——调用方 write 到 stdout 后自行 exit 0。
 */
function emitInject(context) {
  const text = typeof context === 'string' ? context : String(context ?? '');
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  })}\n`;
}

/**
 * 遥测通道：结构化 JSON 行到 stderr（宿主日志面；单行、紧凑、可 jq）。
 * 返回写入的字符串（不直接落 stderr——调用方决定静默/显式与节流策略）。
 */
function emitTelemetry(event) {
  const record = { ...(event && typeof event === 'object' ? event : { event: String(event) }) };
  if (!record.timestamp) record.timestamp = new Date().toISOString();
  return `${JSON.stringify(record)}\n`;
}

module.exports = {
  normalizePayload,
  toolInputOf,
  emitBlock,
  emitInject,
  emitTelemetry,
};
