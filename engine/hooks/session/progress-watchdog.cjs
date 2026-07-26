#!/usr/bin/env node
'use strict';

const { HARNESS_ROOT } = require('../../scripts/lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HOME = HARNESS_ROOT;
const DEFAULT_STATE_FILE = path.join(HOME, 'var', 'index', 'progress-watchdog-state.json');
const DEFAULT_ARCHIVE_DIR = path.join(HOME, 'var', 'failures', 'progress-watchdog');
const DEFAULT_MAX_NO_PROGRESS_TURNS = 8;
const DEFAULT_MAX_IDLE_MS = 45 * 60 * 1000;
const HISTORY_LIMIT = 16;
const BYPASS_AUDIT_LIMIT = 16;
const MIN_BYPASS_REASON_LENGTH = 12;

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoRead',
  'AskUserQuestion',
]);

const DIRECT_PROGRESS_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Agent',
  'Workflow',
]);

const VERIFICATION_COMMAND = /\b(pytest|npm\s+(?:test|run\s+test)|pnpm\s+(?:test|run\s+test)|node\s+.*(?:test-hooks|\.test\.|spec)|ruff\s+check|vlog|vsim|iverilog|verilator|make\s+(?:test|sim|lint|compile|verify)|git\s+commit)\b/i;
const FPGA_VERIFICATION_COMMAND = /\b(?:vivado(?:\.bat|\.exe)?\s+.*(?:-mode\s+batch|-source\b)|node(?:\.exe)?\s+.*(?:pg-synth|fpga-timing-parser|auto-parse-fpga-reports)\.cjs\b)/i;
const READ_ONLY_COMMAND = /^\s*(?:pwd|cd\b|ls\b|dir\b|echo\b|cat\b|type\b|Get-Content\b|rg\b|grep\b|findstr\b)/i;

