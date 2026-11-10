#!/usr/bin/env node

/**
 * engine/scripts/migrate-files-to-sqlite.cjs
 *
 * 将现有 memory/*.md 文件迁移到 SQLite 事实表。
 * 双写兼容: 源文件不动, 只读导入。
 *
 * 用法:
 *   node engine/scripts/migrate-files-to-sqlite.cjs              # 全量迁移
 *   node engine/scripts/migrate-files-to-sqlite.cjs --verify     # 只验证不迁移
 *   node engine/scripts/migrate-files-to-sqlite.cjs --dry-run    # 试运行
 *   node engine/scripts/migrate-files-to-sqlite.cjs --file memory/learnings/xxx.md  # 单文件
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('../sqlite/index.cjs');
const { writeMemory, writeBatch, memoryStats } = require('../sqlite/store-memory.cjs');
const { shouldMigrateMemoryFile } = require('./lib/memory-file-policy.cjs');

// ── 配置 ───────────────────────────────────────────────────────────────────

const HOME_DIR = path.resolve(__dirname, '..', '..');
const MEMORY_DIR = path.join(HOME_DIR, 'memory');

/** 命名空间映射: 子目录 → fact.namespace (需匹配 CHECK 约束) */
const DIR_NS_MAP = {
  learnings: 'learnings',
  errors: 'errors',
  archive: 'archive',
  projects: 'project',
  references: 'reference',
  agents: 'learnings',   // agent 定义归入 learnings
  work: 'reference',      // 工作模板归入 reference
};

/** 不迁移的系统文件 */
const SKIP_FILES = new Set(['MEMORY.md', 'MEMORY_RULES.md', 'links.md']);

/** 模板文件 (带 TEMPLATE 的文件提取教训但不做为主要事实) */
const TEMPLATE_PATTERN = /TEMPLATE/i;

// ── 简易 Frontmatter 解析 ─────────────────────────────────────────────────

/**
 * 解析 Markdown 文件中的 YAML frontmatter。
 * 格式: 文件头 `---\\n...\\n---` 之间的键值对。
 * 不依赖 js-yaml, 只用正则逐行解析简单键值。
 *
 * @param {string} content - 文件全文
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFrontmatter(content) {
  const lines = content.split('\n');
  const frontmatter = {};
  let body = content;
  let inFm = false;
  let fmEnd = -1;

  // 第一行必须是 ---
  if (lines.length > 0 && lines[0].trim() === '---') {
    inFm = true;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '---') {
        fmEnd = i;
        break;
      }
      // 解析 key: value (支持多行值? 不处理, 只用第一行)
      const match = line.match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
      if (match) {
        let val = match[2].trim();
        // 去掉引号
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        frontmatter[match[1]] = val;
      }
    }
  }

  if (fmEnd > 0) {
    body = lines.slice(fmEnd + 1).join('\n').trim();
  }

  return { frontmatter, body };
}

/**
 * 提取 Markdown 中的 [[links]] 引用。
 * @param {string} content
 * @returns {string[]} 链接名称列表
 */
function extractLinks(content) {
  const links = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const name = match[1].trim();
    if (name && !links.includes(name)) links.push(name);
  }
  return links;
}

/**
 * 从文件路径推断 namespace。
 */
function inferNamespace(filePath) {
  const rel = path.relative(MEMORY_DIR, filePath);
  const parts = rel.split(path.sep);
  if (parts.length >= 2) {
    const dir = parts[0];
    return DIR_NS_MAP[dir] || 'learnings';
  }
  return 'learnings';
}

/**
 * 从文件名推断 name。
 */
function inferName(filePath) {
  const base = path.basename(filePath, '.md');
  // 去掉日期前缀 YYYY-MM-DD- 或 YYYY-MM-DD-
  return base.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

/**
 * 从 frontmatter + 文件名 提取描述。
 */
function extractDescription(fm, body, filePath) {
  if (fm.description) return fm.description;
  // 取第一个非空标题行
  const titleMatch = body.match(/^#\s+(.+)$/m);
  if (titleMatch) return titleMatch[1].trim();
  return inferName(filePath);
}

// ── 迁移单个文件 ──────────────────────────────────────────────────────────

/**
 * 将单个 .md 文件转换为事实对象。
 * @returns {{ fact: object|null, links: string[] }}
 */
function fileToFact(filePath) {
  if (!shouldMigrateMemoryFile(filePath, { memoryDir: MEMORY_DIR })) {
    return { fact: null, links: [], filePath, skipped: true };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);

  const namespace = frontmatter.metadata?.type || inferNamespace(filePath);
  const name = frontmatter.name || inferName(filePath);
  const description = extractDescription(frontmatter, body, filePath);
  const links = extractLinks(content);

  // 根据 frontmatter 推断置信度
  let confidence = 0.7; // default
  if (namespace === 'errors') confidence = 0.9; // 错误记录高可信
  if (namespace === 'archive') confidence = 0.3; // 归档低
  if (TEMPLATE_PATTERN.test(filePath)) confidence = 0.2; // 模板最低

  return {
    fact: {
      namespace: namespace === 'error' ? 'errors' : namespace,
      name,
      content,
      description,
      source: 'migration:file',
      confidence,
    },
    links,
    filePath,
  };
}

// ── 扫描 ──────────────────────────────────────────────────────────────────

/**
 * 递归扫描 memory/ 目录, 返回所有 .md 文件路径 (排除 SKIP_FILES)。
 */
function scanMemoryFiles() {
  const files = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (SKIP_FILES.has(entry.name)) continue;
        if (!shouldMigrateMemoryFile(fullPath, { memoryDir: MEMORY_DIR })) continue;
        files.push(fullPath);
      }
    }
  }

  walk(MEMORY_DIR);
  return files.sort();
}

