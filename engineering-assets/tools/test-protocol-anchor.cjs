#!/usr/bin/env node
// protocol_anchor 协议锚点治理的回归测试 (owner 裁定 2026-08-02 决策⑦)。
//
// 判据是"门禁能不能拦住它声称要拦的错", 不是"现有 16 个包能不能过" —— 后者只要
// 门禁恒 pass 就能骗过去。故绝大多数用例是**反向**的: 造一个坏锚点, 断言被判 fail。
//
// 全部用例在临时固件仓库上跑, 不改动库内任何真实文件; 末尾另有一组对真实库的现状断言。
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGates, validate: gateValidate } = require('./gate-runner.cjs');
const { resealSnapshot } = require('./evidence-snapshot.cjs');

const engineeringRoot = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(engineeringRoot, 'schemas', 'cbb-manifest.schema.json'), 'utf8'));
const liveBaseline = JSON.parse(fs.readFileSync(path.join(engineeringRoot, 'catalog', 'protocol-baseline.json'), 'utf8'));

const BASELINE = { standard: 'IEEE 802.11-2020', clause: '17', profile: '11a/g OFDM 20MHz' };
const NEUTRAL = { standard: 'none', baseline_relation: 'neutral' };
const ANCHORED = {
  standard: 'IEEE 802.11-2020',
  baseline_relation: 'baseline',
  clause: '17',
  profile: '11a/g OFDM 20MHz',
  scope: 'DATA 场通路',
  parameters: { n_fft: 64 },
  anchor_basis: '固件',
};

function baseManifest(anchor, extra = {}) {
  return {
    schema_version: '1.0',
    asset_uid: 'fixture_asset',
    name: 'fixture_asset',
    version: '1.0.0',
    owner: 'lihan',
    kind: 'primitive',
    maturity: { level: 'intake' },
    requirement_ref: 'spec-id',
    doc_refs: ['doc-id'],
    ports: [{ name: 'i_clk', direction: 'input', width: 1 }],
    clock: { name: 'i_clk' },
    reset: { name: 'i_rst', polarity: 'active_high', type: 'sync' },
    sources: [],
    ...(anchor === undefined ? {} : { protocol_anchor: anchor }),
    ...extra,
  };
}

// ── 临时固件仓库 ───────────────────────────────────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-anchor-'));
const pkgDir = path.join(scratch, 'cbb', 'fixture_asset');
fs.mkdirSync(pkgDir, { recursive: true });
fs.mkdirSync(path.join(scratch, 'catalog'), { recursive: true });
const baselinePath = path.join(scratch, 'catalog', 'protocol-baseline.json');
const writeBaseline = (baseline) => fs.writeFileSync(baselinePath, `${JSON.stringify({ baseline }, null, 2)}\n`, 'utf8');
writeBaseline(BASELINE);

// 门禁在这份固件上判 G-B-04; 返回该门的 {status, detail}。
function gb04(anchor, extra = {}) {
  const manifest = baseManifest(anchor, extra);
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return runGates(pkgDir, manifest, scratch).find((gate) => gate.id === 'G-B-04') || null;
}
const detailOf = (gate) => (Array.isArray(gate.detail) ? gate.detail.join(' | ') : String(gate.detail));

function expectFail(name, anchor, needle, extra) {
  const gate = gb04(anchor, extra);
  assert(gate, `${name}: G-B-04 未出现`);
  assert.equal(gate.status, 'fail', `${name}: 期望 fail, 实为 ${gate.status} (${detailOf(gate)})`);
  assert(detailOf(gate).includes(needle), `${name}: 判据未命中 "${needle}", 实为 ${detailOf(gate)}`);
}
function expectPass(name, anchor, extra) {
  const gate = gb04(anchor, extra);
  assert(gate, `${name}: G-B-04 未出现`);
  assert.equal(gate.status, 'pass', `${name}: 期望 pass, 实为 ${gate.status} (${detailOf(gate)})`);
}

