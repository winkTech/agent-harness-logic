'use strict';

/**
 * graph-blast-radius-contract — 跨域图与影响面查询的行为契约。
 *
 * 端到端场景 (三层例化的 RTL 项目):
 *   leaf ← mid ← top, 外加一条 evidence→file 边和一条 requirement→file 边。
 *   改 leaf → 影响面必须报出 mid/top、那条证据、以及对应门禁。
 *
 * 同时锁死三条语义:
 *   1. 索引不新鲜 → staleIndex, 且**不给结果** (与语义检索同一纪律)
 *   2. proves 边只由**通过**的证据产生 (失败的运行什么也没证明)
 *   3. recalled_for 是低置信度边, 与证据分开归类, 不得混进认证链
 *
 * 全程临时项目 + 临时 DB, 不碰 var/ 与真实 memory.db。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

// 图写入需要真实库路径: 先指向临时文件, 再加载依赖 sqlite 的模块。
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-blast-'));
process.env.CLAUDE_SQLITE_PATH = path.join(WORKSPACE, 'graph.db');
delete process.env.CLAUDE_HARNESS_NO_PERSIST;
delete process.env.CLAUDE_NO_DIAGNOSTIC_WRITES;

const cg = require('../cg-queries.cjs');
const graph = require('../../sqlite/store-graph.cjs');
const collectors = require('../lib/graph-collectors.cjs');
const indexer = require('../code-graph-index.cjs');

function makeProject() {
  const project = path.join(WORKSPACE, 'proj');
  fs.mkdirSync(path.join(project, 'rtl'), { recursive: true });
  fs.mkdirSync(path.join(project, 'model'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });

  fs.writeFileSync(path.join(project, 'rtl', 'leaf.sv'),
    'module leaf (input logic clk, input logic ri_d, output logic ro_q);\n'
    + '  always_ff @(posedge clk) ro_q <= ri_d;\n'
    + 'endmodule\n');
  fs.writeFileSync(path.join(project, 'rtl', 'mid.sv'),
    'module mid (input logic clk, input logic ri_d, output logic ro_q);\n'
    + '  leaf u_leaf (.clk(clk), .ri_d(ri_d), .ro_q(ro_q));\n'
    + 'endmodule\n');
  fs.writeFileSync(path.join(project, 'rtl', 'top.sv'),
    'module top (input logic clk, input logic ri_d, output logic ro_q);\n'
    + '  mid u_mid (.clk(clk), .ri_d(ri_d), .ro_q(ro_q));\n'
    + 'endmodule\n');
  // 非深度索引文件: MATLAB Golden Model 也必须进 cg_files, 否则需求追溯断链
  fs.writeFileSync(path.join(project, 'model', 'golden.m'), '% golden model\nfunction y = golden(x)\ny = x;\n');
  return project;
}

const PROJECT = makeProject();

function cleanup() {
  try { fs.rmSync(WORKSPACE, { recursive: true, force: true }); } catch { /* 临时目录清理失败无害 */ }
}

// ── 1. 索引前: 失败关闭 ─────────────────────────────────────────────────────

function assertStaleIndexFailsClosed() {
  const { projectId } = cg.resolveProject(PROJECT);
  const before = cg.getBlastRadius(projectId, 'leaf');
  assert.equal(before.staleIndex, true, '未索引时必须报 staleIndex');
  assert.equal(before.staleReason, 'never_indexed');
  assert.deepEqual(before.downstream, [], 'staleIndex 时不得返回任何结果');
  assert.deepEqual(before.staleEvidence, []);
}

// ── 2. 索引后: 反向依赖闭包 ─────────────────────────────────────────────────

function assertDownstreamClosure(projectId) {
  const radius = cg.getBlastRadius(projectId, 'leaf', { depth: 3 });
  assert.equal(radius.staleIndex, false, `索引后不应再 stale: ${radius.staleReason}`);
  assert.ok(radius.target, '应能定位到 leaf');

  const names = radius.downstream.map(item => item.name);
  assert.ok(names.includes('mid'), `直接例化者 mid 应在影响面内: ${names.join(',')}`);
  assert.ok(names.includes('top'), `传递依赖 top 应在影响面内: ${names.join(',')}`);
  assert.ok(radius.files.some(file => file.endsWith('rtl/top.sv')), '受影响文件应含 top.sv');
}

// ── 3. 非深度索引文件也要进 cg_files ────────────────────────────────────────

function assertNonCodeFilesIndexed(projectId) {
  const matched = collectors.resolveIndexedFiles(projectId, ['model/golden.m']);
  assert.deepEqual(matched, ['model/golden.m'],
    'MATLAB/Tcl 这类非深度索引文件也必须登记到 cg_files, 否则需求→模型的追溯断链');
}

// ── 4. 证据边: 只认通过的证据 ───────────────────────────────────────────────

