'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

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
const { varPath } = require('./harness-state.cjs');

const STATE_FILE = process.env.HARNESS_VERIFY_GATE_STATE_FILE ||
  varPath('verify-gate.json');
const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const {
  canReuseEvidence,
  maxRiskLevel,
  normalizeRiskLevel,
  RISK_LEVELS,
} = require('./risk-policy.cjs');
const DEFAULT_EVIDENCE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_EVIDENCE_CACHE_MAX_ENTRIES = 100;

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
    opts.ttlMs ?? process.env.HARNESS_VERIFY_GATE_TTL_MS ?? DEFAULT_PENDING_TTL_MS,
    10
  );
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PENDING_TTL_MS;
}

function riskTtlMs(opts = {}) {
  const value = Number.parseInt(
    opts.riskTtlMs ?? opts.ttlMs
      ?? process.env.HARNESS_RISK_STATE_TTL_MS
      ?? process.env.HARNESS_VERIFY_GATE_TTL_MS
      ?? DEFAULT_PENDING_TTL_MS,
    10
  );
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PENDING_TTL_MS;
}

function evidenceCacheTtlMs(opts = {}) {
  const value = Number.parseInt(
    opts.evidenceTtlMs ?? opts.ttlMs
      ?? process.env.HARNESS_RISK_EVIDENCE_CACHE_TTL_MS
      ?? DEFAULT_EVIDENCE_CACHE_TTL_MS,
    10
  );
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_EVIDENCE_CACHE_TTL_MS;
}

function evidenceCacheMaxEntries(opts = {}) {
  const value = Number.parseInt(
    opts.maxEntries ?? process.env.HARNESS_RISK_EVIDENCE_CACHE_MAX_ENTRIES
      ?? DEFAULT_EVIDENCE_CACHE_MAX_ENTRIES,
    10,
  );
  if (!Number.isFinite(value)) return DEFAULT_EVIDENCE_CACHE_MAX_ENTRIES;
  return Math.min(10_000, Math.max(1, value));
}

function pendingKey(projectRoot, sessionId = '') {
  return `${scopeId(projectRoot)}::${sessionId || 'legacy'}`;
}

function canonicalPath(value) {
  const absolute = resolvePath(value);
  try { return fs.realpathSync.native(absolute); }
  catch (err) {
    const parent = path.dirname(absolute);
    if (parent === absolute || !['ENOENT', 'ENOTDIR'].includes(err.code)) return absolute;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

// Markerless workspaces belong to the calling directory, never the whole volume.
function declaredWorkspace(target, roots) {
  if (!Array.isArray(roots)) return null;
  return roots.filter(root => typeof root === 'string' && path.isAbsolute(root))
    .map(canonicalPath)
    .filter(root => !isSamePath(root, path.parse(root).root) && isInsidePath(target, root))
    .sort((a, b) => b.length - a.length)[0];
}

function pendingProjectRoot(cwd, filePath, roots) {
  const workspace = canonicalPath(cwd);
  const file = filePath && canonicalPath(filePath);
  const marked = findProjectRoot(file || workspace, { fallback: workspace });
  if (!isSamePath(marked, path.parse(marked).root)) return marked;
  return declaredWorkspace(file || workspace, roots) ||
    (file && !isInsidePath(file, workspace) ? path.dirname(file) : workspace);
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
    version: 4,
    pending: {},
    risk: {},
    evidenceCache: {},
    edited: false,
    verified: false,
    editCount: 0,
    lastEditTime: null,
    lastVerifyTime: null,
  };
}

function normalizePendingEntry(entry, fallbackRoot = HOME, opts = {}) {
  const storedRoot = entry?.projectRoot || fallbackRoot;
  const projectRoot = entry?.revision ? resolvePath(storedRoot) : canonicalPath(storedRoot);
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
    revision: entry?.revision || null,
    ...(entry?.inferredDirectory ? {inferredDirectory:true} : {}),
    firstEditTime: entry?.firstEditTime || entry?.lastEditTime || null,
    lastEditTime: entry?.lastEditTime || null,
    lastTool: entry?.lastTool || null,
    expiresAt: expiryFrom(entry, opts),
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].sort();
}

