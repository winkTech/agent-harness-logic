#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const contextPressure = require('./context-pressure-warn.cjs');
const loopController = require('./loop-controller.cjs');
const watchdog = require('../../hooks/session/progress-watchdog.cjs');
const { isSamePath } = require('../lib/project-scope.cjs');

function defaultIo(opts = {}) {
  return {
    stdout: typeof opts.stdout === 'function'
      ? opts.stdout
      : text => process.stdout.write(String(text)),
    stderr: typeof opts.stderr === 'function'
      ? opts.stderr
      : text => process.stderr.write(`${String(text)}\n`),
  };
}

function hookEventName(payload) {
  return String(payload?.hook_event_name || payload?.event || '').trim();
}

function highestRiskLevel(entries = []) {
  const levels = ['R0', 'R1', 'R2', 'R3'];
  return entries.reduce((highest, entry) => {
    const candidate = String(entry?.effectiveRiskLevel || entry?.minimumRiskLevel || 'R0').toUpperCase();
    return levels.indexOf(candidate) > levels.indexOf(highest) ? candidate : highest;
  }, 'R0');
}

function runWatchdog(payload, io, opts = {}) {
  const result = watchdog.updateProgress(payload, opts.watchdogOptions || {});
  if (result.status === 'bypass_reason_required') {
    io.stderr(JSON.stringify({
      source: 'progress-watchdog',
      type: 'blocked',
      severity: 'high',
      reason: 'emergency bypass requires PROGRESS_WATCHDOG_DISABLED=1 and an auditable reason',
    }));
    return { exitCode: 2, result };
  }
  if (result.status === 'bypassed') {
    io.stdout(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEventName(payload) || 'PreToolUse',
        additionalContext: JSON.stringify({
          schemaVersion: 1,
          kind: 'harness-advisory',
          source: 'progress-watchdog',
          status: 'bypassed',
          blocking: false,
          reason: result.bypass.reason,
          actor: result.bypass.actor,
          sessionStatus: result.session.status,
        }),
      },
    }));
    return { exitCode: 0, result };
  }
  if (result.status === 'warning') {
    io.stderr(JSON.stringify({
      source: 'progress-watchdog',
      type: 'warning',
      severity: 'medium',
      reason: 'no progress threshold exceeded; observation only',
      noProgressTurns: result.session.noProgressTurns,
      thresholds: result.thresholds,
      constraint: '记录事实与下一步；不要仅因启发式进度判断阻断模型探索。',
    }));
  }
  if (result.status === 'frozen_notice') {
    io.stderr(JSON.stringify({
      source: 'progress-watchdog',
      type: 'warning',
      severity: 'medium',
      state: 'frozen',
      reason: result.session.freezeReason || 'repair_budget_exhausted',
      note: 'frozen: read-only/notification/audited-reset actions remain allowed',
      archiveFile: result.archiveFile,
    }));
    return { exitCode: 0, result };
  }
  if (result.status === 'frozen_escalation_required') {
    const blocking = result.mode === 'enforce' && hookEventName(payload) !== 'Stop';
    io.stderr(JSON.stringify({
      source: 'progress-watchdog',
      type: blocking ? 'blocked' : 'warning',
      severity: 'high',
      state: 'frozen',
      escalationRequired: true,
      blocking,
      reason: result.session.freezeReason || 'repair_budget_exhausted',
      archiveFile: result.archiveFile,
      noProgressTurns: result.session.noProgressTurns,
      thresholds: result.thresholds,
      constraint: '停止继续消耗上下文；先输出事实/卡点/下一步并与用户对齐。解冻: progress-watchdog.cjs --reset --reason "<why>"',
    }));
    return { exitCode: blocking ? 2 : 0, result };
  }
  return { exitCode: 0, result };
}

function runLoopController(payload, io, opts = {}) {
  let result;
  try {
    const evaluate = opts.evaluateLoop || loopController.evaluateStop;
    result = evaluate(payload, opts.loopOptions || {});
  } catch (error) {
    io.stderr(`[loop-controller] fail-open: ${error.message}`);
    return { exitCode: 0, decision: 'allow', status: 'internal_error' };
  }
  if (result.decision === 'block') {
    io.stdout(JSON.stringify({ decision: 'block', reason: result.reason }));
    return { exitCode: 0, decision: 'block', stopRouting: true, result };
  }
  if (result.reason) io.stderr(`[loop-controller] ${result.reason}`);
  return { exitCode: 0, decision: 'allow', result };
}

