'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Phase 1.2（refactor/core-split）：拆层后本模块位于 core/engine/scripts/lib/，
// 仓库根 = 上溯 4 级（原 engine/scripts/lib/ 布局时代为 3 级）。
const MODULE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// package.json 锚点的 name 字段值。核心根判定不再依赖根级 CLAUDE.md/AGENTS.md
// ——Phase 1.1 起它们是未跟踪的渲染产物，全新 clone 上不存在。
const ANCHOR_PACKAGE_NAME = 'harness';

function normalizeRoot(value) {
  return value ? path.resolve(String(value)) : '';
}

function readPackageName(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof pkg.name === 'string' ? pkg.name : '';
  } catch {
    return '';
  }
}

/**
 * package.json 锚点（Phase 1.2 起的主判定）：目录含 name="harness" 的
 * package.json 即仓库根。仓库可被 clone 到任意路径、任意目录名。
 */
function hasHarnessAnchor(candidate) {
  const root = normalizeRoot(candidate);
  if (!root) return false;
  return readPackageName(root) === ANCHOR_PACKAGE_NAME;
}

/**
 * 旧布局目录标记（兼容回退，Phase 1.2 起降级）：
 * engine/scripts + 根级 AGENTS.md/CLAUDE.md。仅服务拆层前的检出、
 * robocopy 快照逃生等旧布局目录（CLAUDE_HARNESS_ROOT 指向旧布局时仍可命中）。
 */
function isLegacyHarnessRoot(candidate) {
  const root = normalizeRoot(candidate);
  if (!root) return false;
  return fs.existsSync(path.join(root, 'engine', 'scripts'))
    && (fs.existsSync(path.join(root, 'AGENTS.md')) || fs.existsSync(path.join(root, 'CLAUDE.md')));
}

/**
 * 根有效性总判定：package.json 锚点 或 旧布局目录标记。
 * 显式指定（env/opts.root）的合法性校验走这里。
 */
function isHarnessRoot(candidate) {
  return hasHarnessAnchor(candidate) || isLegacyHarnessRoot(candidate);
}

function walkUp(startPath, accept) {
  if (!startPath) return '';
  let current = normalizeRoot(startPath);
  try {
    if (fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  const volumeRoot = path.parse(current).root;
  while (current) {
    if (accept(current)) return current;
    if (current === volumeRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

/**
 * package.json 锚点向上发现（cwd 向上发现的第一优先级）。
 */
function findAnchorRoot(startPath) {
  return walkUp(startPath, hasHarnessAnchor);
}

/**
 * 旧布局目录标记向上发现（兼容回退）。
 */
function findHarnessRoot(startPath) {
  return walkUp(startPath, isLegacyHarnessRoot);
}

/**
 * Phase 1.2 解析顺序：
 *   1. HARNESS_ROOT env（主）／CLAUDE_HARNESS_ROOT（兼容别名）／opts.root —— 校验后生效；
 *   2. package.json 锚点向上发现（自 startPath/cwd）；
 *   3. cwd 向上发现（旧布局目录标记，兼容回退）；
 *   4. 模块位置兜底（本文件上溯 4 级）；
 *   5. ~/.claude 安装位兜底（兼容保留）。
 */
function resolveHarnessRoot(opts = {}) {
  const env = opts.env || process.env;
  const explicit = normalizeRoot(opts.root || env.HARNESS_ROOT || env.CLAUDE_HARNESS_ROOT);
  if (explicit) {
    if (!isHarnessRoot(explicit)) {
      throw new Error(`Invalid Harness root: ${explicit}`);
    }
    return explicit;
  }

  const start = opts.startPath || process.cwd();
  const anchored = findAnchorRoot(start);
  if (anchored) return anchored;

  const discovered = findHarnessRoot(start);
  if (discovered) return discovered;

  const moduleRoot = normalizeRoot(opts.moduleRoot === undefined ? MODULE_ROOT : opts.moduleRoot);
  if (isHarnessRoot(moduleRoot)) return moduleRoot;

  const installedRoot = path.join(opts.homeDir || os.homedir(), '.claude');
  if (isHarnessRoot(installedRoot)) return path.resolve(installedRoot);

  throw new Error('Unable to resolve Harness root from env, package.json anchor, cwd discovery, module location, or ~/.claude');
}

const HARNESS_ROOT = resolveHarnessRoot({ startPath: __filename });

function harnessPath(...parts) {
  return path.join(HARNESS_ROOT, ...parts);
}

function settingsFiles(root = HARNESS_ROOT) {
  return [path.join(root, 'settings.json'), path.join(root, 'settings.local.json')];
}

module.exports = {
  ANCHOR_PACKAGE_NAME,
  HARNESS_ROOT,
  MODULE_ROOT,
  findAnchorRoot,
  findHarnessRoot,
  hasHarnessAnchor,
  harnessPath,
  isHarnessRoot,
  isLegacyHarnessRoot,
  normalizeRoot,
  resolveHarnessRoot,
  settingsFiles,
};
