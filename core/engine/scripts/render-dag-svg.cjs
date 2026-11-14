#!/usr/bin/env node
/**
 * core/engine/scripts/render-dag-svg.cjs — 模块例化 DAG → SVG 渲染。
 *
 * 数据源是代码图 (code-graph-index / cg-queries) 的 module 节点与穿透 contains
 * 的 instantiates 边（复用 lib/module-topology.cjs 的 buildModuleDeps，不重复
 * 解析逻辑）。分层规则：最长路径层次序 —— 无依赖的底层模块在顶层，
 * 例化它们的父模块逐层向下。兄弟模块之间的数据流序本图表达不了
 * （module-topology 头注释里的既定结论），渲染时也不假装能表达。
 *
 * 索引纪律与语义检索一致（docs/rules/05-harness.md #5）：索引不新鲜 →
 * 失败关闭报错退出，不拿旧图画"可能相关"的依赖图。
 *
 * 用法:
 *   node core/engine/scripts/render-dag-svg.cjs --project <path>            # 全部模块，stdout
 *   node core/engine/scripts/render-dag-svg.cjs --project <path> --top top  # 只画 top 及其依赖闭包
 *   node core/engine/scripts/render-dag-svg.cjs --project <path> --out dag.svg
 *
 * 退出码:
 *   0 — 成功
 *   1 — 索引陈旧或项目未索引（先跑 code-graph-index）
 *   2 — 参数错误 / --top 模块不存在
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveProject, indexFreshness } = require('./cg-queries.cjs');
const { buildModuleDeps } = require('./lib/module-topology.cjs');

// ── 布局常量 ────────────────────────────────────────────────────────────────
const NODE_W = 176;
const NODE_H = 34;
const GAP_X = 36;
const GAP_Y = 58;
const PAD = 24;
const HEADER_H = 64;

function fail(msg, code = 1) {
  process.stderr.write(`[render-dag-svg] ${msg}\n`);
  process.exit(code);
}

/** XML 转义（模块名理论上 ASCII，但防御性处理）。 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 最长路径分层。level(m) = 0（无依赖）或 1 + max(level(dep))。
 * 环检测：DFS 三色标记，回边记入 cycles 并在该次递归按 0 贡献处理
 * （边仍然画出，用虚线标记 —— 诚实呈现而不是静默吞掉）。
 */
function layering(deps) {
  const levels = new Map();
  const state = new Map(); // 1=进行中 2=完成
  const cycles = [];

  function levelOf(name, stack) {
    if (state.get(name) === 2) return levels.get(name) ?? 0;
    if (state.get(name) === 1) {
      cycles.push([...stack.slice(stack.indexOf(name)), name]);
      return 0; // 回边贡献 0，避免无限递归
    }
    state.set(name, 1);
    let lv = 0;
    for (const dep of deps.get(name) || []) {
      lv = Math.max(lv, levelOf(dep, [...stack, name]) + 1);
    }
    state.set(name, 2);
    levels.set(name, lv);
    return lv;
  }

  for (const name of deps.keys()) levelOf(name, []);
  return { levels, cycles };
}

