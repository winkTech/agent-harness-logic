#!/usr/bin/env node
'use strict';
// hook-health 契约测试 —— 错误遏制 + 健康遥测。全部用注入/临时目录，
// 不碰真实 var/、不触发宿主 hook（settings.json 注册面）。
//   1. recordHealth 成功写一行且格式正确（ts/hook/event/outcome/ms/error）
//   2. recordHealth 输出目录不可写时不抛异常
//   3. preflight main 顶层崩溃（非法 JSON）→ 既有语义 exit 2 + error 事件
//   4. preflight main 正常路径 → exit 0 + ok 事件（含数值 ms）
//   5. postflight main 正常路径 → exit 0 + ok 事件
//   6. preflight fail-closed 守卫（bash-safety）注入异常 → 进程不崩、
//      既有语义保持 block、jsonl 出现 outcome=error 事件
//   7. postflight 门禁（verification-gate）注入异常 → 进程不崩、
//      既有语义降级 warn、jsonl 出现 outcome=fail-open 事件
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PREFLIGHT = path.join(ROOT, 'engine', 'scripts', 'hooks', 'preflight-router.cjs');
const POSTFLIGHT = path.join(ROOT, 'engine', 'scripts', 'hooks', 'postflight-router.cjs');

// HARNESS_STATE_DIR 必须在任何 require 之前设置 —— harness-state / hook-health
// 都在模块加载期解析一次状态根。只读类环境变量全部清掉，保证遥测可写。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-health-contract-'));
process.env.HARNESS_STATE_DIR = path.join(TMP, 'state');
for (const key of [
  'CLAUDE_HARNESS_NO_PERSIST',
  'CLAUDE_HARNESS_VERIFY_READONLY',
  'CLAUDE_NO_DIAGNOSTIC_WRITES',
  'CLAUDE_HOOK_NO_WRITE',
]) delete process.env[key];

const { recordHealth, readHealthLog, STORE_FILE } = require(path.join(ROOT, 'engine', 'scripts', 'lib', 'hook-health.cjs'));

/** 子进程用同一套净化环境：HARNESS_STATE_DIR 指到各自独立临时目录。 */
function spawnEnv(stateDir) {
  const env = { ...process.env, HARNESS_STATE_DIR: stateDir };
  return env;
}

function makeStateDir(name) {
  const stateDir = path.join(TMP, name);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

// 1. recordHealth 成功写一行且格式正确
{
  recordHealth({
    hook: 'preflight-router',
    event: 'PreToolUse',
    outcome: 'ok',
    ms: 12.6,
    error: null,
  });
  const entries = readHealthLog({ file: STORE_FILE });
  assert.equal(entries.length, 1, `exactly one line expected, got ${entries.length}`);
  const entry = entries[0];
  assert.equal(entry.hook, 'preflight-router');
  assert.equal(entry.event, 'PreToolUse');
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.ms, 13, 'ms must be rounded to integer');
  assert.equal(entry.error, null);
  assert.ok(!Number.isNaN(Date.parse(entry.ts)), `ts must be ISO time, got ${entry.ts}`);
  console.log('ok 1 - recordHealth writes one well-formed line');
}

// 2. recordHealth 输出目录不可写（父路径被普通文件占据 → ENOTDIR）时不抛异常
{
  const blockerDir = path.join(TMP, 'blocker');
  fs.writeFileSync(blockerDir, 'not a directory');
  const unreachable = path.join(blockerDir, 'metrics', 'hook-health.jsonl');
  assert.doesNotThrow(() => recordHealth({
    hook: 'preflight-router',
    event: 'PreToolUse',
    outcome: 'ok',
    ms: 1,
    error: null,
  }, { file: unreachable }), 'recordHealth must never throw on unwritable output');
  console.log('ok 2 - recordHealth silently survives unwritable output dir');
}