try {
  // ── 1. 声明缺失与中立自相矛盾 ────────────────────────────────────────────
  expectFail('缺字段', undefined, 'protocol_anchor 缺失');
  expectPass('中立显式声明', NEUTRAL);
  expectFail('中立却声明 parameters', { ...NEUTRAL, parameters: { n_fft: 64 } }, '不应声明 parameters');
  expectFail('中立却声明 clause', { ...NEUTRAL, clause: '17' }, '不应声明 clause');
  expectFail('中立却声明 deviations', { ...NEUTRAL, deviations: [] }, '不应声明 deviations');
  expectFail('中立却报 baseline', { ...NEUTRAL, baseline_relation: 'baseline' }, '应为 neutral');
  console.log('ok 1 - 缺字段不等于中立; 中立锚不得夹带协议内容');

  // ── 2. 非中立锚的必填项 ─────────────────────────────────────────────────
  expectPass('基线锚', ANCHORED);
  expectFail('缺 anchor_basis', { ...ANCHORED, anchor_basis: undefined }, '缺 anchor_basis');
  expectFail('缺 scope', { ...ANCHORED, scope: undefined }, '缺 scope');
  expectFail('缺 profile', { ...ANCHORED, profile: undefined }, '缺 profile');
  expectFail('parameters 为空', { ...ANCHORED, parameters: {} }, '缺 parameters');
  console.log('ok 2 - 非中立锚必须带 profile/scope/parameters/anchor_basis');

  // ── 3. 基线比对: 跨版必须自报, 不得静默漂移 ──────────────────────────────
  const crossed = {
    ...ANCHORED, standard: 'IEEE 802.11n-2009', clause: undefined,
    baseline_relation: 'cross_version', notes: '11a 基线不含 LDPC',
  };
  expectPass('跨版正确自报', crossed);
  expectFail('跨版谎报 baseline', { ...crossed, baseline_relation: 'baseline' }, '实算为 cross_version');
  expectFail('跨版无 notes', { ...crossed, notes: undefined }, '须在 notes 说明');
  expectFail('同标准但条款不同也算跨版', { ...ANCHORED, clause: '19' }, '实算为 cross_version');
  expectFail('基线件谎报跨版', { ...ANCHORED, baseline_relation: 'cross_version', notes: 'x' }, '实算为 baseline');
  console.log('ok 3 - baseline_relation 与基线实算比对, 两个方向的谎报都拦');

  // 基线换版后, 原基线件必须随之变判 —— 证明比对真在算而不是读死值
  writeBaseline({ ...BASELINE, standard: 'IEEE 802.11n-2009' });
  expectFail('基线换版后 11a 件应变跨版', ANCHORED, '实算为 cross_version');
  fs.rmSync(baselinePath);
  expectFail('基线文件缺失应 fail-closed', ANCHORED, 'fail-closed');
  writeBaseline(BASELINE);
  console.log('ok 4 - 基线文件是活比对基准, 缺失时 fail-closed 而非放行');

  // ── 4. 偏差登记的出处必须可解析 ──────────────────────────────────────────
  const withDeviation = (ref) => ({ ...ANCHORED, deviations: [{ id: 'L3', summary: '导频极性偏差', ref }] });
  expectFail('偏差出处断链', withDeviation('engineering-assets/cbb/fixture_asset/NOPE.md'), '出处断链');
  expectPass('偏差出处为非路径 id', withDeviation('ADR-004'));
  expectPass('无偏差登记', ANCHORED);
  console.log('ok 5 - 偏差出处写成路径时必须可解析');

  // ── 5. 豁免: golden-model 与 reference 级不做协议声明 ────────────────────
  assert.equal(gb04(undefined, { kind: 'golden-model' }), null, 'golden-model 不应出现 G-B-04');
  assert.equal(gb04(undefined, { maturity: { level: 'reference' } }), null, 'reference 级不应出现 G-B-04');
  console.log('ok 6 - golden-model 锚算法、reference 级为归档, 均豁免协议锚点');

  // ── 6. schema 层: 必填与形状 ────────────────────────────────────────────
  const schemaErrs = (m) => gateValidate(schema, m);
  assert(schemaErrs(baseManifest(undefined)).some((e) => e.includes("缺必填字段 'protocol_anchor'")), 'primitive 缺锚点应被 schema 拦');
  assert(schemaErrs(baseManifest(undefined, { kind: 'rtl', maturity: { level: 'certified' } })).some((e) => e.includes('protocol_anchor')), 'certified rtl 缺锚点应被 schema 拦');
  assert(schemaErrs(baseManifest({ ...NEUTRAL, bogus: 1 })).some((e) => e.includes("不允许的额外字段 'bogus'")), '未知子键应被 schema 拦');
  assert(schemaErrs(baseManifest({ ...NEUTRAL, baseline_relation: 'whatever' })).some((e) => e.includes('baseline_relation')), '非法枚举应被 schema 拦');
  assert(schemaErrs(baseManifest({ standard: 'x' })).some((e) => e.includes('baseline_relation')), '缺 baseline_relation 应被 schema 拦');
  assert(!schemaErrs(baseManifest(undefined, {
    kind: 'golden-model', models: [{ role: 'reference', path: 'x.m' }], vectors: {},
  })).some((e) => e.includes('protocol_anchor')), 'golden-model 不应被要求锚点');
  console.log('ok 7 - schema 对必填、枚举与未知子键的约束');

  // ── 7. 快照重封的窄路径 ─────────────────────────────────────────────────
  assert.throws(() => resealSnapshot(scratch, 'fixture_asset', ''), /requires --reason/, '重封必须带原因');
  assert.throws(() => resealSnapshot(scratch, 'fixture_asset', '  '), /requires --reason/, '空白原因不算原因');

  // 造一份"已封存"的快照, 再分别改门禁产物与实质证据
  const evDir = path.join(scratch, 'var', 'gates', 'pg', 'fixture_asset');
  fs.mkdirSync(evDir, { recursive: true });
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const writeEv = (rel, text) => { fs.writeFileSync(path.join(evDir, rel), text, 'utf8'); return { path: rel, sha256: sha(Buffer.from(text, 'utf8')), bytes: Buffer.byteLength(text, 'utf8') }; };
  const gateFile = writeEv('gate-results.json', `${JSON.stringify({ gates: [] })}\n`);
  const utilFile = writeEv('utilization.rpt', 'LUT 1\n');
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), `${JSON.stringify(baseManifest(NEUTRAL), null, 2)}\n`, 'utf8');
  const snapDir = path.join(scratch, 'evidence', 'fixture_asset', '1.0.0');
  fs.mkdirSync(snapDir, { recursive: true });
  const sealed = {
    schema_version: '1.0', asset_uid: 'fixture_asset', version: '1.0.0',
    created_at: '2026-01-01T00:00:00.000Z', git_head: null,
    manifest_sha256: 'stale'.padEnd(64, '0'),
    evidence_source: 'var/gates/pg/fixture_asset',
    files: [gateFile, utilFile].sort((a, b) => a.path.localeCompare(b.path)),
    gate_summary: null,
  };
  fs.writeFileSync(path.join(snapDir, 'SNAPSHOT.json'), `${JSON.stringify(sealed, null, 2)}\n`, 'utf8');

  fs.writeFileSync(path.join(evDir, 'utilization.rpt'), 'LUT 2\n', 'utf8');   // 实质证据被改
  assert.throws(() => resealSnapshot(scratch, 'fixture_asset', '试探'), /substantive evidence changed/, '实质证据变动必须拒绝重封');
  fs.writeFileSync(path.join(evDir, 'utilization.rpt'), 'LUT 1\n', 'utf8');   // 还原

  writeEv('G-B-04.json', `${JSON.stringify({ id: 'G-B-04' })}\n`);            // 只增门禁产物
  const { snapshot, changed } = resealSnapshot(scratch, 'fixture_asset', '新增一道门, 资产未变');
  assert.deepEqual(changed, ['+G-B-04.json'], `重封差异应只有门禁产物, 实为 ${changed.join(',')}`);
  assert.equal(snapshot.created_at, '2026-01-01T00:00:00.000Z', '原封存时间必须保留');
  assert.equal(snapshot.reseal_history.length, 1, '重封须留痕');
  assert.equal(snapshot.reseal_history[0].prior_manifest_sha256, sealed.manifest_sha256, '须记下旧 manifest 哈希');
  assert.notEqual(snapshot.manifest_sha256, sealed.manifest_sha256, 'manifest 哈希须更新');
  assert.throws(() => resealSnapshot(scratch, 'fixture_asset', '再来一次'), /no drift/, '无漂移时不得重封');
  console.log('ok 8 - 重封只放行门禁产物差异, 实质证据变动即拒绝, 且强制留痕');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// ── 8. 真实库现状 ──────────────────────────────────────────────────────────