/** 取 top 的依赖闭包（含自身）。 */
function closureOf(top, deps) {
  const seen = new Set([top]);
  const queue = [top];
  while (queue.length) {
    const cur = queue.shift();
    for (const dep of deps.get(cur) || []) {
      if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
  }
  return seen;
}

function render(projectRoot, projectId, deps, cycles, opts) {
  const names = [...deps.keys()].sort();
  const { levels } = layering(deps);

  // 分层 → 行
  const byLevel = new Map();
  for (const name of names) {
    const lv = levels.get(name) || 0;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(name);
  }
  const maxLevel = Math.max(...byLevel.keys());
  const maxPerLevel = Math.max(...[...byLevel.values()].map((a) => a.length));

  const width = PAD * 2 + maxPerLevel * NODE_W + (maxPerLevel - 1) * GAP_X;
  const height = HEADER_H + PAD + (maxLevel + 1) * NODE_H + maxLevel * GAP_Y + PAD;

  const pos = new Map(); // name -> {x, y}
  for (const [lv, row] of byLevel) {
    row.sort();
    // 行内居中
    const rowW = row.length * NODE_W + (row.length - 1) * GAP_X;
    const x0 = (width - rowW) / 2;
    row.forEach((name, i) => {
      pos.set(name, { x: x0 + i * (NODE_W + GAP_X), y: HEADER_H + PAD + lv * (NODE_H + GAP_Y) });
    });
  }

  const edgeCount = [...deps.values()].reduce((n, set) => n + set.size, 0);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="Consolas, 'Courier New', monospace">`);
  parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
    + `<path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker></defs>`);
  parts.push(`<rect width="${width}" height="${height}" fill="#f8fafc"/>`);

  // 头部元数据
  parts.push(`<text x="${PAD}" y="26" font-size="15" font-weight="bold" fill="#0f172a">模块例化 DAG — ${esc(path.basename(projectRoot))}</text>`);
  parts.push(`<text x="${PAD}" y="46" font-size="11" fill="#475569">模块 ${names.length} · 依赖边 ${edgeCount} · 分层 0-${maxLevel}（顶层=无依赖底层模块）`
    + ` · 环 ${cycles.length}${opts.top ? ` · 根节点 ${esc(opts.top)} 的依赖闭包` : ''}</text>`);
  if (cycles.length) {
    parts.push(`<text x="${PAD}" y="62" font-size="11" fill="#b91c1c">⚠ 检测到 ${cycles.length} 个例化环（虚线边）: ${esc(cycles.map((c) => c.join('→')).join(' ; ')).slice(0, 200)}</text>`);
  }

  // 边（父 → 子，向下）
  const cycleEdges = new Set();
  for (const c of cycles) {
    for (let i = 0; i + 1 < c.length; i++) cycleEdges.add(`${c[i]}\u0000${c[i + 1]}`);
  }
  for (const [parent, children] of deps) {
    const p = pos.get(parent);
    if (!p) continue;
    for (const child of children) {
      const c = pos.get(child);
      if (!c) continue;
      const x1 = p.x + NODE_W / 2;
      const y1 = p.y + NODE_H;
      const x2 = c.x + NODE_W / 2;
      const y2 = c.y;
      const dashed = cycleEdges.has(`${parent}\u0000${child}`) ? ' stroke-dasharray="5,4"' : '';
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="1.4" marker-end="url(#arrow)"${dashed}/>`);
    }
  }

  // 节点
  for (const name of names) {
    const p = pos.get(name);
    const isTop = opts.top && name === opts.top;
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="6"`
      + ` fill="${isTop ? '#dbeafe' : '#ffffff'}" stroke="${isTop ? '#1d4ed8' : '#334155'}" stroke-width="${isTop ? 2 : 1.2}"/>`);
    parts.push(`<text x="${p.x + NODE_W / 2}" y="${p.y + NODE_H / 2 + 4.5}" font-size="12"`
      + ` text-anchor="middle" fill="#0f172a">${esc(name)}</text>`);
  }

  parts.push(`<text x="${PAD}" y="${height - 8}" font-size="10" fill="#94a3b8">generated ${new Date().toISOString()} · projectId ${projectId} · 分层=最长路径层次序，兄弟数据流序不可表达（module-topology 既定结论）</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const projectPath = get('--project') || process.cwd();
  const out = get('--out');
  const top = get('--top');

  const { projectId, rootPath } = resolveProject(projectPath);
  const fresh = indexFreshness(projectId);
  if (!fresh.fresh) {
    fail(`索引不可用（${fresh.reason}${fresh.indexedAt ? `，索引于 ${new Date(fresh.indexedAt).toISOString()}` : ''}）`
      + `—— 先跑 node core/engine/scripts/code-graph-index.cjs --project <path> 重建`, 1);
  }

  const deps = buildModuleDeps(projectId);
  if (deps.moduleNames.size === 0) {
    fail(`项目 ${rootPath} 的图里没有 module 节点（索引的是非 HDL 工程？）`, 1);
  }

  let scoped = deps.deps;
  if (top) {
    if (!deps.moduleNames.has(top)) {
      fail(`模块 '${top}' 不存在（图内模块 ${deps.moduleNames.size} 个）`, 2);
    }
    const cl = closureOf(top, deps.deps);
    scoped = new Map([...deps.deps].filter(([name]) => cl.has(name)));
  }

  const { cycles } = layering(scoped);
  if (cycles.length) {
    process.stderr.write(`[render-dag-svg] ⚠ 例化环 ${cycles.length} 个: ${cycles.map((c) => c.join('→')).join(' ; ')}\n`);
  }
  const svg = render(rootPath, projectId, scoped, cycles, { top });

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, svg, 'utf8');
    process.stdout.write(`[render-dag-svg] 已写入 ${out}（模块 ${scoped.size}）\n`);
  } else {
    process.stdout.write(svg + '\n');
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { layering, closureOf, render };
