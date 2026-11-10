#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  LEVEL_RANK,
  evaluateDrift,
  scanRepository,
} = require('./catalog-gen.cjs');
const { validate: validateRegistry } = require('./integration-registry.cjs');
const { check: checkLineage } = require('./lineage-check.cjs');

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.do', '.hex', '.json', '.m', '.md', '.py', '.sdc', '.sv', '.svh',
  '.tcl', '.txt', '.v', '.vhd', '.vhdl', '.vh', '.xdc',
]);

function slash(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function canonicalBytes(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return bytes;
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function canonicalFileHash(filePath) {
  return crypto.createHash('sha256').update(canonicalBytes(filePath)).digest('hex');
}

function auditFinding(code, asset, message, extra = {}) {
  return {
    code,
    asset_uid: asset.asset_uid || null,
    dir: asset.dir,
    message,
    ...extra,
  };
}

function effectiveRank(asset) {
  const declared = LEVEL_RANK[asset.level];
  const cleared = asset.gate_results ? LEVEL_RANK[asset.gate_results.cleared_level] : undefined;
  return Math.max(Number.isFinite(declared) ? declared : -1, Number.isFinite(cleared) ? cleared : -1);
}

function readLedger(engineeringRoot) {
  const ledgerPaths = [
    path.join(engineeringRoot, 'var', 'cbb', 'waiver-ledger.json'),
    path.join(engineeringRoot, 'catalog', 'waiver-ledger.json'),
  ];
  for (const ledgerPath of ledgerPaths) {
    if (!fs.existsSync(ledgerPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : []);
    } catch {
      return [];
    }
  }
  return [];
}

function auditRepository(engineeringRoot) {
  const scan = scanRepository(engineeringRoot);
  const drift = evaluateDrift(scan);
  const red = [];
  const yellow = [];
  const ledger = readLedger(scan.root);

  for (const item of [...drift.red, ...drift.yellow]) {
    if (!['D1', 'D3'].includes(item.code)) continue;
    const target = drift.red.includes(item) ? red : yellow;
    target.push({ ...item, code: 'A1', source_code: item.code });
  }

  for (const asset of scan.assets) {
    const packageDir = path.dirname(asset.manifest_path);
    const readmePath = path.join(packageDir, 'README.md');
    const changelogPath = path.join(packageDir, 'CHANGELOG.md');
    const limitationsPath = path.join(packageDir, 'docs', 'limitations.md');

    if (asset.kind === 'rtl') {
      if (!fs.existsSync(readmePath)) {
        red.push(auditFinding('A4', asset, 'README.md is missing'));
      } else {
        const readme = fs.readFileSync(readmePath, 'utf8');
        const marker = readme.match(/<!--\s*asset-status:\s*([a-z-]+)\s+v([0-9]+\.[0-9]+\.[0-9]+)\s*-->/i);
        if (!marker) {
          yellow.push(auditFinding('A2', asset, 'asset-status marker is missing', { path: slash(path.relative(scan.root, readmePath)) }));
        } else if (marker[1] !== asset.level || marker[2] !== asset.version) {
          red.push(auditFinding('A2', asset, `asset-status marker ${marker[1]} v${marker[2]} does not match ${asset.level} v${asset.version}`, { path: slash(path.relative(scan.root, readmePath)) }));
        }
        if (asset.gate_results) {
          const gateStatus = new Map((asset.gate_results.gates || []).map((gate) => [gate.id, gate.status]));
          const lines = readme.split(/\r?\n/);
          lines.forEach((line, index) => {
            const gateIds = line.match(/G-[A-Z0-9-]+/g) || [];
            const negativeClaim = /(未修复|阻塞|blocked|未通过|无法通过|fail(?:ed)?)/i.test(line);
            const positiveClaim = /(?:^|[\s|:：])(?:pass(?:ed)?|通过|全绿)(?:[\s|,，。]|$)/i.test(line);
            const historicalContext = /(历史|原先|此前|修复前|曾经|补上.+后|before|after)/i.test(line);
            const namesPassedGate = negativeClaim && !historicalContext
              && gateIds.some((gateId) => ['pass', 'na'].includes(gateStatus.get(gateId)));
            const namesBlockedGate = positiveClaim && !historicalContext
              && gateIds.some((gateId) => ['blocked', 'fail', 'failed'].includes(gateStatus.get(gateId)));
            const genericStaleClaim = /未修复/i.test(line) && gateIds.length === 0 && asset.gate_results.blocking_at === null;
            if (namesPassedGate || namesBlockedGate || genericStaleClaim) {
              yellow.push(auditFinding('A2', asset, `possible machine/document contradiction at README.md:${index + 1}: ${line.trim()}`, { path: slash(path.relative(scan.root, readmePath)), line: index + 1 }));
            }
          });
        }
      }

      if (effectiveRank(asset) >= LEVEL_RANK.qualification) {
        if (!fs.existsSync(changelogPath)) {
          yellow.push(auditFinding('A4', asset, 'CHANGELOG.md is missing'));
        }
        if (!fs.existsSync(limitationsPath)) {
          yellow.push(auditFinding('A4', asset, 'docs/limitations.md is missing'));
        }
      }
      if (fs.existsSync(changelogPath)) {
        const changelog = fs.readFileSync(changelogPath, 'utf8');
        const topVersion = changelog.match(/^##\s+\[([0-9]+\.[0-9]+\.[0-9]+)\]/m);
        if (!topVersion || topVersion[1] !== asset.version) {
          red.push(auditFinding('A4', asset, `CHANGELOG top version ${topVersion ? topVersion[1] : 'missing'} does not match ${asset.version}`, { path: slash(path.relative(scan.root, changelogPath)) }));
        }
      }
    }

    for (const source of asset.manifest.sources || []) {
      const sourcePath = path.join(packageDir, source.path);
      let problem = null;
      if (!fs.existsSync(sourcePath)) problem = 'registered source is missing';
      else if (source.sha256 && canonicalFileHash(sourcePath) !== source.sha256) problem = 'registered source sha256 mismatch';
      if (!problem) continue;
      const target = asset.level === 'certified' ? red : yellow;
      target.push(auditFinding('A3', asset, `${problem}: ${source.path}`, { path: slash(path.relative(scan.root, sourcePath)) }));
    }

    for (const waiver of asset.manifest.waivers || []) {
      const match = ledger.some((entry) => {
        if (waiver.ledger_id) return entry.id === waiver.ledger_id;
        return entry.asset_uid === asset.asset_uid && entry.gate === waiver.gate;
      });
      if (!match) red.push(auditFinding('A5', asset, `waiver ${waiver.ledger_id || waiver.gate || '(unknown)'} has no ledger entry`));
    }
  }

  if (fs.existsSync(path.join(scan.root, 'integration', 'registry.json'))) {
    for (const message of validateRegistry(scan.root)) red.push({ code: 'A7', asset_uid: null, dir: null, message });
  }
  for (const message of checkLineage(scan.root)) red.push({ code: 'A8', asset_uid: null, dir: null, message });

  const sorter = (left, right) => `${left.code}:${left.asset_uid}:${left.path || ''}:${left.message}`
    .localeCompare(`${right.code}:${right.asset_uid}:${right.path || ''}:${right.message}`);
  red.sort(sorter);
  yellow.sort(sorter);
  return {
    schema_version: '1.0',
    summary: { assets: scan.assets.length, red: red.length, yellow: yellow.length },
    red,
    yellow,
    known_legacy: [
      'P1 treats missing CHANGELOG and limitations as YELLOW for effective qualification+ RTL assets.',
      'Golden-model assets are retained as correctness evidence and do not use the RTL three-document rule in P1.',
    ],
  };
}

function writeAuditReport(engineeringRoot, report) {
  const reportPath = path.join(path.resolve(engineeringRoot), 'var', 'audit', 'audit-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return reportPath;
}

function printReport(report) {
  console.log(`[asset-audit] assets=${report.summary.assets} RED=${report.summary.red} YELLOW=${report.summary.yellow}`);
  for (const severity of ['red', 'yellow']) {
    for (const finding of report[severity]) {
      console.log(`${severity.toUpperCase()} ${finding.code} ${finding.asset_uid || '-'}: ${finding.message}`);
    }
  }
  for (const legacy of report.known_legacy) console.log(`KNOWN-LEGACY ${legacy}`);
}

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const engineeringRoot = rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..');
  if (!engineeringRoot) {
    console.error('[asset-audit] --root requires a path');
    return 2;
  }
  try {
    const report = auditRepository(engineeringRoot);
    writeAuditReport(engineeringRoot, report);
    printReport(report);
    return report.red.length || (argv.includes('--strict') && report.yellow.length) ? 1 : 0;
  } catch (error) {
    console.error(`[asset-audit] ${error.message}`);
    return 2;
  }
}

module.exports = {
  auditRepository,
  canonicalFileHash,
  main,
  writeAuditReport,
};

if (require.main === module) process.exitCode = main();
