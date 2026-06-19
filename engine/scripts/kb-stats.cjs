#!/usr/bin/env node
/**
 * engine/scripts/kb-stats.cjs — 知识库自动统计脚本
 *
 * 统计 knowledge/ 各子目录的文档数，输出 JSON 供 INDEX.md 引用。
 * 替代手工维护的 Stats 表。
 *
 * 用法:
 *   node engine/scripts/kb-stats.cjs          # 输出摘要到 stdout
 *   node engine/scripts/kb-stats.cjs --json   # 输出 JSON
 *   node engine/scripts/kb-stats.cjs --check  # 检查 INDEX.md 计数是否过时
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KB_DIR = path.join(require('node:os').homedir(), '.claude', 'knowledge');

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

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const check = args.includes('--check');

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
  const pdfs = count(path.join(KB_DIR, 'source'), f => f.endsWith('.pdf'));

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
    frontmatterRate: totalMd > 0 ? Math.round(withFm / totalMd * 100) : 0,
    totalMd,
    withFrontmatter: withFm,
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

    if (issues.length > 0) {
      console.log('⚠️ 知识库索引需要更新:');
      for (const i of issues) console.log(`  - ${i}`);
      process.exit(1);
    } else {
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
}

if (require.main === module) {
  main();
}

module.exports = { count };
