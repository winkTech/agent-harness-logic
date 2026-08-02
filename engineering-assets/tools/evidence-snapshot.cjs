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
const EXCLUDED = /(?:^|[\\/])(?:synth\.log|backup|work|waves?|trace|rtl_[A-Za-z0-9_]*_out\.hex|.*\.(?:wlf|vcd|vpd|fsdb))(?=$|[\\/])/i;

function canonicalBytes(file) {
  const bytes = fs.readFileSync(file);
  return /\.(?:json|rpt|txt|log|tcl|xdc|sv|v|m)$/i.test(file)
    ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    : bytes;
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function gitHead(root) {
  try {
    return cp.execFileSync('git', ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch { return null; }
}

function manifestFor(scan, uid) {
  const asset = scan.assets.find((item) => item.asset_uid === uid);
  if (!asset) throw new Error(`unknown asset_uid: ${uid}`);
  return asset;
}

function snapshotSpec(scan, uid, version) {
  const asset = manifestFor(scan, uid);
  if (version && asset.version !== version) throw new Error(`${uid} manifest version=${asset.version}, requested=${version}`);
  const sourceDir = path.join(scan.root, 'var', 'gates', 'pg', uid);
  if (!fs.existsSync(sourceDir)) throw new Error(`evidence source missing: var/gates/pg/${uid}`);
  const destination = path.join(scan.root, 'evidence', uid, asset.version);
  if (fs.existsSync(destination)) throw new Error(`snapshot destination exists; bump version before resnapshot: ${path.relative(scan.root, destination)}`);
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

function makeSnapshot(scan, uid, version) {
  const { asset, sourceDir, destination } = snapshotSpec(scan, uid, version);
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
    const uid = argv.find((arg, index) => !arg.startsWith('-') && index !== rootIndex + 1);
    if (!uid || !argv.includes('--write')) throw new Error('usage: evidence-snapshot.cjs <uid> --write --root <engineering-assets> | --verify <uid>@<version> | --verify-all');
    const snapshot = makeSnapshot(scanRepository(root), uid);
    console.log(`[evidence-snapshot] created ${snapshot.asset_uid}@${snapshot.version}`);
    return 0;
  } catch (error) {
    console.error(`[evidence-snapshot] ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { allFiles, canonicalBytes, main, makeSnapshot, sourceFiles, verifySnapshot };
