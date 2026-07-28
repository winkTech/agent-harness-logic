#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanRepository } = require('./catalog-gen.cjs');

const CANONICAL = path.join('var', 'cbb', 'waiver-ledger.json');
const MIRROR = path.join('catalog', 'waiver-ledger.json');
const STATUS = new Set(['open', 'closed', 'expired']);
const DENY = new Set(['G-A-00', 'G-A-01', 'G-A-02', 'RL-OUT', 'G-C-03', 'G-B-03', 'G-B-05']);

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function paths(root) {
  const canonical = path.join(root, CANONICAL);
  const mirror = path.join(root, MIRROR);
  return { canonical, mirror };
}

function load(root) {
  const p = paths(root);
  const file = fs.existsSync(p.canonical) ? p.canonical : p.mirror;
  if (!fs.existsSync(file)) throw new Error(`missing waiver ledger: ${CANONICAL}`);
  return { file, value: readJson(file), ...p };
}

function write(root, value) {
  const p = paths(root);
  fs.mkdirSync(path.dirname(p.canonical), { recursive: true });
  fs.mkdirSync(path.dirname(p.mirror), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(p.canonical, text);
  fs.writeFileSync(p.mirror, text);
}

function manifestWaivers(root) {
  const waivers = [];
  for (const asset of scanRepository(root).assets) {
    for (const waiver of asset.manifest?.waivers || []) {
      if (waiver.ledger_id) waivers.push({ asset_uid: asset.asset_uid, ...waiver });
    }
  }
  return waivers;
}

function validate(root, now = new Date()) {
  const { value } = load(root);
  const assets = new Set(scanRepository(root).assets.map((asset) => asset.asset_uid));
  const entries = Array.isArray(value.entries) ? value.entries : [];
  const errors = [];
  const ids = new Set();
  if (value.schema_version !== '1.0' || !Array.isArray(value.entries)) {
    errors.push('schema_version=1.0 and entries[] are required');
  }
  for (const entry of entries) {
    const required = ['id', 'asset_uid', 'gate', 'reason', 'scope', 'approver', 'opened_at', 'expires_at', 'status'];
    for (const field of required) if (entry[field] === undefined || entry[field] === '') errors.push(`incomplete waiver ${entry.id || '(no id)'}: ${field}`);
    if (entry.id && ids.has(entry.id)) errors.push(`duplicate ledger id: ${entry.id}`);
    if (entry.id) ids.add(entry.id);
    if (entry.asset_uid && !assets.has(entry.asset_uid)) errors.push(`unknown asset_uid: ${entry.asset_uid}`);
    if (entry.status && !STATUS.has(entry.status)) errors.push(`invalid waiver status: ${entry.id || '(no id)'}`);
    if (entry.scope && (!Array.isArray(entry.scope) || entry.scope.length === 0)) errors.push(`scope[] required: ${entry.id || '(no id)'}`);
    if (entry.gate && DENY.has(entry.gate) && entry.status === 'open') errors.push(`DENY gate cannot be waived while open: ${entry.gate}`);
    if (entry.expires_at && !Number.isNaN(Date.parse(entry.expires_at)) && Date.parse(entry.expires_at) < now.getTime() && entry.status === 'open') {
      errors.push(`expired open waiver: ${entry.id || '(no id)'}`);
    }
  }
  const byId = new Set(entries.map((entry) => entry.id));
  for (const waiver of manifestWaivers(root)) {
    if (!byId.has(waiver.ledger_id)) errors.push(`manifest waiver ledger_id is unlinked: ${waiver.asset_uid}:${waiver.ledger_id}`);
  }
  return errors;
}

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..'));
  try {
    const current = load(root);
    if (argv.includes('--write') && !fs.existsSync(current.canonical)) write(root, current.value);
    const errors = validate(root);
    if (errors.length) { errors.forEach((error) => console.error(`[waiver-ledger] ${error}`)); return 1; }
    if (argv.includes('--write')) write(root, load(root).value);
    console.log(`[waiver-ledger] valid entries=${load(root).value.entries.length} canonical=${CANONICAL}`);
    return 0;
  } catch (error) {
    console.error(`[waiver-ledger] ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main, validate, load, write, DENY };
