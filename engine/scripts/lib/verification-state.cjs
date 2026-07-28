'use strict';

const path = require('node:path');

const {
  HOME,
  findProjectRoot,
  isInsidePath,
  isSamePath,
  payloadCwd,
  payloadFilePath,
  readJson,
  replaceJsonFileSync,
  resolvePath,
  scopeId,
  updateJsonFileSync,
} = require('./project-scope.cjs');

const STATE_FILE = process.env.CLAUDE_VERIFY_GATE_STATE_FILE ||
  path.join(HOME, 'var', 'verify-gate.json');
const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function sessionIdFromPayload(payload = {}) {
  return String(
    payload?.session_id
    || payload?.sessionId
    || payload?.thread_id
    || payload?.threadId
    || ''
  ).trim();
}

function pendingTtlMs(opts = {}) {
  const value = Number.parseInt(
    opts.ttlMs ?? process.env.CLAUDE_VERIFY_GATE_TTL_MS ?? DEFAULT_PENDING_TTL_MS,
    10
  );
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PENDING_TTL_MS;
}

function pendingKey(projectRoot, sessionId = '') {
  return `${scopeId(projectRoot)}::${sessionId || 'legacy'}`;
}

function expiryFrom(entry, opts = {}) {
  const explicit = Date.parse(entry?.expiresAt || '');
  if (Number.isFinite(explicit)) return new Date(explicit).toISOString();

  const nowMs = Date.parse(opts.now || new Date().toISOString());
  const baseMs = Date.parse(entry?.lastEditTime || entry?.firstEditTime || '');
  const startMs = Number.isFinite(baseMs) ? baseMs : nowMs;
  return new Date(startMs + pendingTtlMs(opts)).toISOString();
}

