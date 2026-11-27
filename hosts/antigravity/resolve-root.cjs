'use strict';

/**
 * Shared Harness engine root resolver for the Antigravity host adapter.
 *
 * Resolution priority:
 *   1. Explicit HARNESS_ROOT environment variable
 *   2. Embedded core/engine inside the plugin directory (portable dist mode)
 *   3. Parent repository root when running directly from hosts/antigravity/
 *   4. Option A thin-link pointer (.source-root.json written by connect.cjs)
 *   5. Default ~/.claude checkout
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE_MARKER = path.join('core', 'engine', 'scripts', 'lib', 'harness-state.cjs');

function hasEngine(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, ENGINE_MARKER));
  } catch {
    return false;
  }
}

function canonicalPath(dir) {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function readSourcePointer(pluginDir) {
  try {
    const pointerPath = path.join(pluginDir, '.source-root.json');
    if (!fs.existsSync(pointerPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    if (parsed && typeof parsed.sourceRoot === 'string' && parsed.sourceRoot.trim()) {
      return canonicalPath(parsed.sourceRoot.trim());
    }
  } catch {
    // Ignore malformed pointer and fall through
  }
  return null;
}

function resolveHarnessRoot(pluginDir = __dirname) {
  if (process.env.HARNESS_ROOT && String(process.env.HARNESS_ROOT).trim()) {
    return {
      root: canonicalPath(String(process.env.HARNESS_ROOT).trim()),
      mode: 'env',
    };
  }
  if (hasEngine(pluginDir)) {
    return {
      root: canonicalPath(pluginDir),
      mode: 'portable',
    };
  }
  const repoCandidate = canonicalPath(path.resolve(pluginDir, '..', '..'));
  if (hasEngine(repoCandidate)) {
    return {
      root: repoCandidate,
      mode: 'repo',
    };
  }
  const pointer = readSourcePointer(pluginDir);
  if (pointer && hasEngine(pointer)) {
    return {
      root: pointer,
      mode: 'thin-link',
    };
  }
  return {
    root: canonicalPath(path.join(os.homedir(), '.claude')),
    mode: 'default',
  };
}

module.exports = {
  ENGINE_MARKER,
  hasEngine,
  readSourcePointer,
  resolveHarnessRoot,
};
