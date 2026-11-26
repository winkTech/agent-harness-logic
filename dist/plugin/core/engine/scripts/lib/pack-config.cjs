'use strict';

/**
 * core/engine/scripts/lib/pack-config.cjs — pack 规则表加载器（Phase 2.6）
 *
 * F 内容外置后的 core 侧骨架：gate/guard 骨架留 core，域规则表
 * （FPGA 验证命令、RTL 变体模式、综合红线、仿真治理、保护路径）外置到
 * packs/fpga/config/*.json。本加载器是唯一读取点：
 *
 *   - HARNESS_PACKS_DISABLED=1（P-4 可卸性）→ 返回 null，调用方降级为空规则
 *   - 配置文件缺失/坏 JSON → fail-soft 返回 null + stderr 一次告警
 *   - 正则以 { pattern, flags } 描述，加载时编译
 *
 * core 保持"无 FPGA 字面量"：所有域词只出现在 packs/fpga/config/。
 */

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('./harness-root.cjs');

const CONFIG_DIR_CANDIDATES = [
  () => process.env.HARNESS_FPGA_CONFIG_DIR, // 显式覆盖（测试注入）
  () => path.join(HARNESS_ROOT, 'packs', 'fpga', 'config'),
];

let warned = new Set();

function configDir() {
  for (const probe of CONFIG_DIR_CANDIDATES) {
    const dir = probe();
    if (dir && fs.existsSync(dir)) return path.resolve(dir);
  }
  return null;
}

/** pack 整体禁用（P-4 可卸性烟测：core 不得依赖 packs 存在）。 */
function packsDisabled(env = process.env) {
  return ['1', 'true'].includes(String(env.HARNESS_PACKS_DISABLED || ''));
}

/** 列出仓库 packs/ 下所有可用域包名（排序稳定）。 */
function discoverAvailablePacks(root = HARNESS_ROOT) {
  const packsDir = path.join(root, 'packs');
  if (!fs.existsSync(packsDir)) return [];
  return fs.readdirSync(packsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * 解析当前启用的域包列表（支持通用裁剪：core / core,office / fpga / all）。
 *
 * 优先级：
 *   1. HARNESS_PACKS_DISABLED=1 → []（全部域包禁用，仅保留 core）
 *   2. 显式 opts.packs 或 env.HARNESS_PACKS：
 *      - 空 / 'all' / '*' → 全部已发现域包（默认，向后兼容）
 *      - 'core' / 'none'  → []（纯通用软件工程核心，不含任何域包）
 *      - 逗号分隔列表（如 'core,office' / 'office' / 'fpga,office'）→ 去重校验后返回
 *
 * @param {{ packs?: string|string[]|null, root?: string, env?: object }} [opts]
 * @returns {string[]}
 */
function resolveEnabledPacks(opts = {}) {
  const env = opts.env || process.env;
  const root = opts.root || HARNESS_ROOT;
  const available = discoverAvailablePacks(root);
  if (packsDisabled(env)) return [];

  const raw = opts.packs !== undefined && opts.packs !== null
    ? opts.packs
    : env.HARNESS_PACKS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return available;

  const tokens = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0 || tokens.includes('all') || tokens.includes('*')) return available;

  const selected = new Set();
  for (const token of tokens) {
    if (token === 'core' || token === 'none') continue;
    if (!available.includes(token)) {
      throw new Error(`Unknown pack "${token}". Available packs: core, ${available.join(', ')}, all`);
    }
    selected.add(token);
  }
  return [...selected].sort();
}

/** 检查某个域包在当前配置下是否启用。 */
function isPackEnabled(packName, opts = {}) {
  const enabled = resolveEnabledPacks(opts);
  return enabled.includes(String(packName || '').toLowerCase());
}

/** 读一份规则表；禁用/缺失/坏 JSON → null（调用方降级空规则）。 */
function loadPackConfig(name) {
  if (packsDisabled()) return null;
  try {
    if (!isPackEnabled('fpga')) return null;
  } catch {
    return null;
  }
  const dir = configDir();
  if (!dir) return null;
  const file = path.join(dir, `${name}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    if (!warned.has(name)) {
      warned.add(name);
      try {
        process.stderr.write(`[pack-config] ${name}.json 解析失败: ${e.message}\n`);
      } catch { /* 只读环境 */ }
    }
    return null;
  }
}

/** 把 { pattern, flags } 条目列表编译为 RegExp（坏条目跳过）。 */
function compileRegexRules(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry.pattern !== 'string') continue;
    try {
      out.push({
        name: entry.name,
        re: new RegExp(entry.pattern, entry.flags || ''),
        message: entry.message,
      });
    } catch { /* 坏正则跳过——规则表外置的容错边界 */ }
  }
  return out;
}

/** 单正则字段（如 triggerCommand/fpgaVerificationCommand）编译。 */
function compileRegexField(config, field) {
  if (!config || typeof config[field] !== 'string') return null;
  try {
    return new RegExp(config[field], config[`${field}Flags`] || '');
  } catch { return null; }
}

/** 解析启用域包内的引擎、工作流或资产路径；域包禁用或文件不存在时返回 null（P-4 可卸性）。 */
function resolvePackAsset(packName, ...segments) {
  if (packsDisabled()) return null;
  try {
    if (!isPackEnabled(packName)) return null;
  } catch {
    return null;
  }
  const target = path.join(HARNESS_ROOT, 'packs', String(packName || '').toLowerCase(), ...segments);
  return fs.existsSync(target) ? target : null;
}

module.exports = {
  packsDisabled,
  discoverAvailablePacks,
  resolveEnabledPacks,
  isPackEnabled,
  configDir,
  loadPackConfig,
  compileRegexRules,
  compileRegexField,
  resolvePackAsset,
};
