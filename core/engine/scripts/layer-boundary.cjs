#!/usr/bin/env node
/**
 * core/engine/scripts/layer-boundary.cjs — §3.3 分层依赖执法器（Phase 1.6）。
 *
 * 分层从"约定"变成"机器执法"：任何人往 core 塞宿主/领域引用，CI 当场红。
 *
 * 三项检查（均基于源码文本扫描，不执行代码）：
 *   ① require 方向（零豁免）：core/** 的 .cjs 不得 require packs/ 或 hosts/
 *      下的模块。§3.3：core 禁止 import packs/hosts。
 *   ② 路径字面量方向：core/** 中出现 pack/host 路径字面量（packs/fpga、
 *      'packs'、hosts/claude-code 等）仅允许出现在 SANCTIONED_DISTRIBUTION
 *      分发/配置面——每一条注明方案出处（§3.5 / §6.1.4 / §4.2）。
 *   ③ 宿主拓扑耦合：core/** 中出现宿主拓扑词（.claude/settings、.codex、
 *      ~/.agents、statusLine）仅允许出现在 SANCTIONED_ENTRY_SHELL 入口壳面
 *      （§2.1：耦合面在入口壳，不在核心）。
 *
 * 白名单铁律（方案 1.6"挂载时白名单非空即 fail"的实现口径）：
 *   本检查器**不提供**可编辑的豁免文件——core/engine/scripts/layer-boundary.json
 *   若存在且非空即 fail。合法新增场景的正确路径是修改本文件的两个 SANCTIONED
 *   常量并附方案条目出处（走 code review），而不是加豁免。Phase 2 host-concepts/
 *      io/ 落地后，③的入口壳面收敛为 host-concepts/io/config 三处（方案原文），
 *      届时 SANCTIONED_ENTRY_SHELL 缩小、违规自然暴露——这是 Phase 2 的工作。
 *
 * 用法：
 *   node core/engine/scripts/layer-boundary.cjs          # 扫描并打印违规
 *   node core/engine/scripts/layer-boundary.cjs --check  # 违规非零则 exit 1
 *
 * 退出码：0 无违规；1 存在违规或豁免文件；2 扫描自身错误。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

/** 分发/配置面：core 中允许出现 pack/host 路径字面量的文件（相对 core/engine/）。 */
const SANCTIONED_DISTRIBUTION = new Set([
  // 检查器自身（文档化面——规则与出处说明本身包含被检词）
  'scripts/layer-boundary.cjs',
  // KB 统计数据面（datasheets 计数读 pack references）
  'scripts/kb-stats.cjs',
  // §6.1.4：KB_PATH 注入点（默认解析 pack 内知识库）
  'config.cjs',
  // §6.1.4：rule-loader 双根扫描（core/rules + packs/fpga/rules）
  'scripts/rule-loader.cjs',
  // §3.5：技能/规则单一真源同步器与渲染器
  'scripts/sync-skills.cjs',
  'scripts/sync-pack-skills.cjs',
  'scripts/render-hook-settings.cjs',
  // §4.2：P 系列 bench 采集器（跑 pack 工具是其职责）
  'scripts/bench-refactor.cjs',
  // 注册表数据面：registrations/manifest 真源在 hosts/claude-code/
  'scripts/lib/hook-latency.cjs',
  // pack 模板 QA（检查 pack 内模板规范头）
  'scripts/lib/check-templates.cjs',
  // prompt 内容：指向 KB 目录的提示性文本（非代码依赖）
  'scripts/agent-context-budget.cjs',
]);

/** 入口壳面：core 中允许出现宿主拓扑词的文件（§2.1 耦合面在入口壳）。 */
const SANCTIONED_ENTRY_SHELL = new Set([
  'scripts/layer-boundary.cjs',
  // settings/settings.local 读取与根解析（宿主注册入口壳）
  'scripts/lib/harness-root.cjs',
  'scripts/lib/hook-registry.cjs',
  'scripts/lib/hook-health.cjs',
  'scripts/lib/plugin-mode.cjs',
  // 渲染器/同步器（宿主产物面）
  'scripts/render-hook-settings.cjs',
  'scripts/sync-skills.cjs',
  'scripts/sync-pack-skills.cjs',
  // CI 总门禁（读 settings 与宿主注册做核对）
  'scripts/harness-ci.cjs',
  'scripts/diagnostics.cjs',
  // 插件宿主集成（plugin root / cache 探测）
  'scripts/hooks/plugin-session-context.cjs',
  'scripts/ecc-root-resolver.cjs',
]);

