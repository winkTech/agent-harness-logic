'use strict';

/**
 * module-topology-contract — 图驱动模块顺序的行为契约。
 *
 * 锁死的语义:
 *   1. 子模块必须排在例化它的父模块之前 (改子模块会让父模块的验证失效)
 *   2. 图上无约束的兄弟模块**保持调用方给定的相对顺序** —— 例化图定不出数据流序,
 *      不许假装能定出来
 *   3. 父在子前 = 矛盾, 必须报出来 (这正是 cascade 门禁被悄悄绕过的形状)
 *   4. 例化环只报告不崩溃
 *   5. 索引不新鲜 → CLI 失败关闭, 不给顺序
 *
 * 临时项目 + 临时 DB, 不碰 var/ 与真实 memory.db。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-topo-'));
process.env.CLAUDE_SQLITE_PATH = path.join(WORKSPACE, 'topo.db');
delete process.env.CLAUDE_HARNESS_NO_PERSIST;
delete process.env.CLAUDE_NO_DIAGNOSTIC_WRITES;

const cg = require('../cg-queries.cjs');
const topology = require('../lib/module-topology.cjs');
const indexer = require('../code-graph-index.cjs');

const CLI = path.join(HARNESS_ROOT, 'engine', 'scripts', 'module-order.cjs');

function mod(name, children = []) {
  const body = children.map((c, i) => `  ${c} u_${c}_${i} (.clk(clk), .d(d), .q(q));`).join('\n');
  return `module ${name} (input logic clk, input logic d, output logic q);\n${body}\nendmodule\n`;
}

function makeProject() {
  const project = path.join(WORKSPACE, 'proj');
  fs.mkdirSync(path.join(project, 'rtl'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  // 层次: top → {mid_a, mid_b}; mid_a → leaf
  // mid_a 与 mid_b 是兄弟, 图上**没有**先后关系
  fs.writeFileSync(path.join(project, 'rtl', 'leaf.sv'), mod('leaf'));
  fs.writeFileSync(path.join(project, 'rtl', 'mid_a.sv'), mod('mid_a', ['leaf']));
  fs.writeFileSync(path.join(project, 'rtl', 'mid_b.sv'), mod('mid_b'));
  fs.writeFileSync(path.join(project, 'rtl', 'top.sv'), mod('top', ['mid_a', 'mid_b']));
  return project;
}

const PROJECT = makeProject();

function cleanup() {
  try { fs.rmSync(WORKSPACE, { recursive: true, force: true }); } catch { /* 清理失败无害 */ }
}

// ── 1. 索引前: CLI 失败关闭 ─────────────────────────────────────────────────

function assertStaleFailsClosed() {
  const result = spawnSync(process.execPath,
    [CLI, '--project', PROJECT, '--modules', 'leaf,top'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env } });
  assert.notEqual(result.status, 0, '索引不新鲜时必须非零退出');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.staleIndex, true);
  assert.equal(parsed.ok, false);
  assert.match(parsed.hint, /code-graph-index/, '必须告诉调用者怎么修');
}

// ── 2. 层次约束: 子先于父 ───────────────────────────────────────────────────

function assertHierarchyOrder(projectId) {
  const { deps } = topology.buildModuleDeps(projectId);
  assert.ok(deps.get('top')?.has('mid_a'), 'top 应例化 mid_a');
  assert.ok(deps.get('mid_a')?.has('leaf'), 'mid_a 应例化 leaf');
  assert.equal(deps.get('mid_b')?.size || 0, 0, 'mid_b 无子模块');

  const derived = topology.deriveModuleOrder(projectId, ['top', 'mid_a', 'mid_b', 'leaf']);
  const at = (name) => derived.order.indexOf(name);
  assert.ok(at('leaf') < at('mid_a'), 'leaf 必须排在 mid_a 之前');
  assert.ok(at('mid_a') < at('top'), 'mid_a 必须排在 top 之前');
  assert.ok(at('mid_b') < at('top'), 'mid_b 必须排在 top 之前');
  assert.equal(derived.derivable, true);
  assert.deepEqual(derived.unknown, []);
  assert.deepEqual(derived.cycles, []);
}

// ── 3. 兄弟顺序: 图上无约束就保持调用方的顺序 ───────────────────────────────

function assertSiblingOrderPreserved(projectId) {
  const ab = topology.deriveModuleOrder(projectId, ['mid_a', 'mid_b', 'leaf', 'top']);
  const ba = topology.deriveModuleOrder(projectId, ['mid_b', 'mid_a', 'leaf', 'top']);
  const idx = (list, n) => list.indexOf(n);
  assert.ok(idx(ab.order, 'mid_a') < idx(ab.order, 'mid_b'),
    '调用方把 mid_a 放前面, 图上无约束时就该保持');
  assert.ok(idx(ba.order, 'mid_b') < idx(ba.order, 'mid_a'),
    '调换输入顺序, 输出也应随之调换 —— 例化图定不出兄弟间的数据流序');

  // 稳定性: 同样输入必须给出同样输出
  const again = topology.deriveModuleOrder(projectId, ['mid_a', 'mid_b', 'leaf', 'top']);
  assert.deepEqual(again.order, ab.order, '排序必须可复现');
}

