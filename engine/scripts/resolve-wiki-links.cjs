#!/usr/bin/env node
/**
 * engine/scripts/resolve-wiki-links.cjs — P1-M2: [[wiki-link]] 解析器
 *
 * 将 memory/ MEMORY.md 中的 [[name]] 引用解析为实际文件路径和摘要。
 *
 * 解析规则:
 *   1. [[name]] 匹配 memory/learnings/ 中 frontmatter name 字段
 *   2. 回退匹配文件名（去掉日期前缀后的部分）
 *   3. 回退到 MEMORY.md 索引表
 *
 * 输出格式:
 *   {
 *     resolved: [{ name, file, description, summary }],
 *     unresolved: [string]  // 未能匹配的引用
 *   }
 *
 * 用法:
 *   const resolve = require('./resolve-wiki-links.cjs');
 *   const result = resolve.resolveWikiLinks(['name1', 'name2']);
 *
 *   CLI: node resolve-wiki-links.cjs --check   # 检查所有链接健康状况
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HOMEDIR = require('os').homedir();
const MEMORY_DIR = path.join(HOMEDIR, '.claude', 'memory');
const LEARNINGS_DIR = path.join(MEMORY_DIR, 'learnings');
const ERRORS_DIR = path.join(MEMORY_DIR, 'errors');
const PROJECTS_DIR = path.join(MEMORY_DIR, 'projects');
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');

// ── 索引缓存 ─────────────────────────────────────────────────────────────────
let _nameIndex = null;

/**
 * 建立名称→文件映射索引。
 * 扫描所有 memory 子目录，读取 frontmatter name 字段和文件名。
 */
function buildNameIndex() {
  if (_nameIndex) return _nameIndex;

  const index = new Map(); // name → { file, description, summary }

  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const filePath = path.join(dir, f);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const fm = {};
        if (match) {
          for (const line of match[1].split('\n')) {
            const idx = line.indexOf(':');
            if (idx === -1) continue;
            const key = line.slice(0, idx).trim();
            let val = line.slice(idx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
            fm[key] = val;
          }
        }

        const names = new Set();
        const fmName = fm.name || fm['metadata.name'];
        if (fmName) names.add(fmName);

        // 去日期前缀的文件名也作为别名
        const baseName = path.basename(f, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
        if (baseName) names.add(baseName);

        // 提取第一行作为摘要
        const body = match ? content.slice(match[0].length).trim() : content.trim();
        const firstLine = body.split('\n')[0]?.replace(/^#+\s*/, '').replace(/`/g, '').trim() || '';

        for (const n of names) {
          if (!index.has(n)) {
            index.set(n, {
              file: path.relative(MEMORY_DIR, filePath),
              description: fm.description || firstLine,
              summary: firstLine,
            });
          }
        }
      } catch { /* 跳过无法读取的文件 */ }
    }
  };

  scanDir(LEARNINGS_DIR);
  scanDir(ERRORS_DIR);
  scanDir(PROJECTS_DIR);
  scanDir(path.join(MEMORY_DIR, 'references'));
  scanDir(path.join(MEMORY_DIR, 'agents'));
  scanDir(path.join(HOMEDIR, '.claude', 'knowledge', 'methodology'));
  scanDir(path.join(HOMEDIR, '.claude', 'knowledge', 'references'));

  // 从 MEMORY.md 补充索引（仅取名称，路径从索引行推断）
  if (fs.existsSync(MEMORY_INDEX)) {
    const idxContent = fs.readFileSync(MEMORY_INDEX, 'utf8');
    // 匹配 [[name]] 引用格式
    const wikiRefs = idxContent.match(/\[\[([^\]]+)\]\]/g) || [];
    for (const ref of wikiRefs) {
      const name = ref.slice(2, -2);
      if (!index.has(name)) {
        // 标记为未解析引用
        index.set(name, {
          file: null,
          description: '(MEMORY.md 中引用但未找到实际文件)',
          summary: '(未解析)',
          unresolved: true,
        });
      }
    }
  }

  _nameIndex = index;
  return index;
}

function invalidateCache() { _nameIndex = null; }

/**
 * 解析单个 wiki 链接。
 * @param {string} name — [[name]] 中的名称
 * @returns {{ name: string, resolved: boolean, file?: string, description?: string, summary?: string }}
 */
function resolveLink(name) {
  const index = buildNameIndex();
  const entry = index.get(name);
  if (entry && !entry.unresolved) {
    return { name, resolved: true, file: entry.file, description: entry.description, summary: entry.summary };
  }
  return { name, resolved: false };
}

/**
 * 批量解析多个 wiki 链接。
 * @param {string[]} names
 * @returns {{ resolved: Array, unresolved: string[] }}
 */
function resolveWikiLinks(names) {
  const resolved = [];
  const unresolved = [];

  for (const n of names) {
    const r = resolveLink(n);
    if (r.resolved) resolved.push(r);
    else unresolved.push(n);
  }

  return { resolved, unresolved };
}

/**
 * 从 MEMORY.md 提取所有 [[wiki-link]] 引用。
 * @returns {string[]} 引用名称列表
 */
function extractReferences() {
  if (!fs.existsSync(MEMORY_INDEX)) return [];
  const content = fs.readFileSync(MEMORY_INDEX, 'utf8');
  const refs = content.match(/\[\[([^\]]+)\]\]/g) || [];
  return refs.map(r => r.slice(2, -2));
}

/**
 * 完整链接健康检查。
 * @returns {{ total: number, resolved: number, broken: string[], details: Array }}
 */
function healthCheck() {
  const refs = extractReferences();
  const result = resolveWikiLinks(refs);
  const total = refs.length;
  const resolved = result.resolved.length;
  const broken = result.unresolved;

  return { total, resolved, broken, details: result.resolved };
}

module.exports = {
  resolveLink,
  resolveWikiLinks,
  extractReferences,
  healthCheck,
  buildNameIndex,
  invalidateCache,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case '--check':
    case '--health': {
      const hc = healthCheck();
      console.log(`📊 Wiki-Link 健康状况`);
      console.log(`   总引用: ${hc.total}`);
      console.log(`   已解析: ${hc.resolved}`);
      console.log(`   断裂:   ${hc.broken.length}`);
      if (hc.broken.length > 0) {
        console.log(`   断裂列表:`);
        for (const b of hc.broken) console.log(`     ❌ [[${b}]]`);
      }
      for (const d of hc.details) {
        console.log(`   ✅ [[${d.name}]] → ${d.file}`);
      }
      process.exit(hc.broken.length > 0 ? 1 : 0);
    }

    case '--resolve': {
      const names = args.slice(1);
      if (names.length === 0) {
        console.log('用法: node resolve-wiki-links.cjs --resolve name1 name2 ...');
        process.exit(1);
      }
      const result = resolveWikiLinks(names);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case '--extract': {
      const refs = extractReferences();
      console.log(JSON.stringify(refs, null, 2));
      break;
    }

    case '--index':
      invalidateCache();
      buildNameIndex();
      console.log('索引已重建');
      break;

    default: {
      // 无参数：默认运行健康检查
      const hc = healthCheck();
      console.log(JSON.stringify(hc, null, 2));
    }
  }
}
