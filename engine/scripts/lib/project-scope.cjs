'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HARNESS_ROOT } = require('./harness-root.cjs');

const HOME = HARNESS_ROOT;

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
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
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
  payloadCwd,
  payloadFilePath,
  scopeFromPayload,
  stateScopeRoots,
  stateHasScopeForFile,
  readJson,
  atomicWriteJson,
};
