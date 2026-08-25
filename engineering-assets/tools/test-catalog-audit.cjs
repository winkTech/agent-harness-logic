#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkCatalog,
  evaluateDrift,
  scanRepository,
  writeCatalog,
} = require('./catalog-gen.cjs');
const { auditRepository } = require('./asset-audit.cjs');
const { redlineChecks, validate: gateValidate } = require('./gate-runner.cjs');
const { validate: waiverValidate } = require('./waiver-ledger.cjs');
const { check: lineageCheck } = require('./lineage-check.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function minimalManifest(assetUid, level, evidenceRef = null) {
  return {
    schema_version: '1.0',
    asset_uid: assetUid,
    name: assetUid,
    owner: 'lihan',
    maturity: { level, ...(evidenceRef ? { evidence_ref: evidenceRef } : {}) },
    sources: [],
    waivers: [],
  };
}

const engineeringRoot = path.resolve(__dirname, '..');
const scan = scanRepository(engineeringRoot);

assert(scan.assets.length >= 10, 'true repository must retain the original ten-asset baseline');
assert.deepEqual(
  scan.assets.map((asset) => asset.asset_uid),
  [...scan.assets.map((asset) => asset.asset_uid)].sort(),
  'assets must be sorted deterministically by asset_uid',
);
assert(
  scan.unregistered_roots.includes('reference-assets/vendor'),
  'unregistered vendor reference root must be visible in the catalog scan',
);