function watchdogMode(opts = {}) {
  const cliMode = process.argv.includes('--enforce') ? 'enforce' : '';
  const value = String(opts.mode || cliMode || process.env.PROGRESS_WATCHDOG_MODE || 'observe').toLowerCase();
  return value === 'enforce' ? 'enforce' : 'observe';
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

function sessionIdFor(payload) {
  return String(
    payload?.session_id
    || payload?.sessionId
    || payload?.thread_id
    || payload?.threadId
    || process.env.CLAUDE_SESSION_ID
    || ''
  ).trim().slice(0, 128);
}

function objectiveHashFor(payload) {
  const instruction = String(
    payload?.user_message
    || payload?.userMessage
    || payload?.prompt
    || process.env.CLAUDE_USER_MESSAGE
    || ''
  ).trim();
  return instruction ? sha1(instruction) : '';
}

function stableSessionKey(cwd, sessionId = '') {
  const root = path.resolve(cwd || process.cwd());
  const identity = sessionId ? `${root}\n${sessionId}` : root;
  return sha1(identity).slice(0, 12);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // Corrupt watchdog state must not hide the current hook event.
  }
  return fallback;
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function toolName(payload) {
  return String(payload?.tool_name || payload?.tool?.name || payload?.name || '').trim();
}

function commandText(payload) {
  return String(payload?.tool_input?.command || payload?.tool?.input?.command || payload?.command || '').trim();
}

function eventName(payload) {
  return String(payload?.hook_event_name || payload?.event || '').trim();
}

function bypassRequest(opts = {}) {
  const disabled = String(opts.disabled ?? process.env.PROGRESS_WATCHDOG_DISABLED ?? '') === '1';
  const reason = String(opts.bypassReason ?? process.env.PROGRESS_WATCHDOG_BYPASS_REASON ?? '').trim();
  const actor = String(opts.bypassActor ?? process.env.PROGRESS_WATCHDOG_BYPASS_ACTOR ?? 'unknown').trim() || 'unknown';
  return {
    requested: disabled || Boolean(reason),
    valid: disabled && reason.length >= MIN_BYPASS_REASON_LENGTH,
    reason,
    actor,
  };
}

function resultFromPayload(payload) {
  const result = payload?.tool_response || payload?.tool_result || payload?.response || {};
  const rawStatus = result.status ?? result.exit_code ?? result.exitCode;
  const parsedStatus = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
  return {
    exitCode: Number.isFinite(parsedStatus) ? parsedStatus : null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: String(result.error || ''),
  };
}

function cwdFor(payload) {
  return payload?.cwd || payload?.workspace?.current_dir || process.cwd();
}

function classifyEvent(payload) {
  const name = toolName(payload);
  const command = commandText(payload);
  const explicit = String(payload?.progress_status || payload?.progressStatus || '').toLowerCase();
  const hookEvent = eventName(payload);

  if (explicit === 'no_progress') {
    return { kind: explicit, evidence: `explicit progress classification: ${explicit}` };
  }

  if (DIRECT_PROGRESS_TOOLS.has(name)) {
    return { kind: 'activity', evidence: `${name} tool use without verification outcome` };
  }

  if (name === 'Bash') {
    if (READ_ONLY_COMMAND.test(command)) {
      return { kind: 'activity', evidence: `read-only shell exploration: ${command.slice(0, 160)}` };
    }
    if (VERIFICATION_COMMAND.test(command) || FPGA_VERIFICATION_COMMAND.test(command)) {
      if (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') {
        const result = resultFromPayload(payload);
        const failed = hookEvent === 'PostToolUseFailure' || result.exitCode !== 0;
        const status = failed ? 'failed' : 'passed';
        return {
          kind: failed ? 'no_progress' : 'progress',
          evidence: `verification outcome ${status}: exit=${result.exitCode ?? 'unknown'} command=${command.slice(0, 160)}`,
          verification: {
            status,
            exitCode: result.exitCode,
            command: command.slice(0, 240),
            outputHash: sha1(`${result.stdout}\n${result.stderr}\n${result.error}`),
          },
        };
      }
      return { kind: 'activity', evidence: `verification command awaiting result: ${command.slice(0, 160)}` };
    }
    return { kind: 'activity', evidence: `shell command without artifact proof: ${command.slice(0, 160)}` };
  }

  if (READ_ONLY_TOOLS.has(name)) {
    return { kind: 'activity', evidence: `${name} read-only exploration` };
  }

  if (eventName(payload) === 'Stop') {
    return { kind: 'checkpoint', evidence: 'Stop hook checkpoint' };
  }

  return { kind: 'activity', evidence: name ? `${name} activity` : 'unknown hook activity' };
}

function defaultState() {
  return { schemaVersion: 2, sessions: {} };
}

function sessionRecord(state, cwd, sessionId = '', objectiveHash = '') {
  const key = stableSessionKey(cwd, sessionId);
  if (!state.sessions[key]) {
    state.sessions[key] = {
      cwd: path.resolve(cwd || process.cwd()),
      sessionId,
      objectiveHash,
      noProgressTurns: 0,
      status: 'active',
      lastProgressAt: null,
      lastEventAt: null,
      archivedAt: null,
      history: [],
    };
  }
  if (objectiveHash) state.sessions[key].objectiveHash = objectiveHash;
  return { key, session: state.sessions[key] };
}

function appendHistory(session, event) {
  session.history = [...(session.history || []), event].slice(-HISTORY_LIMIT);
}

function appendBypassAudit(session, event) {
  session.bypassAudit = [...(session.bypassAudit || []), event].slice(-BYPASS_AUDIT_LIMIT);
}

function freezeRepairLoop({ archiveDir, sessionKey, session, trigger, now, thresholds }) {
  ensureDir(archiveDir);
  const stamp = now.replace(/[:.]/g, '-');
  const archiveFile = path.join(archiveDir, `${stamp}-${sessionKey}.json`);
  const record = {
    schemaVersion: 2,
    status: 'frozen_escalation_required',
    reason: 'repair_budget_exhausted',
    trigger,
    cwd: session.cwd,
    sessionId: session.sessionId || '',
    objectiveHash: session.objectiveHash || '',
    archivedAt: now,
    noProgressTurns: session.noProgressTurns,
    lastProgressAt: session.lastProgressAt,
    lastEventAt: session.lastEventAt,
    thresholds,
    repairBudget: {
      limit: thresholds.maxNoProgressTurns,
      used: session.noProgressTurns,
      exhausted: true,
    },
    escalation: {
      required: true,
      type: 'human_alignment_or_architecture_review',
      reason: 'repair_budget_exhausted',
    },
    history: session.history || [],
    requiredNextStep: [
      'Summarize confirmed facts and open questions.',
      'Ask the user for alignment if the task direction is still unclear.',
      'Resume only with a concrete edit, verification, or explicitly approved workflow step.',
    ],
  };
  writeJson(archiveFile, record);
  session.status = 'frozen';
  session.frozenAt = now;
  session.freezeReason = 'repair_budget_exhausted';
  session.escalation = record.escalation;
  session.archivedAt = now;
  session.archiveFile = archiveFile;
  return { archiveFile, record };
}

function updateProgress(payload, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const stateFile = opts.stateFile || process.env.PROGRESS_WATCHDOG_STATE_FILE || DEFAULT_STATE_FILE;
  const archiveDir = opts.archiveDir || process.env.PROGRESS_WATCHDOG_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
  const maxNoProgressTurns = Number.parseInt(
    opts.maxNoProgressTurns || process.env.PROGRESS_WATCHDOG_MAX_NO_PROGRESS_TURNS || DEFAULT_MAX_NO_PROGRESS_TURNS,
    10
  );
  const maxIdleMs = Number.parseInt(
    opts.maxIdleMs || process.env.PROGRESS_WATCHDOG_MAX_IDLE_MS || DEFAULT_MAX_IDLE_MS,
    10
  );
  const mode = watchdogMode(opts);
  const state = readJson(stateFile, defaultState());
  if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};

  const cwd = cwdFor(payload);
  const sessionId = sessionIdFor(payload);
  const objectiveHash = objectiveHashFor(payload);
  const { key, session } = sessionRecord(state, cwd, sessionId, objectiveHash);
  const bypass = bypassRequest(opts);
  if (bypass.requested) {
    if (!bypass.valid) {
      return {
        status: 'bypass_reason_required',
        classification: { kind: 'blocked_bypass', evidence: 'emergency bypass requires an auditable reason' },
        sessionKey: key,
        stateFile,
        archiveFile: session.archiveFile || null,
        session,
        mode,
        thresholds: { maxNoProgressTurns, maxIdleMs },
      };
    }
    const audit = {
      at: now,
      actor: bypass.actor,
      reason: bypass.reason,
      event: eventName(payload) || 'unknown',
      tool: toolName(payload) || 'unknown',
      sessionStatus: session.status || 'active',
    };
    appendBypassAudit(session, audit);
    appendHistory(session, { ...audit, kind: 'bypass', evidence: `audited emergency bypass by ${bypass.actor}` });
    session.lastEventAt = now;
    writeJson(stateFile, state);
    return {
      status: 'bypassed',
      classification: { kind: 'bypass', evidence: audit.reason },
      sessionKey: key,
      stateFile,
      archiveFile: session.archiveFile || null,
      session,
      bypass: audit,
      mode,
      thresholds: { maxNoProgressTurns, maxIdleMs },
    };
  }
  if (session.status === 'frozen') {
    session.lastEventAt = now;
    appendHistory(session, {
      at: now,
      event: eventName(payload) || 'unknown',
      tool: toolName(payload) || 'unknown',
      kind: 'blocked_frozen',
      evidence: `repair loop frozen: ${session.freezeReason || 'repair_budget_exhausted'}`,
      objectiveHash,
    });
    writeJson(stateFile, state);
    return {
      status: 'frozen_escalation_required',
      classification: { kind: 'blocked_frozen', evidence: session.freezeReason || 'repair_budget_exhausted' },
      sessionKey: key,
      stateFile,
      archiveFile: session.archiveFile || null,
      session,
      mode,
      thresholds: { maxNoProgressTurns, maxIdleMs },
    };
  }
  const classification = classifyEvent(payload);
  const historyItem = {
    at: now,
    event: eventName(payload) || 'unknown',
    tool: toolName(payload) || 'unknown',
    kind: classification.kind,
    evidence: classification.evidence,
    objectiveHash,
    verification: classification.verification || null,
  };

  if (classification.verification) session.lastVerification = classification.verification;

  if (classification.kind === 'progress') {
    session.noProgressTurns = 0;
    session.lastProgressAt = now;
    session.archivedAt = null;
    delete session.archiveFile;
  } else if (classification.kind === 'no_progress') {
    session.noProgressTurns = (session.noProgressTurns || 0) + 1;
  }
  session.lastEventAt = now;
  appendHistory(session, historyItem);

  const idleMs = session.lastProgressAt ? Date.parse(now) - Date.parse(session.lastProgressAt) : 0;
  const turnExceeded = maxNoProgressTurns > 0
    && classification.kind === 'no_progress'
    && session.noProgressTurns >= maxNoProgressTurns;
  const idleExceeded = maxIdleMs > 0 && session.lastProgressAt && idleMs >= maxIdleMs && classification.kind === 'no_progress';
  let archive = null;
  let status = classification.kind;
  if (turnExceeded || idleExceeded) {
    const reason = turnExceeded ? 'no_progress_turn_threshold' : 'idle_time_threshold';
    if (mode === 'enforce') {
      archive = freezeRepairLoop({
        archiveDir,
        sessionKey: key,
        session,
        trigger: reason,
        now,
        thresholds: { maxNoProgressTurns, maxIdleMs },
      });
      status = 'frozen_escalation_required';
    } else {
      status = 'warning';
    }
  }

  writeJson(stateFile, state);
  return {
    status,
    classification,
    sessionKey: key,
    stateFile,
    archiveFile: archive?.archiveFile || null,
    session,
    mode,
    thresholds: { maxNoProgressTurns, maxIdleMs },
  };
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
  if (process.argv.includes('reset')) {
    const stateFile = process.env.PROGRESS_WATCHDOG_STATE_FILE || DEFAULT_STATE_FILE;
    const bypass = bypassRequest();
    if (!bypass.valid) {
      console.error(JSON.stringify({ source: 'progress-watchdog', type: 'blocked', reason: 'reset requires PROGRESS_WATCHDOG_DISABLED=1 and an auditable PROGRESS_WATCHDOG_BYPASS_REASON' }));
      process.exit(2);
    }
    const state = defaultState();
    state.bypassAudit = [{
      at: new Date().toISOString(),
      actor: bypass.actor,
      reason: bypass.reason,
      action: 'reset',
    }];
    writeJson(stateFile, state);
    console.error(JSON.stringify({ source: 'progress-watchdog', type: 'reset', stateFile, reason: bypass.reason, actor: bypass.actor }));
    return;
  }

  let payload = {};
  const raw = readStdin();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      console.error(JSON.stringify({ source: 'progress-watchdog', type: 'warning', message: `invalid hook json: ${error.message}` }));
      return;
    }
  }

  const result = updateProgress(payload);
  if (result.status === 'bypass_reason_required') {
    console.error(JSON.stringify({
      source: 'progress-watchdog',
      type: 'blocked',
      severity: 'high',
      reason: 'emergency bypass requires PROGRESS_WATCHDOG_DISABLED=1 and an auditable reason',
    }));
    process.exit(2);
  }
  if (result.status === 'bypassed') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName(payload) || 'PreToolUse',
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
    return;
  }
  if (result.status === 'warning') {
    console.error(JSON.stringify({
      source: 'progress-watchdog',
      type: 'warning',
      severity: 'medium',
      reason: 'no progress threshold exceeded; observation only',
      noProgressTurns: result.session.noProgressTurns,
      thresholds: result.thresholds,
      constraint: '记录事实与下一步；不要仅因启发式进度判断阻断模型探索。',
    }));
  }
  if (result.status === 'frozen_escalation_required') {
    console.error(JSON.stringify({
      source: 'progress-watchdog',
      type: 'blocked',
      severity: 'high',
      state: 'frozen',
      escalationRequired: true,
      reason: result.session.freezeReason || 'repair_budget_exhausted',
      archiveFile: result.archiveFile,
      noProgressTurns: result.session.noProgressTurns,
      thresholds: result.thresholds,
      constraint: '停止继续消耗上下文；先输出事实/卡点/下一步并与用户对齐。',
    }));
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  classifyEvent,
  objectiveHashFor,
  sessionIdFor,
  updateProgress,
  stableSessionKey,
  watchdogMode,
  DEFAULT_STATE_FILE,
  DEFAULT_ARCHIVE_DIR,
};
