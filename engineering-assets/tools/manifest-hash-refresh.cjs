#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { discoverManifestPaths } = require('./catalog-gen.cjs');

const TEXT_EXTENSIONS = new Set(['.cjs', '.do', '.hex', '.json', '.m', '.md', '.py', '.sdc', '.sv', '.svh', '.tcl', '.txt', '.v', '.vh', '.xdc']);
function canonicalBytes(file) {
  const bytes = fs.readFileSync(file);
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : bytes;
}
function hash(file) { return crypto.createHash('sha256').update(canonicalBytes(file)).digest('hex'); }
function scan(root) {
  const changes = []; const missing = [];
  for (const manifestPath of discoverManifestPaths(root)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let changed = false;
    for (const source of manifest.sources || []) {
      const sourcePath = path.join(path.dirname(manifestPath), source.path);
      if (!fs.existsSync(sourcePath)) { missing.push({ manifest: path.relative(root, manifestPath), path: source.path }); continue; }
      const next = hash(sourcePath);
      if (source.sha256 !== next) { changes.push({ manifest: path.relative(root, manifestPath), path: source.path, old: source.sha256, next }); source.sha256 = next; changed = true; }
    }
    if (changed && process.argv.includes('--write')) fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { changes, missing };
}
function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--root'); const root = path.resolve(index >= 0 ? argv[index + 1] : path.resolve(__dirname, '..'));
  try {
    const result = scan(root);
    console.log(`[manifest-hash-refresh] mismatches=${result.changes.length} missing=${result.missing.length} action=${argv.includes('--write') ? 'write' : 'check'}`);
    result.missing.forEach((item) => console.log(`MISSING ${item.manifest}:${item.path}`));
    if (!argv.includes('--write') && result.changes.length) return 1;
    return 0;
  } catch (error) { console.error(`[manifest-hash-refresh] ${error.message}`); return 2; }
}
if (require.main === module) process.exitCode = main();
module.exports = { canonicalBytes, hash, main, scan };
