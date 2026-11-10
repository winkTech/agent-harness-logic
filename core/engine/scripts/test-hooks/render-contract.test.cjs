'use strict';

/**
 * engine/scripts/test-hooks/render-contract.test.cjs — transport 输出渲染层契约测试
 *
 * 验证 engine/scripts/transport/render.cjs 的 renderDecision：
 *   1. 三 transport × {allow 有 context, allow 无 context, block} 的输出矩阵；
 *   2. claude-code / workbuddy 的 stdout 与路由现有 emit() 逐字节一致
 *      （基线函数 preflightEmitBaseline / postflightEmitBaseline 复现
 *       preflight-router.cjs / postflight-router.cjs 改造前 emit() 的 JSON 形状，
 *       含键顺序 hookEventName → additionalContext）；
 *   3. codex 走 harness.verdict 协议，allow 也必须出 stdout；
 *   4. fail-closed：未知 transport 抛 EVENT_INVALID；
 *   5. 纯函数：不写 stdout、不改 process.exitCode。
 *
 * 独立可执行：退出码 0 = 通过；失败打印堆栈并以 exit 1 结束。
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const transportRoot = path.join(HARNESS_ROOT, 'engine', 'scripts', 'transport');
const { renderDecision } = require(path.join(transportRoot, 'render.cjs'));

// ── 现有 emit() 的字节基线（复现，不引入路由依赖） ─────────────────────────

/**
 * preflight-router.cjs emit() 的既有行为：
 *   block → 无 stdout、exitCode 2（诊断走 stderr，由调用方负责）；
 *   否则 additionalContext 非空才写 hookSpecificOutput JSON。
 */
function preflightEmitBaseline({ decision, eventName, additionalContext }) {
  if (decision === 'block') return { stdout: null, exitCode: 2 };
  if (additionalContext) {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName || 'PreToolUse',
          additionalContext,
        },
      }),
      exitCode: 0,
    };
  }
  return { stdout: null, exitCode: 0 };
}

/**
 * postflight-router.cjs emit() 的既有行为：
 *   additionalContext 非空即写 hookSpecificOutput JSON（block 时也写）；
 *   decision === 'block' 再置 exitCode 2。
 */
function postflightEmitBaseline({ decision, eventName, additionalContext }) {
  const stdout = additionalContext
    ? JSON.stringify({
      hookSpecificOutput: {
        hookEventName: String(eventName || 'PostToolUseFailure'),
        additionalContext,
      },
    })
    : null;
  return { stdout, exitCode: decision === 'block' ? 2 : 0 };
}

// ── 1. 输出矩阵：三 transport × 三判定 ─────────────────────────────────────

const CONTEXT = 'harness: 新代码文件需先过需求门禁';
const DIAGNOSTICS = ['promoted-harness-gate: missing requirements gate', 'risk-policy: R3'];

const MATRIX = [
  { label: 'allow + context', input: { decision: 'allow', eventName: 'PreToolUse', additionalContext: CONTEXT, diagnostics: [] } },
  { label: 'allow no context', input: { decision: 'allow', eventName: 'PreToolUse', additionalContext: '', diagnostics: [] } },
  { label: 'block', input: { decision: 'block', eventName: 'PreToolUse', additionalContext: '', diagnostics: DIAGNOSTICS } },
];

let checks = 0;

for (const transport of ['claude-code', 'workbuddy']) {
  for (const { label, input } of MATRIX) {
    const actual = renderDecision(transport, input);
    const baseline = preflightEmitBaseline(input);
    assert.deepEqual(actual, baseline,
      `${transport} / ${label}: 必须与 preflight-router emit() 基线逐字节一致`);
    checks += 1;
  }
}

// codex：verdict 协议，allow 也出 stdout
for (const { label, input } of MATRIX) {
  const actual = renderDecision('codex', input);
  assert.equal(typeof actual.stdout, 'string', `codex / ${label}: 必须始终产出 stdout`);
  assert.equal(actual.exitCode, input.decision === 'block' ? 2 : 0, `codex / ${label}: exitCode`);
  assert.deepEqual(JSON.parse(actual.stdout), {
    schema: 'harness.verdict',
    version: 1,
    decision: input.decision,
    eventName: input.eventName,
    additionalContext: input.additionalContext,
    diagnostics: input.diagnostics,
  }, `codex / ${label}: verdict 形状`);
  checks += 1;
}

