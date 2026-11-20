'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { HARNESS_ROOT } = require('./harness-root.cjs');

const HOME = HARNESS_ROOT;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_STALE_LOCK_MS = 30000;

const ROOT_MARKERS = [
  '.git',
  'AGENTS.md',
  'CLAUDE.md',
  'pyproject.toml',
  'package.json',
  'Cargo.toml',
  'go.mod',
  'Makefile',
  'makefile',
];

function expandHome(value) {
  if (!value || typeof value !== 'string') return '';
  const home = os.homedir();
  return value
    .replace(/\$HOME/g, home.replace(/\\/g, '/'))
    .replace(/%USERPROFILE%/gi, home)
    .replace(/^~(?=\/|\\|$)/, home);
}

function resolvePath(value, base = process.cwd()) {
  if (!value || typeof value !== 'string') return '';
  const expanded = expandHome(value.trim());
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(base || process.cwd(), expanded);
  return path.normalize(resolved);
}

function keyPath(value) {
  const resolved = resolvePath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(a, b) {
  if (!a || !b) return false;
  return keyPath(a) === keyPath(b);
}

function isInsidePath(child, parent) {
  if (!child || !parent) return false;
  const childKey = keyPath(child);
  const parentKey = keyPath(parent);
  return childKey === parentKey || childKey.startsWith(parentKey + path.sep);
}

function statPath(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function hasRootMarker(dir) {
  return ROOT_MARKERS.some(marker => fs.existsSync(path.join(dir, marker)));
}

function nearestExistingDir(startPath) {
  let current = resolvePath(startPath || process.cwd());
  const stat = statPath(current);
  if (stat?.isFile()) current = path.dirname(current);

  while (current && !statPath(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const currentStat = statPath(current);
  return currentStat?.isFile() ? path.dirname(current) : current;
}

function findProjectRoot(startPath = process.cwd(), opts = {}) {
  const fallback = resolvePath(opts.fallback || process.cwd());
  let dir = nearestExistingDir(startPath) || nearestExistingDir(fallback) || HOME;
  const root = path.parse(dir).root;

  while (dir && dir !== root) {
    if (hasRootMarker(dir)) return dir;
    if (isSamePath(dir, HOME)) return HOME;
    dir = path.dirname(dir);
  }

  return dir || HOME;
}

function scopeId(projectRoot) {
  return keyPath(projectRoot || HOME);
}

function memoryProjectId(projectRoot) {
  const canonicalRoot = scopeId(projectRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  return `project:${crypto.createHash('sha256').update(canonicalRoot).digest('hex')}`;
}

function payloadCwd(payload, fallback = process.cwd()) {
  return resolvePath(
    payload?.cwd ||
    payload?.tool_input?.cwd ||
    payload?.tool?.input?.cwd ||
    payload?.input?.cwd ||
    fallback,
    fallback
  );
}

function payloadFilePath(payload, cwd = payloadCwd(payload)) {
  const filePath =
    payload?.tool_input?.file_path ||
    payload?.tool?.input?.file_path ||
    payload?.input?.file_path ||
    payload?.file_path ||
    '';
  return filePath ? resolvePath(filePath, cwd) : '';
}

function scopeFromPayload(payload, opts = {}) {
  const cwd = payloadCwd(payload, opts.cwd || process.cwd());
  const filePath = payloadFilePath(payload, cwd);
  const projectRoot = findProjectRoot(filePath || cwd, { fallback: cwd });
  return {
    cwd,
    filePath,
    projectRoot,
    scopeId: scopeId(projectRoot),
  };
}

function memoryScopeFromPayload(payload, opts = {}) {
  const scope = scopeFromPayload(payload, opts);
  const filesystemRoot = path.parse(scope.projectRoot).root;
  const projectRoot = isSamePath(scope.projectRoot, filesystemRoot)
    ? scope.cwd
    : scope.projectRoot;
  const relativePath = scope.filePath && isInsidePath(scope.filePath, projectRoot)
    ? path.relative(projectRoot, scope.filePath).replace(/\\/g, '/')
    : '';
  return {
    ...scope,
    projectRoot,
    projectId: memoryProjectId(projectRoot),
    relativePath,
  };
}

function stateScopeRoots(state) {
  const roots = [];
  if (!state || typeof state !== 'object') return roots;
  if (typeof state.projectRoot === 'string') roots.push(state.projectRoot);
  if (Array.isArray(state.projectRoots)) roots.push(...state.projectRoots);
  if (state.scope && typeof state.scope.projectRoot === 'string') roots.push(state.scope.projectRoot);
  if (state.scope && Array.isArray(state.scope.projectRoots)) roots.push(...state.scope.projectRoots);
  return roots.map(root => resolvePath(root)).filter(Boolean);
}

function stateHasScopeForFile(state, filePath) {
  const roots = stateScopeRoots(state);
  if (roots.length === 0) return false;
  const resolved = resolvePath(filePath);
  return roots.some(root => isInsidePath(resolved, root));
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch { /* best-effort temporary-file cleanup */ }
  }
}

function stateHasTaskTargetForFile(state, filePath, opts = {}) {
  if (!state || Number(state.version) !== 2) return false;
  if (!String(state.taskId || '').trim()) return false;
  if (!/^[a-f0-9]{64}$/i.test(String(state.contractHash || '').trim())) return false;
  const validUntil = Date.parse(String(state.validUntil || ''));
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  if (!Number.isFinite(validUntil) || validUntil <= now) return false;
  const projectRoot = resolvePath(String(state.projectRoot || '').trim());
  const resolvedFile = resolvePath(filePath);
  const targets = Array.isArray(state.targets) ? state.targets : [];
  if (!projectRoot || !resolvedFile || !isInsidePath(resolvedFile, projectRoot) || targets.length === 0) {
    return false;
  }
  return targets.some((target) => {
    const raw = String(target || '').trim().replace(/\\/g, '/');
    if (!raw) return false;
    if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) return false;
    const recursive = raw.endsWith('/**');
    const targetValue = recursive ? raw.slice(0, -3) : raw;
    const resolvedTarget = resolvePath(targetValue, projectRoot);
    if (!isInsidePath(resolvedTarget, projectRoot) || isSamePath(resolvedTarget, projectRoot)) return false;
    return recursive
      ? isInsidePath(resolvedFile, resolvedTarget)
      : isSamePath(resolvedFile, resolvedTarget);
  });
}

function sleepSync(milliseconds) {
  Atomics.wait(LOCK_SLEEP, 0, 0, Math.max(1, milliseconds));
}

function lockToken() {
  return `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

/**
 * Run a short synchronous state transaction while holding an exclusive lock
 * next to the state file. The token check prevents an expired owner from
 * deleting a replacement lock created by another process.
 */
function withFileLockSync(filePath, operation, opts = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lockPath = opts.lockPath || `${filePath}.lock`;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs))
    ? Math.max(0, Number(opts.timeoutMs))
    : DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(Number(opts.staleMs))
    ? Math.max(timeoutMs, Number(opts.staleMs))
    : DEFAULT_STALE_LOCK_MS;
  const startedAt = Date.now();
  const token = lockToken();
  let fd;

  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      const lockExists = (() => {
        try { return fs.existsSync(lockPath); } catch { return false; }
      })();
      const contention = error.code === 'EEXIST'
        || (error.code === 'EPERM' && (process.platform === 'win32' || lockExists));
      if (!contention) throw error;
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const timeout = new Error(`Timed out waiting for state lock: ${lockPath}`);
        timeout.code = 'STATE_LOCK_TIMEOUT';
        throw timeout;
      }
      sleepSync(Math.min(25, Math.max(1, timeoutMs - (Date.now() - startedAt))));
    }
  }

  try {
    return operation();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (owner.token === token) fs.unlinkSync(lockPath);
    } catch { /* never remove a lock we cannot prove we own */ }
  }
}

function initialJsonValue(fallback) {
  if (typeof fallback === 'function') return fallback();
  if (fallback === undefined) return {};
  return structuredClone(fallback);
}

/**
 * Lock-protected read/modify/write transaction. Corrupt existing JSON fails
 * closed instead of being replaced with a default value.
 */
function updateJsonFileSync(filePath, fallback, mutator, opts = {}) {
  return withFileLockSync(filePath, () => {
    const current = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf8'))
      : initialJsonValue(fallback);
    const next = mutator(current);
    if (next === undefined) throw new TypeError('JSON state mutator must return the next value');
    atomicWriteJson(filePath, next);
    return next;
  }, opts);
}

function replaceJsonFileSync(filePath, value, opts = {}) {
  return withFileLockSync(filePath, () => {
    atomicWriteJson(filePath, value);
    return value;
  }, opts);
}

module.exports = {
  HOME,
  ROOT_MARKERS,
  expandHome,
  resolvePath,
  keyPath,
  isSamePath,
  isInsidePath,
  findProjectRoot,
  scopeId,
  memoryProjectId,
  payloadCwd,
  payloadFilePath,
  scopeFromPayload,
  memoryScopeFromPayload,
  stateScopeRoots,
  stateHasScopeForFile,
  stateHasTaskTargetForFile,
  readJson,
  atomicWriteJson,
  withFileLockSync,
  updateJsonFileSync,
  replaceJsonFileSync,
};
