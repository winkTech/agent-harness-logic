#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);

function defaultDependencies() {
  return {
    verificationGate: require('./verification-gate.cjs'),
    progressWatchdog: require('../../hooks/session/progress-watchdog.cjs'),
    toolchainHealth: require('./toolchain-health-gate.cjs'),
    crossLinkMemory: require('../cross-link-memory.cjs'),
    memoryAttribution: require('../../sqlite/store-memory-attribution.cjs'),
    openAttributionDb: require('../../sqlite/index.cjs').openDb,
    deliveryTracker: require('../delivery-tracker.cjs'),
  };
}

/** 验证判定 → delivery 事件 (D1 自动喂数): PASS/FAIL 不再依赖手工 record。 */
function recordDeliveryFromVerdict(payload, gateResult, deps) {
  if (process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1') return { skipped: true };
  const verification = gateResult.verification;
  return deps.deliveryTracker.recordDelivery({
    workflow: 'verification-gate',
    phase: 'verification',
    status: verification.ok ? 'pass' : 'fail',
    error: verification.ok ? null : String(verification.reason || verification.detail || '').slice(0, 200) || null,
    sessionId: String(payload?.session_id || payload?.sessionId || '') || undefined,
    cwd: String(payload?.cwd || '') || undefined,
  });
}

function normalizedResult(source, value) {
  if (!value || typeof value !== 'object') {
    return { source, decision: 'allow', diagnostics: [] };
  }
  const decision = ['allow', 'warn', 'block'].includes(value.decision)
    ? value.decision
    : 'allow';
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics
    : value.diagnostics ? [value.diagnostics] : [];
  return { ...value, source, decision, diagnostics };
}

function watchdogResult(payload, value) {
  const blocking = value?.status === 'bypass_reason_required'
    || (value?.status === 'frozen_escalation_required'
      && value?.mode === 'enforce'
      && String(payload?.hook_event_name || '') !== 'Stop');
  if (blocking) {
    return {
      source: 'progress-watchdog',
      decision: 'block',
      diagnostics: [value?.session?.freezeReason || value.status],
    };
  }
  if (['warning', 'frozen_notice', 'frozen_escalation_required', 'bypassed'].includes(value?.status)) {
    return {
      source: 'progress-watchdog',
      decision: 'warn',
      diagnostics: [value.status],
    };
  }
  return { source: 'progress-watchdog', decision: 'allow', diagnostics: [] };
}

function mergeDecision(current, next) {
  if (current === 'block' || next === 'block') return 'block';
  if (current === 'warn' || next === 'warn') return 'warn';
  return 'allow';
}

async function invoke(results, source, callback, normalize = normalizedResult) {
  try {
    const result = normalize(source, await callback());
    results.push(result);
    return result;
  } catch (error) {
    const result = {
      source,
      decision: 'warn',
      diagnostics: [`internal error: ${error.stack || error.message}`],
    };
    results.push(result);
    return result;
  }
}

function memoryContext(value) {
  const context = value?.hookSpecificOutput?.additionalContext;
  return typeof context === 'string' ? context.trim() : '';
}

function hasVerificationVerdict(result) {
  return result?.source === 'verification-gate'
    && result.verification
    && typeof result.verification === 'object'
    && typeof result.verification.ok === 'boolean';
}

function recordVerificationAttribution(payload, gateResult, deps) {
  let wDb;
  try {
    wDb = deps.openAttributionDb({});
    return deps.memoryAttribution.observeVerificationGateResult(payload, gateResult, {
      db: wDb.db,
    });
  } finally {
    try { wDb?.close(); } catch { /* fail-open attribution cleanup */ }
  }
}

async function route(payload, injected = {}) {
  const deps = { ...defaultDependencies(), ...injected };
  const eventKey = String(payload?.hook_event_name || payload?.event || '').toLowerCase();
  const toolKey = String(payload?.tool_name || payload?.tool?.name || payload?.name || '').toLowerCase();
  const isSuccess = eventKey === 'posttooluse';
  const isFailure = eventKey === 'posttoolusefailure';
  const results = [];
  let additionalContext = '';
  let verificationResult = null;

  if (isSuccess && WRITE_TOOLS.has(toolKey)) {
    verificationResult = await invoke(
      results, 'verification-gate', () => deps.verificationGate.evaluate(payload),
    );
  } else if ((isSuccess || isFailure) && SHELL_TOOLS.has(toolKey)) {
    verificationResult = await invoke(
      results, 'verification-gate', () => deps.verificationGate.evaluate(payload),
    );
    if (hasVerificationVerdict(verificationResult)) {
      await invoke(
        results,
        'memory-attribution',
        () => recordVerificationAttribution(payload, verificationResult, deps),
      );
      await invoke(
        results,
        'delivery-tracker',
        () => recordDeliveryFromVerdict(payload, verificationResult, deps),
      );
    }
    if (isFailure || toolKey === 'bash') {
      await invoke(
        results,
        'progress-watchdog',
        () => deps.progressWatchdog.updateProgress(payload),
        (_source, value) => watchdogResult(payload, value),
      );
    }
    if (toolKey === 'bash') {
      await invoke(results, 'toolchain-health-gate', () => deps.toolchainHealth.evaluatePayload(payload));
    }
  }

  if (isFailure) {
    const memory = await invoke(results, 'cross-link-memory', () => deps.crossLinkMemory.evaluatePayload(payload));
    additionalContext = memoryContext(memory);
  }

  return {
    decision: results.reduce(
      (decision, result) => mergeDecision(decision, result.decision),
      'allow',
    ),
    diagnostics: results.flatMap((result) => result.diagnostics.map((message) => ({
      source: result.source,
      message: typeof message === 'string' ? message : JSON.stringify(message),
    }))),
    additionalContext,
    results,
  };
}

function readPayload() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return {};
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`[postflight-router] invalid hook JSON: ${error.message}\n`);
    return {};
  }
}

function emit(payload, result) {
  for (const item of result.diagnostics) {
    process.stderr.write(`[postflight-router:${item.source}] ${item.message}\n`);
  }
  if (result.additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: String(payload?.hook_event_name || 'PostToolUseFailure'),
        additionalContext: result.additionalContext,
      },
    }));
  }
  if (result.decision === 'block') process.exitCode = 2;
}

async function main() {
  const payload = readPayload();
  await require('../lib/hook-latency.cjs').timed(
    'postflight-router',
    String(payload?.hook_event_name || ''),
    async () => emit(payload, await route(payload)),
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[postflight-router] internal error: ${error.stack || error.message}\n`);
  });
}

module.exports = {
  main,
  route,
  hasVerificationVerdict,
  recordVerificationAttribution,
  watchdogResult,
};