function isExpired(entry, opts = {}) {
  const nowMs = Date.parse(opts.now || new Date().toISOString());
  const expiresMs = Date.parse(entry?.expiresAt || '');
  return Number.isFinite(nowMs) && Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

function emptyState() {
  return {
    version: 3,
    pending: {},
    edited: false,
    verified: false,
    editCount: 0,
    lastEditTime: null,
    lastVerifyTime: null,
  };
}

function normalizePendingEntry(entry, fallbackRoot = HOME, opts = {}) {
  const projectRoot = resolvePath(entry?.projectRoot || fallbackRoot);
  const sessionId = String(entry?.sessionId || '').trim();
  const files = Array.isArray(entry?.files)
    ? [...new Set(entry.files.map(f => resolvePath(f, projectRoot)).filter(Boolean))]
    : [];
  return {
    pendingKey: pendingKey(projectRoot, sessionId),
    scopeId: scopeId(projectRoot),
    projectRoot,
    sessionId,
    files,
    editCount: Number(entry?.editCount || 0),
    firstEditTime: entry?.firstEditTime || entry?.lastEditTime || null,
    lastEditTime: entry?.lastEditTime || null,
    lastTool: entry?.lastTool || null,
    expiresAt: expiryFrom(entry, opts),
  };
}

function summarize(state, opts = {}) {
  const pending = {};
  for (const entry of Object.values(state.pending || {})) {
    if (!entry) continue;
    const normalized = normalizePendingEntry(entry, HOME, opts);
    if (isExpired(normalized, opts)) continue;
    pending[normalized.pendingKey] = normalized;
  }
  const pendingEntries = Object.values(pending);
  const editCount = pendingEntries.reduce((sum, entry) => sum + (entry.editCount || 0), 0);
  return {
    ...state,
    version: 3,
    pending,
    edited: pendingEntries.length > 0,
    verified: pendingEntries.length === 0 && Boolean(state.lastVerifyTime),
    editCount,
    lastEditTime: pendingEntries
      .map(entry => entry.lastEditTime)
      .filter(Boolean)
      .sort()
      .at(-1) || state.lastEditTime || null,
  };
}

function migrate(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') return emptyState();
  if (raw.version >= 2 && raw.pending && typeof raw.pending === 'object') {
    return summarize(raw, opts);
  }

  const state = emptyState();
  state.lastEditTime = raw.lastEditTime || null;
  state.lastVerifyTime = raw.lastVerifyTime || null;
  if (raw.edited) {
    const projectRoot = resolvePath(raw.projectRoot || raw.scope?.projectRoot || HOME);
    const entry = normalizePendingEntry({
      projectRoot,
      sessionId: raw.sessionId || '',
      files: raw.files || [],
      editCount: raw.editCount || 1,
      firstEditTime: raw.firstEditTime || raw.lastEditTime || new Date().toISOString(),
      lastEditTime: raw.lastEditTime || new Date().toISOString(),
      lastTool: raw.lastTool || 'legacy',
    }, projectRoot, opts);
    if (!isExpired(entry, opts)) state.pending[entry.pendingKey] = entry;
  }
  return summarize(state, opts);
}

function readVerificationState(opts = {}) {
  return migrate(readJson(STATE_FILE, null), opts);
}

function writeVerificationState(state, opts = {}) {
  replaceJsonFileSync(STATE_FILE, summarize(state, opts));
}

function resetVerificationState() {
  writeVerificationState(emptyState());
}

function markEdited(opts = {}) {
  const cwd = resolvePath(opts.cwd || process.cwd());
  const filePath = opts.filePath ? resolvePath(opts.filePath, cwd) : '';
  const projectRoot = findProjectRoot(filePath || cwd, { fallback: cwd });
  const sessionId = String(opts.sessionId || '').trim();
  const id = pendingKey(projectRoot, sessionId);
  const now = opts.now || new Date().toISOString();
  const ttlMs = pendingTtlMs(opts);
  return updateJsonFileSync(STATE_FILE, emptyState, (raw) => {
    const state = migrate(raw, { ...opts, now, ttlMs });
    const prev = state.pending[id] || {
      pendingKey: id,
      scopeId: scopeId(projectRoot),
      projectRoot,
      sessionId,
      files: [],
      editCount: 0,
      firstEditTime: now,
      lastEditTime: null,
      lastTool: null,
      expiresAt: null,
    };
    const files = new Set(prev.files || []);
    if (filePath) files.add(filePath);
    state.pending[id] = {
      ...prev,
      projectRoot,
      sessionId,
      files: [...files].sort(),
      editCount: (prev.editCount || 0) + 1,
      firstEditTime: prev.firstEditTime || now,
      lastEditTime: now,
      lastTool: opts.toolName || prev.lastTool || null,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    return summarize(state, { ...opts, now, ttlMs });
  });
}

function pendingForCwd(state, cwd = process.cwd(), opts = {}) {
  const resolvedCwd = resolvePath(cwd);
  const projectRoot = findProjectRoot(resolvedCwd, { fallback: resolvedCwd });
  const sessionId = String(opts.sessionId || '').trim();
  return Object.values(summarize(state, opts).pending).filter(entry =>
    entry.sessionId === sessionId
    && (isSamePath(entry.projectRoot, projectRoot) || isInsidePath(resolvedCwd, entry.projectRoot))
  );
}

function pendingForPayload(state, payload) {
  return pendingForCwd(state, payloadCwd(payload), { sessionId: sessionIdFromPayload(payload) });
}

function markVerifiedForCwd(cwd = process.cwd(), opts = {}) {
  let cleared = [];
  const state = updateJsonFileSync(STATE_FILE, emptyState, (raw) => {
    const next = migrate(raw, opts);
    cleared = pendingForCwd(next, cwd, opts);
    for (const entry of cleared) delete next.pending[entry.pendingKey];
    if (cleared.length > 0) {
      next.lastVerifyTime = opts.now || new Date().toISOString();
      next.lastVerifyCommand = opts.command || null;
      next.lastVerifySessionId = String(opts.sessionId || '').trim() || null;
    }
    return summarize(next, opts);
  });
  return { state, cleared };
}

function markEditedFromPayload(payload, opts = {}) {
  const cwd = payloadCwd(payload);
  const filePath = payloadFilePath(payload, cwd);
  return markEdited({
    cwd,
    filePath,
    sessionId: sessionIdFromPayload(payload),
    toolName: opts.toolName,
  });
}

module.exports = {
  STATE_FILE,
  DEFAULT_PENDING_TTL_MS,
  emptyState,
  migrate,
  readVerificationState,
  writeVerificationState,
  resetVerificationState,
  markEdited,
  markEditedFromPayload,
  markVerifiedForCwd,
  pendingForCwd,
  pendingForPayload,
  pendingTtlMs,
  sessionIdFromPayload,
};
