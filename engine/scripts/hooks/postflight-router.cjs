#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit']);
const SHELL_TOOLS = new Set(['bash', 'powershell']);

function defaultDependencies() {
  return {
    verificationGate: {
      evaluate(...args) { return require('./verification-gate.cjs').evaluate(...args); },
    },
    progressWatchdog: {
      updateProgress(...args) {
        return require('../../hooks/session/progress-watchdog.cjs').updateProgress(...args);
      },
    },
    toolchainHealth: {
      evaluatePayload(...args) { return require('./toolchain-health-gate.cjs').evaluatePayload(...args); },
    },
    crossLinkMemory: {
      evaluatePayload(...args) { return require('../cross-link-memory.cjs').evaluatePayload(...args); },
    },
    memoryAttribution: {
      observeVerificationGateResult(...args) {
        return require('../../sqlite/store-memory-attribution.cjs').observeVerificationGateResult(...args);
      },
    },
    openAttributionDb(...args) { return require('../../sqlite/index.cjs').openDb(...args); },
    deliveryTracker: {
      recordDelivery(...args) { return require('../delivery-tracker.cjs').recordDelivery(...args); },
    },
    fileProtection: {
      settlePendingWrites(...args) {
        return require('./file-protection-guard.cjs').settlePendingWrites(...args);
      },
    },
    riskPolicy: {
      evaluatePostflightRisk(...args) { return evaluatePostflightRisk(...args); },
    },
  };
}

function riskRank(level) {
  return ['R0', 'R1', 'R2', 'R3'].indexOf(String(level || '').toUpperCase());
}

function verificationFailureStatus(payload, verification = {}) {
  const response = payload?.tool_response
    || payload?.tool_result
    || payload?.result
    || payload?.tool?.result
    || {};
  const detail = [
    verification.reason,
    verification.detail,
    response.stdout,
    response.stderr,
    response.error,
  ].filter(Boolean).join('\n');
  const unavailable = /(?:command not found|is not recognized as|\bENOENT\b|exit=127|toolchain[^\n]*unavailable|license[^\n]*(?:unavailable|not found|checkout failed)|timed out waiting for[^\n]*license)/i.test(detail);
  return {
    status: unavailable ? 'unavailable' : 'failed',
    reason: detail.trim().slice(0, 500) || 'verification failed without readable detail',
  };
}