function riskExpiryFrom(entry, opts = {}) {
  const explicit = Date.parse(entry?.expiresAt || '');
  if (Number.isFinite(explicit)) return new Date(explicit).toISOString();
  const nowMs = Date.parse(opts.now || new Date().toISOString());
  const baseMs = Date.parse(entry?.lastUpdatedAt || entry?.escalatedAt || '');
  const startMs = Number.isFinite(baseMs) ? baseMs : nowMs;
  return new Date(startMs + riskTtlMs(opts)).toISOString();
}

function normalizeRiskEntry(entry, fallbackRoot = HOME, opts = {}) {
  const projectRoot = canonicalPath(entry?.projectRoot || fallbackRoot);
  const sessionId = String(entry?.sessionId || '').trim();
  const minimumRiskLevel = normalizeRiskLevel(entry?.minimumRiskLevel);
  const effectiveRiskLevel = maxRiskLevel(minimumRiskLevel, entry?.effectiveRiskLevel);
  const verificationStatus = ['pending', 'failed', 'unavailable'].includes(entry?.verificationStatus)
    ? entry.verificationStatus
    : 'pending';
  return {
    riskKey: pendingKey(projectRoot, sessionId),
    scopeId: scopeId(projectRoot),
    projectRoot,
    sessionId,
    minimumRiskLevel,
    effectiveRiskLevel,
    riskReasons: normalizeStringArray(entry?.riskReasons),
    targets: normalizeStringArray(entry?.targets)
      .map(target => canonicalPath(resolvePath(target, projectRoot)))
      .filter(target => isInsidePath(target, projectRoot)),
    requiredEvidence: normalizeStringArray(entry?.requiredEvidence),
    contractHash: String(entry?.contractHash || '').trim() || null,
    evidenceKey: String(entry?.evidenceKey || '').trim() || null,
    verificationStatus,
    verificationReason: String(entry?.verificationReason || '').trim().slice(0, 500) || null,
    verificationAt: entry?.verificationAt || null,
    escalatedAt: entry?.escalatedAt || entry?.lastUpdatedAt || null,
    lastUpdatedAt: entry?.lastUpdatedAt || entry?.escalatedAt || null,
    expiresAt: riskExpiryFrom(entry, opts),
  };
}

function normalizeEvidenceEntry(entry, fallbackRoot = HOME, opts = {}) {
  const projectRoot = canonicalPath(entry?.projectRoot || fallbackRoot);
  const verifiedAt = entry?.verifiedAt || entry?.recordedAt || opts.now || new Date().toISOString();
  const explicitExpiry = Date.parse(entry?.expiresAt || '');
  const expiresAt = Number.isFinite(explicitExpiry)
    ? new Date(explicitExpiry).toISOString()
    : new Date(Date.parse(verifiedAt) + evidenceCacheTtlMs(opts)).toISOString();
  return {
    status: entry?.status === 'pass' ? 'pass' : 'invalid',
    evidenceKey: String(entry?.evidenceKey || '').trim().toLowerCase(),
    contentHash: String(entry?.contentHash || '').trim().toLowerCase(),
    projectRoot,
    riskLevel: normalizeRiskLevel(entry?.riskLevel),
    command: String(entry?.command || '').trim().replace(/\s+/g, ' '),
    inputs: entry?.inputs && typeof entry.inputs === 'object' ? entry.inputs : {},
    verifiedAt,
    expiresAt,
  };
}