function currentEvidenceKey(cacheEntry, policy) {
  const inputs = cacheEntry?.inputs;
  const projectRoot = String(cacheEntry?.projectRoot || inputs?.projectRoot || '');
  if (!projectRoot || !inputs || typeof inputs !== 'object') return null;
  const rebuild = (items) => {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      const filePath = path.resolve(projectRoot, String(item?.path || ''));
      try {
        if (!fs.statSync(filePath).isFile()) return null;
        out.push({
          path: String(item.path),
          sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
        });
      } catch {
        return null;
      }
    }
    return out;
  };
  const fileHashes = rebuild(inputs.fileHashes);
  const testHashes = rebuild(inputs.testHashes);
  const goldenHashes = rebuild(inputs.goldenHashes);
  if (!fileHashes || !testHashes || !goldenHashes) return null;
  return policy.buildEvidenceKey({
    projectRoot,
    fileHashes,
    testHashes,
    goldenHashes,
    command: cacheEntry.command || inputs.command,
    toolVersions: { ...(inputs.toolVersions || {}), node: process.version },
    riskLevel: cacheEntry.riskLevel,
  }).evidenceKey;
}

function findCachedEvidence(entry, state, riskState, policy, opts = {}) {
  if (entry.effectiveRiskLevel === 'R3') return null;
  const candidates = Object.values(state?.evidenceCache || {})
    .filter(candidate => candidate?.projectRoot && entry.projectRoot
      && isSamePath(path.resolve(candidate.projectRoot), path.resolve(entry.projectRoot)))
    .sort((a, b) => Date.parse(b.verifiedAt || 0) - Date.parse(a.verifiedAt || 0))
    .slice(0, 20);
  for (const candidate of candidates) {
    const evidenceKey = currentEvidenceKey(candidate, policy);
    if (!evidenceKey || evidenceKey !== candidate.evidenceKey) continue;
    const hit = riskState.findReusableRiskEvidence(state, {
      projectRoot: entry.projectRoot,
      riskLevel: entry.effectiveRiskLevel,
      evidenceKey,
      now: opts.now,
    });
    if (hit) return hit;
  }
  return null;
}

function runDeliveryRisk(payload, io, opts = {}) {
  const policy = require('../lib/risk-policy.cjs');
  const env = opts.env || process.env;
  const mode = policy.riskPolicyMode(env);
  if (mode === 'off') return { exitCode: 0, decision: 'allow', status: 'off' };

  let entries;
  let riskState = null;
  let state = null;
  try {
    if (Array.isArray(opts.riskEntries)) {
      entries = opts.riskEntries;
    } else {
      riskState = opts.riskState || require('../lib/verification-state.cjs');
      state = opts.state || riskState.readVerificationState();
      entries = riskState.riskForPayload(state, payload);
    }
  } catch (error) {
    io.stderr(JSON.stringify({
      source: 'risk-policy',
      type: 'warning',
      status: 'state-unreadable',
      reason: error.message,
    }));
    return { exitCode: 0, decision: 'allow', status: 'state-unreadable' };
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return { exitCode: 0, decision: 'allow', status: 'verified-or-not-applicable' };
  }

  const rank = level => ['R0', 'R1', 'R2', 'R3'].indexOf(String(level || '').toUpperCase());
  const highest = [...entries].sort(
    (a, b) => rank(b.effectiveRiskLevel) - rank(a.effectiveRiskLevel),
  )[0];
  const level = String(highest.effectiveRiskLevel || highest.minimumRiskLevel || 'R1').toUpperCase();
  const reason = String(highest.riskReasons?.[0] || 'unresolved-risk');
  const evidence = (highest.requiredEvidence || policy.requiredEvidenceForRisk(level)).join(', ')
    || 'proportional verification';
  const unavailable = entries.every(entry => entry.verificationStatus === 'unavailable');

  if (level !== 'R3') {
    const findCacheEvidence = opts.findCacheEvidence
      || (entry => findCachedEvidence(entry, state, riskState, policy, opts));
    const hits = entries.map(entry => findCacheEvidence(entry));
    if (hits.every(Boolean)) {
      if (riskState && typeof riskState.markRiskVerifiedForCwd === 'function') {
        try {
          riskState.markRiskVerifiedForCwd(String(payload?.cwd || process.cwd()), {
            sessionId: String(payload?.session_id || payload?.sessionId || ''),
            evidenceRiskLevel: level,
            command: 'content-addressed-evidence-cache',
            fresh: false,
          });
        } catch { /* cache hit remains valid even if cleanup is deferred */ }
      }
      return { exitCode: 0, decision: 'allow', status: 'cached-evidence', entries, cacheHits: hits };
    }
  }

  if (unavailable) {
    const detail = String(highest.verificationReason || 'required verification environment unavailable')
      .slice(0, 120);
    io.stdout(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEventName(payload) || 'Stop',
        additionalContext: `[risk-policy] status=unverified; ${detail}. Report the blocker and evidence boundary; do not claim success.`,
      },
    }));
    return { exitCode: 0, decision: 'allow', status: 'unverified', entries };
  }

  if (mode === 'shadow') {
    io.stderr(JSON.stringify({
      source: 'risk-policy',
      type: 'warning',
      status: 'shadow',
      riskLevel: level,
      reason,
      remediation: `run ${evidence} before delivery`,
    }));
    return { exitCode: 0, decision: 'allow', status: 'shadow', entries };
  }

  const blockReason = `Delivery has unresolved ${level} risk (${reason}); provide ${evidence}.`;
  io.stdout(JSON.stringify({ decision: 'block', reason: blockReason }));
  return {
    exitCode: 0,
    decision: 'block',
    status: 'blocked',
    stopRouting: true,
    reason: blockReason,
    entries,
  };
}

