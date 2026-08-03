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

/**
 * 路径亲和度加成 (2026-07-30, D4 金标评测暴露的根因)。
 *
 * 旧实现只按**正文** TF-IDF 排序, 路径与文件名不参与任何环节 —— 于是
 * "LDPC 定点量化"命中的是其他模块的 fixed_point_report.md, 而不是
 * ldpc/stage3_fixed_point_report.md: 正文里模块名的出现次数远少于通用术语。
 * 金标集 30 例实测 6 miss, 其中 5 例是这个原因。
 *
 * 先试过把路径词元塞进文档向量, 实测几乎无效 (3 次出现在数千词元的长文里被
 * 归一化摊平, precision 0.722→0.733)。改为**查询时**按"查询词元在路径里出现的
 * 比例"加成: 机制显式、上界固定 (PATH_AFFINITY_WEIGHT), 不改索引语义。
 */
const PATH_AFFINITY_WEIGHT = 0.35;

function pathTokenSet(relativePath) {
  const segments = slash(relativePath).replace(/\.md$/i, '').split('/');
  const tokens = new Set();
  for (const segment of segments) {
    for (const token of tokenize(segment.replace(/[-_]/g, ' '))) tokens.add(token);
    for (const token of tokenize(segment)) tokens.add(token);
  }
  return tokens;
}

