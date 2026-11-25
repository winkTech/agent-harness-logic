'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { kbPath } = require('../../config.cjs');
const { answer } = require('../knowledge-answer.cjs');
const { ensureIndex, inspectIndexFreshness } = require('../semantic-search.cjs');
const root = path.resolve(__dirname, '../../../..');

function verifyQuotes(home, result) {
  assert.ok(result.citations.length > 0);
  for (const { file, line, quote } of result.citations) {
    assert.equal(fs.readFileSync(path.join(home, file), 'utf8').split(/\r?\n/)[line - 1]?.trim(), quote);
  }
}

test('engineering questions cite the current source, script, and scoped signoff', () => {
  for (const [query, expected] of [
    ['异步 FIFO 的格雷码有什么用？', /相邻跳变 bit 数 \| 1/],
    ['信道估计的 MATLAB 联仿入口在哪？', /channel_est\/run_rtl_cosim\.m/],
    ['准备复用 LDPC 编码器，综合做到哪一步了？', /编码器无独立综合包络/],
    ['What is the signoff scope for ldpc_codec?', /3240 样点 0 失配/],
  ]) {
    const result = answer(query, { home: root });
    assert.match(result.answer, expected);
    verifyQuotes(root, result);
  }
  assert.equal(answer('QZMX-77491 在 85℃ 下的实测 BER？', { home: root }).status, 'insufficient_evidence');
});

test('packaged MCP answers engineering lessons without access to personal notes', t => {
  const pkg = fs.existsSync(path.join(root, '.codex-plugin/plugin.json')) ? root : path.join(root, 'dist/plugin');
  assert.equal(fs.existsSync(path.join(pkg, 'personal')), false);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-user-'));
  t.after(() => fs.rmSync(userDir, { recursive: true, force: true }));
  const cases = [
    ['只跑 lint 能证明 Hook 的功能正确吗？', 'functional-verification', /可见效果|事务已提交/],
    ['未验证或过期的记忆可以直接注入吗？', 'memory-retrieval-trust', /复核期限|过期/],
    ['修已有模块时，为什么不能保留 _v2 和 _final 两份？', 'fix-in-place', /构建使用|原入口/],
    ['之前做过的工程，查外部资料前应先从哪里找依据？', 'knowledge-retrieval-priority', /本地知识库|补查规范/],
    ['定点对拍前，上一个流水线阶段要交付什么？', 'pipeline-stage-evidence', /实跑数据|期望输出/],
    ['Viterbi 的 traceback 原本 14 次，为何跑成了 28 次？', 'viterbi-traceback', /完成标志|禁止重复启动/],
    ['解交织输出第一个 nibble 就有 tlast，要怎样定位？', 'fullframe-boundary', /r_frame_bits|首次成交/],
    ['skill evolve 生成的建议在哪里等候审查？', 'skill-evolution', /staging/],
  ];
  const server = JSON.parse(fs.readFileSync(path.join(pkg, '.codex-mcp.json'), 'utf8')).mcpServers.codegraph;
  const input = cases.map(([query], id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'harness_knowledge_query', arguments: { query } } })).join('\n') + '\n';
  const { KB_PATH, ...env } = process.env;
  const stdout = execFileSync(process.execPath, [path.resolve(pkg, server.args[0])], {
    cwd: userDir, input, encoding: 'utf8', timeout: 45000,
    env: { ...env, HOME: userDir, USERPROFILE: userDir, HARNESS_ROOT: pkg, HARNESS_STATE_DIR: userDir },
  });
  const messages = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  for (const [i, [query, topic, evidence]] of cases.entries()) {
    const message = messages.find(m => m.id === i);
    assert.ok(message?.result && !message.result.isError, query);
    const result = JSON.parse(message.result.content[0].text);
    assert.equal(result.status, 'references', query);
    assert.ok(result.citations.every(c => c.file.endsWith('/lessons/' + topic + '.md')), query);
    assert.match(result.answer, evidence, query);
    verifyQuotes(pkg, result);
  }
});

test('refresh after rename, same-size edit, retirement, unavailable index and lost script', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-routing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const kb = kbPath(home);
  const dir = path.join(kb, 'primary');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'alpha.md'), current = path.join(dir, 'replacement.md');
  fs.writeFileSync(old, '# Oscillator setup\noscillator divider mode alpha\n');
  assert.match(answer('oscillator divider', { home }).answer, /alpha/);
  fs.renameSync(old, current);
  const first = answer('oscillator divider', { home });
  assert.match(first.citations[0].file, /replacement\.md$/);
  const st = fs.statSync(current);
  fs.writeFileSync(current, '# Oscillator setup\noscillator divider mode bravo\n');
  fs.utimesSync(current, st.atime, st.mtime);
  assert.equal(inspectIndexFreshness({ home }).stale, true);
  assert.match(answer('oscillator divider', { home }).answer, /bravo/);
  fs.writeFileSync(path.join(dir, '_SUPERSEDED.md'), 'retired');
  assert.equal(answer('oscillator divider', { home }).status, 'insufficient_evidence');
  fs.writeFileSync(path.join(kb, 'TAG_INDEX.md'), '[telemetry](collect.m)');
  fs.writeFileSync(path.join(kb, 'collect.m'), '% telemetry acquisition\n');
  fs.rmSync(path.join(home, 'var/index'), { recursive: true });
  fs.writeFileSync(path.join(home, 'var/index'), 'cannot create index under this file');
  const fallback = answer('telemetry script', { home });
  assert.ok(fallback.indexWarning);
  verifyQuotes(home, fallback);
  fs.unlinkSync(path.join(kb, 'collect.m'));
  assert.equal(answer('telemetry script', { home }).status, 'insufficient_evidence');
});

test('signoff follows a sealed current version and rejects drift and unmatched measurements', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-asset-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const assets = path.dirname(kbPath(home));
  const id = 'timing_probe';
  const file = path.join(assets, 'cbb', id, 'manifest.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const manifest = { asset_uid: id, version: '1.0.0', maturity: { level: 'certified' },
    signoff: { by: 'test', at: '2026-06-01', scope: ['上板实测 LAB-72 85℃ BER 0.003', '尚未上板，LAB-72 75℃ BER 目标 0.001'] } };
  function write(seal) {
    const text = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(file, text);
    if (!seal) return;
    const dir = path.join(assets, 'evidence', id, manifest.version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SNAPSHOT.json'), JSON.stringify({ asset_uid: id, version: manifest.version,
      manifest_sha256: crypto.createHash('sha256').update(text).digest('hex'),
      gate_summary: { cleared_level: 'certified', asset_uid: id, blocking_at: null } }, null, 2));
  }
  write(true);
  verifyQuotes(home, answer('timing_probe LAB-72 85℃ 实测 BER', { home }));
  assert.equal(answer('timing_probe LAB-72 75℃ 实测 BER', { home }).status, 'insufficient_evidence');
  manifest.version = '2.0.0';
  write(false);
  assert.equal(answer('timing_probe 签核', { home }).status, 'insufficient_evidence');
  write(true);
  assert.equal(answer('timing_probe 签核', { home }).version, '2.0.0');
  manifest.signoff.scope.push('changed after sealing');
  write(false);
  assert.equal(answer('timing_probe 签核', { home }).status, 'insufficient_evidence');
  manifest.superseded_by = 'timing_probe_v3';
  write(true);
  assert.match(answer('timing_probe 签核', { home }).answer, /已被取代/);
  assert.equal(ensureIndex(home).status, 'fresh');
});
