#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ledger = require('./agent-transparency-ledger.cjs');
const contractGate = require('./tool-action-contract-gate.cjs');
const watchdog = require('../../hooks/session/progress-watchdog.cjs');

const SHELL_TOOLS = new Set(['bash', 'powershell']);
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit']);

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
    throw new Error(`invalid PreToolUse JSON: ${error.message}`);
  }
}

function toolInputFrom(payload) {
  return payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
}

function runtimeFrom(payload) {
  const input = toolInputFrom(payload);
  const toolName = String(payload?.tool_name || payload?.tool?.name || payload?.name || '');
  const cwd = path.resolve(String(payload?.cwd || process.cwd()));
  const fileValue = input.file_path || input.path || payload?.file_path || '';
  const hasDirectContent = Object.prototype.hasOwnProperty.call(input, 'content')
    || Object.prototype.hasOwnProperty.call(payload || {}, 'content');
  return {
    payload,
    eventName: String(payload?.hook_event_name || payload?.event || 'PreToolUse'),
    toolName,
    toolKey: toolName.toLowerCase(),
    input,
    command: String(input.command || payload?.command || '').trim(),
    cwd,
    filePath: fileValue ? path.resolve(cwd, String(fileValue)) : '',
    content: hasDirectContent ? String(input.content ?? payload?.content ?? '') : undefined,
    commits: [],
    diagnostics: [],
    advisories: [],
    additionalContexts: [],
  };
}

function normalizedResult(source, value) {
  if (!value || typeof value !== 'object') return { source, decision: 'allow' };
  const decision = ['allow', 'warn', 'block'].includes(value.decision) ? value.decision : 'allow';
  return { ...value, source, decision };
}

function recordPromotedAttribution(runtime, gateResult, deps = {}) {
  let wDb;
  try {
    const openAttributionDb = deps.openAttributionDb || require('../../sqlite/index.cjs').openDb;
    const memoryAttribution = deps.memoryAttribution
      || require('../../sqlite/store-memory-attribution.cjs');
    wDb = openAttributionDb({});
    return memoryAttribution.observePromotedHarnessGateResult(
      runtime.payload,
      gateResult,
      { db: wDb.db },
    );
  } catch (error) {
    runtime.diagnostics.push({
      source: 'memory-attribution',
      message: `promoted rule attribution dropped: ${error.stack || error.message}`,
    });
    return { recorded: 0, rejected: true, reason: 'attribution-write-failed' };
  } finally {
    try { wDb?.close(); } catch { /* blocking decision must survive cleanup failure */ }
  }
}

function appendResult(runtime, result) {
  const diagnostics = Array.isArray(result.diagnostics)
    ? result.diagnostics
    : result.diagnostics ? [result.diagnostics] : [];
  for (const item of diagnostics) {
    let message;
    if (typeof item === 'string') message = item;
    else if (item instanceof Error) message = item.stack || item.message;
    else if (item && typeof item === 'object') message = item.message || JSON.stringify(item);
    else message = String(item);
    runtime.diagnostics.push({ source: result.source, message });
  }
  const advisories = Array.isArray(result.advisories)
    ? result.advisories
    : result.advisory ? [result.advisory] : [];
  for (const advisory of advisories) {
    runtime.advisories.push(typeof advisory === 'string'
      ? { source: result.source, message: advisory }
      : { source: result.source, ...advisory });
  }
  if (result.decision === 'warn' && advisories.length === 0) {
    runtime.advisories.push({
      source: result.source,
      message: diagnostics.map((entry) => String(entry)).join('; ') || 'advisory warning',
    });
  }
  if (typeof result.commit === 'function') {
    runtime.commits.push({
      source: result.source,
      run: result.commit,
      critical: result.commitCritical !== false,
    });
  }
}

async function runGate(runtime, spec) {
  try {
    const moduleValue = spec.load();
    const evaluate = moduleValue?.evaluate;
    if (typeof evaluate !== 'function') throw new Error('evaluate(payload, runtime) export is missing');
    const result = normalizedResult(spec.source, await evaluate(runtime.payload, runtime));
    appendResult(runtime, result);
    return result;
  } catch (error) {
    const result = {
      source: spec.source,
      decision: spec.failClosed ? 'block' : 'warn',
      diagnostics: [`internal error: ${error.stack || error.message}`],
    };
    appendResult(runtime, result);
    return result;
  }
}

