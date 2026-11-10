#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/hook-latency-sla-contract.test.cjs — 延迟档位硬门契约（M4a E2）
 *
 * 覆盖断言：
 *   1. 档位判定：preflight-router 200ms / postflight-router 250ms / prompt-context 300ms /
 *      其余同步入口 500ms；
 *   2. scale 生效：CLAUDE_HARNESS_LATENCY_SCALE=3 时 450ms 的 preflight 通过（预算 600ms）；
 *   3. async-only 入口不计入判定，落在 skipped 里；同一脚本既有同步又有 async 注册时按同步算；
 *   4. 任一超标样本让 evaluateSla 判定为 fail 并列进 violations。
 *
 * 全部用注入的 registrations 文档与注入的基准结果，纯函数判定 ——
 * 不读真实 registrations.json、不真实拉起任何 hook、不写任何运行时状态。
 *
 * 独立可执行：退出码 0 = 通过（由 run-all-tests.cjs 的 AuditRemediationContracts 组 spawn 校验）。
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const {
  budgetFor,
  registrationIndex,
  latencyScale,
  normalizeScriptName,
  scriptNamesFromCommand,
  SCRIPT_BUDGETS_MS,
  DEFAULT_SYNC_BUDGET_MS,
} = require(path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'hook-latency.cjs'));
const { evaluateSla } = require(path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'bench-hooks.cjs'));

/** 注入的 registrations：同步入口 4 条、async-only 1 条、同步+async 混合 1 条。 */
function syncHook(script) {
  return { type: 'command', command: `node {{HARNESS_ROOT}}/core/engine/scripts/hooks/${script}.cjs` };
}
function asyncHook(script, args = '') {
  return { type: 'command', command: `node {{HARNESS_ROOT}}/core/engine/scripts/hooks/${script}.cjs${args}`, async: true };
}

const REGISTRATIONS = {
  version: 1,
  hooks: {
    PreToolUse: [{ matcher: '*', hooks: [syncHook('preflight-router')] }],
    PostToolUse: [{
      matcher: '*',
      hooks: [syncHook('postflight-router'), asyncHook('postflight-observer')],
    }],
    UserPromptSubmit: [{ hooks: [syncHook('prompt-context')] }],
    SessionStart: [{ hooks: [syncHook('session-bootstrap'), syncHook('git-integrity-guard')] }],
    // git-integrity-guard 在 Stop 上是 async：同一脚本混合注册时必须按同步算。
    Stop: [{ hooks: [asyncHook('git-integrity-guard')] }],
  },
};

const INDEX = registrationIndex({ registrations: REGISTRATIONS });

function benchResult(script, warmP95, extra = {}) {
  return {
    point: 'PreToolUse',
    cmd: `node C:/Users/Lihan/.claude/core/engine/scripts/hooks/${script}.cjs`,
    id: `node C:/Users/Lihan/.claude/core/engine/scripts/hooks/${script}.cjs`,
    script: `node C:/Users/Lihan/.claude/core/engine/scripts/hooks/${script}`.slice(0, 60),
    ok: true,
    skipped: false,
    isAsync: false,
    warm_p95_ms: warmP95,
    ...extra,
  };
}

function evaluate(results, opts = {}) {
  return evaluateSla(results, { index: INDEX, scale: 1, ...opts });
}

// ── 1. 档位判定 ─────────────────────────────────────────────────────────────

test('每个脚本拿到自己档位的预算（scale=1）', () => {
  const expected = {
    'preflight-router': 200,
    'postflight-router': 250,
    'prompt-context': 300,
    'session-bootstrap': DEFAULT_SYNC_BUDGET_MS,
    'git-integrity-guard': DEFAULT_SYNC_BUDGET_MS,
  };
  for (const [script, budgetMs] of Object.entries(expected)) {
    const budget = budgetFor(script, { index: INDEX, scale: 1 });
    assert.equal(budget.budgetMs, budgetMs, `${script} 预算应为 ${budgetMs}ms`);
    assert.equal(budget.async, false, `${script} 不应被判为 async`);
  }
  assert.equal(SCRIPT_BUDGETS_MS['preflight-router'], 200);
  assert.equal(DEFAULT_SYNC_BUDGET_MS, 500);
});

test('档位判定进入 evaluateSla：刚好在预算内通过、超 1ms 即超标', () => {
  const cases = [
    ['preflight-router', 200],
    ['postflight-router', 250],
    ['prompt-context', 300],
    ['session-bootstrap', 500],
  ];
  for (const [script, budgetMs] of cases) {
    const inside = evaluate([benchResult(script, budgetMs)]);
    assert.equal(inside.pass, true, `${script} ${budgetMs}ms 应在预算内`);
    assert.equal(inside.checks[0].budget_ms, budgetMs);
    assert.equal(inside.checks[0].script, script);

    const outside = evaluate([benchResult(script, budgetMs + 1)]);
    assert.equal(outside.pass, false, `${script} ${budgetMs + 1}ms 应超标`);
  }
});

