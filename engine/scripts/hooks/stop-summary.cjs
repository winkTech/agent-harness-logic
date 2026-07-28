#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const contextPressure = require('./context-pressure-warn.cjs');
const watchdog = require('../../hooks/session/progress-watchdog.cjs');

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

function defaultComponents(opts = {}) {
  return {
    contextPressure() {
      return contextPressure.main();
    },
    progressWatchdog(payload, io) {
      return runWatchdog(payload, io, opts);
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
  const route = ['contextPressure', 'progressWatchdog'];
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
    exitCode = Math.max(exitCode, normalizeExitCode(component(payload, io)));
  }

  return { exitCode, payload, componentsRun: route };
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

module.exports = { runStopSummary, runWatchdog };