function summarize(state, opts = {}) {
  const pending = {};
  for (const entry of Object.values(state.pending || {})) {
    if (!entry) continue;
    const normalized = normalizePendingEntry(entry, HOME, opts);
    if (isExpired(normalized, opts)) continue;
    // Older markerless edits could share a single volume-root entry, even for
    // sibling projects. Recover each file's scope before exposing it to peers.
    if (isSamePath(normalized.projectRoot, path.parse(normalized.projectRoot).root) && normalized.files.length) {
      const groups = new Map();
      for (const file of normalized.files) {
        const root = pendingProjectRoot(path.dirname(file), file);
        const key = scopeId(root);
        if (!groups.has(key)) groups.set(key, {root, files:[]});
        groups.get(key).files.push(file);
      }
      let extra = Math.max(0, normalized.editCount - normalized.files.length);
      for (const [scope, {root, files}] of groups) {
        const key = pendingKey(root, normalized.sessionId);
        const inferredDirectory = isSamePath(findProjectRoot(root), path.parse(root).root);
        const migrated = {...normalized, projectRoot:root, scopeId:scope, pendingKey:key, files,
          inferredDirectory, editCount:files.length + extra};
        extra = 0;
        addPending(pending, migrated);
      }
    } else {
      addPending(pending, normalized);
    }
  }
  const pendingEntries = Object.values(pending);
  const risk = {};
  for (const entry of Object.values(state.risk || {})) {
    if (!entry) continue;
    const normalized = normalizeRiskEntry(entry, HOME, opts);
    if (isExpired(normalized, opts) || normalized.effectiveRiskLevel === 'R0') continue;
    risk[normalized.riskKey] = normalized;
  }
  const evidenceCache = {};
  for (const entry of Object.values(state.evidenceCache || {})) {
    if (!entry) continue;
    const normalized = normalizeEvidenceEntry(entry, HOME, opts);
    if (normalized.status !== 'pass'
        || !/^[a-f0-9]{64}$/.test(normalized.evidenceKey)
        || isExpired(normalized, opts)) continue;
    evidenceCache[normalized.evidenceKey] = normalized;
  }
  const editCount = pendingEntries.reduce((sum, entry) => sum + (entry.editCount || 0), 0);
  return {
    ...state,
    version: 4,
    pending,
    risk,
    evidenceCache,
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

function addPending(pending, entry) {
  const prior = pending[entry.pendingKey];
  if (!prior) { pending[entry.pendingKey] = entry; return; }
  const latest = prior.lastEditTime > entry.lastEditTime ? prior : entry;
  pending[entry.pendingKey] = {...latest, files:[...new Set([...prior.files, ...entry.files])].sort(),
    editCount:prior.editCount + entry.editCount, expiresAt:[prior.expiresAt, entry.expiresAt].sort().at(-1)};
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
  if (opts.strict) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!record(raw) || (raw.version >= 2
      ? !record(raw.pending) || !Object.values(raw.pending).every(record)
      : typeof raw.edited !== 'boolean')) throw new Error('Invalid verification state.');
    return migrate(raw, opts);
  }
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
  const projectRoot = pendingProjectRoot(cwd, filePath, opts.workspacePaths);
  const sessionId = String(opts.sessionId || '').trim();
  const id = pendingKey(projectRoot, sessionId);
  const ttlMs = pendingTtlMs(opts);
  return updateJsonFileSync(STATE_FILE, emptyState, (raw) => {
    const now = opts.now || new Date().toISOString();
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
      revision: randomUUID(),
      firstEditTime: prev.firstEditTime || now,
      lastEditTime: now,
      lastTool: opts.toolName || prev.lastTool || null,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    };
    return summarize(state, { ...opts, now, ttlMs });
  });
}

