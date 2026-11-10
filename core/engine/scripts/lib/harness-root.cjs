'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_ROOT = path.resolve(__dirname, '..', '..', '..');

function normalizeRoot(value) {
  return value ? path.resolve(String(value)) : '';
}

function isHarnessRoot(candidate) {
  const root = normalizeRoot(candidate);
  if (!root) return false;
  return fs.existsSync(path.join(root, 'engine', 'scripts'))
    && (fs.existsSync(path.join(root, 'AGENTS.md')) || fs.existsSync(path.join(root, 'CLAUDE.md')));
}

function findHarnessRoot(startPath) {
  if (!startPath) return '';
  let current = normalizeRoot(startPath);
  try {
    if (fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  const volumeRoot = path.parse(current).root;
  while (current) {
    if (isHarnessRoot(current)) return current;
    if (current === volumeRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

function resolveHarnessRoot(opts = {}) {
  const env = opts.env || process.env;
  const explicit = normalizeRoot(opts.root || env.CLAUDE_HARNESS_ROOT);
  if (explicit) {
    if (!isHarnessRoot(explicit)) {
      throw new Error(`Invalid Harness root: ${explicit}`);
    }
    return explicit;
  }

  const discovered = findHarnessRoot(opts.startPath || process.cwd());
  if (discovered) return discovered;

  const moduleRoot = normalizeRoot(opts.moduleRoot === undefined ? MODULE_ROOT : opts.moduleRoot);
  if (isHarnessRoot(moduleRoot)) return moduleRoot;

  const installedRoot = path.join(opts.homeDir || os.homedir(), '.claude');
  if (isHarnessRoot(installedRoot)) return path.resolve(installedRoot);

  throw new Error('Unable to resolve Harness root from cwd, module location, or ~/.claude');
}

const HARNESS_ROOT = resolveHarnessRoot({ startPath: __filename });

function harnessPath(...parts) {
  return path.join(HARNESS_ROOT, ...parts);
}

function settingsFiles(root = HARNESS_ROOT) {
  return [path.join(root, 'settings.json'), path.join(root, 'settings.local.json')];
}

module.exports = {
  HARNESS_ROOT,
  MODULE_ROOT,
  findHarnessRoot,
  harnessPath,
  isHarnessRoot,
  normalizeRoot,
  resolveHarnessRoot,
  settingsFiles,
};
