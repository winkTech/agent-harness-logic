#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanRepository } = require('./catalog-gen.cjs');

function check(root) {
  const scan = scanRepository(root); const byUid = new Map(scan.assets.map((asset) => [asset.asset_uid, asset])); const errors = [];
  for (const asset of scan.assets) {
    if (!/^\d+\.\d+\.\d+$/.test(asset.version || '')) errors.push(`${asset.asset_uid}: invalid semver ${asset.version}`);
    if (/_v2(?:\.|_|$)|_new(?:\.|_|$)/i.test(asset.dir)) errors.push(`${asset.asset_uid}: forbidden version suffix in directory`);
    const lineage = asset.manifest.lineage;
    if (lineage) {
      if (lineage.parent_uid && !byUid.has(lineage.parent_uid)) errors.push(`${asset.asset_uid}: lineage parent_uid not found: ${lineage.parent_uid}`);
      if (lineage.base_version && !/^\d+\.\d+\.\d+$/.test(lineage.base_version)) errors.push(`${asset.asset_uid}: invalid lineage base_version`);
      if (!lineage.changelog || !fs.existsSync(path.join(root, asset.dir, lineage.changelog))) errors.push(`${asset.asset_uid}: lineage changelog missing`);
    }
    if (asset.level === 'certified') {
      for (const source of asset.manifest.sources || []) {
        const sourcePath = path.join(root, asset.dir, source.path);
        if (!fs.existsSync(sourcePath)) { errors.push(`${asset.asset_uid}: certified source missing: ${source.path}`); continue; }
        const bytes = fs.readFileSync(sourcePath);
        const actual = crypto.createHash('sha256').update(bytes).digest('hex');
        const normalized = crypto.createHash('sha256').update(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')).digest('hex');
        if (source.sha256 && actual !== source.sha256 && normalized !== source.sha256) errors.push(`${asset.asset_uid}: certified source sha drift: ${source.path}`);
      }
    }
    if (lineage && lineage.base_version && /^\d+\.\d+\.\d+$/.test(lineage.base_version)) {
      const baseMajor = Number(lineage.base_version.split('.')[0]); const currentMajor = Number(asset.version.split('.')[0]);
      if (currentMajor > baseMajor && (!lineage.changelog || !/BREAKING/i.test(fs.readFileSync(path.join(root, asset.dir, lineage.changelog), 'utf8')))) errors.push(`${asset.asset_uid}: major lineage bump requires BREAKING changelog entry`);
    }
  }
  return errors;
}
function main(argv = process.argv.slice(2)) { const i = argv.indexOf('--root'); const root = path.resolve(i >= 0 ? argv[i + 1] : path.resolve(__dirname, '..')); try { const errors = check(root); if (errors.length) { errors.forEach((e) => console.error(`[lineage-check] ${e}`)); return 1; } console.log(`[lineage-check] GREEN assets=${require('./catalog-gen.cjs').scanRepository(root).assets.length}`); return 0; } catch (error) { console.error(`[lineage-check] ${error.message}`); return 2; } }
if (require.main === module) process.exitCode = main();
module.exports = { check, main };