function markRisk(opts = {}) {
  const assessment = opts.assessment || {};
  const minimumRiskLevel = normalizeRiskLevel(assessment.minimumRiskLevel);
  const effectiveRiskLevel = maxRiskLevel(minimumRiskLevel, assessment.effectiveRiskLevel);
  if (effectiveRiskLevel === 'R0') return readVerificationState(opts);

  const cwd = canonicalPath(opts.cwd || process.cwd());
  const filePath = opts.filePath ? canonicalPath(resolvePath(opts.filePath, cwd)) : '';
  const projectRoot = pendingProjectRoot(cwd, filePath, opts.workspacePaths);
  const sessionId = String(opts.sessionId || '').trim();
  const id = pendingKey(projectRoot, sessionId);
  const now = opts.now || new Date().toISOString();
  const ttlMs = riskTtlMs(opts);
  return updateJsonFileSync(STATE_FILE, emptyState, (raw) => {
    const state = migrate(raw, { ...opts, now, riskTtlMs: ttlMs });
    const prev = state.risk[id] || normalizeRiskEntry({
      projectRoot,
      sessionId,
      minimumRiskLevel: 'R0',
      effectiveRiskLevel: 'R0',
      escalatedAt: now,
      lastUpdatedAt: now,
    }, projectRoot, { ...opts, now, riskTtlMs: ttlMs });
    const nextMinimum = maxRiskLevel(prev.minimumRiskLevel, minimumRiskLevel);
    const nextEffective = maxRiskLevel(prev.effectiveRiskLevel, effectiveRiskLevel, nextMinimum);
    const targets = new Set(prev.targets || []);
    if (filePath && isInsidePath(filePath, projectRoot)) targets.add(filePath);
    for (const target of assessment.targets || []) {
      const resolved = canonicalPath(resolvePath(target, projectRoot));
      if (isInsidePath(resolved, projectRoot)) targets.add(resolved);
    }
    const escalated = RISK_LEVELS.indexOf(nextEffective) > RISK_LEVELS.indexOf(prev.effectiveRiskLevel);
    state.risk[id] = normalizeRiskEntry({
      ...prev,
      projectRoot,
      sessionId,
      minimumRiskLevel: nextMinimum,
      effectiveRiskLevel: nextEffective,
      riskReasons: [...(prev.riskReasons || []), ...(assessment.riskReasons || [])],
      targets: [...targets],
      requiredEvidence: [...(prev.requiredEvidence || []), ...(assessment.requiredEvidence || [])],
      contractHash: assessment.contractHash || prev.contractHash,
      evidenceKey: assessment.evidenceKey || prev.evidenceKey,
      verificationStatus: 'pending',
      verificationReason: null,
      verificationAt: null,
      escalatedAt: escalated ? now : prev.escalatedAt || now,
      lastUpdatedAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    }, projectRoot, { ...opts, now, riskTtlMs: ttlMs });
    return summarize(state, { ...opts, now, riskTtlMs: ttlMs });
  });
}

function pendingForCwd(state, cwd = process.cwd(), opts = {}) {
  const pending = Object.values(summarize(state, opts).pending);
  if (pending.length === 0) return pending;
  const resolvedCwd = canonicalPath(cwd);
  const workspace = declaredWorkspace(resolvedCwd, opts.workspacePaths) || resolvedCwd;
  if (!pending.some(entry => isInsidePath(resolvedCwd, entry.projectRoot) ||
      (entry.inferredDirectory && isInsidePath(entry.projectRoot, workspace)) ||
      isSamePath(entry.projectRoot, path.parse(resolvedCwd).root))) return [];
  const projectRoot = findProjectRoot(resolvedCwd, { fallback: resolvedCwd });
  const markerless = isSamePath(projectRoot, path.parse(projectRoot).root);
  return pending.filter(entry => {
    // Old fileless volume receipts carry no project information.
    if (isSamePath(entry.projectRoot, path.parse(entry.projectRoot).root)) {
      return markerless && isSamePath(entry.projectRoot, projectRoot) && entry.sessionId === (opts.sessionId || '');
    }
    if (!markerless) return isSamePath(entry.projectRoot, projectRoot);
    return isInsidePath(resolvedCwd, entry.projectRoot) ||
      (entry.inferredDirectory && isInsidePath(entry.projectRoot, workspace));
  });
}

function pendingForPayload(state, payload) {
  return pendingForCwd(state, payloadCwd(payload), { sessionId: sessionIdFromPayload(payload), workspacePaths:payload.workspacePaths });
}

