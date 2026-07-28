#!/usr/bin/env node
'use strict';

/**
 * Lightweight TF-IDF retrieval for validated memory and knowledge files.
 *
 * Retrieval fails closed when the index no longer describes the eligible file
 * set.  Callers must rebuild explicitly; stale vectors are never presented as
 * current evidence.
 */

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { shouldIndexSemanticFile } = require('./lib/memory-file-policy.cjs');

const DAY_MS = 86_400_000;
const DEFAULT_MAX_AGE_DAYS = 7;
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'this', 'that', 'these', 'those',
  'it', 'its', 'they', 'them', 'we', 'you', 'he', 'she', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'and',
  'or', 'but', 'if', 'then', 'else', 'when', 'where', 'why', 'how', 'which',
  'who', 'not', 'no', 'nor', 'so', 'very', 'just', 'about', 'all', 'each',
  'every', 'both', 'more', 'most', 'some', 'any', 'such', 'only', 'own',
  'same', 'too', 'const', 'let', 'var', 'function', 'return', 'export',
  'import', 'require',
]);

function pathsFor(home = HARNESS_ROOT) {
  const knowledgeDir = path.join(home, 'engineering-assets', 'knowledge');
  const indexDir = path.join(home, 'var', 'index');
  return {
    home,
    memoryDir: path.join(home, 'memory'),
    knowledgeDir,
    roots: [
      path.join(home, 'memory'),
      path.join(knowledgeDir, 'primary'),
      path.join(knowledgeDir, 'docs'),
      path.join(knowledgeDir, 'references'),
    ],
    indexDir,
    indexFile: path.join(indexDir, 'semantic-index.json'),
    metaFile: path.join(indexDir, 'semantic-index-meta.json'),
  };
}

function slash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function tokenize(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const tokens = [...lower.matchAll(/[a-z][a-z0-9_]*/g)].map((match) => match[0]);
  const han = lower.match(/\p{Script=Han}/gu) || [];
  for (let size = 3; size >= 1; size -= 1) {
    for (let index = 0; index <= han.length - size; index += 1) {
      tokens.push(han.slice(index, index + size).join(''));
    }
  }
  return tokens.filter((token) => !STOP_WORDS.has(token));
}

function buildIndex(fileList) {
  const df = {};
  const tf = {};

  for (const filePath of fileList) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); }
    catch { continue; }
    const termCounts = {};
    const seen = new Set();
    for (const token of tokenize(content)) {
      termCounts[token] = (termCounts[token] || 0) + 1;
      if (!seen.has(token)) {
        seen.add(token);
        df[token] = (df[token] || 0) + 1;
      }
    }
    tf[filePath] = termCounts;
  }

  const documentCount = fileList.length;
  const idf = Object.fromEntries(Object.entries(df).map(([term, count]) => [
    term,
    Math.log((documentCount + 1) / (count + 1)) + 1,
  ]));
  const vectors = {};
  for (const [filePath, termCounts] of Object.entries(tf)) {
    const vector = {};
    let normSquared = 0;
    for (const [term, count] of Object.entries(termCounts)) {
      const weight = (1 + Math.log(count)) * (idf[term] || 1);
      vector[term] = weight;
      normSquared += weight * weight;
    }
    const norm = Math.sqrt(normSquared);
    if (norm > 0) {
      for (const term of Object.keys(vector)) vector[term] /= norm;
      vectors[filePath] = vector;
    }
  }
  return vectors;
}

function walkMarkdown(root, opts, files = []) {
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, opts, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')
      && shouldIndexSemanticFile(full, opts)) files.push(full);
  }
  return files;
}

function eligibleFiles(home = HARNESS_ROOT) {
  const locations = pathsFor(home);
  const opts = {
    home,
    memoryDir: locations.memoryDir,
    knowledgeDir: locations.knowledgeDir,
  };
  const files = [];
  for (const root of locations.roots) walkMarkdown(root, opts, files);
  return [...new Set(files.map((filePath) => path.resolve(filePath)))].sort();
}

function buildSemanticIndex(opts = {}) {
  const home = path.resolve(opts.home || HARNESS_ROOT);
  const locations = pathsFor(home);
  const files = eligibleFiles(home);
  const now = opts.now ?? Date.now();
  const builtAt = new Date(now).toISOString();
  const vectors = buildIndex(files);
  const meta = {
    type: 'tfidf-charngram',
    version: 3,
    builtAt,
    fileCount: files.length,
    files: files.map((filePath) => ({
      path: slash(path.relative(home, filePath)),
      mtime: fs.statSync(filePath).mtimeMs,
    })),
  };
  const index = {
    vectors,
    type: meta.type,
    version: meta.version,
    builtAt,
    fileCount: files.length,
  };
  fs.mkdirSync(locations.indexDir, { recursive: true });
  fs.writeFileSync(locations.indexFile, JSON.stringify(index), 'utf8');
  fs.writeFileSync(locations.metaFile, JSON.stringify(meta), 'utf8');
  return {
    ok: true,
    status: 'indexed',
    builtAt,
    fileCount: files.length,
    vectorCount: Object.keys(vectors).length,
    indexFile: locations.indexFile,
  };
}

