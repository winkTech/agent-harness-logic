#!/usr/bin/env node
'use strict';

/** Knowledge-base statistics and fail-closed freshness checks. */

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { shouldIndexSemanticFile } = require('./lib/memory-file-policy.cjs');
const { inspectIndexFreshness } = require('./semantic-search.cjs');
const { healthCheck } = require('./resolve-wiki-links.cjs');

function locationsFor(home = HARNESS_ROOT) {
  const knowledgeDir = path.join(home, 'engineering-assets', 'knowledge');
  return {
    home,
    knowledgeDir,
    memoryDir: path.join(home, 'memory'),
    semanticMeta: path.join(home, 'var', 'index', 'semantic-index-meta.json'),
  };
}

function count(dir, filter = (name) => name.endsWith('.md'), excludeDirs = []) {
  if (!fs.existsSync(dir)) return { files: 0, dirs: 0 };
  let files = 0;
  let dirs = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name) || entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      const child = count(full, filter, excludeDirs);
      files += child.files;
      dirs += child.dirs + 1;
    } else if (entry.isFile() && filter(entry.name)) {
      files += 1;
    }
  }
  return { files, dirs };
}

function slash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function walkMarkdown(dir, shouldInclude, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, shouldInclude, files);
    else if (entry.isFile() && entry.name.endsWith('.md') && (!shouldInclude || shouldInclude(full))) files.push(full);
  }
  return files;
}

function requiresFrontmatter(filePath, knowledgeDir) {
  const relative = slash(path.relative(knowledgeDir, filePath));
  return relative !== 'INDEX-FILES.md'
    && !relative.startsWith('archive/sources/')
    && !relative.split('/').includes('examples');
}

function scanFrontmatter(home = HARNESS_ROOT) {
  const { knowledgeDir } = locationsFor(home);
  const files = walkMarkdown(knowledgeDir, (filePath) => requiresFrontmatter(filePath, knowledgeDir));
  const missing = [];
  let withFrontmatter = 0;
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trimStart().startsWith('---')) withFrontmatter += 1;
      else missing.push(slash(path.relative(knowledgeDir, filePath)));
    } catch {
      missing.push(slash(path.relative(knowledgeDir, filePath)));
    }
  }
  return {
    totalMd: files.length,
    withFrontmatter,
    missingFrontmatter: missing,
    frontmatterRate: files.length > 0 ? Math.round((withFrontmatter / files.length) * 100) : 100,
  };
}

function semanticEligibleFiles(home = HARNESS_ROOT) {
  const locations = locationsFor(home);
  const roots = [
    locations.memoryDir,
    path.join(locations.knowledgeDir, 'primary'),
    path.join(locations.knowledgeDir, 'docs'),
    path.join(locations.knowledgeDir, 'references'),
  ];
  const files = [];
  for (const root of roots) {
    walkMarkdown(root, (filePath) => shouldIndexSemanticFile(filePath, {
      home,
      memoryDir: locations.memoryDir,
      knowledgeDir: locations.knowledgeDir,
    }), files);
  }
  return files;
}

function readSemanticMeta(home = HARNESS_ROOT) {
  const { semanticMeta } = locationsFor(home);
  try {
    const meta = JSON.parse(fs.readFileSync(semanticMeta, 'utf8'));
    return {
      found: true,
      builtAt: meta.builtAt || null,
      fileCount: Number(meta.fileCount || 0),
      files: Array.isArray(meta.files) ? meta.files : [],
    };
  } catch {
    return { found: false, builtAt: null, fileCount: 0, files: [] };
  }
}

function wikiStats(home) {
  if (path.resolve(home) !== path.resolve(HARNESS_ROOT)) {
    return { total: 0, resolved: 0, broken: [] };
  }
  try { return healthCheck(); }
  catch { return { total: 0, resolved: 0, broken: ['wiki-health-check-failed'] }; }
}

function collectStats(opts = {}) {
  const home = path.resolve(opts.home || HARNESS_ROOT);
  const { knowledgeDir } = locationsFor(home);
  const primary = count(path.join(knowledgeDir, 'primary'));
  const primaryNoExamples = count(path.join(knowledgeDir, 'primary'), (name) => name.endsWith('.md'), ['examples']);
  const cardDirectories = ['python-basics', 'math-foundation', 'linear-algebra', 'probability-statistics', 'data-viz'];
  const cardDetails = Object.fromEntries(cardDirectories.map((name) => [
    name,
    count(path.join(knowledgeDir, name)).files,
  ]));
  const frontmatter = scanFrontmatter(home);
  const wiki = wikiStats(home);
  const semanticFiles = semanticEligibleFiles(home);
  const semanticMeta = readSemanticMeta(home);
  const semanticFreshness = inspectIndexFreshness({ home, now: opts.now });
  return {
    primary: primary.files,
    primaryNoExamples: primaryNoExamples.files,
    iris: Object.values(cardDetails).reduce((sum, value) => sum + value, 0),
    irisDetails: cardDetails,
    references: count(path.join(knowledgeDir, 'references')).files,
    methodology: count(path.join(knowledgeDir, 'methodology')).files,
    templates: count(path.join(knowledgeDir, 'docs', 'templates')).files,
    sources: count(path.join(knowledgeDir, 'archive', 'sources')).files,
    pdfs: count(path.join(home, 'engineering-assets', 'reference-assets', 'datasheets'), (name) => name.endsWith('.pdf')).files,
    frontmatterRate: frontmatter.frontmatterRate,
    totalMd: frontmatter.totalMd,
    withFrontmatter: frontmatter.withFrontmatter,
    missingFrontmatter: frontmatter.missingFrontmatter,
    wikiLinks: {
      total: Number(wiki.total || 0),
      resolved: Number(wiki.resolved || 0),
      broken: Array.isArray(wiki.broken) ? wiki.broken : [],
    },
    semanticIndex: {
      eligible: semanticFiles.length,
      indexed: semanticMeta.fileCount,
      builtAt: semanticMeta.builtAt,
      found: semanticMeta.found,
      freshness: semanticFreshness,
    },
  };
}

