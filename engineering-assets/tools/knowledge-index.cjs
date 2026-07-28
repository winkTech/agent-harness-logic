#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanRepository } = require('./catalog-gen.cjs');

const BEGIN = '<!-- BEGIN:KIDX:STATS -->';
const END = '<!-- END:KIDX:STATS -->';
const GENERATED = new Set(['INDEX-FILES.md']);

function build(scan) {
  const entries = scan.assets.map((asset) => ({
    asset_uid: asset.asset_uid,
    level: asset.level,
    requirement_ref: asset.manifest.requirement_ref || null,
    doc_refs: asset.manifest.doc_refs || [],
    golden_model_ref: asset.manifest.golden_model_ref || null,
  }));
  return { schema_version: '1.0', generated_by: 'knowledge-index.cjs', entries };
}

function knowledgeFiles(root) {
  const knowledge = path.join(root, 'knowledge');
  const out = [];
  function walk(dir, relative = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'archive') continue;
      const abs = path.join(dir, entry.name);
      const rel = path.join(relative, entry.name).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (rel.split('/').length <= 3) walk(abs, rel);
      } else if (entry.isFile() && /\.(?:md|markdown|txt)$/i.test(entry.name) && !GENERATED.has(entry.name) && rel.split('/').length <= 4) {
        out.push({ abs, rel });
      }
    }
  }
  if (fs.existsSync(knowledge)) walk(knowledge);
  return out;
}

function titleOf(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 40);
  for (const line of lines) {
    const match = line.match(/^(?:title|name):\s*["']?(.+?)["']?\s*$/i);
    if (match) return match[1].trim();
  }
  const heading = lines.find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, '').trim() : path.basename(file);
}

function renderFiles(files) {
  const lines = ['# Knowledge Files Index', '', '> Generated from knowledge/ files at depth <= 3; archive/ and this generated index are excluded.', '', '| Path | Title |', '|---|---|'];
  for (const file of files) lines.push('| `' + file.rel + '` | ' + titleOf(file.abs).replace(/\|/g, '\\|') + ' |');
  return `${lines.join('\n')}\n`;
}

function statsBlock(files) {
  const counts = {};
  for (const file of files) {
    const ext = path.extname(file.rel).toLowerCase() || '(none)';
    counts[ext] = (counts[ext] || 0) + 1;
  }
  const summary = Object.keys(counts).sort().map((ext) => `${ext}=${counts[ext]}`).join(', ');
  return `${BEGIN}\n<!-- files=${files.length}; ${summary} -->\n${END}`;
}

function updateStats(existing, files) {
  const block = statsBlock(files);
  const pattern = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  return pattern.test(existing) ? existing.replace(pattern, block) : `${existing.trimEnd()}\n\n${block}\n`;
}

function render(index) {
  const lines = ['# CBB Knowledge Index', '', '> Generated from managed manifests; this is a navigation index, not a certification claim.', '', '| Asset | Level | Requirement | Golden | Documents |', '|---|---|---|---|---|'];
  for (const entry of index.entries) lines.push(`| \`${entry.asset_uid}\` | ${entry.level} | ${entry.requirement_ref || '—'} | ${entry.golden_model_ref || '—'} | ${entry.doc_refs.length} refs |`);
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..'));
  const index = build(scanRepository(root));
  const files = knowledgeFiles(root);
  const jsonPath = path.join(root, 'catalog', 'knowledge-index.json');
  const mdPath = path.join(root, 'catalog', 'KNOWLEDGE-INDEX.md');
  const filesPath = path.join(root, 'knowledge', 'INDEX-FILES.md');
  const indexPath = path.join(root, 'knowledge', 'INDEX.md');
  const json = `${JSON.stringify(index, null, 2)}\n`;
  const md = render(index);
  const existingIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n') : '';
  const updatedIndex = updateStats(existingIndex, files);
  const filesMd = renderFiles(files);
  if (argv.includes('--write')) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, json, 'utf8');
    fs.writeFileSync(mdPath, md, 'utf8');
    fs.writeFileSync(filesPath, filesMd, 'utf8');
    fs.writeFileSync(indexPath, updatedIndex, 'utf8');
    console.log(`[knowledge-index] wrote assets=${index.entries.length} files=${files.length}`);
    return 0;
  }
  const actualJson = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, 'utf8').replace(/\r\n/g, '\n') : null;
  const actualMd = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n') : null;
  const actualFiles = fs.existsSync(filesPath) ? fs.readFileSync(filesPath, 'utf8').replace(/\r\n/g, '\n') : null;
  const actualIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n') : null;
  const stale = [];
  if (actualJson !== json) stale.push('catalog/knowledge-index.json');
  if (actualMd !== md) stale.push('catalog/KNOWLEDGE-INDEX.md');
  if (actualFiles !== filesMd) stale.push('knowledge/INDEX-FILES.md');
  if (actualIndex !== updatedIndex) stale.push('knowledge/INDEX.md');
  if (stale.length) {
    if (actualIndex !== updatedIndex) console.error(`[knowledge-index] index-length actual=${actualIndex?.length ?? -1} expected=${updatedIndex.length}`);
    console.error(`[knowledge-index] stale derived index: ${stale.join(', ')}`); return 1;
  }
  console.log(`[knowledge-index] fresh assets=${index.entries.length} files=${files.length}`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { build, knowledgeFiles, main, render, renderFiles, statsBlock, updateStats };