// 3. preflight main 顶层崩溃（非法 JSON）→ 既有语义 exit 2 + error 事件
{
  const stateDir = makeStateDir('preflight-invalid-json');
  const r = cp.spawnSync('node', [PREFLIGHT], {
    input: 'not-json-at-all',
    cwd: TMP,
    env: spawnEnv(stateDir),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 2, `invalid JSON must keep exit 2, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /invalid PreToolUse JSON/, 'stderr must keep the existing diagnostic');
  const events = readHealthLog({ file: path.join(stateDir, 'var', 'metrics', 'hook-health.jsonl') });
  const errorEvent = events.find((e) => e.hook === 'preflight-router' && e.outcome === 'error');
  assert.ok(errorEvent, 'hook-health.jsonl must contain a preflight error event');
  assert.match(errorEvent.error, /invalid PreToolUse JSON/);
  assert.equal(errorEvent.event, 'PreToolUse');
  assert.ok(Number.isFinite(errorEvent.ms), 'top-level event must carry wall-time ms');
  console.log('ok 3 - preflight top-level crash keeps exit 2 and records error event');
}

// 4. preflight main 正常路径（只读工具）→ exit 0 + ok 事件
{
  const stateDir = makeStateDir('preflight-ok');
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'some-file.txt' },
    cwd: TMP,
  });
  const r = cp.spawnSync('node', [PREFLIGHT], {
    input: payload,
    cwd: TMP,
    env: spawnEnv(stateDir),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, `healthy run must exit 0, got ${r.status}: ${r.stderr}`);
  const events = readHealthLog({ file: path.join(stateDir, 'var', 'metrics', 'hook-health.jsonl') });
  const okEvent = events.find((e) => e.hook === 'preflight-router' && e.outcome === 'ok');
  assert.ok(okEvent, 'hook-health.jsonl must contain a preflight ok event');
  assert.equal(okEvent.event, 'PreToolUse');
  assert.ok(Number.isFinite(okEvent.ms) && okEvent.ms >= 0, `ok event must carry ms, got ${okEvent.ms}`);
  assert.equal(okEvent.error, null);
  console.log('ok 4 - preflight healthy run records ok event with ms');
}

// 5. postflight main 正常路径（只读工具）→ exit 0 + ok 事件
{
  const stateDir = makeStateDir('postflight-ok');
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'some-file.txt' },
    cwd: TMP,
    tool_response: { stdout: 'contents' },
  });
  const r = cp.spawnSync('node', [POSTFLIGHT], {
    input: payload,
    cwd: TMP,
    env: spawnEnv(stateDir),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, `healthy run must exit 0, got ${r.status}: ${r.stderr}`);
  const events = readHealthLog({ file: path.join(stateDir, 'var', 'metrics', 'hook-health.jsonl') });
  const okEvent = events.find((e) => e.hook === 'postflight-router' && e.outcome === 'ok');
  assert.ok(okEvent, 'hook-health.jsonl must contain a postflight ok event');
  assert.equal(okEvent.event, 'PostToolUse');
  assert.ok(Number.isFinite(okEvent.ms) && okEvent.ms >= 0);
  console.log('ok 5 - postflight healthy run records ok event with ms');
}

// 6. preflight fail-closed 守卫注入异常 → 不崩、既有语义 block、jsonl error 事件
{
  const stateDir = makeStateDir('preflight-guard-crash');
  const driver = [
    "'use strict';",
    `const router = require(${JSON.stringify(PREFLIGHT)});`,
    'const payload = { hook_event_name: "PreToolUse", tool_name: "Bash",',
    '  tool_input: { command: "echo hi" }, cwd: process.cwd() };',
    'router.decide(payload, { loaders: {',
    '  "bash-safety-guard": () => { throw new Error("injected-guard-crash"); },',
    '} }).then((r) => {',
    '  process.stdout.write(JSON.stringify({ decision: r.decision }) + "\\n");',
    '}).catch((e) => {',
    '  process.stderr.write(String((e && e.stack) || e) + "\\n");',
    '  process.exitCode = 1;',
    '});',
  ].join('\n');
  const driverPath = path.join(stateDir, 'driver-preflight.cjs');
  fs.writeFileSync(driverPath, driver);
  const r = cp.spawnSync('node', [driverPath], {
    cwd: stateDir,
    env: spawnEnv(stateDir),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, `process must not crash, got exit=${r.status}: ${r.stderr}`);
  const reported = JSON.parse(r.stdout.trim());
  assert.equal(reported.decision, 'block',
    'fail-closed guard crash must keep the existing block semantics');
  const events = readHealthLog({ file: path.join(stateDir, 'var', 'metrics', 'hook-health.jsonl') });
  const errorEvent = events.find((e) => e.hook === 'preflight-router'
    && e.outcome === 'error' && /injected-guard-crash/.test(String(e.error)));
  assert.ok(errorEvent, 'hook-health.jsonl must record the injected guard crash');
  assert.equal(errorEvent.event, 'PreToolUse');
  console.log('ok 6 - preflight fail-closed guard crash: no crash, block kept, error event recorded');
}

// 7. postflight 门禁注入异常 → 不崩、既有语义降级 warn、jsonl fail-open 事件
{
  const stateDir = makeStateDir('postflight-gate-crash');
  const driver = [
    "'use strict';",
    `const router = require(${JSON.stringify(POSTFLIGHT)});`,
    'const payload = { hook_event_name: "PostToolUse", tool_name: "Bash",',
    '  tool_input: { command: "echo hi" }, cwd: process.cwd(),',
    '  tool_response: { stdout: "hi" } };',
    'router.route(payload, {',
    '  verificationGate: { evaluate() { throw new Error("injected-gate-crash"); } },',
    '}).then((r) => {',
    '  process.stdout.write(JSON.stringify({ decision: r.decision }) + "\\n");',
    '}).catch((e) => {',
    '  process.stderr.write(String((e && e.stack) || e) + "\\n");',
    '  process.exitCode = 1;',
    '});',
  ].join('\n');
  const driverPath = path.join(stateDir, 'driver-postflight.cjs');
  fs.writeFileSync(driverPath, driver);
  const r = cp.spawnSync('node', [driverPath], {
    cwd: stateDir,
    env: spawnEnv(stateDir),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, `process must not crash, got exit=${r.status}: ${r.stderr}`);
  const reported = JSON.parse(r.stdout.trim());
  assert.equal(reported.decision, 'warn',
    'fail-open gate crash must keep the existing warn (degraded advisory) semantics');
  const events = readHealthLog({ file: path.join(stateDir, 'var', 'metrics', 'hook-health.jsonl') });
  const failOpenEvent = events.find((e) => e.hook === 'postflight-router'
    && e.outcome === 'fail-open' && /injected-gate-crash/.test(String(e.error)));
  assert.ok(failOpenEvent, 'hook-health.jsonl must record the injected gate crash');
  assert.equal(failOpenEvent.event, 'PostToolUse');
  console.log('ok 7 - postflight fail-open gate crash: no crash, warn kept, fail-open event recorded');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('hook-health contract: all checks passed');
