#!/usr/bin/env node
'use strict';

/**
 * 契约：preflight 路由的门禁**加载**失败只降级，不让进程 fatal。
 *
 * 背景：2026-09-02 与 2026-09-04 两次事故都是同一形态 —— runCommon 里的裸 require
 * （progress-watchdog / tool-action-contract-gate / agent-transparency-ledger）或路由自身的
 * 运行期异常把 PreToolUse 打成 exit 2，于是本机所有会话的工具调用被拒且 Agent 无法自救。
 * 这里用注入的抛错 loader 覆盖三条加载路径，并覆盖 fallbackDecision 的兜底判定：
 * 加载失败 → warn + 继续；只有 bash-safety / file-protection 两个硬拦截保持 fail-closed。
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
// 副本协议：替换前可用 PREFLIGHT_ROUTER_PATH 指向 preflight-router.next.cjs 先验证副本。
const ROUTER_PATH = process.env.PREFLIGHT_ROUTER_PATH
  ? path.resolve(ROOT, process.env.PREFLIGHT_ROUTER_PATH)
  : path.join(ROOT, 'core', 'engine', 'scripts', 'hooks', 'preflight-router.cjs');
const router = require(ROUTER_PATH);

const NO_PERSIST_ENV = { CLAUDE_HARNESS_NO_PERSIST: '1' };

function writePayload() {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    session_id: 'gate-load-degradation',
    cwd: ROOT,
    tool_input: {
      file_path: path.join(ROOT, 'var', 'tmp', 'gate-load-degradation.cjs'),
      content: 'module.exports = {};',
    },
  };
}

function readPayload() {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    session_id: 'gate-load-degradation',
    cwd: ROOT,
    tool_input: { file_path: path.join(ROOT, 'README.md') },
  };
}

function bashPayload(command) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    session_id: 'gate-load-degradation',
    cwd: ROOT,
    tool_input: { command },
  };
}

const throwingLoader = (name) => () => {
  throw new Error(`injected load failure: ${name}`);
};

/** 不触发合同写入的账本桩：让 runCommon 走到 watchdog 段。 */
const inertLedger = () => ({
  mayRequireActionContract: () => false,
  buildContext: () => ({}),
  run: () => ({ artifacts: {} }),
});

/** 触发合同写入的账本桩：让 runCommon 走到 tool-action-contract-gate 加载点。 */
const activeLedger = () => ({
  mayRequireActionContract: () => true,
  buildContext: () => ({ loopScope: { status: 'open' } }),
  run: () => ({ artifacts: { toolActionContract: { id: 'stub-contract' } } }),
});

/** 只读判定的 watchdog 桩：不写任何会话状态。 */
const inertWatchdog = () => ({
  isReadOnlyAction: () => true,
  inspectProgress: () => ({ status: 'ok' }),
});

function assertLoadFailure(result, source) {
  assert.notEqual(result.decision, 'block',
    `${source} 加载失败不得阻断工具调用`);
  assert.ok(result.diagnosticsSources.includes(source),
    `${source} 加载失败必须留下诊断来源，实际：${result.diagnosticsSources.join(', ')}`);
  const message = result.diagnostics.find((item) => item.startsWith(`[${source}]`)) || '';
  assert.match(message, /load failed/,
    `${source} 的诊断必须说明是加载失败，实际：${message}`);
}

test('progress-watchdog 加载失败降级为 warn，不抛也不阻断', async () => {
  const result = await router.decide(writePayload(), {
    env: {},
    loaders: {
      'agent-transparency-ledger': inertLedger,
      'progress-watchdog': throwingLoader('progress-watchdog'),
    },
  });
  assertLoadFailure(result, 'progress-watchdog');
});

test('tool-action-contract-gate 加载失败降级为 warn，不抛也不阻断', async () => {
  const result = await router.decide(writePayload(), {
    env: {},
    loaders: {
      'agent-transparency-ledger': activeLedger,
      'tool-action-contract-gate': throwingLoader('tool-action-contract-gate'),
      'progress-watchdog': inertWatchdog,
    },
  });
  assertLoadFailure(result, 'tool-action-contract');
});

test('agent-transparency-ledger 加载失败降级为 warn，不抛也不阻断', async () => {
  const result = await router.decide(writePayload(), {
    env: {},
    loaders: {
      'agent-transparency-ledger': throwingLoader('agent-transparency-ledger'),
      'progress-watchdog': inertWatchdog,
    },
  });
  assertLoadFailure(result, 'agent-transparency-ledger');
});

test('bash-safety 加载失败仍然 fail-closed：force push 被阻断', async () => {
  const result = await router.decide(bashPayload('git push --force origin main'), {
    env: NO_PERSIST_ENV,
    loaders: { 'bash-safety-guard': throwingLoader('bash-safety-guard') },
  });
  assert.equal(result.decision, 'block',
    'bash-safety 是 fail-closed 白名单成员，加载失败必须按阻断处理');
});

test('fallbackDecision：只读载荷在路由异常时降级放行', () => {
  const result = router.fallbackDecision(readPayload(), new Error('router exploded'));
  assert.equal(result.exitCode, 0, '只读动作不得因路由自身异常被拒');
  assert.equal(result.decision, 'allow');
  assert.match(result.stderr, /degraded/, '降级放行必须在 stderr 留下 degraded 警告');
  assert.match(result.stderr, /router exploded/, '降级警告必须带上原始异常原因');
});

test('fallbackDecision：force push 在路由异常时仍然阻断', () => {
  const result = router.fallbackDecision(
    bashPayload('git push --force origin main'),
    new Error('router exploded'),
  );
  assert.equal(result.exitCode, 2, '硬安全在兜底路径必须继续阻断');
  assert.equal(result.decision, 'block');
});

test('fallbackDecision：兜底守卫自身加载失败按阻断处理', () => {
  const result = router.fallbackDecision(readPayload(), new Error('router exploded'), {
    loaders: { 'bash-safety-guard': throwingLoader('bash-safety-guard') },
  });
  assert.equal(result.exitCode, 2, '兜底守卫不可用时不得静默放行');
  assert.match(result.stderr, /fallback guard unavailable/);
});
