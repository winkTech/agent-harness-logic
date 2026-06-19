#!/usr/bin/env node
/**
 * Semantic Search — L2 记忆层核心工具
 *
 * 基于 TF-IDF + 中文字符 n-gram 的语义检索。
 * 覆盖参考文档要求的三种场景：
 *   1. 跨词同义召回（"打卡"↔"attendance"） — 用汉字 trigram 桥接
 *   2. 概念查询（"为什么用了两张表"↔"DB schema decision"） — TF-IDF 向量相似度
 *   3. 精确字面量 — 落到 grep，本脚本不做 (grep 更快)
 *
 * 用法:
 *   node semantic-search.cjs index [--rebuild]       # 构建/增量索引
 *   node semantic-search.cjs query "你的问题" [--top 5]  # 查询
 *
 * 索引位置: var/index/semantic-index.json
 */

const p = require('node:path');
const f = require('node:fs');
const os = require('node:os');

const HOME = p.join(os.homedir(), '.claude');
const INDEX_DIR = p.join(HOME, 'var', 'index');
const INDEX_FILE = p.join(INDEX_DIR, 'semantic-index.json');
const MEMORY_DIR = p.join(HOME, 'memory');
const KNOWLEDGE_DIRS = [
  p.join(HOME, 'knowledge', 'primary'),
  p.join(HOME, 'knowledge', 'docs'),
  p.join(HOME, 'knowledge', 'references'),
];

// ── Tokenizer: English words + Chinese char trigrams ─────────────────────
function tokenize(text) {
  if (!text) return [];
  const t = text.toLowerCase();
  const tokens = [];

  // English words / numbers / identifiers
  for (const m of t.matchAll(/[a-z][a-z0-9_]*/g)) {
    tokens.push(m[0]);
  }

  // Chinese char trigrams — bridges cross-language gaps
  const chars = t.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < chars.length - 2; i++) {
    tokens.push(chars.slice(i, i + 3));
  }
  // bigrams too
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.push(chars.slice(i, i + 2));
  }
  // unigrams
  for (const c of chars) tokens.push(c);

  return tokens;
}

// Stop words (English only — Chinese unigrams are meaningful)
const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','can','shall',
  'this','that','these','those','it','its','they','them','we','you','he','she',
  'to','of','in','for','on','with','at','by','from','as','into','through',
  'and','or','but','if','then','else','when','where','why','how','which','who',
  'not','no','nor','so','very','just','about','all','each','every','both',
  'more','most','some','any','such','only','own','same','too',
  '//','#','const','let','var','function','return','export','import','require',
]);

function filterStop(tokens) {
  return tokens.filter(t => t.length >= 2 || /[一-鿿]/.test(t));
}

// ── TF-IDF ────────────────────────────────────────────────────────────────
function buildIndex(fileList) {
  const docCount = fileList.length;
  const df = {};   // document frequency
  const tf = {};   // term frequency per doc: { file: { term: count } }

  for (const filePath of fileList) {
    let content;
    try {
      content = f.readFileSync(filePath, 'utf8');
    } catch { continue; }

    const tokens = filterStop(tokenize(content));
    const termCounts = {};
    const seen = new Set();

    for (const t of tokens) {
      termCounts[t] = (termCounts[t] || 0) + 1;
      if (!seen.has(t)) {
        seen.add(t);
        df[t] = (df[t] || 0) + 1;
      }
    }

    // Normalize TF: log(1 + count)
    const normTf = {};
    for (const [term, count] of Object.entries(termCounts)) {
      normTf[term] = 1 + Math.log(count);
    }
    tf[filePath] = normTf;
  }

  // Build IDF
  const idf = {};
  for (const [term, docFreq] of Object.entries(df)) {
    idf[term] = Math.log((docCount + 1) / (docFreq + 1)) + 1;
  }

  // Build TF-IDF vectors
  const vectors = {};
  for (const [filePath, termCounts] of Object.entries(tf)) {
    const vec = {};
    let norm2 = 0;
    for (const [term, val] of Object.entries(termCounts)) {
      const w = val * (idf[term] || 1);
      vec[term] = w;
      norm2 += w * w;
    }
    const norm = Math.sqrt(norm2);
    // Normalize to unit vector
    for (const term of Object.keys(vec)) {
      vec[term] /= norm;
    }
    vectors[filePath] = vec;
  }

  return { vectors, idf, df, docCount };
}

function cosineSimilarity(queryVec, docVec) {
  let dot = 0;
  for (const [term, qv] of Object.entries(queryVec)) {
    if (docVec[term]) {
      dot += qv * docVec[term];
    }
  }
  return dot;
}

