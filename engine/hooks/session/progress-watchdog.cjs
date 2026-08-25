#!/usr/bin/env node
'use strict';

const { HARNESS_ROOT } = require('../../scripts/lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  atomicWriteJson,
  withFileLockSync,
} = require('../../scripts/lib/project-scope.cjs');

const transport = require('../../scripts/transport/index.cjs');

const HOME = HARNESS_ROOT;
const DEFAULT_STATE_FILE = path.join(HOME, 'var', 'index', 'progress-watchdog-state.json');
const DEFAULT_ARCHIVE_DIR = path.join(HOME, 'var', 'failures', 'progress-watchdog');
const DEFAULT_MAX_NO_PROGRESS_TURNS = 8;
const DEFAULT_MAX_IDLE_MS = 45 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_ARCHIVES = 50;
const DEFAULT_SCOPE_TTL_MS = 45 * 60 * 1000;
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
const LONG_TASK_TOOLS = new Set(['Agent', 'Workflow', 'Task']);
const NOTIFY_TOOLS = new Set(['AskUserQuestion', 'PushNotification', 'SendMessage', 'TodoWrite', 'ToolSearch']);

const VERIFICATION_COMMAND = /\b(pytest|npm\s+(?:test|run\s+test)|pnpm\s+(?:test|run\s+test)|node\s+.*(?:test-hooks|\.test\.|spec)|ruff\s+check|vlog|vsim|iverilog|verilator|make\s+(?:test|sim|lint|compile|verify)|git\s+commit)\b/i;
const FPGA_VERIFICATION_COMMAND = /\b(?:vivado(?:\.bat|\.exe)?\s+.*(?:-mode\s+batch|-source\b)|node(?:\.exe)?\s+.*(?:pg-synth|fpga-timing-parser|auto-parse-fpga-reports)\.cjs\b)/i;
const READ_ONLY_COMMAND = /^\s*(?:pwd|cd\b|ls\b|dir\b|echo\b|cat\b|type\b|Get-Content\b|rg\b|grep\b|findstr\b)/i;
const LONG_TASK_TEXT = /\b(?:long[- ]?running|monitor|watch|babysit|repair loop|keep going|do not stop)\b|长任务|持续监控|不要停止|修复循环/i;
const RISK_LEVELS = ['R0', 'R1', 'R2', 'R3'];

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
  atomicWriteJson(filePath, value);
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

function normalizeRiskLevel(value) {
  const level = String(value || 'R0').trim().toUpperCase();
  return RISK_LEVELS.includes(level) ? level : 'R0';
}

function payloadDeclaresLongTask(payload) {
  if (LONG_TASK_TOOLS.has(toolName(payload))) return true;
  const explicit = payload?.long_running
    ?? payload?.longRunning
    ?? payload?.task?.long_running
    ?? payload?.task?.longRunning
    ?? payload?.tool_input?.long_running
    ?? payload?.tool_input?.longRunning;
  if (explicit === true || String(explicit || '').toLowerCase() === 'true') return true;
  const taskKind = String(
    payload?.task_kind || payload?.taskKind || payload?.task?.kind || payload?.tool_input?.task_kind || '',
  );
  if (/^(?:long|monitor|watch|repair|workflow)$/i.test(taskKind.trim())) return true;
  const text = String(
    payload?.user_message || payload?.userMessage || payload?.prompt || payload?.task?.objective || '',
  );
  return LONG_TASK_TEXT.test(text);
}

/**
 * D1 transport 归一化入口：把原始 hook payload 经 transport 层归一化为
 * harness-event-v1 事件对象。归一化层是纯函数、无副作用。
 *
 * fail-closed：归一化失败（非法载荷/未知 transport）不抛异常，返回一个
 * status=unknown 的 fallback 事件，保证 watchdog 不因 transport 故障而
 * 静默吞事件或误判成败。调用方拿到 event 后用 event.status 作为
 * D1 失败证据（=== 'failed' ⟺ PostToolUseFailure 或载荷显式 failed）。
 *
 * @param {object} payload 原始 hook payload
 * @param {object} [opts] 选项
 * @param {string} [opts.transport='claude-code'] 目标 transport
 * @returns {{event: object, transportError: Error|null}}
 */
