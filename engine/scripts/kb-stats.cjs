#!/usr/bin/env node
/**
 * engine/scripts/kb-stats.cjs — 知识库自动统计脚本
 *
 * 统计 engineering-assets/knowledge/ 各子目录的文档数，输出 JSON 供 INDEX.md 引用。
 * 替代手工维护的 Stats 表。
 *
 * 用法:
 *   node engine/scripts/kb-stats.cjs          # 输出摘要到 stdout
 *   node engine/scripts/kb-stats.cjs --json   # 输出 JSON
 *   node engine/scripts/kb-stats.cjs --check  # 检查 INDEX.md 计数是否过时
 */

'use strict';

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { shouldIndexSemanticFile } = require('./lib/memory-file-policy.cjs');
const { healthCheck } = require('./resolve-wiki-links.cjs');

const HOME_DIR = HARNESS_ROOT;
const KB_DIR = path.join(HOME_DIR, 'engineering-assets', 'knowledge');
const MEMORY_DIR = path.join(HOME_DIR, 'memory');
const SEMANTIC_META = path.join(HOME_DIR, 'var', 'index', 'semantic-index-meta.json');

function count(dir, filter = f => f.endsWith('.md'), excludeDirs = []) {
  if (!fs.existsSync(dir)) return { files: 0, dirs: 0 };
  let files = 0, dirs = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 排除指定目录
      if (excludeDirs.includes(entry.name)) continue;
      if (!entry.name.startsWith('.') && entry.name !== '__pycache__') {
        const sub = count(full, filter, excludeDirs);
        files += sub.files;
        dirs += sub.dirs + 1;
      }
    } else if (entry.isFile() && filter(entry.name)) {
      files++;
    }
  }
  return { files, dirs };
}

function rel(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function walkMarkdown(dir, shouldInclude, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== '__pycache__') {
        walkMarkdown(full, shouldInclude, files);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md') && (!shouldInclude || shouldInclude(full))) {
      files.push(full);
    }
  }
  return files;
}

function requiresFrontmatter(filePath) {
  const r = rel(KB_DIR, filePath);
  if (r.startsWith('archive/sources/')) return false;
  if (r.split('/').includes('examples')) return false;
  return true;
}

function scanFrontmatter() {
  const files = walkMarkdown(KB_DIR, requiresFrontmatter);
  const missing = [];
  let withFm = 0;

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trimStart().startsWith('---')) withFm++;
      else missing.push(rel(KB_DIR, filePath));
    } catch {
      missing.push(rel(KB_DIR, filePath));
    }
  }

  return {
    totalMd: files.length,
    withFrontmatter: withFm,
    missingFrontmatter: missing,
    frontmatterRate: files.length > 0 ? Math.round(withFm / files.length * 100) : 0,
  };
}

function semanticEligibleFiles() {
  const dirs = [
    MEMORY_DIR,
    path.join(KB_DIR, 'primary'),
    path.join(KB_DIR, 'docs'),
    path.join(KB_DIR, 'references'),
  ];
  const files = [];
  for (const dir of dirs) {
    walkMarkdown(dir, filePath => shouldIndexSemanticFile(filePath, {
      home: HOME_DIR,
      memoryDir: MEMORY_DIR,
      knowledgeDir: KB_DIR,
    }), files);
  }
  return files;
}