function riskForCwd(state, cwd = process.cwd(), opts = {}) {
  const resolvedCwd = canonicalPath(cwd);
  const marked = findProjectRoot(resolvedCwd, { fallback: resolvedCwd });
  const markerless = isSamePath(marked, path.parse(marked).root);
  const root = markerless ? (declaredWorkspace(resolvedCwd, opts.workspacePaths) || resolvedCwd) : marked;
  const sessionId = String(opts.sessionId || '').trim();
  return Object.values(summarize(state, opts).risk || {}).filter(entry => {
    if (entry.sessionId !== sessionId) return false;
    if (isSamePath(entry.projectRoot, path.parse(entry.projectRoot).root)) {
      // Legacy markerless records with no target can only be handed back to
      // the owning session. Evidence from an unrelated project cannot clear them.
      return isSamePath(resolvedCwd, entry.projectRoot);
    }
    return isSamePath(entry.projectRoot, root) || (markerless && isInsidePath(resolvedCwd, entry.projectRoot));
  });
}

function riskForPayload(state, payload, opts = {}) {
  return riskForCwd(state, payloadCwd(payload), {
    ...opts,
    sessionId: sessionIdFromPayload(payload),
    workspacePaths:payload.workspacePaths,
  });
}

function markRiskVerifiedForCwd(cwd = process.cwd(), opts = {}) {
  const evidenceRiskLevel = normalizeRiskLevel(opts.evidenceRiskLevel);
  let cleared = [];
  let remaining = [];
  const state = updateJsonFileSync(STATE_FILE, emptyState, (raw) => {
    const next = migrate(raw, opts);
    const active = riskForCwd(next, cwd, opts);
    for (const entry of active) {
      if (RISK_LEVELS.indexOf(evidenceRiskLevel) >= RISK_LEVELS.indexOf(entry.effectiveRiskLevel)) {
        cleared.push(entry);
        delete next.risk[entry.riskKey];
      } else {
        remaining.push(entry);
      }
    }
    return summarize(next, opts);
  });
  return { state, cleared, remaining };
}

function markRiskVerificationStatusForCwd(cwd = process.cwd(), opts = {}) {
  const status = String(opts.status || '').trim().toLowerCase();
  if (!['pending', 'failed', 'unavailable'].includes(status)) {
    throw new TypeError('risk verification status must be pending, failed, or unavailable');
  }
  const reason = String(opts.reason || '').trim().slice(0, 500) || null;
  const now = opts.now || new Date().toISOString();
  let updated = [];
  const state = updateJsonFileSync(STATE_FILE, emptyState, (raw) => {
    const next = migrate(raw, { ...opts, now });
    for (const entry of riskForCwd(next, cwd, { ...opts, now })) {
      const changed = normalizeRiskEntry({
        ...entry,
        verificationStatus: status,
        verificationReason: reason,
        verificationAt: now,
        lastUpdatedAt: now,
      }, entry.projectRoot, { ...opts, now });
      next.risk[entry.riskKey] = changed;
      updated.push(changed);
    }
    return summarize(next, { ...opts, now });
  });
  return { state, updated };
}

function recordRiskEvidence(opts = {}) {
  const riskLevel = normalizeRiskLevel(opts.riskLevel);
  const evidenceKey = String(opts.evidenceKey || '').trim().toLowerCase();
  if (riskLevel === 'R3') return { recorded: false, reason: 'r3-requires-fresh-evidence' };
  if (!/^[a-f0-9]{64}$/.test(evidenceKey)) {
    return { recorded: false, reason: 'invalid-evidence-key' };
  }
  const projectRoot = canonicalPath(opts.projectRoot || process.cwd());
  const now = opts.now || new Date().toISOString();
  const ttlMs = evidenceCacheTtlMs(opts);
  const maxEntries = evidenceCacheMaxEntries(opts);
  const state = updateJsonFileSync(STATE_FILE, emptyState, (raw) => {
    const next = migrate(raw, { ...opts, now, evidenceTtlMs: ttlMs });
    next.evidenceCache[evidenceKey] = normalizeEvidenceEntry({
      status: 'pass',
      evidenceKey,
      contentHash: opts.contentHash,
      projectRoot,
      riskLevel,
      command: opts.command,
      inputs: opts.inputs,
      verifiedAt: now,
      expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    }, projectRoot, { ...opts, now, evidenceTtlMs: ttlMs });
    next.evidenceCache = Object.fromEntries(
      Object.entries(next.evidenceCache)
        .sort((a, b) => {
          const bAt = Date.parse(b[1]?.verifiedAt || '') || 0;
          const aAt = Date.parse(a[1]?.verifiedAt || '') || 0;
          return bAt - aAt || a[0].localeCompare(b[0]);
        })
        .slice(0, maxEntries),
    );
    return summarize(next, { ...opts, now, evidenceTtlMs: ttlMs });
  });
  return { recorded: true, entry: state.evidenceCache[evidenceKey], state };
}

