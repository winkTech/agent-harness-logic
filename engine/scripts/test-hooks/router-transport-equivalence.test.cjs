'use strict';

/**
 * engine/scripts/test-hooks/router-transport-equivalence.test.cjs
 *   —— 路由层 transport 等价性契约（M3 D2）
 *
 * M3 的核心命题：核心只在**边界**识别一次运行时。同一个逻辑动作，
 * 无论以 Claude 的 snake_case 载荷（transport=claude-code）还是 WorkBuddy 的
 * camelCase 载荷（hookEventName / toolName / toolInput / sessionId，
 * transport=workbuddy）进来，19 个门禁看到的规范载荷相同，因而判定必须相同。
 *
 * 本测试用两个路由的进程内入口 decide(raw, { transport })（不写 stdout、
 * 不设 exitCode）比对：
 *   1. decision（allow / warn / block）
 *   2. diagnostics 的 source 集合（哪些门禁发声，不比对文本细节）
 *   3. additionalContext（注入正文逐字节一致）
 * 时间戳与 eventId 不进入比对面 —— decide 不返回它们。
 * 另外直接比对 ingest 产出的规范载荷字段（tool_name / tool_input / session_id /
 * cwd / hook_event_name），把"判定相同"的原因钉死在归一化上，而不是碰巧同为 allow。
 *
 * 覆盖：
 *   preflight  —— Read（allow 无 context）、Write 新 .cjs（advisory context）、
 *                 Bash `git push --force origin main`（block）
 *   postflight —— PostToolUse Read、PostToolUseFailure Bash、PostToolUse Write（warn）
 *
 * 判定必须落在不同取值上（allow / warn / block 三种都出现），否则"全等"没有区分力。
 */

process.env.CLAUDE_HARNESS_NO_PERSIST = '1';

// 状态根隔离（必须在下方 require 路由器之前）：路由器的重复失败检测会读取
// 状态根下累积的真实事件历史——本机反复跑过该用例后，PostToolUseFailure Bash
// 会被"同一错误签名第二次出现"逻辑判 warn 而非 allow，10s 慢路径即历史扫描。
// harness-state 在模块加载时解析一次，因此这里把 HARNESS_STATE_DIR 指向全新
// 临时目录，用例看到的是零事件的干净状态（与 CI / 新克隆等价）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.HARNESS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'router-equiv-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

// best-effort 清理；状态目录即使残留也在系统临时目录，不影响任何判定。
test.after(() => {
  try {
    fs.rmSync(process.env.HARNESS_STATE_DIR, { recursive: true, force: true });
  } catch { /* Windows 句柄占用时留待系统清理 */ }
});

const hooksRoot = path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks');
const preflight = require(path.join(hooksRoot, 'preflight-router.cjs'));
const postflight = require(path.join(hooksRoot, 'postflight-router.cjs'));
const { ingest } = require(path.join(HARNESS_ROOT, 'engine', 'scripts', 'transport', 'index.cjs'));

const CWD = String(HARNESS_ROOT).replace(/\\/g, '/');
const SESSION = 'm3-transport-equivalence';

/** 规范载荷的比对面：门禁真正读的字段。status 是 WorkBuddy 独有的额外证据，不入比对。 */
const CANONICAL_FIELDS = ['hook_event_name', 'tool_name', 'tool_input', 'session_id', 'cwd'];

function canonicalOf(raw, transport) {
  const { payload, error } = ingest(raw, { transport, argv: [], env: {} });
  assert.equal(error, null, `ingest(${transport}) 不应报错`);
  const picked = {};
  for (const key of CANONICAL_FIELDS) picked[key] = payload[key];
  return picked;
}

/**
 * 一对等价载荷：同一逻辑动作的 Claude snake_case 与 WorkBuddy camelCase 形态。
 * @returns {{name, expected, claude, workbuddy}}
 */
function pair(name, expected, claude, workbuddy) {
  return { name, expected, claude, workbuddy };
}

const READ_TARGET = `${CWD}/README.md`;
const NEW_MODULE = `${CWD}/var/tmp/m3-transport-equivalence-module.cjs`;
const NEW_MODULE_CONTENT = 'module.exports = {};';
const FORCE_PUSH = 'git push --force origin main';

const PREFLIGHT_PAIRS = [
  pair(
    'PreToolUse Read —— 只读，allow 且无 context',
    'allow',
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      session_id: SESSION,
      cwd: CWD,
      tool_input: { file_path: READ_TARGET },
    },
    {
      hookEventName: 'PreToolUse',
      toolName: 'Read',
      sessionId: SESSION,
      cwd: CWD,
      toolInput: { file_path: READ_TARGET },
    },
  ),
  pair(
    'PreToolUse Write 新 .cjs —— allow 带 advisory context',
    'allow',
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      session_id: SESSION,
      cwd: CWD,
      tool_input: { file_path: NEW_MODULE, content: NEW_MODULE_CONTENT },
    },
    {
      hookEventName: 'PreToolUse',
      toolName: 'Write',
      sessionId: SESSION,
      cwd: CWD,
      toolInput: { file_path: NEW_MODULE, content: NEW_MODULE_CONTENT },
    },
  ),
  pair(
    'PreToolUse Bash git push --force —— block',
    'block',
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      session_id: SESSION,
      cwd: CWD,
      tool_input: { command: FORCE_PUSH },
    },
    {
      hookEventName: 'PreToolUse',
      toolName: 'Bash',
      sessionId: SESSION,
      cwd: CWD,
      toolInput: { command: FORCE_PUSH },
    },
  ),
];