function shellSpecs(command) {
  const { gitSubcommand } = require('./verification-gate.cjs');
  const gitAction = gitSubcommand(command);
  const specs = [
    { source: 'bash-safety', failClosed: true, load: () => require('./bash-safety-guard.cjs') },
    { source: 'fix-in-place', failClosed: false, load: () => require('../../hooks/safety/fix-in-place-guard.cjs') },
    { source: 'verification-gate', failClosed: false, load: () => require('./verification-gate.cjs') },
  ];
  if (gitAction === 'commit') {
    specs.push({ source: 'resource-budget', failClosed: false, load: () => require('./resource-budget-gate.js') });
  } else if (gitAction === 'push') {
    specs.push(
      { source: 'diff-size', failClosed: false, load: () => require('./diff-size-gate.js') },
      { source: 'resource-budget', failClosed: false, load: () => require('./resource-budget-gate.js') },
    );
  }
  return specs;
}

function writeSpecs() {
  return [
    { source: 'project-directory', failClosed: true, load: () => require('./project-directory-guard.cjs') },
    { source: 'repair-content', failClosed: true, load: () => require('./repair-content-gate.cjs') },
    { source: 'file-protection', failClosed: true, load: () => require('./file-protection-guard.cjs') },
    { source: 'fix-in-place', failClosed: false, load: () => require('../../hooks/safety/fix-in-place-guard.cjs') },
    { source: 'hdl-gate', failClosed: false, load: () => require('./hdl-gate.cjs') },
    { source: 'requirements-gate', failClosed: false, load: () => require('./requirements-gate-guard.cjs') },
    { source: 'verification-quality', failClosed: false, load: () => require('./verification-quality-guard.cjs') },
    { source: 'rtl-semantic-oracle', failClosed: false, load: () => require('./rtl-semantic-oracle.cjs') },
  ];
}

function collectMemoryContext(runtime, deps = {}) {
  if (!WRITE_TOOLS.has(runtime.toolKey)) return null;
  try {
    const retrieveContext = deps.retrieveContext
      || require('../memory-retrieve-hook.cjs').retrieveContext;
    if (typeof retrieveContext !== 'function') {
      throw new Error('retrieveContext(payload, deps) export is missing');
    }
    const output = retrieveContext(runtime.payload, deps.retrieveDeps || {});
    const context = output?.hookSpecificOutput?.additionalContext;
    if (typeof context !== 'string' || !context.trim()) return null;
    const normalized = context.trim();
    runtime.additionalContexts.push({ source: 'memory-retrieve', message: normalized });
    return normalized;
  } catch (error) {
    runtime.diagnostics.push({
      source: 'memory-retrieve',
      message: `in-process retrieval failed: ${error.stack || error.message}`,
    });
    return null;
  }
}

function formatAdditionalContext(runtime) {
  const blocks = (runtime.additionalContexts || [])
    .map((entry) => String(entry?.message || '').trim())
    .filter(Boolean);
  if (runtime.advisories.length > 0) {
    blocks.push(JSON.stringify({
      schemaVersion: 1,
      kind: 'preflight-summary',
      advisories: runtime.advisories,
    }));
  }
  return blocks.join('\n\n');
}

function watchdogResult(payload, result) {
  const blocking = result.status === 'bypass_reason_required'
    || (result.status === 'frozen_escalation_required'
      && result.mode === 'enforce'
      && String(payload?.hook_event_name || '') !== 'Stop');
  if (blocking) {
    return {
      source: 'progress-watchdog',
      decision: 'block',
      diagnostics: [result.session?.freezeReason || result.status],
    };
  }
  if (['warning', 'frozen_notice', 'frozen_escalation_required', 'bypassed'].includes(result.status)) {
    return {
      source: 'progress-watchdog',
      decision: 'warn',
      advisories: [{ status: result.status, blocking: false }],
    };
  }
  return { source: 'progress-watchdog', decision: 'allow' };
}

