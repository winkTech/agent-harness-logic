#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/module-order.cjs — 由代码图推导/校验模块验证顺序。
 *
 * hdl-coding-dag-workflow 的 cascade 门禁 (上游没过就不调下游) 完全依赖
 * moduleOrder 正确, 而这个顺序一直是手写的、错了也没人报错。工作流跑在受限
 * JS 沙箱里 (没有 require/fs), 拿不到代码图, 所以由本 CLI 承担查询, 工作流通过
 * 一次 Bash 调用取结果。
 *
 * 用法:
 *   node engine/scripts/module-order.cjs --modules a,b,c            # 推导顺序
 *   node engine/scripts/module-order.cjs --modules a,b,c --check    # 校验; 矛盾则 exit 1
 *   node engine/scripts/module-order.cjs --impacted leaf --project /p  # 改 leaf 要重验谁
 *
 * 输出恒为 JSON (供工作流解析), 人类可读的说明走 stderr。
 */

const { findProjectRoot } = require('./lib/project-scope.cjs');
const { resolveProject, indexFreshness } = require('./cg-queries.cjs');
const topology = require('./lib/module-topology.cjs');

function parseFlags(argv) {
  const flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      flags.positional.push(argv[i]);
    }
  }
  return flags;
}

function splitList(value) {
  if (!value || value === true) return [];
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const projectPath = flags.project && flags.project !== true
    ? String(flags.project) : process.cwd();
  const projectRoot = findProjectRoot(projectPath, { fallback: projectPath });
  const { projectId } = resolveProject(projectRoot);

  // 索引不新鲜时失败关闭: 拿过期的图排验证顺序, 比手写顺序更危险 —— 它看起来
  // 是"图算出来的"因而更可信, 实际却基于已经不存在的例化关系。
  const freshness = indexFreshness(projectId);
  if (!freshness.fresh && flags.allowStale !== true) {
    console.log(JSON.stringify({
      ok: false,
      staleIndex: true,
      reason: freshness.reason,
      hint: `先重建索引: node engine/scripts/code-graph-index.cjs sync ${projectRoot}`,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (flags.impacted) {
    const changed = splitList(flags.impacted);
    const result = topology.impactedModules(projectId, changed, {
      depth: Number.parseInt(flags.depth, 10) || 4,
    });
    console.log(JSON.stringify({ ok: !result.staleIndex, projectRoot, ...result }, null, 2));
    if (result.staleIndex) process.exitCode = 1;
    return;
  }

  const modules = splitList(flags.modules);
  if (modules.length === 0) {
    console.error('用法: module-order.cjs --modules a,b,c [--check] [--project <路径>]');
    console.error('      module-order.cjs --impacted <模块名> [--project <路径>]');
    process.exitCode = 2;
    return;
  }

  if (flags.check) {
    const result = topology.validateModuleOrder(projectId, modules);
    console.log(JSON.stringify({ ok: result.ok, projectRoot, ...result }, null, 2));
    if (!result.ok) {
      for (const item of result.contradictions) console.error(`[module-order] ${item.detail}`);
      process.exitCode = 1;
    }
    return;
  }

  const derived = topology.deriveModuleOrder(projectId, modules);
  console.log(JSON.stringify({ ok: true, projectRoot, ...derived }, null, 2));
  if (derived.unknown.length > 0) {
    console.error(`[module-order] 图中没有这些模块 (尚未编码或名字不符): ${derived.unknown.join(', ')}`);
  }
  if (derived.cycles.length > 0) {
    console.error(`[module-order] 检测到例化环: ${derived.cycles.map(c => c.join('→')).join(' | ')}`);
  }
}

if (require.main === module) main();

module.exports = { main, parseFlags, splitList };