// ── 4. 矛盾检测 ─────────────────────────────────────────────────────────────

function assertContradictionDetected(projectId) {
  const bad = topology.validateModuleOrder(projectId, ['top', 'mid_a', 'leaf']);
  assert.equal(bad.ok, false, '父在子前必须判为矛盾');
  assert.ok(bad.contradictions.length >= 2, `应报出 top→mid_a 与 mid_a→leaf 两处: ${JSON.stringify(bad.contradictions)}`);
  assert.match(bad.contradictions[0].detail, /cascade/, '措辞要说清后果, 而不只是"顺序不对"');
  assert.deepEqual(bad.suggestion.slice(0, 1), ['leaf'], '建议顺序应以最底层开头');

  const good = topology.validateModuleOrder(projectId, ['leaf', 'mid_a', 'top']);
  assert.equal(good.ok, true, '子在父前应通过');
  assert.deepEqual(good.contradictions, []);
}

// ── 5. 未知模块必须显式报出 ─────────────────────────────────────────────────

function assertUnknownReported(projectId) {
  const derived = topology.deriveModuleOrder(projectId, ['leaf', 'not_coded_yet']);
  assert.deepEqual(derived.unknown, ['not_coded_yet'],
    '图里没有的模块必须报出来, 不能假装排好了');
  assert.ok(derived.order.includes('not_coded_yet'), '未知模块仍应留在顺序里, 只是没有约束');
}

// ── 6. 例化环: 报告而不崩溃 ─────────────────────────────────────────────────

function assertCycleReported() {
  const deps = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
    ['c', new Set()],
  ]);
  const { order, cycles } = topology.stableTopoSort(['a', 'b', 'c'], deps);
  assert.equal(cycles.length >= 1, true, '互例化环必须被报告');
  assert.equal(order.length, 3, '有环也要把所有模块排进去, 不能丢');
}

// ── 7. 影响面: 改 leaf 要重验谁 ─────────────────────────────────────────────

function assertImpactedModules(projectId) {
  const result = topology.impactedModules(projectId, ['leaf']);
  assert.equal(result.staleIndex, false);
  assert.ok(result.modules.includes('leaf'));
  assert.ok(result.modules.includes('mid_a'), `改 leaf 应波及 mid_a: ${result.modules.join(',')}`);
  assert.ok(result.modules.includes('top'), `改 leaf 应传递波及 top: ${result.modules.join(',')}`);
  assert.ok(!result.modules.includes('mid_b'), 'mid_b 不依赖 leaf, 不该被拉进重验清单');
}

// ── 8. CLI 端到端 ───────────────────────────────────────────────────────────

function assertCli() {
  const ok = spawnSync(process.execPath,
    [CLI, '--project', PROJECT, '--modules', 'leaf,mid_a,top', '--check'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env } });
  assert.equal(ok.status, 0, `正确顺序应 exit 0: ${ok.stdout}${ok.stderr}`);
  assert.equal(JSON.parse(ok.stdout).ok, true);

  const bad = spawnSync(process.execPath,
    [CLI, '--project', PROJECT, '--modules', 'top,mid_a,leaf', '--check'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env } });
  assert.equal(bad.status, 1, '矛盾顺序必须非零退出 (工作流据此判定)');
  const parsed = JSON.parse(bad.stdout);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.suggestion, ['leaf', 'mid_a', 'top']);
  assert.match(bad.stderr, /例化了/, '矛盾说明要走 stderr, 不污染 JSON');

  const impacted = spawnSync(process.execPath,
    [CLI, '--project', PROJECT, '--impacted', 'leaf'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env } });
  assert.equal(impacted.status, 0);
  assert.ok(JSON.parse(impacted.stdout).modules.includes('top'));
}

function main() {
  try {
    assertStaleFailsClosed();

    const stats = indexer.cmdSyncProject(PROJECT, { quiet: true });
    assert.ok(stats.nodeCount > 0, '临时项目应被成功索引');
    const { projectId } = cg.resolveProject(PROJECT);

    assertHierarchyOrder(projectId);
    assertSiblingOrderPreserved(projectId);
    assertContradictionDetected(projectId);
    assertUnknownReported(projectId);
    assertCycleReported();
    assertImpactedModules(projectId);
    assertCli();
    process.stdout.write('MODULE_TOPOLOGY_RESULT: PASS\n');
  } finally {
    cleanup();
  }
}

main();