function readSemanticMeta() {
  try {
    const meta = JSON.parse(fs.readFileSync(SEMANTIC_META, 'utf8'));
    return {
      found: true,
      builtAt: meta.builtAt || null,
      fileCount: Number(meta.fileCount || 0),
    };
  } catch {
    return { found: false, builtAt: null, fileCount: 0 };
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const check = args.includes('--check');
  const quiet = args.includes('--quiet');

  // primary/ 文档
  const primary = count(path.join(KB_DIR, 'primary'));
  const primaryNoExamples = count(path.join(KB_DIR, 'primary'), f => f.endsWith('.md'), ['examples']);

  // 各子目录
  const irisDirs = ['python-basics', 'math-foundation', 'linear-algebra', 'probability-statistics', 'data-viz'];
  const irisCards = {};
  let irisTotal = 0;
  for (const d of irisDirs) {
    const c = count(path.join(KB_DIR, d));
    irisCards[d] = c.files;
    irisTotal += c.files;
  }

  const refs = count(path.join(KB_DIR, 'references'));
  const templates = count(path.join(KB_DIR, 'docs', 'templates'));
  const sources = count(path.join(KB_DIR, 'archive', 'sources'));
  // PDF 原始资料已迁至 reference-assets/datasheets/（规范 §3.1 reference 级）
  const pdfs = count(path.join(HOME_DIR, 'engineering-assets', 'reference-assets', 'datasheets'), f => f.endsWith('.pdf'));
  const fm = scanFrontmatter();
  const wiki = healthCheck();
  const semanticFiles = semanticEligibleFiles();
  const semanticMeta = readSemanticMeta();

  // frontmatter 覆盖率
  let withFm = 0, totalMd = 0;
  function scanFm(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== '__pycache__' && entry.name !== 'examples') {
          scanFm(full);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        totalMd++;
        try {
          const content = fs.readFileSync(full, 'utf8');
          if (content.trimStart().startsWith('---')) withFm++;
        } catch { /* ignore */ }
      }
    }
  }
  scanFm(KB_DIR);

  const stats = {
    primary: primary.files,
    primaryNoExamples: primaryNoExamples.files,
    iris: irisTotal,
    irisDetails: irisCards,
    references: refs.files,
    templates: templates.files,
    sources: sources.files,
    pdfs: pdfs.files,
    frontmatterRate: fm.frontmatterRate,
    totalMd: fm.totalMd,
    withFrontmatter: fm.withFrontmatter,
    missingFrontmatter: fm.missingFrontmatter,
    wikiLinks: {
      total: wiki.total,
      resolved: wiki.resolved,
      broken: wiki.broken,
    },
    semanticIndex: {
      eligible: semanticFiles.length,
      indexed: semanticMeta.fileCount,
      builtAt: semanticMeta.builtAt,
      found: semanticMeta.found,
    },
  };

  // --check 模式：检查 INDEX.md 是否过时
  if (check) {
    const indexPath = path.join(KB_DIR, 'INDEX.md');
    let indexContent = '';
    try { indexContent = fs.readFileSync(indexPath, 'utf8'); } catch { /* */ }

    const lastUpdatedMatch = indexContent.match(/最后更新:\s*(\S+)/);
    const lastUpdated = lastUpdatedMatch ? lastUpdatedMatch[1] : 'unknown';
    const today = new Date().toISOString().slice(0, 10);

    const issues = [];
    if (lastUpdated !== today) {
      issues.push(`INDEX.md 最后更新 ${lastUpdated}，今天是 ${today}`);
    }

    // Check primary count in header
    const headerMatch = indexContent.match(/(\d+)\s*篇\s*primary/);
    if (headerMatch && parseInt(headerMatch[1]) !== stats.primaryNoExamples) {
      issues.push(`primary 计数: INDEX.md 声称 ${headerMatch[1]}，实际 ${stats.primaryNoExamples}`);
    }

    if (stats.missingFrontmatter.length > 0) {
      issues.push(`frontmatter missing: ${stats.missingFrontmatter.length} files (${stats.missingFrontmatter.slice(0, 5).join(', ')})`);
    }

    if (stats.wikiLinks.broken.length > 0) {
      issues.push(`wiki links broken: ${stats.wikiLinks.broken.length} (${stats.wikiLinks.broken.slice(0, 5).map(x => `[[${x}]]`).join(', ')})`);
    }

    if (!stats.semanticIndex.found) {
      issues.push('semantic index missing: run node engine/scripts/semantic-search.cjs index --rebuild');
    } else {
      const builtDate = String(stats.semanticIndex.builtAt || '').slice(0, 10);
      if (builtDate !== today) {
        issues.push(`semantic index stale: built ${builtDate || 'unknown'}, today is ${today}`);
      }
      if (stats.semanticIndex.indexed !== stats.semanticIndex.eligible) {
        issues.push(`semantic index file count: indexed ${stats.semanticIndex.indexed}, eligible ${stats.semanticIndex.eligible}`);
      }
    }

    if (issues.length > 0) {
      if (quiet) process.exit(0);
      console.log('⚠️ 知识库索引需要更新:');
      for (const i of issues) console.log(`  - ${i}`);
      process.exit(1);
    } else {
      if (quiet) process.exit(0);
      console.log('✅ 知识库索引最新');
      process.exit(0);
    }
  }

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  // 摘要输出
  console.log('📊 知识库统计 (' + new Date().toISOString().slice(0, 10) + ')');
  console.log('─────────────────────────');
  console.log(`  Primary 文档 (不含示例): ${stats.primaryNoExamples}`);
  console.log(`  Primary 文档 (含示例):   ${stats.primary}`);
  console.log(`  鸢尾花书蒸馏卡片:       ${stats.iris}`);
  console.log(`  引用文档 (references/):  ${stats.references}`);
  console.log(`  文档模板:                ${stats.templates}`);
  console.log(`  源提取 (archive/):       ${stats.sources}`);
  console.log(`  PDF 原始文件:            ${stats.pdfs}`);
  console.log(`  Frontmatter 覆盖率:      ${stats.frontmatterRate}% (${stats.withFrontmatter}/${stats.totalMd})`);
  console.log(`  Wiki-Link 断链:          ${stats.wikiLinks.broken.length}/${stats.wikiLinks.total}`);
  console.log(`  Semantic Index:          ${stats.semanticIndex.indexed}/${stats.semanticIndex.eligible} (${stats.semanticIndex.builtAt || 'missing'})`);
}

if (require.main === module) {
  main();
}

module.exports = {
  count,
  scanFrontmatter,
  semanticEligibleFiles,
  readSemanticMeta,
};
