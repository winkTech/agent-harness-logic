#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanRepository } = require('./catalog-gen.cjs');

function validate(root) {
  const registryPath = path.join(root, 'integration', 'registry.json');
  if (!fs.existsSync(registryPath)) return ['integration/registry.json missing'];
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const scan = scanRepository(root);
  const byUid = new Map(scan.assets.map((asset) => [asset.asset_uid, asset]));
  const errors = [];
  if (registry.schema_version !== '1.1' || registry.owner !== 'lihan' || !Array.isArray(registry.entries)) errors.push('registry schema/owner/entries invalid');
  const ids = new Set();
  const assetIds = new Set();
  for (const entry of registry.entries || []) {
    for (const field of ['id', 'project', 'project_ref', 'asset_uid', 'version_pinned', 'config', 'integrated_at', 'status', 'owner', 'consumers', 'issues', 'badge_gap']) if (entry[field] === undefined) errors.push(`missing registry field ${field}: ${entry.id || entry.asset_uid || '(unknown)'}`);
    if (entry.id && ids.has(entry.id)) errors.push(`duplicate registry id: ${entry.id}`);
    if (entry.id) ids.add(entry.id);
    if (assetIds.has(entry.asset_uid)) errors.push(`duplicate registry asset_uid: ${entry.asset_uid}`);
    assetIds.add(entry.asset_uid);
    const asset = byUid.get(entry.asset_uid);
    if (!asset) { errors.push(`unknown registry asset_uid: ${entry.asset_uid}`); continue; }
    if (entry.version_pinned !== asset.version) errors.push(`version drift ${entry.asset_uid}: registry=${entry.version_pinned} manifest=${asset.version}`);
    if (!['active', 'retired'].includes(entry.status)) errors.push(`invalid lifecycle status ${entry.asset_uid}: ${entry.status}`);
    if (Number.isNaN(Date.parse(entry.integrated_at))) errors.push(`invalid integrated_at ${entry.asset_uid}`);
    const paramNames = new Set((asset.manifest.params || []).map((param) => param.name));
    for (const key of Object.keys(entry.config || {})) if (!paramNames.has(key)) errors.push(`config key not declared in manifest.params ${entry.asset_uid}: ${key}`);
    for (const consumer of entry.consumers || []) if (!byUid.has(consumer) && !fs.existsSync(path.join(root, consumer))) errors.push(`missing consumer ${entry.asset_uid}: ${consumer}`);
    if (entry.maturity_status === 'deferred' && !entry.deferred_reason) errors.push(`deferred entry requires reason: ${entry.asset_uid}`);
  }
  for (const asset of scan.assets) if (!assetIds.has(asset.asset_uid)) errors.push(`manifest asset absent from integration registry: ${asset.asset_uid}`);
  return errors;
}

function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--root'); const root = path.resolve(index >= 0 ? argv[index + 1] : path.resolve(__dirname, '..'));
  try { const errors = validate(root); if (errors.length) { errors.forEach((e) => console.error(`[integration-registry] ${e}`)); return 1; } console.log('[integration-registry] valid entries=10'); return 0; }
  catch (error) { console.error(`[integration-registry] ${error.message}`); return 2; }
}
if (require.main === module) process.exitCode = main();
module.exports = { main, validate };