async function runCommon(runtime) {
  const noPersist = process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1';
  let commonResult = { source: 'common', decision: 'allow' };

  // Preserve the security/audit order for controlled actions: write one fresh
  // contract, validate that exact payload, and only then mutate watchdog state.
  // Read-only and ordinary low-risk calls still skip the heavy ledger path.
  if (!noPersist && process.env.CLAUDE_TRANSPARENCY_LEDGER_DISABLED !== '1'
      && ledger.mayRequireActionContract(runtime.payload)) {
    let context;
    try {
      context = ledger.buildContext(runtime.payload);
      runtime.context = context;
    } catch (error) {
      const result = {
        source: 'tool-action-contract',
        decision: 'warn',
        diagnostics: [`context build failed: ${error.stack || error.message}`],
      };
      appendResult(runtime, result);
      commonResult = result;
    }

    if (context) {
      try {
        const written = ledger.run(runtime.payload, { context });
        const result = normalizedResult('tool-action-contract', contractGate.evaluate(runtime.payload, {
          context,
          contract: written.artifacts?.toolActionContract,
        }));
        appendResult(runtime, result);
        commonResult = result;
        if (result.decision === 'block') return result;
      } catch (error) {
        const result = {
          source: 'tool-action-contract',
          decision: context.loopScope?.status === 'blocked' ? 'block' : 'warn',
          diagnostics: [`ledger write failed: ${error.stack || error.message}`],
        };
        appendResult(runtime, result);
        commonResult = result;
        if (result.decision === 'block') return result;
      }
    }
  }

  if (!noPersist && !watchdog.isReadOnlyAction(runtime.payload)) {
    try {
      const result = watchdogResult(runtime.payload, watchdog.updateProgress(runtime.payload));
      appendResult(runtime, result);
      if (result.decision === 'block') return result;
    } catch (error) {
      appendResult(runtime, {
        source: 'progress-watchdog',
        decision: 'warn',
        diagnostics: [`internal error: ${error.stack || error.message}`],
      });
    }
  }

  return commonResult;
}

async function commitDeferred(runtime) {
  for (const entry of runtime.commits) {
    try {
      await entry.run();
    } catch (error) {
      const result = {
        source: entry.source,
        decision: entry.critical ? 'block' : 'warn',
        diagnostics: [`deferred commit failed: ${error.stack || error.message}`],
      };
      appendResult(runtime, result);
      if (result.decision === 'block') return result;
    }
  }
  return { source: 'deferred-commit', decision: 'allow' };
}

function emit(runtime, decision) {
  for (const item of runtime.diagnostics) {
    process.stderr.write(`[preflight-router:${item.source}] ${item.message}\n`);
  }
  if (decision === 'block') {
    process.stderr.write('[preflight-router] BLOCKED\n');
    process.exitCode = 2;
    return;
  }
  const additionalContext = formatAdditionalContext(runtime);
  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: runtime.eventName || 'PreToolUse',
        additionalContext,
      },
    }));
  }
}

async function main() {
  let payload;
  try {
    payload = readPayload();
  } catch (error) {
    process.stderr.write(`[preflight-router] ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const runtime = runtimeFrom(payload);
  const promotedPolicy = await runGate(runtime, {
    source: 'promoted-harness-gate',
    failClosed: true,
    load: () => require('./promoted-harness-gate.cjs'),
  });
  if (promotedPolicy.decision === 'block') {
    recordPromotedAttribution(runtime, promotedPolicy);
    emit(runtime, 'block');
    return;
  }
  const specs = SHELL_TOOLS.has(runtime.toolKey)
    ? shellSpecs(runtime.command)
    : WRITE_TOOLS.has(runtime.toolKey) ? writeSpecs() : [];

  for (const spec of specs) {
    const result = await runGate(runtime, spec);
    if (result.decision === 'block') {
      emit(runtime, 'block');
      return;
    }
  }

  const common = await runCommon(runtime);
  if (common.decision === 'block') {
    emit(runtime, 'block');
    return;
  }
  const committed = await commitDeferred(runtime);
  if (committed.decision !== 'block') collectMemoryContext(runtime);
  emit(runtime, committed.decision);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[preflight-router] fatal: ${error.stack || error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  main,
  runtimeFrom,
  collectMemoryContext,
  formatAdditionalContext,
  recordPromotedAttribution,
};