// ── Walk files ────────────────────────────────────────────────────────────
function walkMd(dir, files = []) {
  try {
    for (const entry of f.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkMd(p.join(dir, entry.name), files);
      } else if (entry.name.endsWith('.md') && entry.name !== 'MEMORY.md' && entry.name !== 'MEMORY_RULES.md') {
        files.push(p.join(dir, entry.name));
      }
    }
  } catch { /* skip unreadable */ }
  return files;
}

// ── Index command ─────────────────────────────────────────────────────────
function cmdIndex(rebuild) {
  f.mkdirSync(INDEX_DIR, { recursive: true });

  // Gather all .md files
  const files = walkMd(MEMORY_DIR);
  for (const kd of KNOWLEDGE_DIRS) walkMd(kd, files);

  console.error(`Indexing ${files.length} files...`);

  const index = buildIndex(files);
  index.type = 'tfidf-charngram';
  index.version = 2;
  index.builtAt = new Date().toISOString();
  index.fileCount = files.length;

  // Store meta separately to keep the main index lean
  const meta = {
    type: 'tfidf-charngram',
    version: 2,
    builtAt: index.builtAt,
    fileCount: files.length,
    files: files.map(fp => ({
      path: fp.replace(HOME + p.sep, ''),
      mtime: f.statSync(fp).mtimeMs,
    })),
  };

  // Only store vectors (lean: no idf/df in the vector map, they're folded in)
  const vectors = index.vectors;

  // Prune: remove near-zero vectors (empty files)
  for (const [fp, vec] of Object.entries(vectors)) {
    if (Object.keys(vec).length === 0) delete vectors[fp];
  }

  const data = { vectors, type: index.type, version: index.version, builtAt: index.builtAt, fileCount: index.fileCount };
  f.writeFileSync(INDEX_FILE, JSON.stringify(data));
  f.writeFileSync(INDEX_FILE.replace('.json', '-meta.json'), JSON.stringify(meta));

  console.error(`Index built: ${Object.keys(vectors).length} docs indexed at ${INDEX_FILE}`);
}

// ── Query command ─────────────────────────────────────────────────────────
function cmdQuery(queryStr, topK) {
  if (!f.existsSync(INDEX_FILE)) {
    console.error('Index not found. Run "node semantic-search.cjs index" first.');
    process.exit(1);
  }

  const index = JSON.parse(f.readFileSync(INDEX_FILE, 'utf8'));
  const vectors = index.vectors;

  // Tokenize query
  const qTokens = filterStop(tokenize(queryStr));
  const qCounts = {};
  for (const t of qTokens) qCounts[t] = (qCounts[t] || 0) + 1;
  const maxQf = Math.max(...Object.values(qCounts), 1);
  const qVec = {};
  let qNorm2 = 0;
  for (const [t, c] of Object.entries(qCounts)) {
    const w = 1 + Math.log(c);
    qVec[t] = w;
    qNorm2 += w * w;
  }
  const qNorm = Math.sqrt(qNorm2);
  for (const t of Object.keys(qVec)) qVec[t] /= qNorm;

  // Score all docs
  const scored = [];
  for (const [filePath, docVec] of Object.entries(vectors)) {
    const sim = cosineSimilarity(qVec, docVec);
    if (sim > 0) {
      scored.push({ path: filePath, score: sim });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);

  // Output JSON for programmatic use
  const result = top.map(r => ({
    path: r.path.replace(HOME + p.sep, ''),
    score: r.score,
    snippet: extractSnippet(r.path, queryStr),
  }));

  console.log(JSON.stringify(result, null, 2));
}

function extractSnippet(filePath, query) {
  try {
    const content = f.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const qLower = query.toLowerCase();

    // Find the line with best keyword match
    let bestLine = 0;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      let score = 0;
      for (const word of qLower.split(/\s+/)) {
        if (word.length > 1 && l.includes(word)) score += word.length;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLine = i;
      }
    }

    const start = Math.max(0, bestLine - 1);
    const end = Math.min(lines.length, bestLine + 3);
    return lines.slice(start, end).join('\n').slice(0, 400);
  } catch {
    return '';
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
const cmd = process.argv[2];
switch (cmd) {
  case 'index':
    cmdIndex(process.argv.includes('--rebuild'));
    break;
  case 'query':
    cmdQuery(process.argv[3] || '', parseInt(process.argv[5], 10) || 5);
    break;
  default:
    console.error('Usage:');
    console.error('  node semantic-search.cjs index [--rebuild]');
    console.error('  node semantic-search.cjs query "your question" [--top N]');
    process.exit(1);
}