const PACK_PATH_PATTERNS = [
  /packs\/(fpga|office)/,
  /packs\\(fpga|office)/,
  /['"]packs['"]\s*,/,
  /hosts\/(claude-code|codex|grok)/,
  /hosts\\(claude-code|codex|grok)/,
  /['"]hosts['"]\s*,/,
];
const HOST_TOPOLOGY_PATTERNS = [
  /\.claude[\\/](settings|hooks)/,
  /\.codex[\\/]/,
  [/~/, /\.agents[\\/]/][1],
  /\.agents[\\/]/,
  /statusLine/i,
];
const REQUIRE_PACK_PATTERNS = [
  /require(s*['"][^'"]*packs[\/](fpga|office)[\/][^'"]*['"]s*)/,
  /require(s*['"][^'"]*hosts[\/](claude-code|codex|grok)[\/][^'"]*['"]s*)/,
];

function walkCjs(dir, acc = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === '.git' || name === 'node_modules' || name === 'test-hooks') continue; // 验证面：测试有权知道全部层
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkCjs(p, acc);
    else if (name.endsWith('.cjs') && !name.includes('.test.')) acc.push(p);
  }
  return acc;
}

function relToEngine(file) {
  return path.relative(path.join(HARNESS_ROOT, 'core', 'engine'), file).replace(/\\/g, '/');
}

function violationsOf(files, patterns, sanctioned) {
  const violations = [];
  for (const file of files) {
    if (sanctioned.has(relToEngine(file))) continue;
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          violations.push(`${relToEngine(file)}:${i + 1}  ${pattern.source}  |  ${line.trim().slice(0, 100)}`);
          break;
        }
      }
    });
  }
  return violations;
}

function checkWhitelistFile() {
  const file = path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'layer-boundary.json');
  if (fs.existsSync(file)) {
    let entries = 1;
    try { entries = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).length; } catch { /* 非法 JSON 视为非空 */ }
    if (entries > 0) return [`豁免文件 layer-boundary.json 存在且非空（${entries} 条）——挂载时白名单必须为空`];
  }
  return [];
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const coreFiles = walkCjs(path.join(HARNESS_ROOT, 'core'));

  const requireViolations = [];
  for (const file of coreFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of REQUIRE_PACK_PATTERNS) {
      const m = source.match(new RegExp(pattern.source, 'g'));
      if (m) requireViolations.push(`${relToEngine(file)}  ${m[0].slice(0, 80)}`);
    }
  }
  const stringViolations = violationsOf(coreFiles, PACK_PATH_PATTERNS, SANCTIONED_DISTRIBUTION);
  const topologyViolations = violationsOf(coreFiles, HOST_TOPOLOGY_PATTERNS, SANCTIONED_ENTRY_SHELL);
  const whitelistViolations = checkWhitelistFile();

  const all = [
    ...whitelistViolations.map((v) => `[白名单] ${v}`),
    ...requireViolations.map((v) => `[①require方向] ${v}`),
    ...stringViolations.map((v) => `[②路径字面量] ${v}`),
    ...topologyViolations.map((v) => `[③宿主拓扑] ${v}`),
  ];

  if (all.length) {
    for (const v of all) process.stdout.write(`[layer-boundary] ✖ ${v}\n`);
    process.stdout.write(`[layer-boundary] 共 ${all.length} 处违规（①${requireViolations.length} ②${stringViolations.length} ③${topologyViolations.length} 白名单${whitelistViolations.length}）\n`);
    if (checkOnly) return 1;
    return 1;
  }
  process.stdout.write(`[layer-boundary] ✓ violations=0（①require ②字面量[${SANCTIONED_DISTRIBUTION.size} 文件面] ③拓扑[${SANCTIONED_ENTRY_SHELL.size} 文件面] 白名单空；扫描 ${coreFiles.length} 文件）\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  HOST_TOPOLOGY_PATTERNS,
  PACK_PATH_PATTERNS,
  REQUIRE_PACK_PATTERNS,
  SANCTIONED_DISTRIBUTION,
  SANCTIONED_ENTRY_SHELL,
  main,
  violationsOf,
};
