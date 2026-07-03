'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  HOME,
  atomicWriteJson,
  findProjectRoot,
  isInsidePath,
  isSamePath,
  payloadCwd,
  payloadFilePath,
  readJson,
  resolvePath,
  scopeId,
} = require('./project-scope.cjs');

const STATE_FILE = process.env.CLAUDE_VERIFY_GATE_STATE_FILE ||
  path.join(os.homedir(), '.claude', 'var', 'verify-gate.json');

function emptyState() {
  return {
    version: 2,
    pending: {},
    edited: false,
    verified: false,
    editCount: 0,
    lastEditTime: null,
    lastVerifyTime: null,
  };
}

function normalizePendingEntry(entry, fallbackRoot = HOME) {
  const projectRoot = resolvePath(entry?.projectRoot || fallbackRoot);
  const files = Array.isArray(entry?.files)
    ? [...new Set(entry.files.map(f => resolvePath(f, projectRoot)).filter(Boolean))]
    : [];
  return {
    scopeId: scopeId(projectRoot),
    projectRoot,
    files,
    editCount: Number(entry?.editCount || 0),
    firstEditTime: entry?.firstEditTime || entry?.lastEditTime || null,
    lastEditTime: entry?.lastEditTime || null,
    lastTool: entry?.lastTool || null,
  };
}

function summarize(state) {
  const pending = {};
  for (const entry of Object.values(state.pending || {})) {
    if (!entry) continue;
    const normalized = normalizePendingEntry(entry);
    pending[normalized.scopeId] = normalized;
  }
  const pendingEntries = Object.values(pending);
  const editCount = pendingEntries.reduce((sum, entry) => sum + (entry.editCount || 0), 0);
  return {
    ...state,
    version: 2,
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

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  if (raw.version === 2 && raw.pending && typeof raw.pending === 'object') {
    return summarize(raw);
  }

  const state = emptyState();
  state.lastEditTime = raw.lastEditTime || null;
  state.lastVerifyTime = raw.lastVerifyTime || null;
  if (raw.edited) {
    const projectRoot = resolvePath(raw.projectRoot || raw.scope?.projectRoot || HOME);
    const entry = normalizePendingEntry({
      projectRoot,
      files: raw.files || [],
      editCount: raw.editCount || 1,
      firstEditTime: raw.firstEditTime || raw.lastEditTime || new Date().toISOString(),
      lastEditTime: raw.lastEditTime || new Date().toISOString(),
      lastTool: raw.lastTool || 'legacy',
    }, projectRoot);
    state.pending[entry.scopeId] = entry;
  }
  return summarize(state);
}

function readVerificationState() {
  return migrate(readJson(STATE_FILE, null));
}

function writeVerificationState(state) {
  atomicWriteJson(STATE_FILE, summarize(state));
}

function resetVerificationState() {
  writeVerificationState(emptyState());
}

function markEdited(opts = {}) {
  const cwd = resolvePath(opts.cwd || process.cwd());
  const filePath = opts.filePath ? resolvePath(opts.filePath, cwd) : '';
  const projectRoot = findProjectRoot(filePath || cwd, { fallback: cwd });
  const id = scopeId(projectRoot);
  const now = opts.now || new Date().toISOString();
  const state = readVerificationState();
  const prev = state.pending[id] || {
    scopeId: id,
    projectRoot,
    files: [],
    editCount: 0,
    firstEditTime: now,
    lastEditTime: null,
    lastTool: null,
  };
  const files = new Set(prev.files || []);
  if (filePath) files.add(filePath);
  state.pending[id] = {
    ...prev,
    projectRoot,
    files: [...files].sort(),
    editCount: (prev.editCount || 0) + 1,
    firstEditTime: prev.firstEditTime || now,
    lastEditTime: now,
    lastTool: opts.toolName || prev.lastTool || null,
  };
  writeVerificationState(state);
  return summarize(state);
}

function pendingForCwd(state, cwd = process.cwd()) {
  const resolvedCwd = resolvePath(cwd);
  const projectRoot = findProjectRoot(resolvedCwd, { fallback: resolvedCwd });
  return Object.values(summarize(state).pending).filter(entry =>
    isSamePath(entry.projectRoot, projectRoot) || isInsidePath(resolvedCwd, entry.projectRoot)
  );
}

function pendingForPayload(state, payload) {
  return pendingForCwd(state, payloadCwd(payload));
}

function markVerifiedForCwd(cwd = process.cwd(), opts = {}) {
  const state = readVerificationState();
  const pending = pendingForCwd(state, cwd);
  if (pending.length === 0) {
    writeVerificationState(state);
    return { state: summarize(state), cleared: [] };
  }

  for (const entry of pending) {
    delete state.pending[entry.scopeId];
  }
  state.lastVerifyTime = opts.now || new Date().toISOString();
  state.lastVerifyCommand = opts.command || null;
  writeVerificationState(state);
  return { state: readVerificationState(), cleared: pending };
}

function markEditedFromPayload(payload, opts = {}) {
  const cwd = payloadCwd(payload);
  const filePath = payloadFilePath(payload, cwd);
  return markEdited({
    cwd,
    filePath,
    toolName: opts.toolName,
  });
}

module.exports = {
  STATE_FILE,
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
};