const cbbRoot = path.join(engineeringRoot, 'cbb');
const uids = fs.readdirSync(cbbRoot).filter((name) => fs.existsSync(path.join(cbbRoot, name, 'manifest.json')));
const relations = { baseline: [], cross_version: [], neutral: [] };
for (const uid of uids) {
  const manifest = JSON.parse(fs.readFileSync(path.join(cbbRoot, uid, 'manifest.json'), 'utf8'));
  const anchor = manifest.protocol_anchor;
  assert(anchor, `${uid}: 缺 protocol_anchor`);
  assert(relations[anchor.baseline_relation], `${uid}: baseline_relation 非法 ${anchor.baseline_relation}`);
  relations[anchor.baseline_relation].push(uid);
  const gate = runGates(path.join(cbbRoot, uid), manifest, path.resolve(engineeringRoot, '..')).find((g) => g.id === 'G-B-04');
  assert.equal(gate && gate.status, 'pass', `${uid}: G-B-04 未过 — ${gate ? detailOf(gate) : '门缺失'}`);
}
assert(relations.baseline.length + relations.cross_version.length + relations.neutral.length === uids.length);
assert(liveBaseline.baseline && liveBaseline.baseline.standard && liveBaseline.baseline.parameters, '库基线声明结构不完整');
assert(liveBaseline.anchor_basis, '库基线必须写明锚点确证依据');
console.log(`ok 9 - 库内 ${uids.length} 个 CBB 锚点齐备且 G-B-04 全过 `
  + `(baseline ${relations.baseline.length} / cross_version ${relations.cross_version.length} / neutral ${relations.neutral.length})`);
