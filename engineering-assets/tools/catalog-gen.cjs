#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANAGED_ROOTS = ['cbb', 'incubator', 'models'];
const MAX_MANIFEST_DEPTH = 4;
const LEVEL_RANK = { reference: 0, intake: 1, qualification: 2, certified: 3 };

function slash(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function walkForManifests(dir, depth, out) {
  if (!fs.existsSync(dir) || depth > MAX_MANIFEST_DEPTH) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walkForManifests(absolute, depth + 1, out);
    else if (entry.isFile() && entry.name === 'manifest.json') out.push(absolute);
  }
}

function discoverManifestPaths(engineeringRoot) {
  const manifestPaths = [];
  for (const root of MANAGED_ROOTS) {
    walkForManifests(path.join(engineeringRoot, root), 1, manifestPaths);
  }
  return manifestPaths;
}

function readManifest(manifestPath, engineeringRoot) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${slash(path.relative(engineeringRoot, manifestPath))}: invalid manifest JSON: ${error.message}`);
  }
  return {
    asset_uid: manifest.asset_uid,
    name: manifest.name,
    kind: manifest.kind || 'rtl',
    version: manifest.version || null,
    owner: manifest.owner,
    level: manifest.maturity && manifest.maturity.level,
    dir: slash(path.relative(engineeringRoot, path.dirname(manifestPath))),
    manifest,
    manifest_path: manifestPath,
  };
}

function findUnregisteredRoots(engineeringRoot) {
  const referenceRoot = path.join(engineeringRoot, 'reference-assets');
  if (!fs.existsSync(referenceRoot)) return [];
  return fs.readdirSync(referenceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `reference-assets/${entry.name}`)
    .sort();
}

function scanRepository(engineeringRoot) {
  const root = path.resolve(engineeringRoot);
  const assets = discoverManifestPaths(root)
    .map((manifestPath) => readManifest(manifestPath, root))
    .sort((left, right) => String(left.asset_uid).localeCompare(String(right.asset_uid)));
  for (const asset of assets) {
    const gatePath = path.join(root, 'var', 'gates', 'pg', String(asset.asset_uid), 'gate-results.json');
    asset.gate_results_path = gatePath;
    asset.gate_results = null;
    if (fs.existsSync(gatePath)) {
      try {
        asset.gate_results = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
      } catch (error) {
        asset.gate_results_error = error.message;
      }
    }
  }
  return { root, assets, unregistered_roots: findUnregisteredRoots(root) };
}

function finding(code, asset, message) {
  return { code, asset_uid: asset.asset_uid || null, dir: asset.dir, message };
}

function evidencePath(scan, reference) {
  if (path.isAbsolute(reference)) return reference;
  const normalized = slash(reference);
  if (normalized === 'engineering-assets' || normalized.startsWith('engineering-assets/')) {
    return path.resolve(scan.root, '..', reference);
  }
  return path.resolve(scan.root, reference);
}

function evaluateDrift(scan) {
  const red = [];
  const yellow = [];
  const byUid = new Map();
  for (const asset of scan.assets) {
    if (!byUid.has(asset.asset_uid)) byUid.set(asset.asset_uid, []);
    byUid.get(asset.asset_uid).push(asset);

    const inCbb = asset.dir.startsWith('cbb/');
    const inIncubator = asset.dir.startsWith('incubator/');
    const inModels = asset.dir.startsWith('models/');
    if ((inCbb && asset.level !== 'certified')
      || (inIncubator && !['intake', 'qualification'].includes(asset.level))
      || (inModels && asset.kind !== 'golden-model')) {
      red.push(finding('D1', asset, `directory ${asset.dir} is incompatible with level=${asset.level} kind=${asset.kind}`));
    }

    if (asset.gate_results_error) {
      red.push(finding('D3', asset, `invalid gate-results.json: ${asset.gate_results_error}`));
    } else if (asset.level === 'certified' && !asset.gate_results) {
      red.push(finding('D3', asset, 'certified asset has no gate-results.json'));
    } else if (asset.gate_results && asset.level !== 'deprecated') {
      const cleared = asset.gate_results.cleared_level;
      if (LEVEL_RANK[asset.level] > LEVEL_RANK[cleared]) {
        red.push(finding('D3', asset, `declared level ${asset.level} exceeds machine-cleared ${cleared}`));
      } else if (LEVEL_RANK[asset.level] < LEVEL_RANK[cleared]) {
        yellow.push(finding('D3', asset, `declared level ${asset.level} is below machine-cleared ${cleared}`));
      }
    }

    const evidenceRef = asset.manifest.maturity && asset.manifest.maturity.evidence_ref;
    if (evidenceRef && !fs.existsSync(evidencePath(scan, evidenceRef))) {
      red.push(finding('D4', asset, `maturity.evidence_ref does not exist: ${evidenceRef}`));
    }
  }

  for (const [assetUid, assets] of byUid) {
    if (!assetUid || assets.length < 2) continue;
    for (const asset of assets) red.push(finding('D2', asset, `duplicate asset_uid ${assetUid}`));
  }

  const sorter = (left, right) => `${left.code}:${left.asset_uid}:${left.dir}`.localeCompare(`${right.code}:${right.asset_uid}:${right.dir}`);
  red.sort(sorter);
  yellow.sort(sorter);
  return { red, yellow };
}

function documentState(asset) {
  const packageDir = path.dirname(asset.manifest_path);
  return {
    readme: fs.existsSync(path.join(packageDir, 'README.md')),
    changelog: fs.existsSync(path.join(packageDir, 'CHANGELOG.md')),
    limitations: fs.existsSync(path.join(packageDir, 'docs', 'limitations.md')),
  };
}

function publicAsset(asset, usedBy = {}, registryMeta = {}) {
  const manifest = asset.manifest;
  const gateResults = asset.gate_results;
  const target = manifest.constraints && manifest.constraints.target;
  return {
    asset_uid: asset.asset_uid,
    name: asset.name,
    kind: asset.kind,
    version: asset.version,
    owner: asset.owner,
    level: asset.level,
    dir: asset.dir,
    top: manifest.top || null,
    golden_model_ref: manifest.golden_model_ref || null,
    fidelity: manifest.fidelity ? manifest.fidelity.status : null,
    device: manifest.device ? manifest.device.part || null : null,
    target_fmax: target ? target.fmax || null : null,
    signoff_at: manifest.signoff ? manifest.signoff.at || null : null,
    waiver_count: Array.isArray(manifest.waivers) ? manifest.waivers.length : 0,
    used_by: [...new Set(usedBy[asset.asset_uid] || [])].sort(),
    badge_gap: [...new Set([
      ...(gateResults
      ? gateResults.gates.filter((gate) => gate.must && !['pass', 'na', 'waived'].includes(gate.status)).map((gate) => gate.id).sort()
      : (asset.level === 'certified' ? ['gate-results'] : [])),
      ...(registryMeta[asset.asset_uid]?.badge_gap || []),
    ])].sort(),
    documents: documentState(asset),
    gates: {
      cleared_level: gateResults ? gateResults.cleared_level || null : null,
      blocking_at: gateResults ? gateResults.blocking_at || null : null,
      pass_count: gateResults && Array.isArray(gateResults.gates)
        ? gateResults.gates.filter((gate) => gate.status === 'pass').length
        : 0,
    },
  };
}

function buildCatalog(scan) {
  const drift = evaluateDrift(scan);
  const usedBy = {};
  const registryMeta = {};
  for (const asset of scan.assets) {
    const golden = asset.manifest.golden_model_ref;
    if (golden) (usedBy[golden] ||= []).push(asset.asset_uid);
  }
  const registryPath = path.join(scan.root, 'integration', 'registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      for (const entry of registry.entries || []) {
        registryMeta[entry.asset_uid] = entry;
        for (const consumer of entry.consumers || []) (usedBy[entry.asset_uid] ||= []).push(consumer);
      }
    } catch {}
  }
  const assets = scan.assets.map((asset) => publicAsset(asset, usedBy, registryMeta));
  const byLevel = {};
  for (const asset of assets) byLevel[asset.level] = (byLevel[asset.level] || 0) + 1;
  return {
    schema_version: '1.0',
    summary: {
      asset_count: assets.length,
      by_level: Object.fromEntries(Object.entries(byLevel).sort(([left], [right]) => left.localeCompare(right))),
      red_count: drift.red.length,
      yellow_count: drift.yellow.length,
      unregistered_root_count: scan.unregistered_roots.length,
    },
    unregistered_roots: scan.unregistered_roots,
    drift,
    assets,
  };
}

function renderCatalogJson(scan) {
  return `${JSON.stringify(buildCatalog(scan), null, 2)}\n`;
}

function blockingText(asset) {
  if (!asset.gates.cleared_level) return 'no gate-results';
  return asset.gates.blocking_at || '—';
}

function renderCatalogMarkdown(scan) {
  const catalog = buildCatalog(scan);
  const lines = [
    '# CBB/IP Catalog',
    '',
    '> Generated from manifest.json and gate-results.json. Do not edit by hand.',
    '',
    `Assets: ${catalog.summary.asset_count} · RED: ${catalog.summary.red_count} · YELLOW: ${catalog.summary.yellow_count}`,
    '',
  ];
  const order = ['certified', 'qualification', 'intake', 'reference', 'deprecated'];
  for (const level of order) {
    const assets = catalog.assets.filter((asset) => asset.level === level);
    if (!assets.length) continue;
    lines.push(`## ${level}`, '', '| UID | Version | Kind | Directory | Machine cleared | Blocking | Used by | Badge gap |', '|---|---:|---|---|---|---|---|---|');
    for (const asset of assets) {
      lines.push(`| \`${asset.asset_uid}\` | ${asset.version || '—'} | ${asset.kind} | \`${asset.dir}\` | ${asset.gates.cleared_level || '—'} | ${blockingText(asset)} | ${asset.used_by.length || '—'} | ${asset.badge_gap.join(', ') || '—'} |`);
    }
    lines.push('');
  }
  if (catalog.unregistered_roots.length) {
    lines.push('## Unregistered roots', '');
    for (const root of catalog.unregistered_roots) lines.push(`- \`${root}\``);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function renderReadmeStatus(scan) {
  const catalog = buildCatalog(scan);
  const lines = [
    '<!-- BEGIN:CATALOG:STATUS -->',
    '| 资产 | 声明级别 | 机器达到级别 | 阻塞门 |',
    '|---|---|---|---|',
  ];
  for (const asset of catalog.assets) {
    lines.push(`| \`${asset.asset_uid}\` | ${asset.level} | ${asset.gates.cleared_level || '—'} | ${blockingText(asset)} |`);
  }
  lines.push('<!-- END:CATALOG:STATUS -->');
  return lines.join('\n');
}

function updateReadmeStatus(readme, scan) {
  const normalized = readme.replace(/\r\n/g, '\n');
  const block = renderReadmeStatus(scan);
  const marker = /<!-- BEGIN:CATALOG:STATUS -->[\s\S]*?<!-- END:CATALOG:STATUS -->/;
  if (marker.test(normalized)) return normalized.replace(marker, block);

  const lines = normalized.split('\n');
  const statusHeading = lines.findIndex((line) => line.trim() === '## 状态');
  const tableStart = lines.findIndex((line, index) => index > statusHeading && /^\|\s*资产\s*\|/.test(line));
  if (statusHeading >= 0 && tableStart >= 0) {
    let tableEnd = tableStart;
    while (tableEnd < lines.length && lines[tableEnd].startsWith('|')) tableEnd++;
    lines.splice(tableStart, tableEnd - tableStart, ...block.split('\n'));
    return lines.join('\n');
  }
  const insertion = statusHeading >= 0 ? statusHeading + 1 : lines.length;
  lines.splice(insertion, 0, '', ...block.split('\n'));
  return lines.join('\n');
}

function expectedFiles(scan, options = {}) {
  const files = new Map([
    ['catalog/catalog.json', renderCatalogJson(scan)],
    ['catalog/CATALOG.md', renderCatalogMarkdown(scan)],
  ]);
  const readmePath = path.join(scan.root, 'README.md');
  if (options.writeReadme || options.checkReadme) {
    const current = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '';
    files.set('README.md', updateReadmeStatus(current, scan));
  }
  return files;
}

function writeCatalog(scan, options = {}) {
  const files = expectedFiles(scan, options);
  for (const [relativePath, content] of files) {
    const absolutePath = path.join(scan.root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
  }
  return [...files.keys()];
}

function checkCatalog(scan, options = {}) {
  const staleFiles = [];
  for (const [relativePath, expected] of expectedFiles(scan, options)) {
    const absolutePath = path.join(scan.root, relativePath);
    const actual = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n') : null;
    if (actual !== expected) staleFiles.push(relativePath);
  }
  return { fresh: staleFiles.length === 0, stale_files: staleFiles };
}

function main(argv = process.argv.slice(2)) {
  const rootArg = argv.indexOf('--root');
  const engineeringRoot = rootArg >= 0 ? argv[rootArg + 1] : path.resolve(__dirname, '..');
  if (!engineeringRoot) {
    console.error('[catalog-gen] --root requires a path');
    return 2;
  }
  try {
    const scan = scanRepository(engineeringRoot);
    const wantsWrite = argv.includes('--write');
    const wantsCheck = argv.includes('--check');
    if (wantsWrite && wantsCheck) {
      console.error('[catalog-gen] --write and --check are mutually exclusive');
      return 2;
    }
    const readme = argv.includes('--write-readme');
    if (wantsWrite) writeCatalog(scan, { writeReadme: readme });
    const check = wantsCheck ? checkCatalog(scan, { checkReadme: readme }) : { fresh: true, stale_files: [] };
    const drift = evaluateDrift(scan);
    console.log(`[catalog-gen] assets=${scan.assets.length} red=${drift.red.length} yellow=${drift.yellow.length} unregistered_roots=${scan.unregistered_roots.length}`);
    if (!check.fresh) console.error(`[catalog-gen] stale: ${check.stale_files.join(', ')}`);
    return drift.red.length || !check.fresh ? 1 : 0;
  } catch (error) {
    console.error(`[catalog-gen] ${error.message}`);
    return 2;
  }
}

module.exports = {
  buildCatalog,
  checkCatalog,
  LEVEL_RANK,
  MAX_MANIFEST_DEPTH,
  discoverManifestPaths,
  evaluateDrift,
  renderCatalogJson,
  renderCatalogMarkdown,
  scanRepository,
  updateReadmeStatus,
  writeCatalog,
};

if (require.main === module) process.exitCode = main();