console.log('ok 1 - true repository catalog scan');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-catalog-red-'));
try {
  writeJson(
    path.join(scratch, 'cbb', 'wrong_level', 'manifest.json'),
    minimalManifest('duplicate_uid', 'intake'),
  );
  writeJson(
    path.join(scratch, 'incubator', 'intake', 'duplicate', 'manifest.json'),
    minimalManifest('duplicate_uid', 'certified', 'evidence/missing/'),
  );
  writeJson(
    path.join(scratch, 'var', 'gates', 'pg', 'duplicate_uid', 'gate-results.json'),
    { asset_uid: 'duplicate_uid', cleared_level: 'qualification', blocking_at: 'certified', gates: [] },
  );

  const drift = evaluateDrift(scanRepository(scratch));
  const redCodes = new Set(drift.red.map((finding) => finding.code));
  for (const code of ['D1', 'D2', 'D3', 'D4']) {
    assert(redCodes.has(code), `scratch injection must report ${code}`);
  }
  console.log('ok 2 - catalog drift RED rules');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const catalogScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-catalog-write-'));
try {
  writeJson(
    path.join(catalogScratch, 'cbb', 'alpha', 'manifest.json'),
    minimalManifest('alpha', 'certified'),
  );
  writeJson(
    path.join(catalogScratch, 'var', 'gates', 'pg', 'alpha', 'gate-results.json'),
    { asset_uid: 'alpha', cleared_level: 'certified', blocking_at: null, gates: [{ status: 'pass' }] },
  );
  writeJson(
    path.join(catalogScratch, 'models', 'comm', 'beta', 'manifest.json'),
    { ...minimalManifest('beta', 'intake'), kind: 'golden-model' },
  );
  fs.writeFileSync(
    path.join(catalogScratch, 'README.md'),
    [
      '# Scratch',
      '',
      '## 状态',
      '',
      '| 资产 | 达到级别 | 阻塞门 |',
      '|---|---|---|',
      '| `old` | reference | stale |',
      '',
      '## Keep me',
      '',
    ].join('\n'),
    'utf8',
  );

  const catalogScan = scanRepository(catalogScratch);
  writeCatalog(catalogScan, { writeReadme: true });
  const jsonPath = path.join(catalogScratch, 'catalog', 'catalog.json');
  const markdownPath = path.join(catalogScratch, 'catalog', 'CATALOG.md');
  const readmePath = path.join(catalogScratch, 'README.md');
  const first = {
    json: fs.readFileSync(jsonPath, 'utf8'),
    markdown: fs.readFileSync(markdownPath, 'utf8'),
    readme: fs.readFileSync(readmePath, 'utf8'),
  };
  assert(!first.json.includes('generated_at'), 'catalog must not contain a timestamp');
  assert(first.readme.includes('<!-- BEGIN:CATALOG:STATUS -->'));
  assert(first.readme.includes('## Keep me'), 'manual README content must be preserved');
  assert.equal(checkCatalog(catalogScan, { checkReadme: true }).fresh, true);

  writeCatalog(scanRepository(catalogScratch), { writeReadme: true });
  assert.equal(fs.readFileSync(jsonPath, 'utf8'), first.json, 'catalog JSON must be idempotent');
  assert.equal(fs.readFileSync(markdownPath, 'utf8'), first.markdown, 'catalog Markdown must be idempotent');
  assert.equal(fs.readFileSync(readmePath, 'utf8'), first.readme, 'README block must be idempotent');

  fs.appendFileSync(markdownPath, 'stale\n', 'utf8');
  const stale = checkCatalog(scanRepository(catalogScratch), { checkReadme: true });
  assert.equal(stale.fresh, false, 'check must detect stale generated outputs');
  assert(stale.stale_files.includes('catalog/CATALOG.md'));
  console.log('ok 3 - deterministic catalog write/check/readme');
} finally {
  fs.rmSync(catalogScratch, { recursive: true, force: true });
}

const auditScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-audit-red-'));
try {
  const packageDir = path.join(auditScratch, 'cbb', 'audit_target');
  const goodLf = 'module good;\nendmodule\n';
  const goodCrlf = goodLf.replace(/\n/g, '\r\n');
  fs.mkdirSync(path.join(packageDir, 'rtl'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'rtl', 'good.sv'), goodCrlf, 'utf8');
  fs.writeFileSync(path.join(packageDir, 'rtl', 'tampered.bin'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(
    path.join(packageDir, 'README.md'),
    '<!-- asset-status: intake v1.0.0 -->\n未修复: 阻塞 G-B-03\n',
    'utf8',
  );
  fs.writeFileSync(path.join(packageDir, 'CHANGELOG.md'), '## [0.9.0] - 2026-07-01\n', 'utf8');
  writeJson(path.join(packageDir, 'manifest.json'), {
    ...minimalManifest('audit_target', 'certified'),
    version: '1.0.0',
    sources: [
      {
        path: 'rtl/good.sv',
        role: 'rtl',
        sha256: crypto.createHash('sha256').update(goodLf).digest('hex'),
      },
      {
        path: 'rtl/tampered.bin',
        role: 'vector',
        sha256: crypto.createHash('sha256').update(Buffer.from([9, 9, 9])).digest('hex'),
      },
    ],
    waivers: [{ gate: 'G-X', reason: 'fixture', approver: 'lihan', expires_at: '2099-01-01' }],
  });
  writeJson(
    path.join(auditScratch, 'var', 'gates', 'pg', 'audit_target', 'gate-results.json'),
    { asset_uid: 'audit_target', cleared_level: 'qualification', blocking_at: 'certified', gates: [] },
  );

  const report = auditRepository(auditScratch);
  const redCodes = new Set(report.red.map((finding) => finding.code));
  for (const code of ['A1', 'A2', 'A3', 'A4', 'A5']) {
    assert(redCodes.has(code), `audit injection must report ${code}`);
  }
  assert(
    !report.red.some((finding) => finding.path && finding.path.endsWith('rtl/good.sv')),
    'CRLF checkout must match the LF-canonical text hash',
  );
  assert(
    report.red.some((finding) => finding.code === 'A3' && finding.path.endsWith('rtl/tampered.bin')),
    'binary source must remain byte-exact',
  );
  console.log('ok 4 - audit A1-A5 and canonical hashing');
} finally {
  fs.rmSync(auditScratch, { recursive: true, force: true });
}

const contradictionScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-audit-doc-'));
try {
  const packageDir = path.join(contradictionScratch, 'incubator', 'intake', 'doc_target');
  writeJson(
    path.join(packageDir, 'manifest.json'),
    { ...minimalManifest('doc_target', 'qualification'), version: '1.0.0' },
  );
  fs.writeFileSync(
    path.join(packageDir, 'README.md'),
    '<!-- asset-status: qualification v1.0.0 -->\n未修复: 阻塞 G-B-03\n',
    'utf8',
  );
  const gatePath = path.join(contradictionScratch, 'var', 'gates', 'pg', 'doc_target', 'gate-results.json');
  writeJson(gatePath, {
    asset_uid: 'doc_target',
    cleared_level: 'qualification',
    blocking_at: 'certified',
    gates: [{ id: 'G-B-03', status: 'blocked' }],
  });
  let report = auditRepository(contradictionScratch);
  assert.equal(
    report.yellow.filter((finding) => finding.code === 'A2' && /contradiction/.test(finding.message)).length,
    0,
    'a document that names a machine-blocked gate is truthful',
  );

  fs.writeFileSync(
    path.join(packageDir, 'README.md'),
    '<!-- asset-status: qualification v1.0.0 -->\nG-B-03 通过\n',
    'utf8',
  );
  report = auditRepository(contradictionScratch);
  assert.equal(
    report.yellow.filter((finding) => finding.code === 'A2' && /contradiction/.test(finding.message)).length,
    1,
    'a pass claim for a machine-blocked gate must be reported',
  );

  fs.writeFileSync(
    path.join(packageDir, 'README.md'),
    '<!-- asset-status: qualification v1.0.0 -->\n未修复: 阻塞 G-B-03\n',
    'utf8',
  );
  writeJson(gatePath, {
    asset_uid: 'doc_target',
    cleared_level: 'certified',
    blocking_at: null,
    gates: [{ id: 'G-B-03', status: 'pass' }],
  });
  report = auditRepository(contradictionScratch);
  assert.equal(
    report.yellow.filter((finding) => finding.code === 'A2' && /contradiction/.test(finding.message)).length,
    1,
    'the same stale claim must be reported after the machine gate passes',
  );
  const trueReport = auditRepository(engineeringRoot);
  assert.equal(
    trueReport.yellow.filter((finding) => finding.code === 'A2' && finding.asset_uid === 'rrc_polyphase_fir').length,
    0,
    'a certified asset whose README agrees with passed machine gates must not produce A2 false positives',
  );
  console.log('ok 5 - document contradiction precision');
} finally {
  fs.rmSync(contradictionScratch, { recursive: true, force: true });
}

const manifestSchema = JSON.parse(fs.readFileSync(
  path.join(engineeringRoot, 'schemas', 'cbb-manifest.schema.json'),
  'utf8',
));
assert(manifestSchema.properties.lineage, 'manifest schema must define optional lineage');
assert.equal(manifestSchema.properties.lineage.additionalProperties, false);
assert.deepEqual(
  Object.keys(manifestSchema.properties.lineage.properties).sort(),
  ['base_version', 'changelog', 'parent_uid'],
);
assert(!manifestSchema.required.includes('lineage'), 'P1 lineage must remain optional');
console.log('ok 6 - optional canonical lineage schema');

const trueScan = scanRepository(engineeringRoot);
for (const asset of trueScan.assets.filter((item) => item.kind === 'rtl')) {
  const readmePath = path.join(engineeringRoot, asset.dir, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert(
    readme.includes(`<!-- asset-status: ${asset.level} v${asset.version} -->`),
    `${asset.asset_uid} README marker must match manifest truth`,
  );
}
for (const assetUid of ['rrc_polyphase_fir', 'ldpc_codec']) {
  const asset = trueScan.assets.find((item) => item.asset_uid === assetUid);
  const changelog = fs.readFileSync(path.join(engineeringRoot, asset.dir, 'CHANGELOG.md'), 'utf8');
  const topVersion = changelog.match(/^##\s+\[([0-9]+\.[0-9]+\.[0-9]+)\]/m);
  assert.equal(topVersion && topVersion[1], asset.version, `${assetUid} CHANGELOG must match manifest version`);
}
const limitations = fs.readFileSync(
  path.join(engineeringRoot, 'cbb', 'rrc_polyphase_fir', 'docs', 'limitations.md'),
  'utf8',
);
assert(limitations.split(/\r?\n/).filter((line) => line.trim()).length >= 10);
assert((limitations.match(/^##\s+/gm) || []).length >= 2);

// 三份治理文档已废止 (2026-08-08 裁定)。
//
// 成熟化路线图 V1.0 / 其勘误 / ADR-001-foundation-first 三份文档, 随 272899f (2026-07-28)
// 的断言一起入库而文档本身从未入库 —— 那个提交自述"上一轮遗留的未提交改动, 未经本会话
// 复核"。原写法直接 readFileSync, ENOENT 把整个进程掀掉, ok 7~12 共 6 条检查一条都跑不到,
// 静默 11 天。实际在用的治理载体是 CBB-治理与生产级准入规范-V1.0.md + adr/ 系列 +
// new-asset-intake-SOP.md, 三者齐备且被本套件其余部分覆盖; 这三份从未存在过的文档不构成
// 现行要求, 故删除对应断言而非补写不存在的决策内容。
// 注意: 库内现有的 ADR-001 是 adr/ADR-001-axis-tready-and-output-registration.md,
// 与被废止的 foundation-first 是两份不同决策, 编号被复用过, 不可混为一谈。
// 若日后确需这三份文档, 应连同文档本身一并加回断言。

const topReadme = fs.readFileSync(path.join(engineeringRoot, 'README.md'), 'utf8');
assert(topReadme.includes('<!-- BEGIN:CATALOG:STATUS -->'));
assert(topReadme.includes('<!-- END:CATALOG:STATUS -->'));
console.log('ok 7 - P1 lifecycle and truth records');

const deletionManifestPath = path.join(engineeringRoot, 'catalog', 'deletion-manifest.json');
assert(fs.existsSync(deletionManifestPath), 'stage-2 deletion manifest must exist');
const deletionManifest = JSON.parse(fs.readFileSync(deletionManifestPath, 'utf8'));
assert.equal(deletionManifest.schema_version, '1.0');
assert.equal(deletionManifest.baseline.git_head, 'dacefb7f8816c739723eaccc97ca04c99c4120f9');
assert.equal(deletionManifest.dependency_recheck.tracked_files, 4100);
// 与相邻三项一样对着**冻结基线**判, 不能跟活扫描比。
//
// deletion-manifest.json 是钉在 baseline.git_head=dacefb7 的一次性 stage-2 审计记录,
// tracked_files/hdl_files/duplicate_hdl_groups 都是那一刻的常量; 唯独 manifest_assets
// 原先与 scan.assets.length 比, 于是每新增一件资产它就必挂 —— 资产数已由当时的 14
// 长到今天的 28。这条从 272899f 起就注定失败, 只是被前面路线图的 ENOENT 硬崩挡住,
// 一直没跑到。
assert.equal(deletionManifest.dependency_recheck.manifest_assets, 14);
assert.equal(deletionManifest.dependency_recheck.hdl_files, 1239);
assert.equal(deletionManifest.dependency_recheck.duplicate_hdl_groups, 46);
assert.equal(deletionManifest.deletion_summary.permanent_delete_candidates, 0);
assert.deepEqual(deletionManifest.deletion_summary.validated_targets, []);
assert.deepEqual(deletionManifest.result.deleted_files, []);
assert.equal(deletionManifest.rejected_candidates.length, 48);
for (const candidate of deletionManifest.rejected_candidates) {
  assert(candidate.id && Array.isArray(candidate.paths) && candidate.paths.length > 0);
  assert.equal(candidate.all_five_conditions_satisfied, false);
  assert(Array.isArray(candidate.failed_conditions) && candidate.failed_conditions.length > 0);
  assert(candidate.explicit_reason);
}
console.log('ok 8 - exact zero-deletion manifest and dependency recheck');

// 注意: 库内现有的 ADR-001 是 adr/ADR-001-axis-tready-and-output-registration.md,
// 与本条要找的 foundation-first 是**两份不同的决策**, 编号被复用了。不可拿前者顶替。
assert(manifestSchema.properties.schema_version.enum.includes('1.1'), 'manifest schema must accept v1.1');
assert(manifestSchema.properties.evidence_snapshot_ref, 'v1.1 must expose evidence_snapshot_ref');
assert.equal(manifestSchema.properties.evidence_snapshot_ref.pattern, '^evidence/[a-z0-9_]+/[0-9]+\\.[0-9]+\\.[0-9]+/SNAPSHOT\\.json$', 'evidence_snapshot_ref must require versioned SNAPSHOT.json');
for (const asset of scan.assets) if (asset.manifest.evidence_snapshot_ref) assert(!asset.manifest.evidence_snapshot_ref.includes('catalog/evidence-snapshot.json'), `${asset.asset_uid} must not reference legacy catalog evidence skeleton`);
assert(manifestSchema.properties.maintenance, 'v1.1 must expose maintenance metadata');
const goldenMissingVectors = { schema_version: '1.1', asset_uid: 'golden_probe', name: 'golden_probe', owner: 'lihan', kind: 'golden-model', maturity: { level: 'intake' }, version: '0.1.0', requirement_ref: 'req', models: [], sources: [] };
assert(gateValidate(manifestSchema, goldenMissingVectors).some((error) => /vectors/.test(error)), 'golden model without vectors must be RED');
const certifiedGoldenMissingSignoff = { ...goldenMissingVectors, maturity: { level: 'certified' }, vectors: {} };
assert(gateValidate(manifestSchema, certifiedGoldenMissingSignoff).some((error) => /signoff/.test(error)), 'certified golden without signoff must be RED');
// 本条原为 "non-golden intake without top must be RED", 与 schema 已经对不上了。
// schema 的 intake 分支自述 "intake 准入 = schema-valid + 编译干净 + 锚链起点"
// (引 规范 §3.1 L152-153, 且注明 272899f 曾误删本分支): intake 要的是 protocol_anchor,
// **不要 top**; top 是非 primitive 在 qualification+ 才强制。测试停在旧契约上, 而它
// 前面的 ENOENT 硬崩让这条从未被执行, 所以漂移一直没暴露。按现行 schema 分两条判。
const intakeProbe = { schema_version: '1.1', asset_uid: 'rtl_probe', name: 'rtl_probe', owner: 'lihan', maturity: { level: 'intake' }, version: '0.1.0', requirement_ref: 'req', doc_refs: ['doc'], golden_model_ref: 'golden', fidelity: { status: 'pending' }, ports: [], clock: { name: 'i_clk' }, reset: { name: 'i_rst', polarity: 'active_high', type: 'sync' }, constraints: { target: { fmax: '100MHz' } }, sources: [] };
assert(gateValidate(manifestSchema, intakeProbe).some((error) => /protocol_anchor/.test(error)), 'non-golden intake without protocol_anchor must be RED');
const qualificationMissingTop = { ...intakeProbe, maturity: { level: 'qualification' }, protocol_anchor: {} };
assert(gateValidate(manifestSchema, qualificationMissingTop).some((error) => /top/.test(error)), 'non-primitive qualification without top must be RED');

function runP2(tool, args = []) {
  return cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', tool), '--root', engineeringRoot, ...args], {
    cwd: engineeringRoot,
    encoding: 'utf8',
  });
}
for (const [tool, args] of [
  ['manifest-migrate.cjs', ['--check']],
  ['manifest-render.cjs', ['--check']],
  ['evidence-snapshot.cjs', ['--check']],
  ['waiver-ledger.cjs', ['--check']],
  ['knowledge-index.cjs', ['--check']],
]) {
  const result = runP2(tool, args);
  assert.equal(result.status, 0, `${tool} ${args.join(' ')} must be GREEN: ${result.stderr || result.stdout}`);
}
for (const file of [
  'catalog/MANIFESTS.md',
  'catalog/evidence-snapshot.json',
  'catalog/waiver-ledger.json',
  'catalog/knowledge-index.json',
  'catalog/KNOWLEDGE-INDEX.md',
]) {
  assert(fs.existsSync(path.join(engineeringRoot, file)), `${file} must be generated or documented`);
}
console.log('ok 9 - P2 schema, evidence, render, ledger and knowledge infrastructure');

const syncReset = { reset: { name: 'i_rst', polarity: 'active_high', type: 'sync', async_release_synchronized: false } };
assert.deepEqual(
  redlineChecks(syncReset, 'always_ff @(negedge data_clk) q <= d;'),
  [],
  'unrelated data-clock negedge must not trigger reset redline',
);
assert(
  redlineChecks(syncReset, 'always_ff @(negedge i_rst) q <= d;').length > 0,
  'reset negedge must trigger reset redline',
);
console.log('ok 10 - gate-runner reset redline precision');

const rrcSnapshot = path.join(engineeringRoot, 'evidence', 'rrc_polyphase_fir', '0.4.0', 'SNAPSHOT.json');
assert(fs.existsSync(rrcSnapshot), 'versioned RRC evidence snapshot must be committed under evidence/<uid>/<version>');
const snapshotValue = JSON.parse(fs.readFileSync(rrcSnapshot, 'utf8'));
for (const key of ['asset_uid', 'version', 'created_at', 'git_head', 'manifest_sha256', 'files', 'gate_summary']) {
  assert(snapshotValue[key] !== undefined, `snapshot must contain ${key}`);
}
assert(snapshotValue.files.every((file) => !/synth\.log$|\.wlf$|work\//.test(file.path)), 'snapshot whitelist must exclude logs/waveforms/work');
for (const args of [['--verify', 'rrc_polyphase_fir@0.4.0'], ['--verify-all']]) {
  const result = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'evidence-snapshot.cjs'), '--root', engineeringRoot, ...args], { cwd: engineeringRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `evidence-snapshot ${args.join(' ')} must verify: ${result.stderr || result.stdout}`);
}
const snapshotOriginal = fs.readFileSync(rrcSnapshot, 'utf8');
const snapshotDir = path.dirname(rrcSnapshot);
try {
  const duplicate = JSON.parse(snapshotOriginal);
  duplicate.files.push({ ...duplicate.files[0] });
  fs.writeFileSync(rrcSnapshot, `${JSON.stringify(duplicate, null, 2)}\n`, 'utf8');
  const duplicateResult = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'evidence-snapshot.cjs'), '--root', engineeringRoot, '--verify', 'rrc_polyphase_fir@0.4.0'], { cwd: engineeringRoot, encoding: 'utf8' });
  assert.notEqual(duplicateResult.status, 0, 'duplicate snapshot path must be RED');
  fs.writeFileSync(path.join(snapshotDir, 'extra-file.bin'), 'unexpected\n', 'utf8');
  fs.writeFileSync(rrcSnapshot, snapshotOriginal, 'utf8');
  const extraResult = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'evidence-snapshot.cjs'), '--root', engineeringRoot, '--verify', 'rrc_polyphase_fir@0.4.0'], { cwd: engineeringRoot, encoding: 'utf8' });
  assert.notEqual(extraResult.status, 0, 'extra snapshot file must be RED');
} finally {
  fs.writeFileSync(rrcSnapshot, snapshotOriginal, 'utf8');
  const extra = path.join(snapshotDir, 'extra-file.bin');
  if (fs.existsSync(extra)) fs.rmSync(extra, { force: true });
}
const restoredVerify = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'evidence-snapshot.cjs'), '--root', engineeringRoot, '--verify', 'rrc_polyphase_fir@0.4.0'], { cwd: engineeringRoot, encoding: 'utf8' });
assert.equal(restoredVerify.status, 0, 'snapshot must return GREEN after tamper fixtures restore');

