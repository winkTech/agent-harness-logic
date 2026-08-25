#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { scanRepository } = require('./catalog-gen.cjs');

const MAX_BYTES = 1024 * 1024;
// cdc.rpt / clock-interaction.rpt / clocks-cdc.rpt: 真实多时钟域资产 (如 cdc_sync)
// 的 report_cdc 原始报告 —— cdc-report.json 是其摘要, 原报告一并锁定才可复核
const ALLOWED = /^(?:gate-results\.json|RL-OUT\.json|(?:G|CS|RL-OUT)-[A-Z0-9./_-]+\.json|envelope-check\.json|alignment-report\.json|tb-selfcheck\.json|reset-sim\.json|cdc-report\.json|synthesis-timing-evidence\.json|timing-summary\.rpt|utilization\.rpt|clocks\.rpt|cdc\.rpt|clock-interaction\.rpt|clocks-cdc\.rpt|synth-meta\.json|stability[\\/][^\\/]+\.json|hold-closure\.json|route-timing-summary\.rpt|route-utilization\.rpt|route-drc\.rpt)$/;
// trace/ = bit-true 对拍原始数据(hex/txt, MB 级), 性质同波形: 可由 TB+golden 复现,
// 摘要在 alignment-report.json 里 —— 不入快照
// rtl_*_out.hex = TB 的 RTL 输出转储, 性质同 trace/: 可由 TB+向量复现, 判定摘要在
// alignment-report.json 里, 不入快照。(channel_est_top 的 tb_chEst_cosim 会产它;
// 它原先被写进 golden 的权威向量目录, 2026-08-02 改写到证据目录后才撞上白名单。)
// `synth_<pid>.backup.log` 是 Vivado 自留的综合日志副本, 与已排除的 synth.log 同类
// (可由 pg-synth 重跑再生, 判定摘要在 envelope-check.json / synthesis-timing-evidence.json)。
// 原 `backup` 一条只匹配**目录段**, 匹配不到这种文件名, 2026-08-02 补 `*.backup.log`。
const EXCLUDED = /(?:^|[\\/])(?:synth\.log|[A-Za-z0-9_]*\.backup\.log|backup|work|waves?|trace|rtl_[A-Za-z0-9_]*_out\.hex|.*\.(?:wlf|vcd|vpd|fsdb))(?=$|[\\/])/i;

