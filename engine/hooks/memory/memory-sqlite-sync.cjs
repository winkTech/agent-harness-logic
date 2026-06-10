#!/usr/bin/env node

/**
 * Hook: memory-sqlite-sync.cjs
 *
 * PostToolUse hook. 当 memory/*.md 文件被编辑时, 同步内容到 SQLite fact 表。
 * 轻量级双写: 不替代文件系统, 只在文件变更时同步。
 *
 * 设计:
 * - 只处理 memory/**/*.md 路径的 Write/Edit
 * - 幂等: 同内容二次触发仅 UPDATE
 * - 不阻塞: 所有异常被捕获, 永不抛
 * - 零依赖: 只用 fs + path + engine/sqlite
 *
 * 注册方式: settings.local.json hooks.PostToolUse 中添加:
 *   {
 *     "matcher": "Edit|Write",
 *     "hooks": [{
 *       "type": "command",
 *       "command": "node engine/hooks/memory/memory-sqlite-sync.cjs",
 *       "async": true,
 *       "timeout": 5000
 *     }]
 *   }
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 仅在 memory/ 目录下的 .md 文件才处理
const MEMORY_DIR = path.resolve(__dirname, '..', '..', '..', 'memory');

function isMemoryFile(filePath) {
  if (!filePath || !filePath.endsWith('.md')) return false;
  const normalized = path.normalize(filePath);
  return normalized.startsWith(MEMORY_DIR);
}

// 简易 frontmatter 解析 (与 migrate 脚本相同逻辑, 内嵌避免交叉引用)
function parseFrontmatter(content) {
  const lines = content.split('\n');
  const fm = {};
  let body = content;
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { body = lines.slice(i + 1).join('\n').trim(); break; }
      const m = lines[i].match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
      if (m) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        fm[m[1]] = v;
      }
    }
  }
  return { frontmatter: fm, body };
}

function inferNamespace(filePath) {
  const rel = path.relative(MEMORY_DIR, filePath);
  const parts = rel.split(path.sep);
  const dirMap = { learnings: 'learnings', errors: 'errors', archive: 'archive', projects: 'project', references: 'reference' };
  return (parts.length >= 2 && dirMap[parts[0]]) || 'learnings';
}

function inferName(filePath) {
  return path.basename(filePath, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

async function main() {
  try {
    // 从 stdin 读 hook 输入 (Claude Code 传递的事件数据)
    let input = '';
    try {
      input = fs.readFileSync(0, 'utf8');
    } catch { /* stdin 可能为空 */ }

    if (!input) return;

    // 尝试从输入中提取文件路径
    const lines = input.split('\n');
    let targetPath = null;

    for (const line of lines) {
      // 查找 "path": "..." 或类似模式
      const pm = line.match(/"path"\s*:\s*"([^"]+)"/);
      if (pm) { targetPath = pm[1]; break; }
    }

    // 从 claude_data / env 回退提取
    if (!targetPath) {
      try {
        const parsed = JSON.parse(input);
        if (parsed.path) targetPath = parsed.path;
        else if (parsed.filePath) targetPath = parsed.filePath;
        else if (parsed.toolInput?.file_path) targetPath = parsed.toolInput.file_path;
      } catch { /* not JSON */ }
    }

    if (!targetPath || !isMemoryFile(targetPath)) return;

    // 读文件内容
    let content;
    try {
      content = fs.readFileSync(targetPath, 'utf8');
    } catch { return; } // 文件可能已被删除

    // 解析 frontmatter
    const { frontmatter, body } = parseFrontmatter(content);
    if (!body) return;

    const namespace = frontmatter.metadata?.type || inferNamespace(targetPath);
    const name = frontmatter.name || inferName(targetPath);

    // 写入 SQLite
    const { writeMemory } = require('../../sqlite/store-memory.cjs');
    const { openDb } = require('../../sqlite/index.cjs');

    const wDb = openDb();
    writeMemory({
      namespace,
      name,
      content,
      description: frontmatter.description || body.split('\n')[0]?.replace(/^#\s+/, '').slice(0, 100) || name,
      source: 'hook:memory-sqlite-sync',
      confidence: namespace === 'errors' ? 0.9 : 0.7,
    }, { db: wDb.db });
    wDb.close();
  } catch { /* 静默失败, 不阻塞 hook 链 */ }
}

main();