function findReusableRiskEvidence(state, opts = {}) {
  const projectRoot = canonicalPath(opts.projectRoot || process.cwd());
  const request = {
    evidenceKey: String(opts.evidenceKey || '').trim().toLowerCase(),
    riskLevel: normalizeRiskLevel(opts.riskLevel),
    now: opts.now,
  };
  if (request.riskLevel === 'R3') return null;
  const summarized = summarize(state, opts);
  const entry = summarized.evidenceCache?.[request.evidenceKey];
  if (!entry || !isSamePath(entry.projectRoot, projectRoot)) return null;
  return canReuseEvidence(entry, request) ? entry : null;
}

function verificationRunKey(payload, command) {
  return JSON.stringify([canonicalPath(payloadCwd(payload)), sessionIdFromPayload(payload), payload.tool_use_id || '', command]);
}

function startVerification(payload, command) {
  const key = verificationRunKey(payload, command);
  const now = Date.now();
  updateJsonFileSync(STATE_FILE, emptyState, raw => {
    const next = migrate(raw);
    const starts = Object.entries(next.testStarts || {}).filter(([, value]) => now - value.time < pendingTtlMs({}));
    next.testStarts = Object.fromEntries(starts.slice(-255));
    const previous = next.testStarts[key];
    const pending = pendingForPayload(next, payload);
    const edits = Object.fromEntries(pending.map(entry => [entry.pendingKey, [entry.lastEditTime, entry.editCount, entry.revision]]));
    next.testStarts[key] = previous
      ? { ...previous, count: previous.count + 1 }
      : { time: now, count: 1, edits };
    return next;
  });
}

function markVerifiedForCwd(cwd = process.cwd(), opts = {}) {
  let cleared = [];
  const state = updateJsonFileSync(STATE_FILE, emptyState, (raw) => {
    const next = migrate(raw, opts);
    const started = next.testStarts?.[opts.runKey];
    if (started && --started.count === 0) delete next.testStarts[opts.runKey];
    cleared = opts.passed === false ? [] : pendingForCwd(next, cwd, opts).filter(entry => {
      if (started) {
        const edit = started.edits?.[entry.pendingKey];
        if (!edit || edit[0] !== entry.lastEditTime || edit[1] !== entry.editCount ||
            (entry.revision && edit[2] !== entry.revision)) return false;
      }
      if (Number.isFinite(opts.startedAtMs)) return Date.parse(entry.lastEditTime) < opts.startedAtMs;
      // Legacy post-only events without timing can settle only their own edits.
      return Boolean(started) || (!opts.correlated && entry.sessionId === (opts.sessionId || ''));
    });
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
    workspacePaths:payload.workspacePaths,
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
  pendingProjectRoot,
  markEditedFromPayload,
  startVerification,
  verificationRunKey,
  markVerifiedForCwd,
  pendingForCwd,
  pendingForPayload,
  markRisk,
  markRiskVerifiedForCwd,
  markRiskVerificationStatusForCwd,
  recordRiskEvidence,
  findReusableRiskEvidence,
  riskForCwd,
  riskForPayload,
  pendingTtlMs,
  riskTtlMs,
  evidenceCacheTtlMs,
  evidenceCacheMaxEntries,
  sessionIdFromPayload,
};
