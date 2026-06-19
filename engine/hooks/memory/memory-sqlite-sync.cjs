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
  const dirMap = { learnings: 'learnings', errors: 'errors', archive: 'archive', projects: 'project', references: 'reference', agents: 'learnings', work: 'reference' };
  return (parts.length >= 2 && dirMap[parts[0]]) || 'learnings';
}

function inferName(filePath) {
  return path.basename(filePath, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

/**
 * 尝试从 hook 上下文中提取文件路径。
 * 优先级: CLAUDE_TOOL 环境变量 > stdin JSON > CLAUDE_DATA env。
 * @returns {string|null}
 */
function extractFilePath() {
  // 1. 首选: CLAUDE_TOOL env (Claude Code 标准的 tool 上下文传递方式)
  const toolEnv = process.env.CLAUDE_TOOL;
  if (toolEnv) {
    try {
      const toolData = JSON.parse(toolEnv);
      if (toolData.toolInput?.file_path) return toolData.toolInput.file_path;
      if (toolData.toolInput?.path) return toolData.toolInput.path;
      if (toolData.filePath) return toolData.filePath;
      if (toolData.path) return toolData.path;
    } catch { /* 解析失败，继续尝试其他方式 */ }
  }

  // 2. 第二优先: CLAUDE_DATA env (多级嵌套)
  const dataEnv = process.env.CLAUDE_DATA;
  if (dataEnv) {
    try {
      const parsed = JSON.parse(dataEnv);
      // 递归查找 file_path
      const search = (obj) => {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.file_path) return obj.file_path;
        if (obj.path) return obj.path;
        return null;
      };
      const direct = search(parsed);
      if (direct) return direct;
      // 检查嵌套: { tool: "...", toolInput: { file_path: "..." } }
      if (parsed.toolInput) {
        const fromInput = search(parsed.toolInput);
        if (fromInput) return fromInput;
      }
      // 检查 HookEvent: { event: { tool: "Write", toolInput: {...} } }
      if (parsed.event?.toolInput) {
        const fromEvent = search(parsed.event.toolInput);
        if (fromEvent) return fromEvent;
      }
    } catch { /* 解析失败，继续 */ }
  }

  // 3. 从 stdin 解析
  try {
    let input = '';
    try {
      input = fs.readFileSync(0, 'utf8');
    } catch { /* stdin 不可用 */ }
    if (!input) return null;

    // 尝试 JSON 解析
    try {
      const parsed = JSON.parse(input);
      if (parsed.toolInput?.file_path) return parsed.toolInput.file_path;
      if (parsed.filePath) return parsed.filePath;
      if (parsed.path) return parsed.path;
      // 检查 HookEvent 格式: { event: { ... } }
      if (parsed.event?.toolInput?.file_path) return parsed.event.toolInput.file_path;
      if (parsed.params?.file_path) return parsed.params.file_path;
    } catch { /* 不是标准 JSON，尝试行级解析 */ }

    // 行级 JSON lines 兼容
    const lines = input.split('\n');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.toolInput?.file_path) return parsed.toolInput.file_path;
        if (parsed.filePath) return parsed.filePath;
        if (parsed.path) return parsed.path;
      } catch { /* 不是 JSON，继续 */ }
    }
  } catch { /* stdin 读取失败 */ }

  return null;
}

async function main() {
  try {
    const targetPath = extractFilePath();
    if (!targetPath) {
      // 诊断：解析失败时输出 stderr 但不阻塞
      const diagMsg = `[memory-sqlite-sync] 无法从 hook 上下文提取文件路径. CLAUDE_TOOL=${!!process.env.CLAUDE_TOOL} CLAUDE_DATA=${!!process.env.CLAUDE_DATA} stdin=${!!process.env.CLAUDE_HOOK_STDIN}`;
      console.error(diagMsg);
      // 上报 signal (静默)
      try {
        const { emitSync } = require('../../learning/signal-collector.cjs');
        emitSync('memory_miss', {
          reason: 'extractFilePath_failed',
          toolEnv: !!process.env.CLAUDE_TOOL,
          dataEnv: !!process.env.CLAUDE_DATA,
        });
      } catch { /* 静默 */ }
      return;
    }

    if (!isMemoryFile(targetPath)) return;

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