function canonicalBytes(file) {
  const bytes = fs.readFileSync(file);
  return /\.(?:json|rpt|txt|log|tcl|xdc|sv|v|m)$/i.test(file)
    ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    : bytes;
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function gitHead(root) {
  try {
    // stderr 丢弃: root 不是 git 仓库时 (如测试固件) git 会往父进程 stderr 打 fatal,
    // 看着像失败其实已被 catch 兜住 —— 返回 null 才是这里的契约。
    return cp.execFileSync('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function manifestFor(scan, uid) {
  const asset = scan.assets.find((item) => item.asset_uid === uid);
  if (!asset) throw new Error(`unknown asset_uid: ${uid}`);
  return asset;
}

// 门禁机器产物: 逐门 JSON 与 gate-results 聚合。它们随门禁清单本身变动而再生,
// 与被测资产的行为无关 —— 新增一道门会让全库这些文件变, 但仿真/综合/对拍证据分毫未动。
// 重封 (--reseal) 只容许这一类差异; 实质证据一旦变动必须升版重取。
const GATE_PRODUCT = /^(?:gate-results\.json|RL-OUT\.json|(?:G|CS)-[A-Z0-9./_-]+\.json)$/;

function snapshotSpec(scan, uid, version, { allowExisting = false } = {}) {
  const asset = manifestFor(scan, uid);
  if (version && asset.version !== version) throw new Error(`${uid} manifest version=${asset.version}, requested=${version}`);
  const sourceDir = path.join(scan.root, 'var', 'gates', 'pg', uid);
  if (!fs.existsSync(sourceDir)) throw new Error(`evidence source missing: var/gates/pg/${uid}`);
  const destination = path.join(scan.root, 'evidence', uid, asset.version);
  if (fs.existsSync(destination) && !allowExisting) throw new Error(`snapshot destination exists; bump version before resnapshot: ${path.relative(scan.root, destination)}`);
  return { asset, sourceDir, destination };
}

function sourceFiles(dir, relative = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = path.join(relative, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) sourceFiles(abs, rel, out);
    else if (entry.isFile() && !EXCLUDED.test(rel) && ALLOWED.test(rel)) out.push({ abs, rel });
  }
  return out;
}

function allFiles(dir, relative = '', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = path.join(relative, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) allFiles(abs, rel, out);
    else if (entry.isFile()) out.push({ abs, rel });
  }
  return out;
}

function synthWarnings(sourceDir) {
  const log = path.join(sourceDir, 'synth.log');
  if (!fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((line) => /Synth 8-(?:6896|3848)/.test(line));
  return lines.length ? { source: 'synth.log', lines } : null;
}

// files[] 的计算 —— --write 与 --reseal 共用, 避免两条路径算法漂移。
function evidenceFiles(sourceDir) {
  const unexpected = allFiles(sourceDir).filter(({ rel }) => !EXCLUDED.test(rel) && !ALLOWED.test(rel));
  if (unexpected.length) throw new Error(`non-whitelisted evidence file: ${unexpected.map((file) => file.rel).join(', ')}`);
  const warning = synthWarnings(sourceDir);
  const files = sourceFiles(sourceDir).map(({ abs, rel }) => {
    const bytes = canonicalBytes(abs);
    return { path: rel, sha256: sha256(bytes), bytes: bytes.length };
  });
  if (warning) {
    const warningBytes = Buffer.from(`${JSON.stringify(warning, null, 2)}\n`, 'utf8');
    files.push({ path: 'synth-warnings.json', sha256: sha256(warningBytes), bytes: warningBytes.length });
    files.sort((a, b) => a.path.localeCompare(b.path));
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > MAX_BYTES) throw new Error(`snapshot exceeds 1MB guard: ${total} bytes`);
  return { files, warning };
}

function makeSnapshot(scan, uid, version) {
  const { asset, sourceDir, destination } = snapshotSpec(scan, uid, version);
  const { files, warning } = evidenceFiles(sourceDir);
  fs.mkdirSync(destination, { recursive: true });
  if (warning) fs.writeFileSync(path.join(destination, 'synth-warnings.json'), `${JSON.stringify(warning, null, 2)}\n`, 'utf8');
  const gatePath = path.join(sourceDir, 'gate-results.json');
  const gateSummary = fs.existsSync(gatePath) ? JSON.parse(fs.readFileSync(gatePath, 'utf8')) : null;
  const manifestBytes = canonicalBytes(asset.manifest_path);
  const snapshot = {
    schema_version: '1.0',
    asset_uid: uid,
    version: asset.version,
    created_at: new Date().toISOString(),
    git_head: gitHead(scan.root),
    manifest_sha256: sha256(manifestBytes),
    evidence_source: `var/gates/pg/${uid}`,
    files,
    gate_summary: gateSummary,
  };
  fs.writeFileSync(path.join(destination, 'SNAPSHOT.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

// 受限重封 —— 治理机制自身变动 (如新增一道门) 会让全库的门禁产物再生, 但被测资产
// 的行为证据分毫未动。此时"升版重取"会让版本史谎称设计改过, "删了重写"会把重封这件
// 事本身抹掉。故给一条窄路径: 只容许门禁产物差异, 实质证据一旦变动即拒绝; 重封原因、
// 时间、旧 manifest 哈希与逐项差异写进 SNAPSHOT.json 的 reseal_history, 可独立复核。
// (owner 裁定 2026-08-03; 同类情形先例见 integration/registry.json ITG-0002 ldpc 1.0.0)
function resealSnapshot(root, uid, reason) {
  if (!reason || !String(reason).trim()) throw new Error('--reseal requires --reason "<why>"');
  const scan = scanRepository(root);
  const { asset, sourceDir, destination } = snapshotSpec(scan, uid, undefined, { allowExisting: true });
  const snapshotPath = path.join(destination, 'SNAPSHOT.json');
  if (!fs.existsSync(snapshotPath)) throw new Error(`no sealed snapshot to reseal: ${path.relative(scan.root, snapshotPath)} (use --write)`);
  const sealed = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (!Array.isArray(sealed.files)) throw new Error('sealed snapshot has no files[]');
  const { files, warning } = evidenceFiles(sourceDir);

  const before = new Map(sealed.files.map((file) => [file.path, file]));
  const after = new Map(files.map((file) => [file.path, file]));
  const changed = [];
  for (const [rel, file] of after) {
    const prior = before.get(rel);
    if (!prior) changed.push(`+${rel}`);
    else if (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes) changed.push(`~${rel}`);
  }
  for (const rel of before.keys()) if (!after.has(rel)) changed.push(`-${rel}`);
  changed.sort();
  const substantive = changed.filter((entry) => !GATE_PRODUCT.test(entry.slice(1)));
  if (substantive.length) throw new Error(`substantive evidence changed — reseal refused, bump version instead: ${substantive.join(', ')}`);

  const manifestHash = sha256(canonicalBytes(asset.manifest_path));
  if (!changed.length && manifestHash === sealed.manifest_sha256) throw new Error('no drift — nothing to reseal');

  const gatePath = path.join(sourceDir, 'gate-results.json');
  const history = Array.isArray(sealed.reseal_history) ? sealed.reseal_history.slice() : [];
  history.push({
    at: new Date().toISOString(),
    reason: String(reason).trim(),
    prior_manifest_sha256: sealed.manifest_sha256,
    prior_git_head: sealed.git_head || null,
    changed_evidence: changed,
  });
  if (warning) fs.writeFileSync(path.join(destination, 'synth-warnings.json'), `${JSON.stringify(warning, null, 2)}\n`, 'utf8');
  const snapshot = {
    ...sealed,                                     // created_at 等原封存事实保留
    git_head: gitHead(scan.root),
    manifest_sha256: manifestHash,
    files,
    gate_summary: fs.existsSync(gatePath) ? JSON.parse(fs.readFileSync(gatePath, 'utf8')) : null,
    reseal_history: history,
  };
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return { snapshot, changed };
}

function verifySnapshot(root, uid, version) {
  const scan = scanRepository(root);
  const asset = manifestFor(scan, uid);
  const actualVersion = version || asset.version;
  const snapshotDir = path.join(root, 'evidence', uid, actualVersion);
  const snapshotPath = path.join(snapshotDir, 'SNAPSHOT.json');
  if (!fs.existsSync(snapshotPath)) throw new Error(`snapshot missing: ${path.relative(root, snapshotPath)}`);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (!Array.isArray(snapshot.files)) throw new Error('snapshot files[] is required');
  if (snapshot.asset_uid !== uid || snapshot.version !== actualVersion) throw new Error('snapshot uid/version mismatch');
  // A versioned snapshot is immutable. Once the manifest advances, the old
  // evidence source directory is intentionally allowed to move on; historical
  // verification checks the sealed snapshot envelope without pretending it is
  // current-source replay evidence.
  if (actualVersion !== asset.version) {
    if (new Set(snapshot.files.map((file) => file.path)).size !== snapshot.files.length) throw new Error('duplicate historical snapshot file path');
    const snapshotEntries = fs.readdirSync(snapshotDir, { withFileTypes: true }).map((entry) => entry.name);
    for (const name of snapshotEntries) if (name !== 'SNAPSHOT.json') throw new Error(`extra historical snapshot file: ${name}`);
    return { ...snapshot, historical: true, historical_reason: `manifest advanced to ${asset.version}; current-source replay is not asserted` };
  }
  const manifestHash = sha256(canonicalBytes(asset.manifest_path));
  if (snapshot.manifest_sha256 !== manifestHash) throw new Error('manifest sha256 drifted after snapshot');
  const sourceDir = path.join(root, 'var', 'gates', 'pg', uid);
  const listed = new Set(snapshot.files.map((file) => file.path));
  if (listed.size !== snapshot.files.length) throw new Error('duplicate snapshot file path');
  const expectedSource = sourceFiles(sourceDir).map((item) => item.rel);
  const unexpected = allFiles(sourceDir).filter(({ rel }) => !EXCLUDED.test(rel) && !ALLOWED.test(rel));
  if (unexpected.length) throw new Error(`non-whitelisted evidence file: ${unexpected.map((file) => file.rel).join(', ')}`);
  for (const rel of expectedSource) if (!listed.has(rel)) throw new Error(`unlisted evidence file: ${rel}`);
  const snapshotEntries = fs.readdirSync(snapshotDir, { withFileTypes: true }).map((entry) => entry.name);
  for (const name of snapshotEntries) if (!['SNAPSHOT.json', 'synth-warnings.json'].includes(name)) throw new Error(`extra snapshot file: ${name}`);
  for (const file of snapshot.files) {
    const abs = file.path === 'synth-warnings.json' ? path.join(snapshotDir, file.path) : path.join(sourceDir, file.path);
    if (!fs.existsSync(abs)) throw new Error(`snapshot file missing: ${file.path}`);
    const bytes = canonicalBytes(abs);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`snapshot hash mismatch: ${file.path}`);
  }
  const total = snapshot.files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > MAX_BYTES) throw new Error('snapshot exceeds 1MB guard');
  return snapshot;
}

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..'));
  const verifyIndex = argv.indexOf('--verify');
  try {
    if (argv.includes('--check')) {
      const evidenceRoot = path.join(root, 'evidence');
      let count = 0;
      if (fs.existsSync(evidenceRoot)) for (const uid of fs.readdirSync(evidenceRoot)) {
        const uidDir = path.join(evidenceRoot, uid);
        if (!fs.statSync(uidDir).isDirectory()) continue;
        for (const version of fs.readdirSync(uidDir)) if (fs.existsSync(path.join(uidDir, version, 'SNAPSHOT.json'))) {
          verifySnapshot(root, uid, version);
          count += 1;
        }
      }
      console.log(`[evidence-snapshot] check passed snapshots=${count}`);
      return 0;
    }
    if (verifyIndex >= 0) {
      const ref = argv[verifyIndex + 1];
      const match = String(ref || '').match(/^([a-z0-9_]+)(?:@([0-9]+\.[0-9]+\.[0-9]+))?$/);
      if (!match) throw new Error('--verify requires <uid>[@version]');
      verifySnapshot(root, match[1], match[2]);
      const result = verifySnapshot(root, match[1], match[2]);
      console.log(`[evidence-snapshot] verified ${match[1]}@${match[2] || 'manifest'}${result.historical ? ' (historical envelope)' : ''}`);
      return 0;
    }
    if (argv.includes('--verify-all')) {
      const evidenceRoot = path.join(root, 'evidence');
      const refs = [];
      if (fs.existsSync(evidenceRoot)) for (const uid of fs.readdirSync(evidenceRoot)) {
        const uidDir = path.join(evidenceRoot, uid);
        if (!fs.statSync(uidDir).isDirectory()) continue;
        for (const version of fs.readdirSync(uidDir)) if (fs.existsSync(path.join(uidDir, version, 'SNAPSHOT.json'))) refs.push([uid, version]);
      }
      if (!refs.length) throw new Error('no versioned snapshots found');
      const results = refs.map(([uid, version]) => verifySnapshot(root, uid, version));
      console.log(`[evidence-snapshot] verified ${refs.length} snapshots historical=${results.filter((result) => result.historical).length}`);
      return 0;
    }
    const reasonIndex = argv.indexOf('--reason');
    // 跳过的是"选项的取值位", 不是固定下标。此处必须先判 >= 0 —— 否则 -1 + 1 = 0
    // 会把 argv[0] 当成某个选项的取值排除掉, 而 usage 里写的正是 `<uid> --write`,
    // 即 uid 就在 argv[0]。结果是文档里的调用形式必然报 usage 错。
    const skip = new Set([rootIndex, reasonIndex].filter((i) => i >= 0).map((i) => i + 1));
    const uid = argv.find((arg, index) => !arg.startsWith('-') && !skip.has(index));
    if (uid && argv.includes('--reseal')) {
      const { snapshot, changed } = resealSnapshot(root, uid, reasonIndex >= 0 ? argv[reasonIndex + 1] : '');
      console.log(`[evidence-snapshot] resealed ${snapshot.asset_uid}@${snapshot.version} (门禁产物差异 ${changed.length} 项, 实质证据未变)`);
      return 0;
    }
    if (!uid || !argv.includes('--write')) throw new Error('usage: evidence-snapshot.cjs <uid> --write --root <engineering-assets> | <uid> --reseal --reason "<why>" | --verify <uid>@<version> | --verify-all');
    const snapshot = makeSnapshot(scanRepository(root), uid);
    console.log(`[evidence-snapshot] created ${snapshot.asset_uid}@${snapshot.version}`);
    return 0;
  } catch (error) {
    console.error(`[evidence-snapshot] ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { allFiles, canonicalBytes, evidenceFiles, main, makeSnapshot, resealSnapshot, sourceFiles, verifySnapshot };