function normalizePayload(payload, opts = {}) {
  const transportName = opts.transport || process.env.HARNESS_TRANSPORT || 'claude-code';
  try {
    const event = transport.normalize(payload, transportName);
    return { event, transportError: null };
  } catch (error) {
    return {
      event: {
        schema: 'harness.event',
        version: 1,
        eventId: 'fallback',
        eventType: 'unknown',
        transport: transportName,
        occurredAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        sessionId: sessionIdFor(payload),
        cwd: cwdFor(payload),
        status: 'unknown',
        toolName: toolName(payload),
        toolInput: null,
        toolUseId: null,
        actor: null,
        source: {
          nativeEventName: eventName(payload) || 'unknown',
          adapter: 'fallback',
          statusInferred: true,
          timestampInferred: true,
          payloadHash: null,
        },
        raw: null,
        extensions: {},
      },
      transportError: error,
    };
  }
}

function shouldTrackProgress(payload, opts = {}) {
  if (opts.forceTrack === true) return { tracked: true, reason: 'forced' };
  if (opts.forceTrack === false) return { tracked: false, reason: 'explicitly_disabled' };
  const existing = opts.existingSession && typeof opts.existingSession === 'object'
    ? opts.existingSession
    : null;
  if (existing?.status === 'frozen') return { tracked: true, reason: 'frozen_session' };

  const riskLevel = normalizeRiskLevel(opts.riskLevel);
  if (RISK_LEVELS.indexOf(riskLevel) >= RISK_LEVELS.indexOf('R2')) {
    return { tracked: true, reason: 'elevated_risk', riskLevel };
  }

  const classification = opts.classification || classifyEvent(payload, opts.event);
  if (eventName(payload) === 'PostToolUseFailure' || opts.event?.status === 'failed' || classification.kind === 'no_progress') {
    return { tracked: true, reason: 'repair_loop' };
  }
  if (Number(existing?.noProgressTurns || 0) > 0) {
    return { tracked: true, reason: 'repair_loop' };
  }
  if (payloadDeclaresLongTask(payload)) return { tracked: true, reason: 'long_task' };

  const nowMs = Date.parse(opts.now || new Date().toISOString());
  const scopeExpiryMs = Date.parse(existing?.trackingScope?.expiresAt || '');
  if (existing?.trackingScope?.kind === 'long_task'
      && Number.isFinite(nowMs) && Number.isFinite(scopeExpiryMs) && scopeExpiryMs > nowMs) {
    return { tracked: true, reason: 'long_task' };
  }
  return { tracked: false, reason: 'ordinary_low_risk' };
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
  // 真实 Claude Code PostToolUse 载荷的 tool_response 没有 status/exit_code:
  // Bash 是 {stdout, stderr, interrupted, ...}, 有的工具直接给字符串或
  // content block 数组。旧实现把"缺退出码"当 Number(undefined)=NaN → null,
  // 再在上游用 `exitCode !== 0` 判失败 —— 于是每一次成功验证都被记为
  // 失败, 8 轮后误冻结整个会话 (2026-07-27 实测事故)。
  const raw = payload?.tool_response ?? payload?.tool_result ?? payload?.response ?? {};
  let result = raw;
  if (typeof raw === 'string') result = { stdout: raw };
  else if (Array.isArray(raw)) {
    result = { stdout: raw.map((b) => (typeof b === 'string' ? b : String(b?.text || ''))).join('\n') };
  } else if (!raw || typeof raw !== 'object') result = {};

  const rawStatus = result.status ?? result.exit_code ?? result.exitCode;
  const parsedStatus = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus);
  const hasStatus = rawStatus !== undefined && rawStatus !== null && rawStatus !== ''
    && Number.isFinite(parsedStatus);
  const stdout = typeof result.stdout === 'string' ? result.stdout
    : (typeof result.output === 'string' ? result.output : '');
  return {
    exitCode: hasStatus ? parsedStatus : null,
    stdout,
    stderr: String(result.stderr || ''),
    error: String(result.error || ''),
    interrupted: result.interrupted === true,
  };
}