function defaultComponents(opts = {}) {
  let deliverySnapshot = null;
  return {
    loopController(payload, io) {
      return runLoopController(payload, io, opts);
    },
    deliveryRisk(payload, io) {
      deliverySnapshot = runDeliveryRisk(payload, io, opts);
      return deliverySnapshot;
    },
    contextPressure() {
      return contextPressure.main();
    },
    progressWatchdog(payload, io) {
      return runWatchdog(payload, io, {
        ...opts,
        watchdogOptions: {
          ...(opts.watchdogOptions || {}),
          riskLevel: highestRiskLevel(deliverySnapshot?.entries || []),
        },
      });
    },
  };
}

function normalizeExitCode(result) {
  const value = Number(result?.exitCode || 0);
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

function runStopSummary(raw, opts = {}) {
  const io = defaultIo(opts);
  const parse = typeof opts.parse === 'function' ? opts.parse : JSON.parse;
  let payload = {};
  try {
    if (String(raw || '').trim()) payload = parse(String(raw));
  } catch (error) {
    io.stderr(JSON.stringify({
      source: 'stop-summary',
      type: 'warning',
      message: `invalid hook json: ${error.message}`,
    }));
    return { exitCode: 0, payload: {}, componentsRun: [] };
  }

  if (typeof opts.onParsed === 'function') opts.onParsed(payload);
  const components = opts.components || defaultComponents(opts);
  const route = ['loopController', 'deliveryRisk', 'contextPressure', 'progressWatchdog'];
  const componentsRun = [];
  let exitCode = 0;
  for (const name of route) {
    const component = components[name];
    if (typeof component !== 'function') {
      io.stderr(JSON.stringify({
        source: 'stop-summary',
        type: 'error',
        component: name,
        message: 'component is not callable',
      }));
      exitCode = Math.max(exitCode, 1);
      continue;
    }
    const componentResult = component(payload, io);
    componentsRun.push(name);
    exitCode = Math.max(exitCode, normalizeExitCode(componentResult));
    if (componentResult?.stopRouting === true) break;
  }

  return { exitCode, payload, componentsRun };
}

function readStdin() {
  try {
    if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
  return '';
}

function main() {
  const result = runStopSummary(readStdin());
  if (result.exitCode) process.exitCode = result.exitCode;
  return result;
}

if (require.main === module) main();

module.exports = {
  runStopSummary,
  runWatchdog,
  runLoopController,
  runDeliveryRisk,
  highestRiskLevel,
  currentEvidenceKey,
  findCachedEvidence,
};
