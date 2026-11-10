'use strict';

/**
 * core/engine/scripts/lib/harness-state.cjs — 状态根解析（代码根 / 状态根解耦）
 *
 * 代码根 HARNESS_ROOT 是仓库（插件）目录，未来会被整体版本替换；运行时状态必须活在别处。
 * 本模块只负责“状态根在哪”，不负责创建目录——消费者自行 mkdir。
 *
 * 解析顺序见 resolveStateRoot。未迁移的机器上 STATE_ROOT === HARNESS_ROOT（legacy in-place），
 * 状态根下仍保留 var/ 与 .wright/ 两个子目录名，因此 legacy 模式下所有路径逐字节不变。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HARNESS_ROOT } = require('./harness-root.cjs');

/** 状态目录布局版本。目录里记录的版本比本常量新 → 拒绝启动。 */
const STATE_LAYOUT_VERSION = 1;
/** 状态根下的布局标记文件：{ layoutVersion, migratedFrom, migratedAt, tool } */
const STATE_MARKER = 'state.json';
/** 默认状态目录名，位于 <homedir> 下 */
const DEFAULT_STATE_DIRNAME = '.logical-paradox';

/**
 * 读取 state.json；不存在返回 null；损坏（非法 JSON / 非对象）抛错。
 * @param {string} stateRoot
 * @returns {object|null}
 */
function readStateMarker(stateRoot) {
  const markerPath = path.join(path.resolve(String(stateRoot)), STATE_MARKER);
  let raw;
  try {
    raw = fs.readFileSync(markerPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`state marker is corrupt: ${markerPath} (${e.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`state marker is corrupt: ${markerPath} (not a JSON object)`);
  }
  return parsed;
}

/** 命中的状态根若声明了更新的布局版本 → 宁可拒绝启动，也不静默丢数据。 */
function assertLayoutSupported(stateRoot) {
  const marker = readStateMarker(stateRoot);
  if (marker && Number(marker.layoutVersion) > STATE_LAYOUT_VERSION) {
    throw new Error(
      `state layout too new: ${stateRoot} declares layoutVersion ${marker.layoutVersion}, `
      + `this harness supports ${STATE_LAYOUT_VERSION}`,
    );
  }
  return marker;
}

/**
 * 解析状态根并说明命中哪一级。纯函数：不创建目录、不写文件。
 * 顺序（M2）：
 *  1. env.HARNESS_STATE_DIR 非空 → path.resolve 后返回（不校验存在性）           mode='env'
 *  2. 默认目录 <homedir>/.logical-paradox 下存在 state.json → 默认目录（已迁移） mode='migrated'
 *  3. harnessRoot 下存在 .wright 或 var → harnessRoot（legacy in-place）        mode='legacy'
 *  4. env.CLAUDE_PLUGIN_DATA 非空 → 该目录（插件安装模式，跨插件更新存活）        mode='plugin-data'
 *  5. 否则 → <homedir>/.logical-paradox（首次运行，消费者自行 mkdir）           mode='default'
 * @param {{env?: object, harnessRoot?: string, homeDir?: string}} [opts]
 * @returns {{stateRoot: string, mode: 'env'|'migrated'|'legacy'|'plugin-data'|'default'}}
 */
function resolveState(opts = {}) {
  const env = opts.env || process.env;
  const harnessRoot = path.resolve(String(opts.harnessRoot || HARNESS_ROOT));
  const homeDir = String(opts.homeDir || os.homedir());

  const override = env.HARNESS_STATE_DIR ? String(env.HARNESS_STATE_DIR).trim() : '';
  if (override) {
    const resolved = path.resolve(override);
    assertLayoutSupported(resolved);
    return { stateRoot: resolved, mode: 'env' };
  }

  const defaultRoot = path.resolve(homeDir, DEFAULT_STATE_DIRNAME);
  if (fs.existsSync(path.join(defaultRoot, STATE_MARKER))) {
    assertLayoutSupported(defaultRoot);
    return { stateRoot: defaultRoot, mode: 'migrated' };
  }

  const hasLegacyState = fs.existsSync(path.join(harnessRoot, '.wright'))
    || fs.existsSync(path.join(harnessRoot, 'var'));
  if (hasLegacyState) {
    assertLayoutSupported(harnessRoot);
    return { stateRoot: harnessRoot, mode: 'legacy' };
  }

  const pluginData = env.CLAUDE_PLUGIN_DATA ? String(env.CLAUDE_PLUGIN_DATA).trim() : '';
  if (pluginData) {
    const resolved = path.resolve(pluginData);
    assertLayoutSupported(resolved);
    return { stateRoot: resolved, mode: 'plugin-data' };
  }

  assertLayoutSupported(defaultRoot);
  return { stateRoot: defaultRoot, mode: 'default' };
}

/**
 * 解析状态根（只要路径）。纯函数，顺序见 resolveState。
 * @param {{env?: object, harnessRoot?: string, homeDir?: string}} [opts]
 * @returns {string}
 */
function resolveStateRoot(opts = {}) {
  return resolveState(opts).stateRoot;
}

const RESOLVED_STATE = resolveState();
const STATE_ROOT = RESOLVED_STATE.stateRoot;
/** 命中的解析级别：'env' | 'migrated' | 'legacy' | 'plugin-data' | 'default' */
const STATE_MODE = RESOLVED_STATE.mode;
/** legacy in-place：状态仍留在仓库目录里（未迁移的机器与所有旧克隆） */
const IS_LEGACY_IN_PLACE = STATE_ROOT === path.resolve(HARNESS_ROOT);

function statePath(...parts) {
  return path.join(STATE_ROOT, ...parts);
}

/** 取代 path.join(HARNESS_ROOT, 'var', ...) */
function varPath(...parts) {
  return statePath('var', ...parts);
}

const VAR_DIR = varPath();
/** 取代 path.join(HARNESS_ROOT, '.wright') */
const WRIGHT_DIR = statePath('.wright');

module.exports = {
  STATE_LAYOUT_VERSION,
  STATE_MARKER,
  DEFAULT_STATE_DIRNAME,
  STATE_ROOT,
  STATE_MODE,
  IS_LEGACY_IN_PLACE,
  VAR_DIR,
  WRIGHT_DIR,
  resolveState,
  resolveStateRoot,
  readStateMarker,
  statePath,
  varPath,
};