function assertEvidenceEdges(projectId) {
  const failed = collectors.collectEvidenceEdges({
    status: 'failed',
    contractHash: 'failedhash',
    command: 'xsim rtl/leaf.sv',
    cwd: PROJECT,
  }, { projectId });
  assert.equal(failed.linked, 0, '失败的运行什么也没证明, 不得建 proves 边');

  const passed = collectors.collectEvidenceEdges({
    status: 'passed',
    contractHash: 'passedhash',
    command: 'xsim rtl/leaf.sv rtl/mid.sv',
    recordedAt: new Date().toISOString(),
    cwd: PROJECT,
  }, { projectId, gate: 'G-SIM-01' });
  assert.ok(passed.linked >= 2, `通过的证据应连上命令里提到的文件, 实得 ${passed.linked}`);

  const radius = cg.getBlastRadius(projectId, 'leaf', { depth: 3 });
  const shas = radius.staleEvidence.map(item => item.evidenceSha);
  assert.ok(shas.includes('passedhash'), '改 leaf 应让指向 leaf 的证据失效');
  assert.ok(!shas.includes('failedhash'), '失败证据不应出现在影响面里');
  assert.ok(radius.gatesToRerun.includes('G-SIM-01'), '失效证据关联的门禁必须列入重跑清单');
}

// ── 5. 需求边 ───────────────────────────────────────────────────────────────

function assertRequirementEdges(projectId) {
  const result = collectors.collectRequirementEdges({
    status: 'completed',
    task: '三层例化链路打通',
    scope: ['rtl/**', 'model/golden.m'],
    plan: 'docs/adr/x.md',
  }, { projectId });
  assert.ok(result.linked >= 3, `需求 scope 应覆盖 rtl/* 与 golden.m, 实得 ${result.linked}`);

  const radius = cg.getBlastRadius(projectId, 'leaf', { depth: 3 });
  assert.ok(radius.requirements.length > 0, '影响面应报出相关需求');
  assert.equal(radius.requirements[0].requirement, result.requirementId);

  const notCompleted = collectors.collectRequirementEdges({
    status: 'in_progress', task: 'x', scope: ['rtl/**'],
  }, { projectId });
  assert.equal(notCompleted.linked, 0, '未完成的门禁不得建追溯边');
}

// ── 6. 记忆边: 低置信度且单独归类 ───────────────────────────────────────────

function assertFactEdges(projectId) {
  const result = collectors.collectFactEdges(
    [{ id: 'fact-123' }, { key: 'learnings/x.md' }],
    { projectId, filePath: 'rtl/leaf.sv' },
  );
  assert.ok(result.linked >= 2);

  const radius = cg.getBlastRadius(projectId, 'leaf', { depth: 3 });
  assert.ok(radius.relatedFacts.length >= 2, '记忆边应出现在 relatedFacts');
  for (const fact of radius.relatedFacts) {
    assert.ok(fact.confidence < 1, '记忆边必须是低置信度, 不能与可核对证据同权');
  }
  const evidenceIds = radius.staleEvidence.map(item => item.evidenceSha);
  assert.ok(!evidenceIds.includes('fact-123'), '记忆绝不能混进证据清单');
}

// ── 7. store 的写入约束 ─────────────────────────────────────────────────────

function assertStoreGuards() {
  assert.throws(() => graph.link({
    src: ['bogus_kind', 'x'], dst: ['file', 'y'], rel: 'proves', provenance: 'test',
  }), /kind 非法/);

  assert.throws(() => graph.link({
    src: ['file', 'x'], dst: ['file', 'y'], rel: 'bogus_rel', provenance: 'test',
  }), /rel 非法/);

  assert.throws(() => graph.link({
    src: ['file', 'x'], dst: ['file', 'y'], rel: 'proves',
  }), /provenance/, '不接受来路不明的边');

  // 幂等: 同一条边写两次只留一条
  const before = graph.stats().total;
  graph.link({ src: ['file', 'a'], dst: ['file', 'b'], rel: 'covers', provenance: 't1' });
  graph.link({ src: ['file', 'a'], dst: ['file', 'b'], rel: 'covers', provenance: 't2' });
  assert.equal(graph.stats().total, before + 1, 'link 必须幂等');

  assert.equal(graph.safeLink({ src: ['nope', 'x'], dst: ['file', 'y'], rel: 'proves', provenance: 't' }), null,
    'safeLink 必须吞掉异常 —— 采集器绝不能拖累权威写入');
}

// ── 8. CLI ──────────────────────────────────────────────────────────────────

function assertCli(projectId) {
  const cli = path.join(HARNESS_ROOT, 'engine', 'scripts', 'cg-queries.cjs');
  const result = spawnSync(process.execPath, [cli, 'blast', projectId, 'leaf'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env },
  });
  assert.equal(result.status, 0, `blast CLI 应正常退出: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.staleIndex, false);
  assert.ok(parsed.downstream.length >= 2);
}

function main() {
  try {
    assertStaleIndexFailsClosed();

    const stats = indexer.cmdSyncProject(PROJECT, { quiet: true });
    assert.ok(stats.nodeCount > 0, '临时项目应被成功索引');
    const { projectId } = cg.resolveProject(PROJECT);

    assertDownstreamClosure(projectId);
    assertNonCodeFilesIndexed(projectId);
    assertEvidenceEdges(projectId);
    assertRequirementEdges(projectId);
    assertFactEdges(projectId);
    assertStoreGuards();
    assertCli(projectId);
    process.stdout.write('GRAPH_BLAST_RADIUS_RESULT: PASS\n');
  } finally {
    cleanup();
  }
}

main();