/** 查询词元命中路径的比例 (0..1)。CJK 单字噪声大, 只看长度 ≥2 的词元。 */
function pathAffinity(queryTerms, relativePath) {
  const meaningful = queryTerms.filter((term) => term.length >= 2);
  if (meaningful.length === 0) return 0;
  const tokens = pathTokenSet(relativePath);
  const hits = meaningful.filter((term) => tokens.has(term)).length;
  return hits / meaningful.length;
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
    version: 4,          // v4 起 files[] 带 size；读取侧对无 size 的旧 meta 向下兼容
    builtAt,
    fileCount: files.length,
    // size 与 mtime 一起记: 仅靠 mtime 判漂移有个 1ms 盲窗 (见 inspectIndexFreshness),
    // 而"建完索引马上改文件"恰恰最常落进这个窗口。size 对追加/截断是精确判据。
    files: files.map((filePath) => {
      const st = fs.statSync(filePath);
      return {
        path: slash(path.relative(home, filePath)),
        mtime: st.mtimeMs,
        size: st.size,
      };
    }),
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
  const current = new Map(eligibleFiles(home).map((filePath) => {
    const st = fs.statSync(filePath);
    return [slash(path.relative(home, filePath)), { mtime: st.mtimeMs, size: st.size }];
  }));

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

  const recorded = new Map(meta.files.map((item) => [slash(item.path), {
    mtime: Number(item.mtime),
    // v3 及更早的 meta 没有 size —— 记为 null 表示"该文件无 size 判据可用",
    // 而不是伪造一个 0 (那会把所有旧索引里的文件误判成被截断)。
    size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
  }]));
  const missing = [...recorded.keys()].filter((item) => !current.has(item)).length;
  const unindexed = [...current.keys()].filter((item) => !recorded.has(item)).length;
  // 漂移判据 = size 变了 或 mtime 差超过容差。
  //
  // 为什么不能只看 mtime: 容差 1ms 是为吸收文件系统时间戳抖动而留的, 但它同时开了
  // 一个盲窗 —— "索引记录 mtime → 随即改文件"几乎必然落在窗内。实测 200 次追加,
  // Linux 有 99.5%、Windows 有 83.5% 的 mtime 差 <=1ms, 即漂移**检测不到**。
  // 这是"看不出来"被当成"没变", 与 harness 的 fail-closed 原则相反。
  // size 对追加/截断是精确判据, 不受时间戳分辨率影响; mtime 继续兜住等长的原地改写。
  const changed = [...current].filter(([item, cur]) => {
    const rec = recorded.get(item);
    if (!rec) return false;
    if (rec.size !== null && rec.size !== cur.size) return true;
    return Math.abs(cur.mtime - rec.mtime) > 1;
  }).length;
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

  const queryTerms = Object.keys(queryVector);
  const scored = [];
  for (const [filePath, documentVector] of Object.entries(index.vectors || {})) {
    const cosine = cosineSimilarity(queryVector, documentVector);
    const relativePath = slash(path.relative(home, filePath));
    const affinity = pathAffinity(queryTerms, relativePath);
    const score = cosine + PATH_AFFINITY_WEIGHT * affinity;
    if (score > 0) scored.push({ filePath, relativePath, score, cosine, pathAffinity: affinity });
  }
  scored.sort((left, right) => right.score - left.score);
  const topK = Math.max(1, Number(opts.topK || 5));
  const results = scored.slice(0, topK).map(({ filePath, relativePath, score, cosine, pathAffinity: affinity }) => ({
    path: relativePath,
    score,
    cosine,
    pathAffinity: affinity,
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

const DEFAULT_EVAL_CASES = path.join(
  'engine', 'scripts', 'test-hooks', 'fixtures', 'retrieval-eval-cases.json',
);

/**
 * 检索金标评测 (D4)。金标的 expected 由文档主题决定, 不能按检索器当前输出反向标注,
 * 否则指标退化成自我确认。三个口径同时报告:
 *   hitRate@k  — 至少命中一条期望文档的 case 比例 (召回是否发生)
 *   precision@k — 命中数 / min(k, |expected|) (排前面的是不是对的)
 *   MRR        — 第一条正确结果的排名倒数 (要不要往下翻)
 */
function evaluateRetrieval(opts = {}) {
  const home = path.resolve(opts.home || HARNESS_ROOT);
  const casesFile = path.resolve(opts.casesFile || path.join(home, DEFAULT_EVAL_CASES));
  const parsed = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
  const cases = Array.isArray(parsed) ? parsed : parsed.cases;
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('retrieval eval corpus is empty');
  const topK = Math.max(1, Number(opts.topK || 5));
  const freshness = inspectIndexFreshness({ home, now: opts.now, maxAgeDays: opts.maxAgeDays });

  const perCase = [];
  for (const testCase of cases) {
    const expected = (testCase.expected || []).map(slash);
    if (expected.length === 0) throw new Error(`${testCase.id}: expected documents are required`);
    const result = querySemantic(testCase.query, { home, topK, allowStale: opts.allowStale, now: opts.now });
    const returned = (result.results || []).map((entry) => slash(entry.path));
    const hits = returned.filter((entry) => expected.includes(entry));
    const firstHitIndex = returned.findIndex((entry) => expected.includes(entry));
    perCase.push({
      id: testCase.id,
      query: testCase.query,
      status: result.status,
      expected,
      returned,
      hits: hits.length,
      hit: hits.length > 0,
      precision: Number((hits.length / Math.min(topK, expected.length)).toFixed(6)),
      reciprocalRank: firstHitIndex >= 0 ? Number((1 / (firstHitIndex + 1)).toFixed(6)) : 0,
    });
  }

  const mean = (values) => (values.length
    ? Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(6))
    : null);
  const summary = {
    cases: perCase.length,
    topK,
    hitRate: mean(perCase.map((entry) => (entry.hit ? 1 : 0))),
    precisionAtK: mean(perCase.map((entry) => entry.precision)),
    mrr: mean(perCase.map((entry) => entry.reciprocalRank)),
    misses: perCase.filter((entry) => !entry.hit).map((entry) => entry.id),
  };
  const threshold = (value, fallback) => {
    // null 来自"命令行没给该选项", 必须回落默认值 —— Number(null)=0 会让门禁失效。
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const minPrecision = threshold(opts.minPrecision, 0.8);
  const minHitRate = threshold(opts.minHitRate, 0.9);
  const failures = [];
  if (freshness.stale && opts.allowStale !== true) failures.push(`index is stale: ${freshness.reason}`);
  if (summary.precisionAtK < minPrecision) failures.push(`precision@${topK} ${summary.precisionAtK} < ${minPrecision}`);
  if (summary.hitRate < minHitRate) failures.push(`hitRate@${topK} ${summary.hitRate} < ${minHitRate}`);

  return {
    schemaVersion: 1,
    mode: 'retrieval-eval',
    casesFile: slash(path.relative(home, casesFile)),
    status: failures.length === 0 ? 'passed' : 'failed',
    freshness,
    summary,
    thresholds: { minPrecision, minHitRate },
    failures,
    perCase,
  };
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
  if (command === 'eval') {
    const result = evaluateRetrieval({
      home,
      casesFile: optionValue(argv, '--cases'),
      topK: Number(optionValue(argv, '--top', 5)),
      minPrecision: optionValue(argv, '--min-precision'),
      minHitRate: optionValue(argv, '--min-hit-rate'),
      allowStale: argv.includes('--allow-stale'),
    });
    if (argv.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const { summary } = result;
      console.log(`retrieval-eval: ${result.status} cases=${summary.cases} `
        + `hitRate@${summary.topK}=${summary.hitRate} precision@${summary.topK}=${summary.precisionAtK} MRR=${summary.mrr}`);
      if (summary.misses.length) console.log(`  misses: ${summary.misses.join(', ')}`);
      for (const failure of result.failures) console.log(`  FAIL ${failure}`);
    }
    return result.status === 'passed' ? 0 : 1;
  }
  console.error('Usage:');
  console.error('  node semantic-search.cjs index [--rebuild] [--home PATH]');
  console.error('  node semantic-search.cjs query "question" [--top N] [--home PATH]');
  console.error('  node semantic-search.cjs eval [--cases FILE] [--top N] [--min-precision X] [--json]');
  return 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_EVAL_CASES,
  tokenize,
  buildIndex,
  eligibleFiles,
  buildSemanticIndex,
  inspectIndexFreshness,
  querySemantic,
  evaluateRetrieval,
  main,
};