const POSTFLIGHT_PAIRS = [
  pair(
    'PostToolUse Read —— allow',
    'allow',
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      session_id: SESSION,
      cwd: CWD,
      tool_input: { file_path: READ_TARGET },
      tool_response: { ok: true },
    },
    {
      hookEventName: 'PostToolUse',
      toolName: 'Read',
      sessionId: SESSION,
      cwd: CWD,
      toolInput: { file_path: READ_TARGET },
      toolResponse: { ok: true },
    },
  ),
  pair(
    'PostToolUseFailure Bash —— allow（观察者路径）',
    'allow',
    {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      session_id: SESSION,
      cwd: CWD,
      tool_input: { command: 'node --test does-not-exist' },
      error: 'exit 1',
    },
    {
      hookEventName: 'PostToolUseFailure',
      toolName: 'Bash',
      sessionId: SESSION,
      cwd: CWD,
      toolInput: { command: 'node --test does-not-exist' },
      error: 'exit 1',
    },
  ),
  pair(
    'PostToolUse Write —— warn（验证门禁发声）',
    'warn',
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      session_id: SESSION,
      cwd: CWD,
      tool_input: { file_path: NEW_MODULE, content: NEW_MODULE_CONTENT },
      tool_response: { ok: true },
    },
    {
      hookEventName: 'PostToolUse',
      toolName: 'Write',
      sessionId: SESSION,
      cwd: CWD,
      toolInput: { file_path: NEW_MODULE, content: NEW_MODULE_CONTENT },
      toolResponse: { ok: true },
    },
  ),
];

function assertPayloadEquivalence(entry) {
  assert.deepEqual(
    canonicalOf(entry.workbuddy, 'workbuddy'),
    canonicalOf(entry.claude, 'claude-code'),
    `${entry.name}: WorkBuddy 载荷归一化后必须与 Claude 载荷逐字段一致`,
  );
}

async function assertRouterEquivalence(router, entry) {
  const fromClaude = await router.decide(entry.claude, { transport: 'claude-code' });
  const fromWorkbuddy = await router.decide(entry.workbuddy, { transport: 'workbuddy' });

  assert.equal(fromClaude.transport, 'claude-code');
  assert.equal(fromWorkbuddy.transport, 'workbuddy');

  assert.equal(fromClaude.decision, entry.expected,
    `${entry.name}: Claude 载荷的判定应为 ${entry.expected}`);
  assert.equal(fromWorkbuddy.decision, fromClaude.decision,
    `${entry.name}: 两个 transport 的 decision 必须相同`);
  assert.deepEqual(fromWorkbuddy.diagnosticsSources, fromClaude.diagnosticsSources,
    `${entry.name}: 发声的门禁集合必须相同`);
  assert.equal(fromWorkbuddy.additionalContext, fromClaude.additionalContext,
    `${entry.name}: 注入的 additionalContext 必须逐字节相同`);
  return fromClaude;
}

test('规范载荷等价：WorkBuddy camelCase 归一化后与 Claude snake_case 逐字段一致', () => {
  for (const entry of [...PREFLIGHT_PAIRS, ...POSTFLIGHT_PAIRS]) assertPayloadEquivalence(entry);
});

test('preflight-router：两个 transport 判定等价', async () => {
  const decisions = [];
  for (const entry of PREFLIGHT_PAIRS) {
    decisions.push((await assertRouterEquivalence(preflight, entry)).decision);
  }
  assert.ok(decisions.includes('block'),
    'preflight 用例必须含一个 block，否则等价断言没有区分力');
  assert.ok(decisions.includes('allow'), 'preflight 用例必须含一个 allow');
});

test('preflight-router：Read 无 context，Write 新模块有 advisory context', async () => {
  const read = await preflight.decide(PREFLIGHT_PAIRS[0].workbuddy, { transport: 'workbuddy' });
  assert.equal(read.additionalContext, '', 'Read 是只读动作，不应注入 context');

  const write = await preflight.decide(PREFLIGHT_PAIRS[1].workbuddy, { transport: 'workbuddy' });
  assert.ok(write.additionalContext.length > 0, 'Write 新代码文件应产出 advisory context');

  const blocked = await preflight.decide(PREFLIGHT_PAIRS[2].workbuddy, { transport: 'workbuddy' });
  assert.equal(blocked.additionalContext, '', 'block 形态不注入 context（emitContextOnBlock=false）');
  assert.ok(blocked.diagnosticsSources.length > 0, 'block 必须留下诊断来源');
});

test('postflight-router：两个 transport 判定等价', async () => {
  const decisions = [];
  for (const entry of POSTFLIGHT_PAIRS) {
    decisions.push((await assertRouterEquivalence(postflight, entry)).decision);
  }
  assert.ok(decisions.includes('warn'),
    'postflight 用例必须含一个非 allow 判定，否则等价断言没有区分力');
});