function checkKnowledge(opts = {}) {
  const home = path.resolve(opts.home || HARNESS_ROOT);
  const now = opts.now ?? Date.now();
  const stats = opts.stats || collectStats({ home, now });
  const { knowledgeDir } = locationsFor(home);
  const indexPath = path.join(knowledgeDir, 'INDEX.md');
  let indexContent = '';
  try { indexContent = fs.readFileSync(indexPath, 'utf8'); }
  catch { /* reported below */ }
  const issues = [];

  if (!indexContent) {
    issues.push({ code: 'knowledge_index_missing', message: 'engineering-assets/knowledge/INDEX.md is missing' });
  } else {
    const dateMatch = indexContent.match(/(?:last\s+updated|最后更新)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/i);
    const countMatch = indexContent.match(/文档:\s*(\d+)\s*篇\s*primary\s*\+\s*(\d+)\s*篇\s*source\s*\+\s*(\d+)\s*篇\s*鸢尾花书蒸馏\s*\+\s*(\d+)\s*篇\s*methodology\s*\+\s*(\d+)\s*篇\s*references\s*\+\s*(\d+)\s*篇\s*templates/i);
    const expected = {
      primary: Number(stats.primaryNoExamples || 0),
      sources: Number(stats.sources || 0),
      iris: Number(stats.iris || 0),
      methodology: Number(stats.methodology || 0),
      references: Number(stats.references || 0),
      templates: Number(stats.templates || 0),
    };
    const observed = countMatch ? {
      primary: Number(countMatch[1]),
      sources: Number(countMatch[2]),
      iris: Number(countMatch[3]),
      methodology: Number(countMatch[4]),
      references: Number(countMatch[5]),
      templates: Number(countMatch[6]),
    } : null;
    const countsMatch = observed
      && Object.keys(expected).every(key => observed[key] === expected[key]);
    if (!dateMatch || !countsMatch) {
      issues.push({
        code: 'knowledge_index_stale',
        message: 'INDEX.md visible metadata does not match current knowledge counts; run knowledge-index.cjs --write',
        observed: { updated: dateMatch?.[1] || null, counts: observed },
        expected: { counts: expected },
      });
    }
  }
  if (stats.missingFrontmatter.length > 0) {
    issues.push({
      code: 'frontmatter_missing',
      message: `${stats.missingFrontmatter.length} knowledge files lack frontmatter`,
      files: stats.missingFrontmatter.slice(0, 20),
    });
  }
  if (stats.wikiLinks.broken.length > 0) {
    issues.push({
      code: 'wiki_links_broken',
      message: `${stats.wikiLinks.broken.length} wiki links are unresolved`,
      links: stats.wikiLinks.broken.slice(0, 20),
    });
  }
  const freshness = stats.semanticIndex.freshness;
  if (freshness.stale) {
    issues.push({
      code: 'semantic_index_stale',
      message: 'semantic index does not match current eligible files',
      evidence: freshness,
    });
  }
  return { ok: issues.length === 0, checkedAt: new Date(now).toISOString(), issues, stats };
}

function optionValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

function printSummary(stats, now = Date.now()) {
  console.log(`Knowledge statistics (${new Date(now).toISOString().slice(0, 10)})`);
  console.log(`  Primary (without examples): ${stats.primaryNoExamples}`);
  console.log(`  Primary (with examples):    ${stats.primary}`);
  console.log(`  References:                 ${stats.references}`);
  console.log(`  Templates:                  ${stats.templates}`);
  console.log(`  Sources:                    ${stats.sources}`);
  console.log(`  PDFs:                       ${stats.pdfs}`);
  console.log(`  Frontmatter:                ${stats.frontmatterRate}% (${stats.withFrontmatter}/${stats.totalMd})`);
  console.log(`  Broken wiki links:          ${stats.wikiLinks.broken.length}/${stats.wikiLinks.total}`);
  console.log(`  Semantic index:             ${stats.semanticIndex.indexed}/${stats.semanticIndex.eligible}`);
}

function main(argv = process.argv.slice(2)) {
  const home = optionValue(argv, '--home', HARNESS_ROOT);
  const json = argv.includes('--json');
  const check = argv.includes('--check');
  const quiet = argv.includes('--quiet');
  const now = Date.now();
  const stats = collectStats({ home, now });
  if (check) {
    const report = checkKnowledge({ home, now, stats });
    if (json) console.log(JSON.stringify(report, null, 2));
    else if (!quiet) {
      if (report.ok) console.log('Knowledge and semantic indexes are current.');
      else {
        console.log('Knowledge checks failed:');
        for (const issue of report.issues) console.log(`  - [${issue.code}] ${issue.message}`);
      }
    }
    return report.ok ? 0 : 1;
  }
  if (json) console.log(JSON.stringify(stats, null, 2));
  else if (!quiet) printSummary(stats, now);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  count,
  scanFrontmatter,
  semanticEligibleFiles,
  readSemanticMeta,
  collectStats,
  checkKnowledge,
  main,
};
