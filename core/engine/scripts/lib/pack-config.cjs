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
function packsDisabled() {
  return ['1', 'true'].includes(String(process.env.HARNESS_PACKS_DISABLED || ''));
}

/** 读一份规则表；禁用/缺失/坏 JSON → null（调用方降级空规则）。 */
function loadPackConfig(name) {
  if (packsDisabled()) return null;
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

module.exports = {
  packsDisabled,
  configDir,
  loadPackConfig,
  compileRegexRules,
  compileRegexField,
};