// 哈希篡改必须打在**当前版本**快照上, 且版本要从 manifest 现算, 不能写死。
//
// 原先这条打在 rrc@0.4.0 上。写它的时候 rrc 就是 0.4.0(当前), 走的是校验哈希的分支;
// 后来 rrc 升到 1.0.2, 0.4.0 变成 historical —— evidence-snapshot 对 historical 只查
// 封套(重复路径/多余文件)就 return, 根本不比哈希(见其 §"A versioned snapshot is
// immutable" 那段)。于是这条断言从某次版本推进起就永远失败, 只是被前面的 ENOENT
// 硬崩挡着没跑到。写死版本号必然重蹈覆辙, 故从 manifest 现取。
const rrcCurrentVersion = JSON.parse(fs.readFileSync(path.join(engineeringRoot, 'cbb', 'rrc_polyphase_fir', 'manifest.json'), 'utf8')).version;
const currentSnapshotPath = path.join(engineeringRoot, 'evidence', 'rrc_polyphase_fir', rrcCurrentVersion, 'SNAPSHOT.json');
assert(fs.existsSync(currentSnapshotPath), `current-version snapshot must exist: ${rrcCurrentVersion}`);
const currentOriginal = fs.readFileSync(currentSnapshotPath, 'utf8');
try {
  const tampered = JSON.parse(currentOriginal);
  tampered.files[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(currentSnapshotPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  const tamperResult = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'evidence-snapshot.cjs'), '--root', engineeringRoot, '--verify', `rrc_polyphase_fir@${rrcCurrentVersion}`], { cwd: engineeringRoot, encoding: 'utf8' });
  assert.notEqual(tamperResult.status, 0, 'snapshot hash tamper must be RED on the current-version snapshot');
} finally {
  fs.writeFileSync(currentSnapshotPath, currentOriginal, 'utf8');
}

