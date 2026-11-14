/**
 * core/engine/config.cjs — 核心路径配置（Phase 1.4 引用显式化）。
 *
 * 领域资产对 core 只是可注入的路径参数：知识库位置不再散落硬编码，
 * 统一由 kbPath() 解析——KB_PATH env 显式指定（CI / 评测沙箱 / 旧布局逃生），
 * 默认 <root>/packs/fpga/engineering-assets/knowledge（FPGA pack 真源）。
 */
'use strict';

const path = require('node:path');
const { HARNESS_ROOT } = require('./scripts/lib/harness-root.cjs');

function kbPath(root) {
  const explicit = process.env.KB_PATH;
  if (explicit) return path.resolve(explicit);
  return path.join(root || HARNESS_ROOT, 'packs', 'fpga', 'engineering-assets', 'knowledge');
}

module.exports = { kbPath, HARNESS_ROOT };