// 与 verification-gate 同口径: 成功必须有正面 PASS 证据, 失败必须有明确
// 失败证据 (PostToolUseFailure / 中断 / 非零退出码 / FAIL / FATAL)。
// 两者都没有 → 记 activity (结论不明, 既不奖励也不扣修复预算)。
const OUTPUT_PASS_MARKERS = [
  /\bRESULT:\s*PASS\b/i,
  /\b(?:ALL\s+)?(?:TESTS?|CHECKS?)\s+PASSED\b/i,
  /\bPASS(?:ED)?\b/,
  /\b\d+\s+passed\b/i,
  /\b0\s+(?:failed|failures|errors|mismatches)\b/i,
  /全部通过/,
  /\bbit-true\b/i,
];
const OUTPUT_FAIL_MARKERS = [
  /\bFATAL\b/i,
  /\[FAIL\]/i,
  /\bRESULT:\s*FAIL\b/i,
  /\bFAIL\b(?!\w)/,
  /\b[1-9]\d*\s+(?:failed|failures|errors|mismatches)\b/i,
  /\bASSERTION\s+FAILED\b/i,
  /\bAssertion error\b/i,
];

function verificationOutcome(hookEvent, result, event) {
  const combined = `${result.stdout}\n${result.stderr}\n${result.error}`;
  if (hookEvent === 'PostToolUseFailure' || event?.status === 'failed') return { verdict: 'failed', why: event?.status === 'failed' ? 'transport status=failed' : 'PostToolUseFailure event' };
  if (result.interrupted) return { verdict: 'failed', why: 'command interrupted' };
  if (result.exitCode !== null && result.exitCode !== 0) return { verdict: 'failed', why: `exit=${result.exitCode}` };
  if (OUTPUT_FAIL_MARKERS.some((re) => re.test(combined))) return { verdict: 'failed', why: 'failure marker in output' };
  if (OUTPUT_PASS_MARKERS.some((re) => re.test(combined))) return { verdict: 'passed', why: 'explicit PASS evidence' };
  return { verdict: 'inconclusive', why: 'no explicit PASS or FAIL evidence' };
}

function cwdFor(payload) {
  return payload?.cwd || payload?.workspace?.current_dir || process.cwd();
}

