'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const routerPath = path.join(
  HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'postflight-router.cjs',
);

function payload(eventName, toolName, extra = {}) {
  return {
    hook_event_name: eventName,
    tool_name: toolName,
    tool_input: toolName === 'Bash' || toolName === 'PowerShell'
      ? { command: 'node engine/scripts/test-hooks/example.cjs' }
      : { file_path: path.join(HARNESS_ROOT, 'rtl', 'example.sv') },
    cwd: HARNESS_ROOT,
    session_id: 'postflight-router-contract',
    ...extra,
  };
}

function dependencies(calls, overrides = {}) {
  return {
    verificationGate: {
      evaluate(input) {
        calls.push(`verification:${input.hook_event_name}:${input.tool_name}`);
        return { source: 'verification-gate', decision: 'allow' };
      },
    },
    progressWatchdog: {
      updateProgress(input) {
        calls.push(`watchdog:${input.hook_event_name}:${input.tool_name}`);
        return { status: 'progress', mode: 'observe', session: {} };
      },
    },
    toolchainHealth: {
      evaluatePayload(input) {
        calls.push(`toolchain:${input.hook_event_name}:${input.tool_name}`);
        return {
          source: 'toolchain-health-gate',
          decision: 'allow',
          classification: { status: 'success' },
        };
      },
    },
    crossLinkMemory: {
      evaluatePayload(input) {
        calls.push(`memory:${input.hook_event_name}:${input.tool_name}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PostToolUseFailure',
            additionalContext: '[memory] related verified failure',
          },
        };
      },
    },
    ...overrides,
  };
}

async function assertPreciseRouting(router) {
  let calls = [];
  let result = await router.route(payload('PostToolUse', 'Edit'), dependencies(calls));
  assert.deepEqual(calls, ['verification:PostToolUse:Edit']);
  assert.equal(result.decision, 'allow');

  calls = [];
  result = await router.route(payload('PostToolUse', 'Bash'), dependencies(calls));
  assert.deepEqual(calls, [
    'verification:PostToolUse:Bash',
    'watchdog:PostToolUse:Bash',
    'toolchain:PostToolUse:Bash',
  ]);
  assert.equal(result.decision, 'allow');

  calls = [];
  await router.route(payload('PostToolUse', 'PowerShell'), dependencies(calls));
  assert.deepEqual(calls, ['verification:PostToolUse:PowerShell'],
    'success PowerShell must preserve the current verification-only route');

  calls = [];
  result = await router.route(payload('PostToolUseFailure', 'Bash'), dependencies(calls));
  assert.deepEqual(calls, [
    'verification:PostToolUseFailure:Bash',
    'watchdog:PostToolUseFailure:Bash',
    'toolchain:PostToolUseFailure:Bash',
    'memory:PostToolUseFailure:Bash',
  ], 'failure state updates and memory lookup ran out of order');
  assert.match(result.additionalContext, /related verified failure/);

  calls = [];
  await router.route(payload('PostToolUseFailure', 'PowerShell'), dependencies(calls));
  assert.deepEqual(calls, [
    'verification:PostToolUseFailure:PowerShell',
    'watchdog:PostToolUseFailure:PowerShell',
    'memory:PostToolUseFailure:PowerShell',
  ], 'PowerShell failure must not invoke the Bash-only toolchain classifier');

  calls = [];
  await router.route(payload('PostToolUseFailure', 'Edit'), dependencies(calls));
  assert.deepEqual(calls, ['memory:PostToolUseFailure:Edit']);

  calls = [];
  await router.route(payload('PostToolUse', 'Read'), dependencies(calls));
  assert.deepEqual(calls, []);
}

async function assertFailureBoundaries(router) {
  let calls = [];
  let result = await router.route(payload('PostToolUse', 'Bash'), dependencies(calls, {
    verificationGate: {
      evaluate() {
        calls.push('verification-error');
        throw new Error('fixture verification failure');
      },
    },
  }));
  assert.equal(result.decision, 'warn', 'internal evaluator errors must fail open');
  assert.deepEqual(calls, ['verification-error', 'watchdog:PostToolUse:Bash', 'toolchain:PostToolUse:Bash'],
    'one fail-open stage must not skip later state updates');

  calls = [];
  result = await router.route(payload('PostToolUseFailure', 'Bash'), dependencies(calls, {
    progressWatchdog: {
      updateProgress(input) {
        calls.push(`watchdog:${input.hook_event_name}:${input.tool_name}`);
        return {
          status: 'frozen_escalation_required',
          mode: 'enforce',
          session: { freezeReason: 'repair_budget_exhausted' },
        };
      },
    },
    toolchainHealth: {
      evaluatePayload(input) {
        calls.push(`toolchain:${input.hook_event_name}:${input.tool_name}`);
        return {
          source: 'toolchain-health-gate',
          decision: 'block',
          diagnostics: ['toolchain loader failure'],
        };
      },
    },
  }));
  assert.equal(result.decision, 'block');
  assert.deepEqual(calls, [
    'verification:PostToolUseFailure:Bash',
    'watchdog:PostToolUseFailure:Bash',
    'toolchain:PostToolUseFailure:Bash',
    'memory:PostToolUseFailure:Bash',
  ], 'blocking results must still preserve all postflight state and context stages');
}

async function assertTrustedVerificationAttribution(router) {
  const calls = [];
  const attributionDb = { marker: 'managed-attribution-db' };
  let closes = 0;
  let receivedGate = null;
  const result = await router.route(payload('PostToolUse', 'Bash', {
    tool_response: { status: 0, stdout: 'RESULT: PASS', stderr: '' },
  }), dependencies(calls, {
    verificationGate: {
      evaluate(input) {
        calls.push(`verification:${input.hook_event_name}:${input.tool_name}`);
        return {
          source: 'model-report-must-not-survive-normalization',
          decision: 'allow',
          verification: { ok: true, reason: 'explicit PASS evidence in output' },
        };
      },
    },
    openAttributionDb(options = {}) {
      assert.notEqual(options.readonly, true, 'outcome attribution reused a readonly DB');
      return { db: attributionDb, close() { closes += 1; } };
    },
    memoryAttribution: {
      observeVerificationGateResult(input, gateResult, options) {
        calls.push(`attribution:${input.hook_event_name}:${input.tool_name}`);
        receivedGate = gateResult;
        assert.equal(options.db, attributionDb);
        return { recorded: 1, outcomesRecorded: 1, rejected: false };
      },
    },
  }));
  assert.deepEqual(calls, [
    'verification:PostToolUse:Bash',
    'attribution:PostToolUse:Bash',
    'watchdog:PostToolUse:Bash',
    'toolchain:PostToolUse:Bash',
  ], 'trusted verification attribution did not run immediately after its gate');
  assert.equal(receivedGate?.source, 'verification-gate',
    'router accepted a self-reported verification source');
  assert.deepEqual(receivedGate?.verification,
    { ok: true, reason: 'explicit PASS evidence in output' });
  assert.equal(closes, 1, 'managed attribution DB was not closed exactly once');
  assert(result.results.some(item => item.source === 'memory-attribution'
      && item.outcomesRecorded === 1),
  'router did not expose the attribution stage result');

  calls.length = 0;
  closes = 0;
  const failed = await router.route(payload('PostToolUse', 'Bash'), dependencies(calls, {
    verificationGate: {
      evaluate(input) {
        calls.push(`verification:${input.hook_event_name}:${input.tool_name}`);
        return {
          decision: 'warn',
          verification: { ok: false, reason: 'failed test count in output' },
        };
      },
    },
    openAttributionDb() {
      return { db: attributionDb, close() { closes += 1; } };
    },
    memoryAttribution: {
      observeVerificationGateResult() {
        calls.push('attribution-error');
        throw new Error('fixture attribution unavailable');
      },
    },
  }));
  assert.deepEqual(calls, [
    'verification:PostToolUse:Bash',
    'attribution-error',
    'watchdog:PostToolUse:Bash',
    'toolchain:PostToolUse:Bash',
  ], 'attribution failure skipped later postflight stages');
  assert.equal(closes, 1, 'failed attribution did not close its managed DB');
  assert.equal(failed.decision, 'warn', 'attribution failure did not fail open as warning');
}

async function assertStoredVerificationChain(router) {
  const sqlite = require(path.join(HARNESS_ROOT, 'engine/sqlite/index.cjs'));
  const attribution = require(path.join(
    HARNESS_ROOT, 'engine/sqlite/store-memory-attribution.cjs',
  ));
  const { memoryProjectId } = require(path.join(
    HARNESS_ROOT, 'engine/scripts/lib/project-scope.cjs',
  ));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'postflight-attribution-chain-'));
  const dbPath = path.join(fixture, 'memory.db');
  const projectId = memoryProjectId(HARNESS_ROOT);
  const setup = sqlite.openDb({ path: dbPath });
  attribution.recordExposure({
    sessionId: 'postflight-router-contract',
    projectId,
    memoryId: 'fact-router-chain',
    retrievalId: 'retrieval-router-chain',
    correlationId: 'prompt-router-chain',
    triggerKind: 'user-query',
    query: 'verify postflight attribution chain',
    rank: 1,
    confidence: 0.9,
  }, { db: setup.db });
  setup.close();

  const calls = [];
  const input = payload('PostToolUse', 'Bash', {
    tool_use_id: 'tool-use-router-chain',
    tool_response: { status: 0, stdout: 'RESULT: PASS', stderr: '' },
  });
  await router.route(input, dependencies(calls, {
    verificationGate: {
      evaluate() {
        return {
          decision: 'allow',
          verification: { ok: true, reason: 'explicit PASS evidence in output' },
        };
      },
    },
    memoryAttribution: attribution,
    openAttributionDb: () => sqlite.openDb({ path: dbPath }),
  }));

  const inspect = sqlite.openDb({ path: dbPath });
  const application = inspect.db.prepare('SELECT * FROM memory_applications').get();
  const outcome = inspect.db.prepare('SELECT * FROM memory_outcomes').get();
  const exposure = inspect.db.prepare(
    "SELECT status FROM memory_retrieval_exposures WHERE memory_id='fact-router-chain'",
  ).get();
  inspect.close();
  fs.rmSync(fixture, { recursive: true, force: true });
  assert.equal(application?.memory_id, 'fact-router-chain');
  assert.equal(application?.session_id, input.session_id);
  assert.equal(application?.project_id, projectId);
  assert.equal(application?.correlation_id, input.tool_use_id);
  assert.equal(application?.evidence_kind, 'observed-followup');
  assert.equal(application?.causal_claim, 'unproven');
  assert.equal(outcome?.application_id, application?.application_id);
  assert.equal(outcome?.evidence_source, 'verification-gate');
  assert.equal(outcome?.accepted, 1);
  assert.equal(outcome?.causal_claim, 'unproven');
  assert.equal(exposure?.status, 'verified-pass');
}

function assertStaticContract() {
  const source = fs.readFileSync(routerPath, 'utf8');
  assert(!/child_process|spawn(?:Sync)?\s*\(|exec(?:File|Sync)?\s*\(|new\s+Worker\s*\(/.test(source),
    'postflight router must evaluate every stage in-process');
  assert.equal((source.match(/JSON\.parse\s*\(/g) || []).length, 1,
    'postflight CLI must parse stdin exactly once');
}

function assertCliFailOpen() {
  const result = spawnSync(process.execPath, [routerPath], {
    cwd: HARNESS_ROOT,
    input: '{invalid-json',
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_HARNESS_NO_PERSIST: '1',
      CLAUDE_HARNESS_VERIFY_READONLY: '1',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
    },
  });
  assert.equal(result.status, 0, `invalid postflight payload must fail open: ${result.stderr}`);
  assert.match(result.stderr, /invalid hook JSON/);
}

async function main() {
  assert(fs.existsSync(routerPath), 'postflight-router.cjs is missing');
  const router = require(routerPath);
  assert.equal(typeof router.route, 'function');
  await assertPreciseRouting(router);
  await assertFailureBoundaries(router);
  await assertTrustedVerificationAttribution(router);
  await assertStoredVerificationChain(router);
  assertStaticContract();
  assertCliFailOpen();
  process.stdout.write('POSTFLIGHT_ROUTER_RESULT: PASS\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