// ── 2. 逐字节：键顺序 hookEventName → additionalContext ────────────────────

const rendered = renderDecision('claude-code', { decision: 'allow', eventName: 'PreToolUse', additionalContext: CONTEXT });
assert.equal(
  rendered.stdout,
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":${JSON.stringify(CONTEXT)}}}`,
  'claude-code stdout 必须与现有 emit() 的键顺序与字节完全一致');
assert.equal(rendered.stdout, preflightEmitBaseline({ decision: 'allow', eventName: 'PreToolUse', additionalContext: CONTEXT }).stdout);

// eventName 缺省沿用 preflight-router emit() 的 'PreToolUse' 兜底
assert.equal(
  renderDecision('workbuddy', { decision: 'allow', additionalContext: CONTEXT }).stdout,
  preflightEmitBaseline({ decision: 'allow', eventName: undefined, additionalContext: CONTEXT }).stdout,
  'eventName 缺省必须兜底为 PreToolUse（与 emit() 一致）');

// 事件名透传：Stop / PostToolUse 等原生名必须原样进 hookEventName
for (const eventName of ['PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionStart', 'UserPromptSubmit']) {
  assert.equal(
    renderDecision('claude-code', { decision: 'allow', eventName, additionalContext: CONTEXT }).stdout,
    preflightEmitBaseline({ decision: 'allow', eventName, additionalContext: CONTEXT }).stdout,
    `事件名 ${eventName} 必须原样进 hookEventName`);
  checks += 1;
}

// ── 3. postflight 形态：block 时仍输出 additionalContext ───────────────────

for (const transport of ['claude-code', 'workbuddy']) {
  for (const decision of ['allow', 'block']) {
    const input = { decision, eventName: 'PostToolUseFailure', additionalContext: CONTEXT, diagnostics: DIAGNOSTICS };
    assert.deepEqual(
      renderDecision(transport, { ...input, emitContextOnBlock: true }),
      postflightEmitBaseline(input),
      `${transport} / postflight ${decision}: 必须与 postflight-router emit() 基线一致`);
    checks += 1;
  }
}
// 默认（emitContextOnBlock 缺省）是 preflight 语义：block 不出 stdout
assert.deepEqual(
  renderDecision('claude-code', { decision: 'block', eventName: 'PreToolUse', additionalContext: CONTEXT }),
  { stdout: null, exitCode: 2 },
  '缺省语义必须是 preflight：block 不输出 additionalContext');

// ── 4. fail-closed 与纯函数性 ──────────────────────────────────────────────

let threw = false;
try {
  renderDecision('gemini', { decision: 'allow', additionalContext: CONTEXT });
} catch (error) {
  threw = true;
  assert.equal(error.code, 'EVENT_INVALID', '未知 transport 必须抛 EVENT_INVALID');
}
assert.ok(threw, '未知 transport 必须抛（fail-closed）');

// 非 'block' 的任意判定按 allow 处理（不得误升级为拦截）
assert.equal(renderDecision('claude-code', { decision: 'warn', additionalContext: CONTEXT }).exitCode, 0,
  "非 'block' 判定不得产生 exitCode 2");
assert.deepEqual(renderDecision('claude-code', {}), { stdout: null, exitCode: 0 }, '空判定必须安全放行');

// 纯函数：不写 stdout、不动 process.exitCode
const beforeExitCode = process.exitCode;
const originalWrite = process.stdout.write;
let wrote = 0;
process.stdout.write = function patched(...args) { wrote += 1; return originalWrite.apply(process.stdout, args); };
try {
  renderDecision('claude-code', { decision: 'block', eventName: 'PreToolUse', additionalContext: CONTEXT, diagnostics: DIAGNOSTICS });
  renderDecision('codex', { decision: 'block', eventName: 'PreToolUse', additionalContext: CONTEXT, diagnostics: DIAGNOSTICS });
} finally {
  process.stdout.write = originalWrite;
}
assert.equal(wrote, 0, 'renderDecision 必须是纯函数：不得直接写 stdout');
assert.equal(process.exitCode, beforeExitCode, 'renderDecision 不得改写 process.exitCode');

process.stdout.write(`RENDER_CONTRACT_RESULT: PASS (${checks} 渲染断言 + 字节基线 + fail-closed)\n`);
