#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanRepository } = require('./catalog-gen.cjs');

function marker(section) {
  return { begin: `<!-- BEGIN:MANIFEST:${section} -->`, end: `<!-- END:MANIFEST:${section} -->` };
}

function replaceSection(readme, section, body) {
  const m = marker(section);
  const block = [m.begin, '<!-- Generated from manifest.json; do not edit this block. -->', ...body, m.end].join('\n');
  const re = new RegExp(`${m.begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${m.end.replace(/[.*+?^${}()|[\]\\\\]/g, '\\$&')}`);
  if (re.test(readme)) return readme.replace(re, block);
  return `${readme.replace(/\s*$/, '')}\n\n${block}\n`;
}

function portLines(manifest) {
  const lines = ['| Name | Dir | Width | Bus |', '|---|---|---:|---|'];
  for (const port of manifest.ports || []) lines.push(`| \`${port.name}\` | ${port.direction} | ${port.width} | ${port.bus || '—'} |`);
  return lines;
}

function paramLines(manifest) {
  const params = manifest.params || manifest.generality?.param_space || [];
  const lines = ['| Name | Values | Support |', '|---|---|---|'];
  for (const param of params) lines.push(`| \`${param.name}\` | ${(param.values || []).join(', ') || '—'} | ${param.support === false ? 'no' : 'yes'} |`);
  return lines;
}

function clockResetLines(manifest) {
  return [
    '| Field | Value |',
    '|---|---|',
    `| Clock | \`${manifest.clock?.name || '—'}\` (${manifest.clock?.period_ns ?? '—'} ns) |`,
    `| Reset | \`${manifest.reset?.name || '—'}\` / ${manifest.reset?.polarity || '—'} / ${manifest.reset?.type || '—'} |`,
  ];
}

function renderReadme(readme, manifest) {
  let out = readme.replace(/\r\n/g, '\n');
  out = replaceSection(out, 'PORTS', portLines(manifest));
  out = replaceSection(out, 'PARAMS', paramLines(manifest));
  out = replaceSection(out, 'CLOCKRESET', clockResetLines(manifest));
  return out;
}

function renderRegistry(scan) {
  const lines = ['# Manifest Registry', '', '> Generated from every managed `manifest.json`; do not edit by hand.', '', '| UID | Schema | Version | Kind | Level | Owner | Directory |', '|---|---|---|---|---|---|---|'];
  for (const asset of scan.assets) lines.push(`| \`${asset.asset_uid}\` | ${asset.manifest.schema_version} | ${asset.version || '—'} | ${asset.kind} | ${asset.level} | ${asset.owner} | \`${asset.dir}\` |`);
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..'));
  const scan = scanRepository(root);
  const write = argv.includes('--write');
  const stale = [];
  for (const asset of scan.assets.filter((item) => item.kind === 'rtl')) {
    const file = path.join(root, asset.dir, 'README.md');
    if (!fs.existsSync(file)) { stale.push(`${asset.dir}/README.md`); continue; }
    const expected = renderReadme(fs.readFileSync(file, 'utf8'), asset.manifest);
    if (write) fs.writeFileSync(file, expected, 'utf8');
    else if (fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== expected) stale.push(`${asset.dir}/README.md`);
  }
  const registry = path.join(root, 'catalog', 'MANIFESTS.md');
  const expectedRegistry = renderRegistry(scan);
  if (write) { fs.mkdirSync(path.dirname(registry), { recursive: true }); fs.writeFileSync(registry, expectedRegistry, 'utf8'); }
  else if (!fs.existsSync(registry) || fs.readFileSync(registry, 'utf8').replace(/\r\n/g, '\n') !== expectedRegistry) stale.push('catalog/MANIFESTS.md');
  if (stale.length) { console.error(`[manifest-render] stale: ${stale.join(', ')}`); return 1; }
  console.log(`[manifest-render] ${write ? 'wrote' : 'fresh'} assets=${scan.assets.filter((item) => item.kind === 'rtl').length}`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main, renderReadme, renderRegistry };