const rrcReadme = fs.readFileSync(path.join(engineeringRoot, 'cbb', 'rrc_polyphase_fir', 'README.md'), 'utf8');
for (const section of ['PORTS', 'PARAMS', 'CLOCKRESET']) {
  assert(rrcReadme.includes(`<!-- BEGIN:MANIFEST:${section} -->`), `README must contain MANIFEST:${section} marker`);
  assert(rrcReadme.includes(`<!-- END:MANIFEST:${section} -->`), `README must close MANIFEST:${section} marker`);
}
assert(fs.existsSync(path.join(engineeringRoot, 'schemas', 'waiver-ledger.schema.json')));
assert(fs.existsSync(path.join(engineeringRoot, 'var', 'cbb', 'waiver-ledger.json')));
assert(fs.existsSync(path.join(engineeringRoot, 'knowledge', 'INDEX-FILES.md')));
const knowledgeIndex = fs.readFileSync(path.join(engineeringRoot, 'knowledge', 'INDEX.md'), 'utf8');
assert(knowledgeIndex.includes('<!-- BEGIN:KIDX:STATS -->'));
const gateRunnerSource = fs.readFileSync(path.join(engineeringRoot, 'tools', 'gate-runner.cjs'), 'utf8');
for (const gate of ['G-DOC-03', 'G-DOC-04', 'waived', 'DENY']) assert(gateRunnerSource.includes(gate), `gate-runner must implement ${gate}`);
const rlRegression = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'redline-regression.cjs'), '--root', engineeringRoot, '--check'], { cwd: engineeringRoot, encoding: 'utf8' });
assert.equal(rlRegression.status, 0, `RL-OUT v2 five-asset regression must pass: ${rlRegression.stderr || rlRegression.stdout}`);