function classifyEvent(payload, event) {
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

  if (name === 'Bash' || name === 'PowerShell') {
    if (READ_ONLY_COMMAND.test(command)) {
      return { kind: 'activity', evidence: `read-only shell exploration: ${command.slice(0, 160)}` };
    }
    if (VERIFICATION_COMMAND.test(command) || FPGA_VERIFICATION_COMMAND.test(command)) {
      if (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure' || (event && event.eventType === 'tool.post')) {
        const result = resultFromPayload(payload);
        const outcome = verificationOutcome(hookEvent, result, event);
        if (outcome.verdict === 'inconclusive') {
          // 真实载荷缺退出码且输出无结论 → 不能臆断成败, 也绝不能记失败
          // (那正是误冻结事故的根因); 按 activity 处理。
          return { kind: 'activity', evidence: `verification outcome inconclusive (${outcome.why}): ${command.slice(0, 160)}` };
        }
        const status = outcome.verdict;
        return {
          kind: status === 'failed' ? 'no_progress' : 'progress',
          evidence: `verification outcome ${status} (${outcome.why}): command=${command.slice(0, 160)}`,
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

function isReadOnlyAction(payload) {
  const name = toolName(payload);
  if (READ_ONLY_TOOLS.has(name)) return true;
  return (name === 'Bash' || name === 'PowerShell') && READ_ONLY_COMMAND.test(commandText(payload));
}

function frozenActionAccess(payload) {
  const name = toolName(payload);
  const command = commandText(payload);
  const hookEvent = eventName(payload);
  const isAuditReset = /(?:progress-watchdog\.cjs|verification-gate\.cjs)\s+(?:--)?reset\b/.test(command);
  const isReadOnly = READ_ONLY_TOOLS.has(name)
    || ((name === 'Bash' || name === 'PowerShell') && READ_ONLY_COMMAND.test(command));
  const allowed = isAuditReset || isReadOnly || NOTIFY_TOOLS.has(name) || hookEvent === 'Stop';
  return {
    allowed,
    evidence: isAuditReset ? 'audited reset'
      : isReadOnly ? 'read-only'
        : hookEvent === 'Stop' ? 'stop checkpoint'
          : NOTIFY_TOOLS.has(name) ? 'notification' : 'blocked',
  };
}

function pruneSessions(state, maxSessions = DEFAULT_MAX_SESSIONS) {
  const entries = Object.entries(state.sessions || {});
  if (entries.length <= maxSessions) return state;
  entries.sort((a, b) => {
    const aFrozen = a[1]?.status === 'frozen' ? 1 : 0;
    const bFrozen = b[1]?.status === 'frozen' ? 1 : 0;
    if (aFrozen !== bFrozen) return bFrozen - aFrozen;
    const aAt = Date.parse(a[1]?.lastEventAt || a[1]?.lastProgressAt || '') || 0;
    const bAt = Date.parse(b[1]?.lastEventAt || b[1]?.lastProgressAt || '') || 0;
    return bAt - aAt;
  });
  const dropped = entries.length - maxSessions;
  state.sessions = Object.fromEntries(entries.slice(0, maxSessions));
  state.droppedSessions = Number(state.droppedSessions || 0) + dropped;
  return state;
}

function writeWatchdogState(stateFile, state, maxSessions) {
  writeJson(stateFile, pruneSessions(state, maxSessions));
}

function appendHistory(session, event) {
  session.history = [...(session.history || []), event].slice(-HISTORY_LIMIT);
}

function appendBypassAudit(session, event) {
  session.bypassAudit = [...(session.bypassAudit || []), event].slice(-BYPASS_AUDIT_LIMIT);
}

function pruneArchiveFiles(archiveDir, maxArchives = DEFAULT_MAX_ARCHIVES) {
  if (!fs.existsSync(archiveDir)) return;
  const files = fs.readdirSync(archiveDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(archiveDir, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* keep deterministic name fallback */ }
      return { filePath, name: entry.name, mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  for (const entry of files.slice(0, Math.max(0, files.length - maxArchives))) {
    fs.unlinkSync(entry.filePath);
  }
}

function freezeRepairLoop({ archiveDir, sessionKey, session, trigger, now, thresholds, maxArchives }) {
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
  pruneArchiveFiles(archiveDir, maxArchives);
  session.status = 'frozen';
  session.frozenAt = now;
  session.freezeReason = 'repair_budget_exhausted';
  session.escalation = record.escalation;
  session.archivedAt = now;
  session.archiveFile = archiveFile;
  return { archiveFile, record };
}

function updateProgressUnlocked(payload, opts = {}) {
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
  const configuredMaxSessions = Number.parseInt(
    opts.maxSessions || process.env.PROGRESS_WATCHDOG_MAX_SESSIONS || DEFAULT_MAX_SESSIONS,
    10
  );
  const maxSessions = Number.isFinite(configuredMaxSessions)
    ? Math.max(8, configuredMaxSessions)
    : DEFAULT_MAX_SESSIONS;
  const configuredMaxArchives = Number.parseInt(
    opts.maxArchives || process.env.PROGRESS_WATCHDOG_MAX_ARCHIVES || DEFAULT_MAX_ARCHIVES,
    10
  );
  const maxArchives = Number.isFinite(configuredMaxArchives)
    ? Math.max(5, configuredMaxArchives)
    : DEFAULT_MAX_ARCHIVES;
  const mode = watchdogMode(opts);
  const state = readJson(stateFile, defaultState());
  if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};

  const cwd = cwdFor(payload);
  const sessionId = sessionIdFor(payload);
  const objectiveHash = objectiveHashFor(payload);
  const key = stableSessionKey(cwd, sessionId);
  const existingSession = state.sessions[key] || null;
  const { event } = normalizePayload(payload, opts);
  const classification = classifyEvent(payload, event);
  const scope = shouldTrackProgress(payload, {
    ...opts,
    now,
    existingSession,
    classification,
    event,
  });
  if (!scope.tracked) {
    return {
      status: 'not_tracked',
      classification: { kind: 'not_tracked', evidence: scope.reason },
      sessionKey: key,
      stateFile,
      archiveFile: existingSession?.archiveFile || null,
      session: existingSession || { status: 'untracked', noProgressTurns: 0, history: [] },
      mode,
      scope,
      thresholds: { maxNoProgressTurns, maxIdleMs },
    };
  }
  const { session } = sessionRecord(state, cwd, sessionId, objectiveHash);
  const scopeTtlMs = Number.parseInt(opts.scopeTtlMs || DEFAULT_SCOPE_TTL_MS, 10);
  session.trackingScope = {
    kind: scope.reason,
    riskLevel: scope.riskLevel || normalizeRiskLevel(opts.riskLevel),
    updatedAt: now,
    expiresAt: scope.reason === 'long_task' && Number.isFinite(scopeTtlMs) && scopeTtlMs > 0
      ? new Date(Date.parse(now) + scopeTtlMs).toISOString()
      : null,
  };
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
    writeWatchdogState(stateFile, state, maxSessions);
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
    // 冻结 = 升级要求, 不是全域断电。仍然放行:
    //   - 只读检查 (Read/Grep/... 与只读 shell 命令) —— 对齐事实需要看得见证据;
    //   - 通知/提问类工具 —— 升级本身依赖它们把卡点递到人面前;
    //   - 本看门狗与 verification-gate 的审计 reset —— 唯一的正规解冻路径。
    // 2026-07-27 事故: 旧实现无差别拦截一切 (连 AskUserQuestion/Read 都拒),
    // 与验证门禁互锁成死锁, 会话只能靠人工删状态救回。
    const frozenTool = toolName(payload);
    const frozenEvent = eventName(payload);
    const access = frozenActionAccess(payload);
    const allowed = access.allowed;
    session.lastEventAt = now;
    appendHistory(session, {
      at: now,
      event: frozenEvent || 'unknown',
      tool: frozenTool || 'unknown',
      kind: allowed ? 'frozen_allowed' : 'blocked_frozen',
      evidence: allowed
        ? `frozen but allowed (${access.evidence})`
        : `repair loop frozen: ${session.freezeReason || 'repair_budget_exhausted'}`,
      objectiveHash,
    });
    writeWatchdogState(stateFile, state, maxSessions);
    return {
      status: allowed ? 'frozen_notice' : 'frozen_escalation_required',
      classification: {
        kind: allowed ? 'frozen_allowed' : 'blocked_frozen',
        evidence: session.freezeReason || 'repair_budget_exhausted',
      },
      sessionKey: key,
      stateFile,
      archiveFile: session.archiveFile || null,
      session,
      mode,
      thresholds: { maxNoProgressTurns, maxIdleMs },
    };
  }
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
    if (session.trackingScope?.kind === 'repair_loop') {
      session.trackingScope.completedAt = now;
      session.trackingScope.expiresAt = now;
    }
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
        maxArchives,
      });
      status = 'frozen_escalation_required';
    } else {
      status = 'warning';
    }
  }

  writeWatchdogState(stateFile, state, maxSessions);
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

function inspectProgress(payload, opts = {}) {
  const stateFile = opts.stateFile || process.env.PROGRESS_WATCHDOG_STATE_FILE || DEFAULT_STATE_FILE;
  const mode = watchdogMode(opts);
  const maxNoProgressTurns = Number.parseInt(
    opts.maxNoProgressTurns || process.env.PROGRESS_WATCHDOG_MAX_NO_PROGRESS_TURNS || DEFAULT_MAX_NO_PROGRESS_TURNS,
    10,
  );
  const maxIdleMs = Number.parseInt(
    opts.maxIdleMs || process.env.PROGRESS_WATCHDOG_MAX_IDLE_MS || DEFAULT_MAX_IDLE_MS,
    10,
  );
  const state = readJson(stateFile, defaultState());
  const key = stableSessionKey(cwdFor(payload), sessionIdFor(payload));
  const existingSession = state?.sessions?.[key] || null;
  const session = existingSession || {
    status: 'active',
    noProgressTurns: 0,
    history: [],
  };
  const common = {
    sessionKey: key,
    stateFile,
    archiveFile: session.archiveFile || null,
    session,
    mode,
    thresholds: { maxNoProgressTurns, maxIdleMs },
  };
  const { event } = normalizePayload(payload, opts);
  const scope = shouldTrackProgress(payload, { ...opts, existingSession, event });
  if (!scope.tracked) {
    return {
      ...common,
      status: 'not_tracked',
      scope,
      classification: { kind: 'not_tracked', evidence: scope.reason },
    };
  }
  const bypass = bypassRequest(opts);
  if (bypass.requested) {
    if (!bypass.valid) {
      return {
        ...common,
        status: 'bypass_reason_required',
        classification: { kind: 'blocked_bypass', evidence: 'emergency bypass requires an auditable reason' },
      };
    }
    return {
      ...common,
      status: 'bypassed',
      classification: { kind: 'bypass', evidence: bypass.reason },
      bypass: {
        actor: bypass.actor,
        reason: bypass.reason,
      },
    };
  }
  if (session.status === 'frozen') {
    const access = frozenActionAccess(payload);
    return {
      ...common,
      status: access.allowed ? 'frozen_notice' : 'frozen_escalation_required',
      classification: {
        kind: access.allowed ? 'frozen_allowed' : 'blocked_frozen',
        evidence: session.freezeReason || 'repair_budget_exhausted',
      },
    };
  }
  return {
    ...common,
    status: 'active',
    classification: { kind: 'precheck', evidence: 'watchdog state permits action' },
  };
}

function updateProgress(payload, opts = {}) {
  const stateFile = opts.stateFile || process.env.PROGRESS_WATCHDOG_STATE_FILE || DEFAULT_STATE_FILE;
  return withFileLockSync(
    stateFile,
    () => updateProgressUnlocked(payload, { ...opts, stateFile }),
    {
      timeoutMs: opts.lockTimeoutMs,
      staleMs: opts.staleLockMs,
    },
  );
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
  // 审计 reset: 同时接受 `reset` 与 `--reset` (旧版只认 `reset`, 而提示文案
  // 与 verification-gate 的肌肉记忆都是 `--reset`, 导致解冻指令悄悄落进
  // 普通载荷分支)。审计要求保留: 必须携带可审计原因 (env 或 --reason),
  // 旧状态先归档再清空, reset 记录含原因与操作者。
  if (process.argv.includes('reset') || process.argv.includes('--reset')) {
    const stateFile = process.env.PROGRESS_WATCHDOG_STATE_FILE || DEFAULT_STATE_FILE;
    const archiveDir = process.env.PROGRESS_WATCHDOG_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
    const reasonIdx = process.argv.indexOf('--reason');
    const reason = String(
      (reasonIdx >= 0 && process.argv[reasonIdx + 1])
      || process.env.PROGRESS_WATCHDOG_BYPASS_REASON
      || ''
    ).trim();
    if (reason.length < MIN_BYPASS_REASON_LENGTH) {
      console.error(JSON.stringify({
        source: 'progress-watchdog',
        type: 'blocked',
        reason: `reset requires an auditable reason (>=${MIN_BYPASS_REASON_LENGTH} chars) via --reason "<why>" or PROGRESS_WATCHDOG_BYPASS_REASON`,
      }));
      process.exit(2);
    }
    const actor = String(process.env.PROGRESS_WATCHDOG_BYPASS_ACTOR || os.userInfo().username || 'operator').trim();
    const now = new Date().toISOString();
    const resetMaxArchives = Math.max(5, Number.parseInt(
      process.env.PROGRESS_WATCHDOG_MAX_ARCHIVES || DEFAULT_MAX_ARCHIVES,
      10,
    ) || DEFAULT_MAX_ARCHIVES);
    let archivedTo = null;
    withFileLockSync(stateFile, () => {
      const prior = readJson(stateFile, null);
      if (prior) {
        archivedTo = path.join(archiveDir, `reset-${now.replace(/[:.]/g, '-')}.json`);
        writeJson(archivedTo, { archivedAt: now, action: 'reset', reason, actor, priorState: prior });
        pruneArchiveFiles(archiveDir, resetMaxArchives);
      }
      const state = defaultState();
      state.bypassAudit = [{ at: now, actor, reason, action: 'reset', archivedPriorStateTo: archivedTo }];
      writeJson(stateFile, state);
    });
    console.error(JSON.stringify({ source: 'progress-watchdog', type: 'reset', stateFile, reason, actor, archivedPriorStateTo: archivedTo }));
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
  if (result.status === 'frozen_notice') {
    // 冻结中但该动作被放行 (只读/通知/审计 reset/Stop) — 仅提示, 不阻塞。
    console.error(JSON.stringify({
      source: 'progress-watchdog',
      type: 'warning',
      severity: 'medium',
      state: 'frozen',
      reason: result.session.freezeReason || 'repair_budget_exhausted',
      note: 'frozen: read-only/notification/audited-reset actions remain allowed',
      archiveFile: result.archiveFile,
    }));
    return;
  }
  if (result.status === 'frozen_escalation_required') {
    // Stop 钩子只告警不阻塞 (阻塞 Stop 会把"停下来对齐"本身变成死循环,
    // 2026-07-27 实测事故); observe 模式下冻结态也只告警。
    const blocking = result.mode === 'enforce' && eventName(payload) !== 'Stop';
    console.error(JSON.stringify({
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
    if (blocking) process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  classifyEvent,
  inspectProgress,
  isReadOnlyAction,
  objectiveHashFor,
  sessionIdFor,
  shouldTrackProgress,
  updateProgress,
  stableSessionKey,
  watchdogMode,
  DEFAULT_STATE_FILE,
  DEFAULT_ARCHIVE_DIR,
};
