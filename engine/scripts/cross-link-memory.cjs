#!/usr/bin/env node
/**
 * engine/scripts/cross-link-memory.cjs — L2↔L4 交叉联动: 挫败→记忆检索
 *
 * 当挫败检测器标记高失败计数时，自动从 memory/errors/ 和
 * memory/learnings/ 检索相关经验，注入到 Claude 上下文。
 *
 * 这解决了"AI 失败时不知道查历史经验"的问题。
 *
 * 触发条件:
 *   PostMessage 时 runtime-state failureCount >= 2
 *
 * 输出:
 *   - 最近 3 条 memory/errors/ 记录摘要
 *   - 最近 2 条 memory/learnings/ 记录摘要
 *
 * 注册:
 *   settings.local.json PostMessage (异步, 低开销)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOMEDIR = os.homedir();
const HARNESS = path.join(HOMEDIR, '.claude');
const STATE_FILE = path.join(HARNESS, 'var', 'index', 'runtime-state.json');
const ERRORS_DIR = path.join(HARNESS, 'memory', 'errors');
const LEARNINGS_DIR = path.join(HARNESS, 'memory', 'learnings');
const PROJECTS_DIR = path.join(HARNESS, 'memory', 'projects');

// ── 辅助函数 ────────────────────────────────────────────────────────────────

function readJSON(fp) {
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

/**
 * 解析 memory 文件 frontmatter 获取名称和描述。
 */
function parseMemoryFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const fm = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    }
    return {
      name: fm.name || path.basename(filePath, '.md'),
      description: (fm.description || '').replace(/^["']|["']$/g, ''),
      type: fm['metadata.type'] || '',
    };
  } catch { return null; }
}

/**
 * 列出自指定目录中的最近文件（按 mtime 降序）。
 */
function getRecentFiles(dir, maxCount, excludePatterns = []) {
  if (!fs.existsSync(dir)) return [];
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .filter(f => !excludePatterns.some(p => f.includes(p)))
      .map(f => ({
        name: f,
        path: path.join(dir, f),
        mtime: fs.statSync(path.join(dir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxCount);
    return files;
  } catch { return []; }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

function evaluate() {
  const state = readJSON(STATE_FILE);
  // 仅当挫败计数 ≥ 2 时触发
  if (!state || (state.failureCount || 0) < 2) return null;

  // 收集最近的错误记录
  const errors = getRecentFiles(ERRORS_DIR, 3).map(f => {
    const meta = parseMemoryFile(f.path);
    return { file: f.name, ...meta };
  }).filter(Boolean);

  // 收集最近的学习记录
  const learnings = getRecentFiles(LEARNINGS_DIR, 2,
    ['MEMORY_RULES', 'MEMORY.md', 'memory-auto-trigger']
  ).map(f => {
    const meta = parseMemoryFile(f.path);
    return { file: f.name, ...meta };
  }).filter(Boolean);

  if (errors.length === 0 && learnings.length === 0) return null;

  return {
    source: 'cross-link-memory',
    type: 'memory-cross-ref',
    trigger: `failureCount=${state.failureCount}`,
    errors: errors.map(e => ({ name: e.name, desc: e.description })),
    learnings: learnings.map(l => ({ name: l.name, desc: l.description })),
  };
}

function main() {
  const result = evaluate();
  if (result) {
    console.log(JSON.stringify(result));
  }
  // 无匹配 → 无输出 (0 token 开销)
}

if (require.main === module) {
  main();
}