function hashEvidenceFile(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function commandFileCandidates(command, cwd) {
  const found = [];
  const pattern = /(?:^|\s)["']?([^"'\s]+\.(?:cjs|js|mjs|ts|tsx|py|sv|v|vhd|json|m))["']?/gi;
  for (const match of String(command || '').matchAll(pattern)) {
    found.push(path.resolve(cwd, match[1]));
  }
  return found;
}

function evidenceDescriptorForEntries(entries, runtime, policy) {
  const eligible = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const projectRoot = eligible[0]?.projectRoot || runtime.cwd;
  const paths = new Set(eligible.flatMap(entry => entry.targets || []));
  for (const candidate of commandFileCandidates(runtime.command, runtime.cwd)) paths.add(candidate);
  if (paths.size === 0 || paths.size > 64) return null;
  const groups = { fileHashes: [], testHashes: [], goldenHashes: [] };
  for (const filePath of [...paths].sort()) {
    const digest = hashEvidenceFile(filePath);
    if (!digest) return null;
    const item = { path: path.relative(projectRoot, filePath).replace(/\\/g, '/'), sha256: digest };
    if (/[/\\](?:golden|models?)[/\\]/i.test(filePath)) groups.goldenHashes.push(item);
    else if (/[/\\](?:test|tests|test-hooks|tb|sim)[/\\]|(?:^|[/\\])(?:test_|tb_)/i.test(filePath)) {
      groups.testHashes.push(item);
    } else groups.fileHashes.push(item);
  }
  return policy.buildEvidenceKey({
    projectRoot,
    ...groups,
    command: runtime.command,
    toolVersions: {
      node: process.version,
      ...(runtime.payload?.tool_versions || {}),
    },
    riskLevel: policy.verificationEvidenceLevel(runtime.command),
  });
}

async function evaluatePostflightRisk(payload, injected = {}, opts = {}) {
  const policy = require('../lib/risk-policy.cjs');
  const env = opts.env || process.env;
  const mode = policy.riskPolicyMode(env);
  if (mode === 'off') {
    const assessment = policy.classifyRisk({ readOnly: true });
    return { ...policy.applyRiskPolicy(assessment, { mode }), assessment, stateUpdated: false };
  }

  const preflight = require('./preflight-router.cjs');
  const runtime = preflight.runtimeFrom(payload);
  let facts = preflight.riskFactsFromRuntime(runtime, {
    fileExists: injected.fileExists,
  });
  let assessment = policy.classifyRisk(facts);
  let blastRadius = null;
  if (riskRank(assessment.effectiveRiskLevel) >= riskRank('R2') && runtime.filePath) {
    try {
      const identity = injected.projectIdentity
        ? injected.projectIdentity(payload)
        : require('../lib/project-scope.cjs').memoryScopeFromPayload(payload);
      const getBlastRadius = injected.getBlastRadius
        || require('../cg-queries.cjs').getBlastRadius;
      blastRadius = await getBlastRadius(identity.projectId, identity.relativePath, { depth: 3, limit: 40 });
      facts = {
        ...facts,
        graphStale: Boolean(blastRadius?.staleIndex),
        sharedCoreChange: facts.sharedCoreChange
          || Number(blastRadius?.downstream?.length || 0) >= 4
          || Number(blastRadius?.files?.length || 0) >= 6,
      };
      assessment = policy.classifyRisk(facts);
      if (Array.isArray(blastRadius?.gatesToRerun) && blastRadius.gatesToRerun.length > 0) {
        assessment.requiredEvidence = [...new Set([
          ...assessment.requiredEvidence,
          ...blastRadius.gatesToRerun.map(gate => `gate:${gate}`),
        ])];
      }
    } catch {
      assessment = policy.classifyRisk({ ...facts, graphStale: true });
      blastRadius = { staleIndex: true, staleReason: 'blast-radius-unavailable' };
    }
  }

  const rendered = policy.applyRiskPolicy(assessment, {
    mode: mode === 'enforce' ? 'shadow' : mode,
    authorized: true,
  });
  const eventKey = String(payload?.hook_event_name || payload?.event || '').toLowerCase();
  const toolKey = String(payload?.tool_name || payload?.tool?.name || payload?.name || '').toLowerCase();
  const shouldPersist = assessment.effectiveRiskLevel !== 'R0'
    && (WRITE_TOOLS.has(toolKey) || riskRank(assessment.effectiveRiskLevel) >= riskRank('R2'));
  const noPersist = env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1';
  let stateUpdated = false;
  let riskClear = null;
  let evidenceRiskLevel = 'R0';
  let cacheRecord = null;
  let riskVerificationStatus = null;
  const diagnostics = [];
  const verification = injected.verificationResult?.verification;
  if (eventKey === 'posttooluse' && verification?.ok === true) {
    evidenceRiskLevel = policy.verificationEvidenceLevel(runtime.command);
    if (evidenceRiskLevel !== 'R0' && !noPersist) {
      try {
        const riskState = injected.riskState || require('../lib/verification-state.cjs');
        if (evidenceRiskLevel !== 'R3'
            && typeof riskState.readVerificationState === 'function'
            && typeof riskState.riskForCwd === 'function'
            && typeof riskState.recordRiskEvidence === 'function') {
          const before = riskState.riskForCwd(riskState.readVerificationState(), runtime.cwd, {
            sessionId: String(payload?.session_id || payload?.sessionId || ''),
          });
          const cacheable = before.filter(entry =>
            entry.effectiveRiskLevel !== 'R3'
            && riskRank(evidenceRiskLevel) >= riskRank(entry.effectiveRiskLevel)
          );
          const descriptor = evidenceDescriptorForEntries(cacheable, runtime, policy);
          if (descriptor) {
            cacheRecord = riskState.recordRiskEvidence({
              ...descriptor,
              projectRoot: cacheable[0]?.projectRoot || runtime.cwd,
              riskLevel: evidenceRiskLevel,
              command: runtime.command,
            });
          }
        }
        riskClear = riskState.markRiskVerifiedForCwd(runtime.cwd, {
          sessionId: String(payload?.session_id || payload?.sessionId || ''),
          evidenceRiskLevel,
          command: runtime.command,
          fresh: true,
        });
        stateUpdated = riskClear.cleared?.length > 0;
      } catch (error) {
        diagnostics.push(`risk evidence update failed: ${error.message}`);
      }
    }
  } else if (verification?.ok === false && !noPersist) {
    riskVerificationStatus = verificationFailureStatus(payload, verification);
    try {
      const riskState = injected.riskState || require('../lib/verification-state.cjs');
      riskState.markRiskVerificationStatusForCwd(runtime.cwd, {
        sessionId: String(payload?.session_id || payload?.sessionId || ''),
        status: riskVerificationStatus.status,
        reason: riskVerificationStatus.reason,
      });
    } catch (error) {
      diagnostics.push(`risk verification status update failed: ${error.message}`);
    }
  }
  if ((eventKey === 'posttooluse' || eventKey === 'posttoolusefailure') && shouldPersist && !noPersist) {
    try {
      const riskState = injected.riskState || require('../lib/verification-state.cjs');
      riskState.markRisk({
        cwd: runtime.cwd,
        filePath: runtime.filePath,
        sessionId: String(payload?.session_id || payload?.sessionId || ''),
        toolName: runtime.toolName,
        assessment,
      });
      stateUpdated = true;
    } catch (error) {
      diagnostics.push(`risk state update failed: ${error.message}`);
    }
  }
  return {
    ...rendered,
    mode,
    decision: diagnostics.length > 0 ? 'warn' : rendered.decision,
    diagnostics,
    assessment,
    blastRadius,
    evidenceRiskLevel,
    riskClear,
    cacheRecord,
    riskVerificationStatus,
    stateUpdated,
  };
}

/**
 * 受保护写入的结算点。
 *
 * PreToolUse 只预留，消费与审计要等到这里 —— 工具跑完才知道字节到底有没有落盘。
 * 成功与失败两条路都要结算: 失败路上是"释放"，没写就不该扣次数。
 */
function settleProtectedWrite(payload, deps) {
  const input = payload?.tool_input || payload?.tool?.input || payload?.input || {};
  const filePath = String(input.file_path || input.filePath || '').trim();
  if (!filePath) return { decision: 'allow', diagnostics: [] };
  const outcome = deps.fileProtection.settlePendingWrites({ filePath });
  return {
    decision: outcome.notes.length ? 'warn' : 'allow',
    diagnostics: outcome.notes,
  };
}

// "判定不可读"的原因族由 lib/verification-markers.cjs 统一持有 —— delivery 的
// partial 与 attribution 的 inconclusive 必须用同一份判据, 各抄一份就会漂移。
const { UNREADABLE_VERDICT_REASONS } = require('../lib/verification-markers.cjs');

/** 验证判定 → delivery 事件 (D1 自动喂数): PASS/FAIL 不再依赖手工 record。 */
function recordDeliveryFromVerdict(payload, gateResult, deps) {
  if (process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1') return { skipped: true };
  const verification = gateResult.verification;
  const reason = String(verification.reason || verification.detail || '');
  const status = verification.ok ? 'pass'
    : UNREADABLE_VERDICT_REASONS.has(reason) ? 'partial' : 'fail';
  return deps.deliveryTracker.recordDelivery({
    workflow: 'verification-gate',
    phase: 'verification',
    status,
    error: verification.ok ? null : reason.slice(0, 200) || null,
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
  let riskResult = null;

  if ((isSuccess || isFailure) && WRITE_TOOLS.has(toolKey)) {
    await invoke(results, 'file-protection', () => settleProtectedWrite(payload, deps));
  }

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
  }

  if ((isSuccess || isFailure) && (WRITE_TOOLS.has(toolKey) || SHELL_TOOLS.has(toolKey))) {
    riskResult = await invoke(
      results,
      'risk-policy',
      () => deps.riskPolicy.evaluatePostflightRisk(payload, { ...deps, verificationResult }),
    );
  }

  if ((isSuccess || isFailure) && (WRITE_TOOLS.has(toolKey) || SHELL_TOOLS.has(toolKey))) {
    await invoke(
      results,
      'progress-watchdog',
      () => deps.progressWatchdog.updateProgress(payload, {
        riskLevel: riskResult?.assessment?.effectiveRiskLevel,
      }),
      (_source, value) => watchdogResult(payload, value),
    );
  }

  if ((isSuccess || isFailure) && toolKey === 'bash') {
    await invoke(results, 'toolchain-health-gate', () => deps.toolchainHealth.evaluatePayload(payload));
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
  recordDeliveryFromVerdict,
  recordVerificationAttribution,
  settleProtectedWrite,
  watchdogResult,
  evaluatePostflightRisk,
  verificationFailureStatus,
  evidenceDescriptorForEntries,
  UNREADABLE_VERDICT_REASONS,
};