function inspectIndexFreshness(opts = {}) {
  const home = path.resolve(opts.home || HARNESS_ROOT);
  const locations = pathsFor(home);
  const now = opts.now ?? Date.now();
  const maxAgeDays = Number(opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS);
  const current = new Map(eligibleFiles(home).map((filePath) => [
    slash(path.relative(home, filePath)),
    fs.statSync(filePath).mtimeMs,
  ]));

  let meta;
  try { meta = JSON.parse(fs.readFileSync(locations.metaFile, 'utf8')); }
  catch { meta = null; }
  const indexFound = fs.existsSync(locations.indexFile);
  if (!meta || !Array.isArray(meta.files) || !indexFound) {
    return {
      found: false,
      stale: true,
      reason: 'index_missing',
      builtAt: null,
      ageDays: null,
      indexed: 0,
      eligible: current.size,
      missing: 0,
      unindexed: current.size,
      changed: 0,
    };
  }

  const recorded = new Map(meta.files.map((item) => [slash(item.path), Number(item.mtime)]));
  const missing = [...recorded.keys()].filter((item) => !current.has(item)).length;
  const unindexed = [...current.keys()].filter((item) => !recorded.has(item)).length;
  const changed = [...current].filter(([item, mtime]) => (
    recorded.has(item) && Math.abs(mtime - recorded.get(item)) > 1
  )).length;
  const builtMs = Date.parse(meta.builtAt || '');
  const ageDays = Number.isFinite(builtMs) ? (now - builtMs) / DAY_MS : null;
  const staleByAge = ageDays === null || ageDays >= maxAgeDays;
  const stale = missing > 0 || unindexed > 0 || changed > 0 || staleByAge;
  return {
    found: true,
    stale,
    reason: stale ? 'index_drift' : null,
    builtAt: meta.builtAt || null,
    ageDays,
    indexed: recorded.size,
    eligible: current.size,
    missing,
    unindexed,
    changed,
  };
}

function cosineSimilarity(queryVector, documentVector) {
  let dot = 0;
  for (const [term, weight] of Object.entries(queryVector)) {
    if (documentVector[term]) dot += weight * documentVector[term];
  }
  return dot;
}

function extractSnippet(filePath, query) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const words = String(query).toLowerCase().split(/\s+/).filter((item) => item.length > 1);
    let bestLine = 0;
    let bestScore = -1;
    for (let index = 0; index < lines.length; index += 1) {
      const lower = lines[index].toLowerCase();
      const score = words.reduce((total, word) => total + (lower.includes(word) ? word.length : 0), 0);
      if (score > bestScore) {
        bestLine = index;
        bestScore = score;
      }
    }
    return lines.slice(Math.max(0, bestLine - 1), bestLine + 3).join('\n').slice(0, 400);
  } catch {
    return '';
  }
}

function querySemantic(query, opts = {}) {
  const home = path.resolve(opts.home || HARNESS_ROOT);
  const freshness = inspectIndexFreshness({
    home,
    now: opts.now,
    maxAgeDays: opts.maxAgeDays,
  });
  if (freshness.stale && opts.allowStale !== true) {
    return { ok: false, status: 'stale_index', freshness, results: [] };
  }

  const locations = pathsFor(home);
  let index;
  try { index = JSON.parse(fs.readFileSync(locations.indexFile, 'utf8')); }
  catch {
    return { ok: false, status: 'index_missing', freshness, results: [] };
  }
  const counts = {};
  for (const token of tokenize(query)) counts[token] = (counts[token] || 0) + 1;
  const queryVector = {};
  let normSquared = 0;
  for (const [term, count] of Object.entries(counts)) {
    const weight = 1 + Math.log(count);
    queryVector[term] = weight;
    normSquared += weight * weight;
  }
  const norm = Math.sqrt(normSquared);
  if (norm > 0) {
    for (const term of Object.keys(queryVector)) queryVector[term] /= norm;
  }

  const scored = [];
  for (const [filePath, documentVector] of Object.entries(index.vectors || {})) {
    const score = cosineSimilarity(queryVector, documentVector);
    if (score > 0) scored.push({ filePath, score });
  }
  scored.sort((left, right) => right.score - left.score);
  const topK = Math.max(1, Number(opts.topK || 5));
  const results = scored.slice(0, topK).map(({ filePath, score }) => ({
    path: slash(path.relative(home, filePath)),
    score,
    snippet: extractSnippet(filePath, query),
  }));
  return {
    ok: true,
    status: freshness.stale ? 'stale_allowed' : 'ok',
    freshness,
    results,
  };
}

function optionValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const home = optionValue(argv, '--home', HARNESS_ROOT);
  if (command === 'index') {
    const result = buildSemanticIndex({ home });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === 'query') {
    const result = querySemantic(argv[1] || '', {
      home,
      topK: Number(optionValue(argv, '--top', 5)),
      allowStale: argv.includes('--allow-stale'),
    });
    if (!result.ok) {
      console.log(JSON.stringify(result, null, 2));
      return 2;
    }
    // Preserve the historical array output for existing retrieval hooks.
    console.log(JSON.stringify(result.results, null, 2));
    return 0;
  }
  console.error('Usage:');
  console.error('  node semantic-search.cjs index [--rebuild] [--home PATH]');
  console.error('  node semantic-search.cjs query "question" [--top N] [--home PATH]');
  return 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  tokenize,
  buildIndex,
  eligibleFiles,
  buildSemanticIndex,
  inspectIndexFreshness,
  querySemantic,
  main,
};
