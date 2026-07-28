#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { discoverManifestPaths } = require('./catalog-gen.cjs');

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..'));
  const manifests = discoverManifestPaths(root);
  const planned = [];
  for (const file of manifests) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!['1.0', '1.1'].includes(manifest.schema_version)) {
      console.error(`[manifest-migrate] unsupported schema_version in ${path.relative(root, file)}`);
      return 1;
    }
    if (manifest.schema_version === '1.0') planned.push({ file, manifest });
  }
  if (argv.includes('--write')) {
    for (const { file, manifest } of planned) {
      manifest.schema_version = '1.1';
      const versionedSnapshot = manifest.version && path.join(root, 'evidence', manifest.asset_uid, manifest.version, 'SNAPSHOT.json');
      if (versionedSnapshot && fs.existsSync(versionedSnapshot)) manifest.evidence_snapshot_ref = `evidence/${manifest.asset_uid}/${manifest.version}/SNAPSHOT.json`;
      else delete manifest.evidence_snapshot_ref;
      manifest.maintenance = { owner: manifest.owner, review_cadence: 'quarterly', status: 'active' };
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
  }
  console.log(`[manifest-migrate] manifests=${manifests.length} legacy_v1.0=${planned.length} action=${argv.includes('--write') ? 'write' : 'check'}`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