test('命令行/路径形式的脚本名归一化到同一档位', () => {
  assert.equal(normalizeScriptName('C:\\x\\engine\\scripts\\hooks\\preflight-router.cjs'), 'preflight-router');
  assert.equal(normalizeScriptName('stop-runner:evidence'), 'stop-runner');
  assert.deepEqual(
    scriptNamesFromCommand('node /a/b/prompt-context.cjs --json'),
    ['prompt-context'],
  );
});

// ── 2. scale 生效 ───────────────────────────────────────────────────────────

test('CLAUDE_HARNESS_LATENCY_SCALE=3 时 450ms 的 preflight 通过', () => {
  const env = { CLAUDE_HARNESS_LATENCY_SCALE: '3' };
  assert.equal(latencyScale(env), 3);

  const budget = budgetFor('preflight-router', { index: INDEX, env });
  assert.equal(budget.scale, 3);
  assert.equal(budget.budgetMs, 600);

  // 同一个 450ms 样本：scale=1 超标，scale=3 通过。
  const sample = [benchResult('preflight-router', 450)];
  assert.equal(evaluate(sample).pass, false, 'scale=1 下 450ms 应超标');

  const scaled = evaluateSla(sample, { index: INDEX, env });
  assert.equal(scaled.scale, 3);
  assert.equal(scaled.checks[0].budget_ms, 600);
  assert.equal(scaled.pass, true, 'scale=3 下 450ms 应通过');

  // 非法/缺省 scale 回落到 1，不得意外放宽门槛。
  assert.equal(latencyScale({}), 1);
  assert.equal(latencyScale({ CLAUDE_HARNESS_LATENCY_SCALE: '0' }), 1);
  assert.equal(latencyScale({ CLAUDE_HARNESS_LATENCY_SCALE: 'abc' }), 1);
});

// ── 3. async 不计入 ─────────────────────────────────────────────────────────

test('async-only 入口不计入预算，落进 skipped', () => {
  const budget = budgetFor('postflight-observer', { index: INDEX, scale: 1 });
  assert.equal(budget.async, true);
  assert.equal(budget.budgetMs, null, 'async 入口不应有预算');
  assert.equal(budget.tier, 'async');

  // 即便实测 5s，也不能让判定 fail。
  const verdict = evaluate([
    benchResult('postflight-observer', 5000, { isAsync: true, skipped: true, skipReason: 'async-hook' }),
  ]);
  assert.equal(verdict.pass, true, 'async 入口不得影响判定');
  assert.equal(verdict.checks.length, 0);
  assert.equal(verdict.skipped.length, 1);
  assert.equal(verdict.skipped[0].reason, 'async-hook');
});

test('同一脚本既有同步又有 async 注册时按同步算', () => {
  const budget = budgetFor('git-integrity-guard', { index: INDEX, scale: 1 });
  assert.equal(budget.async, false, '同步那条仍在热路径上');
  assert.equal(budget.budgetMs, DEFAULT_SYNC_BUDGET_MS);
});

test('--quick 跳过的点不计入，但保留 skip 原因（不静默通过）', () => {
  const verdict = evaluate([
    benchResult('postflight-router', 0, { skipped: true, skipReason: 'quick-mode' }),
  ]);
  assert.equal(verdict.checks.length, 0);
  assert.equal(verdict.skipped[0].reason, 'quick-mode');
  assert.equal(verdict.skipped[0].script, 'postflight-router');
});

// ── 4. 超标样本 → fail ──────────────────────────────────────────────────────

test('一个超标样本让整体判定为 fail 并列进 violations', () => {
  const verdict = evaluate([
    benchResult('preflight-router', 120),
    benchResult('postflight-router', 900),
    benchResult('prompt-context', 210),
    benchResult('postflight-observer', 9000, { isAsync: true, skipped: true, skipReason: 'async-hook' }),
  ]);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.checks.length, 3, 'async 入口不进 checks');
  assert.equal(verdict.violations.length, 1);
  assert.equal(verdict.violations[0].script, 'postflight-router');
  assert.equal(verdict.violations[0].warm_p95_ms, 900);
  assert.equal(verdict.violations[0].budget_ms, 250);

  // 同一批样本在 scale=4 下全部进预算 —— 证明 fail 来自档位而不是别的原因。
  const relaxed = evaluateSla([
    benchResult('preflight-router', 120),
    benchResult('postflight-router', 900),
    benchResult('prompt-context', 210),
  ], { index: INDEX, scale: 4 });
  assert.equal(relaxed.pass, true);
});

test('无 warm 样本时退回 elapsed，不当作 0ms 通过', () => {
  const verdict = evaluate([
    { cmd: 'node /a/b/preflight-router.cjs', id: 'preflight', skipped: false, elapsed: 777 },
  ]);
  assert.equal(verdict.checks[0].warm_p95_ms, 777);
  assert.equal(verdict.pass, false);
});