const registryCheck = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'integration-registry.cjs'), '--root', engineeringRoot], { cwd: engineeringRoot, encoding: 'utf8' });
assert.equal(registryCheck.status, 0, `integration registry must be GREEN: ${registryCheck.stderr || registryCheck.stdout}`);
assert(fs.existsSync(path.join(engineeringRoot, 'schemas', 'integration-registry.schema.json')));
assert(fs.existsSync(path.join(engineeringRoot, 'integration', 'registry.json')));
assert.equal(lineageCheck(engineeringRoot).length, 0, 'lineage check must be GREEN for the real repository');

const maintenanceCheck = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'maintenance-check.cjs'), '--root', engineeringRoot, '--check'], { cwd: engineeringRoot, encoding: 'utf8' });
assert.equal(maintenanceCheck.status, 0, `maintenance report must be fresh and GREEN: ${maintenanceCheck.stderr || maintenanceCheck.stdout}`);
const maintenanceReport = JSON.parse(fs.readFileSync(path.join(engineeringRoot, 'var', 'audit', 'maintenance-report.json'), 'utf8'));
assert.deepEqual(maintenanceReport.checks.lineage_errors, []);
assert.equal(maintenanceReport.metrics.deletion_candidate_count, 0);

const waiverCanonical = path.join(engineeringRoot, 'var', 'cbb', 'waiver-ledger.json');
const waiverMirror = path.join(engineeringRoot, 'catalog', 'waiver-ledger.json');
const waiverCanonicalOriginal = fs.readFileSync(waiverCanonical, 'utf8');
const waiverMirrorOriginal = fs.readFileSync(waiverMirror, 'utf8');
const waiverFixtures = [
  [{ id: 'unknown-asset', asset_uid: 'does_not_exist', gate: 'G-B-04', reason: 'fixture', scope: ['test'], approver: 'lihan', opened_at: '2026-07-01T00:00:00Z', expires_at: '2026-12-01T00:00:00Z', status: 'open' }],
  [{ id: 'expired-open', asset_uid: 'rrc_polyphase_fir', gate: 'G-B-04', reason: 'fixture', scope: ['test'], approver: 'lihan', opened_at: '2026-07-01T00:00:00Z', expires_at: '2026-01-01T00:00:00Z', status: 'open' }],
  [{ id: 'deny-open', asset_uid: 'rrc_polyphase_fir', gate: 'G-A-00', reason: 'fixture', scope: ['test'], approver: 'lihan', opened_at: '2026-07-01T00:00:00Z', expires_at: '2026-12-01T00:00:00Z', status: 'open' }],
  [{ id: 'incomplete', asset_uid: 'rrc_polyphase_fir', gate: 'G-B-04', reason: 'fixture', scope: [], approver: '', opened_at: '', expires_at: '', status: 'open' }],
];
try {
  for (const entries of waiverFixtures) {
    const fixture = { schema_version: '1.0', entries };
    fs.writeFileSync(waiverCanonical, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    fs.writeFileSync(waiverMirror, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    assert(waiverValidate(engineeringRoot, new Date('2026-07-26T00:00:00Z')).length > 0, 'invalid waiver fixture must be RED');
  }
} finally {
  fs.writeFileSync(waiverCanonical, waiverCanonicalOriginal, 'utf8');
  fs.writeFileSync(waiverMirror, waiverMirrorOriginal, 'utf8');
}
assert.equal(waiverValidate(engineeringRoot).length, 0, 'waiver ledger must be restored to GREEN after fixtures');

const registry = JSON.parse(fs.readFileSync(path.join(engineeringRoot, 'integration', 'registry.json'), 'utf8'));
assert.equal(registry.schema_version, '1.1');
assert.equal(new Set(registry.entries.map((entry) => entry.id)).size, scan.assets.length);
for (const entry of registry.entries) {
  for (const field of ['id', 'project', 'project_ref', 'asset_uid', 'version_pinned', 'config', 'integrated_at', 'status', 'issues']) assert(entry[field] !== undefined, `registry ${entry.asset_uid} must include ${field}`);
}
const trueCatalog = JSON.parse(fs.readFileSync(path.join(engineeringRoot, 'catalog', 'catalog.json'), 'utf8'));
const rrcCatalog = trueCatalog.assets.find((asset) => asset.asset_uid === 'rrc_polyphase_fir');
const rrcRegistry = registry.entries.find((entry) => entry.asset_uid === 'rrc_polyphase_fir');
assert(rrcCatalog.used_by.includes('cbb/rrc_polyphase_fir/tb/tb_rrc_polyphase_fir.sv'));
assert(rrcCatalog.badge_gap.includes('board-validation'));
assert.deepEqual(rrcRegistry.config, { DATA_W: 16, COEFF_W: 16, ACC_W: 38, SPS: 4, TAPS_PP: 9 });

const lineageScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-lineage-red-'));
try {
  const sourcePath = path.join(lineageScratch, 'cbb', 'cert', 'rtl', 'module.sv');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, 'module module; endmodule\n', 'utf8');
  writeJson(path.join(lineageScratch, 'cbb', 'cert', 'manifest.json'), {
    ...minimalManifest('cert', 'certified'),
    version: '2.0.0',
    sources: [{ path: 'rtl/module.sv', role: 'rtl', sha256: '0'.repeat(64) }],
    lineage: { base_version: '1.0.0', changelog: 'CHANGELOG.md' },
  });
  writeJson(path.join(lineageScratch, 'cbb', 'cert', 'CHANGELOG.md'), { placeholder: true });
  const lineageErrors = lineageCheck(lineageScratch);
  assert(lineageErrors.some((error) => /source sha drift/.test(error)), 'certified source hash drift must be RED');
  assert(lineageErrors.some((error) => /BREAKING/.test(error)), 'major lineage bump without BREAKING must be RED');
} finally {
  fs.rmSync(lineageScratch, { recursive: true, force: true });
}

// 判"有按版本归档的快照", 不判某个具体版本号。
//
// 原先写死 rrc@0.4.0 与 ldpc@0.1.0; ldpc 现存最早快照是 1.0.0, 0.1.0 从来不在树里,
// 这条注定失败, 同样被更早的 ENOENT 硬崩挡着从未跑到。写死版本号必随版本推进而腐坏,
// 而本条要守的契约是"快照按版本归档且被跟踪", 与具体版本无关。逐份内容的校验由
// 紧随其后的 --verify-all 负责。
for (const assetUid of ['rrc_polyphase_fir', 'ldpc_codec']) {
  const assetEvidenceDir = path.join(engineeringRoot, 'evidence', assetUid);
  assert(fs.existsSync(assetEvidenceDir), `authoritative ${assetUid} evidence directory must exist`);
  const versioned = fs.readdirSync(assetEvidenceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(entry.name))
    .filter((entry) => fs.existsSync(path.join(assetEvidenceDir, entry.name, 'SNAPSHOT.json')));
  assert(versioned.length > 0, `authoritative ${assetUid} snapshot must be versioned and tracked`);
}
const allSnapshots = cp.spawnSync(process.execPath, [path.join(engineeringRoot, 'tools', 'evidence-snapshot.cjs'), '--root', engineeringRoot, '--verify-all'], { cwd: engineeringRoot, encoding: 'utf8' });
assert.equal(allSnapshots.status, 0, `all authoritative snapshots must verify: ${allSnapshots.stderr || allSnapshots.stdout}`);
// docs/plans/F-1-synch-cfo.md 与 F-2-ofdm-fft.md 已随三份治理文档一并废止:
// 整个 docs/plans/ 目录从未入库(git 全历史无记录), 与它们同批的断言出自 272899f
// 那次未经复核的遗留落盘。判定同 05430ce —— 不补写不存在的计划文档, 删断言。
for (const file of [
  'tools/lib/default_nettype_none.vh',
  'tools/lib/default_nettype_wire.vh',
  'docs/governance/new-asset-intake-SOP.md',
]) assert(fs.existsSync(path.join(engineeringRoot, file)), `${file} must be tracked as P3 support evidence`);
assert(fs.readFileSync(path.join(engineeringRoot, 'tools/lib/default_nettype_none.vh'), 'utf8').includes('`default_nettype none'));
assert(fs.readFileSync(path.join(engineeringRoot, 'tools/lib/default_nettype_wire.vh'), 'utf8').includes('`default_nettype wire'));
console.log('ok 11 - exact P2 evidence/render/ledger/knowledge/redline contracts');
console.log('ok 12 - P3/P4 registry, lineage, maintenance and waiver guards');