// ── 报告 ──────────────────────────────────────────────────────────────────

function printReport(results, options, statsDb) {
  let total = 0;
  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const r of results) {
    total++;
    if (r.status === 'imported') imported++;
    else if (r.status === 'skipped') skipped++;
    else if (r.status === 'error') errors.push(r);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`记忆迁移报告 (${options.mode})`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  总计: ${total} 个文件`);
  console.log(`  导入: ${imported} 个`);
  console.log(`  跳过: ${skipped} 个`);
  console.log(`  错误: ${errors.length} 个`);

  if (errors.length > 0) {
    console.log(`\n错误详情:`);
    for (const e of errors) {
      console.log(`  ❌ ${e.path}: ${e.error}`);
    }
  }

  // SQLite 统计
  if (options.mode !== 'dry-run' && statsDb) {
    try {
      const st = memoryStats({ db: statsDb });
      console.log(`\nSQLite 统计:`);
      console.log(`  总记录: ${st.total}`);
      console.log(`  已确认: ${st.confirmed}`);
      console.log(`  待定: ${st.tentative}`);
      console.log(`  低置信: ${st.low}`);
      console.log(`  命名空间: ${st.namespaces}`);
    } catch (e) {
      console.log(`\nSQLite 查询失败: ${e.message}`);
    }
  }
}

// ── 主函数 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const options = {
    mode: args.includes('--dry-run') ? 'dry-run' :
          args.includes('--verify') ? 'verify' : 'import',
    singleFile: null,
  };

  // 检查 --file 参数
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    options.singleFile = path.resolve(HOME_DIR, args[fileIdx + 1]);
  }

  // 扫描
  const files = options.singleFile ? [options.singleFile] : scanMemoryFiles();
  console.log(`扫描到 ${files.length} 个记忆文件...`);

  // 转换
  const entries = files
    .map(fileToFact)
    .filter(e => e.fact !== null);

  if (options.mode === 'verify') {
    console.log(`\n验证 ${entries.length} 个文件的可迁移性:`);
    for (const e of entries) {
      const rel = path.relative(HOME_DIR, e.filePath);
      console.log(`  📄 [${e.fact.namespace}] ${rel}`);
      console.log(`     名称: ${e.fact.name}`);
      console.log(`     描述: ${e.fact.description.slice(0, 60)}`);
      if (e.links.length > 0) {
        console.log(`     链接: ${e.links.join(', ')}`);
      }
    }
    printReport(entries.map(e => ({ path: e.filePath, status: 'verify' })), { mode: 'verify' });
    return;
  }

  if (options.mode === 'dry-run') {
    console.log(`\n[DRY RUN] 将迁移 ${entries.length} 条事实到 SQLite:`);
    for (const e of entries) {
      const rel = path.relative(HOME_DIR, e.filePath);
      console.log(`  📄 [${e.fact.namespace}] ${e.fact.name}`);
    }
    printReport(entries.map(e => ({ path: e.filePath, status: 'dry-run' })), { mode: 'dry-run' });
    return;
  }

  // ── 正式导入 ────────────────────────────────────────────────────────────
  console.log(`\n正在导入 ${entries.length} 条事实到 SQLite...`);

  const wDb = openDb();
  const results = [];

  for (const entry of entries) {
    try {
      const rel = path.relative(HOME_DIR, entry.filePath);
      const result = writeMemory(entry.fact, { db: wDb.db });
      results.push({
        path: rel,
        status: result.isNew ? 'imported' : 'updated',
        id: result.id,
      });
      process.stdout.write(result.isNew ? '➕' : '🔄');
    } catch (err) {
      results.push({
        path: entry.filePath,
        status: 'error',
        error: err.message,
      });
      process.stdout.write('❌');
    }
  }

  // 写入链接
  let linkCount = 0;
  for (const entry of entries) {
    for (const linkName of entry.links) {
      try {
        // 用链接名称模糊查找目标事实
        const target = wDb.db.prepare(
          'SELECT id FROM facts WHERE name = ? OR content LIKE ? LIMIT 1'
        ).get(linkName, `%${linkName}%`);
        if (target) {
          // 从 facts 表查 source id
          const source = wDb.db.prepare(
            'SELECT id FROM facts WHERE name = ? ORDER BY created_at DESC LIMIT 1'
          ).get(entry.fact.name);
          if (source && target.id !== source.id) {
            wDb.db.prepare(
              'INSERT OR IGNORE INTO fact_links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?)'
            ).run(source.id, target.id, 'related', Date.now());
            linkCount++;
          }
        }
      } catch { /* 链接写入失败不阻止迁移 */ }
    }
  }

  console.log(`\n链接: 写入 ${linkCount} 条`);

  printReport(results, { mode: 'import' }, wDb.db);

  // 验证完整性
  const st = memoryStats({ db: wDb.db });
  if (st.total === entries.length) {
    console.log(`\n✅ 完整性验证通过: ${st.total} = ${entries.length}`);
  } else {
    console.log(`\n⚠️ 完整性验证: SQLite ${st.total} 条, 预期 ${entries.length} 条`);
  }

  wDb.close();
}

main().catch(err => {
  console.error('迁移失败:', err.message);
  process.exit(1);
});
