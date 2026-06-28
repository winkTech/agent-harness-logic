#!/usr/bin/env node

/**
 * Hook: memory-sqlite-sync.cjs
 *
 * PostToolUse hook. 当 memory/*.md 文件被编辑时, 同步内容到 SQLite fact 表。
 * 轻量级双写: 不替代文件系统, 只在文件变更时同步。
 *
 * 设计:
 * - 只处理 memory/ 路径下 .md 文件的 Write/Edit (递归匹配子目录)
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

/**
 * Windows 路径兼容: 将 Unix 风格 /c/Users/... 转为 C:\Users\...
 * Claude Code 在 Git Bash 中可能传递 MSYS 格式路径
 */
function normalizePath(p) {
  if (!p) return p;
  const normalized = path.normalize(p);
  if (process.platform === 'win32') {
    const driveMatch = normalized.match(/^[/\\]([a-zA-Z])[/\\]/);
    if (driveMatch) {
      return driveMatch[1].toUpperCase() + ':\\' + normalized.slice(3);
    }
  }
  return normalized;
}

function isMemoryFile(filePath) {
  if (!filePath || !filePath.endsWith('.md')) return false;
  const normalized = normalizePath(filePath);
  return normalized.startsWith(MEMORY_DIR);
}

// 简易 frontmatter 解析（兼容 CRLF）
function parseFrontmatter(content) {
  // 预先去除 \r 避免 Windows CRLF 导致 (.+)$ 在 $ 之前无法跨过 \r 而匹配失败
  const sanitized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = sanitized.split('\n');
  const fm = {};
  let body = sanitized;
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
  // metadata.type 映射到 namespace
  if (fm.metadata) {
    try {
      const metaLines = fm.metadata.split('\n').filter(l => l.trim());
      fm._meta = {};
      for (const ml of metaLines) {
        const mm = ml.trim().match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
        if (mm) fm._meta[mm[1]] = mm[2].trim();
      }
    } catch { /* metadata 解析失败不影响 */ }
  }
  return { frontmatter: fm, body };
}

function inferNamespace(filePath) {
  const rel = path.relative(MEMORY_DIR, filePath);
  const parts = rel.split(path.sep);
  const dirMap = { learnings: 'learnings', errors: 'errors', archive: 'archive', projects: 'project', references: 'reference', agents: 'learnings', work: 'reference' };
  return (parts.length >= 2 && dirMap[parts[0]]) || 'learnings';
}

function inferName(filePath) {
  return path.basename(filePath, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

/**
 * 从 stdin JSON 中提取 file_path（支持多种 Hook 格式）
 */
function extractFilePathFromStdin(input) {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    if (parsed.tool?.input?.file_path) return parsed.tool.input.file_path;
    if (parsed.toolInput?.file_path) return parsed.toolInput.file_path;
    if (parsed.filePath) return parsed.filePath;
    if (parsed.path) return parsed.path;
    if (parsed.event?.toolInput?.file_path) return parsed.event.toolInput.file_path;
    if (parsed.params?.file_path) return parsed.params.file_path;
  } catch { /* 非标准 JSON */ }

  for (const line of input.split('\n')) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.tool?.input?.file_path) return parsed.tool.input.file_path;
      if (parsed.toolInput?.file_path) return parsed.toolInput.file_path;
      if (parsed.filePath) return parsed.filePath;
      if (parsed.path) return parsed.path;
    } catch { /* 跳过非 JSON 行 */ }
  }
  return null;
}

async function main() {
  try {
    // 优先级: CLAUDE_TOOL env > stdin > CLAUDE_DATA env
    let rawPath = null;

    const toolEnv = process.env.CLAUDE_TOOL;
    if (toolEnv) {
      try {
        const toolData = JSON.parse(toolEnv);
        rawPath = toolData.toolInput?.file_path || toolData.toolInput?.path || toolData.filePath || toolData.path;
      } catch { /* 继续 */ }
    }

    if (!rawPath) {
      // 从 stdin 读取 — 仅在 Hook 运行时有数据管道
      try {
        // fs.readFileSync(0) 在 Git Bash 无管道时会阻塞,
        // 但 Hook 系统始终提供 stdin 且自带超时, 故安全
        const input = fs.readFileSync(0, 'utf8');
        if (input) rawPath = extractFilePathFromStdin(input);
      } catch { /* stdin 不可用 */ }
    }

    if (!rawPath) {
      const dataEnv = process.env.CLAUDE_DATA;
      if (dataEnv) {
        try {
          const parsed = JSON.parse(dataEnv);
          const search = (o) => { if (!o || typeof o !== 'object') return null; return o.file_path || o.path || null; };
          rawPath = search(parsed);
          if (!rawPath && parsed.toolInput) rawPath = search(parsed.toolInput);
          if (!rawPath && parsed.event?.toolInput) rawPath = search(parsed.event.toolInput);
        } catch { /* 继续 */ }
      }
    }

    if (!rawPath) return; // 非 Hook 上下文或无法提取路径

    const normalizedPath = normalizePath(rawPath);
    if (!isMemoryFile(normalizedPath)) return;

    // 读文件内容
    let content;
    try {
      content = fs.readFileSync(normalizedPath, 'utf8');
    } catch { return; }

    // 解析 frontmatter
    const { frontmatter, body } = parseFrontmatter(content);
    if (!body) return;

    const namespace = frontmatter._meta?.type || inferNamespace(normalizedPath);
    const name = frontmatter.name || inferName(normalizedPath);

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
