'use strict';

/**
 * core/engine/scripts/io/transcript-source.cjs — transcript 路径解析唯一实现
 *
 * Phase 2.2：ledger / visible-checklist-gate 两份近同构副本（约 60 行×2，
 * 差异仅 deadline 400/500ms 与 checklist 多一个 cwd 近期回退）收敛于此。
 *
 * 解析顺序（与原 ledger 版逐字对齐，checklist 版行为是其超集）：
 *   1. 显式声明：payload.transcript_path / transcriptPath /
 *      conversation.transcript_path / session.transcript_path /
 *      env.CLAUDE_TRANSCRIPT_PATH —— 存在即返回
 *   2. 会话目录：payload.session_dir / env.CLAUDE_SESSION_DIR 下
 *      transcript.jsonl | conversation.jsonl | messages.jsonl
 *   3. 会话 ID：payload.session_id / sessionId / env.CLAUDE_SESSION_ID →
 *      <home>/projects/ 深层 DFS 找 <sessionId>.jsonl（限时，防大目录拖垮 hook）
 *   4. cwd 近期回退（opts.allowRecentFallback，仅清单门语义需要）：
 *      <home>/projects/<slug(cwd)>/ 下 2 分钟内 mtime 最新的 .jsonl
 *
 * 所有查找只读、限时（默认 400ms 上限，与原 ledger 版一致）；找不到返回 ''。
 */

const fs = require('node:fs');
const path = require('node:path');

const SESSION_FILE_CANDIDATES = ['transcript.jsonl', 'conversation.jsonl', 'messages.jsonl'];

function resolveTranscriptPath(payload, opts = {}) {
  const home = opts.home || '';
  const searchBudgetMs = opts.searchBudgetMs || 400;

  const explicit = payload?.transcript_path
    || payload?.transcriptPath
    || payload?.conversation?.transcript_path
    || payload?.session?.transcript_path
    || process.env.CLAUDE_TRANSCRIPT_PATH
    || '';
  if (explicit && fs.existsSync(explicit)) return explicit;

  const sessionDir = payload?.session_dir || process.env.CLAUDE_SESSION_DIR || '';
  if (sessionDir && fs.existsSync(sessionDir)) {
    for (const name of SESSION_FILE_CANDIDATES) {
      const candidate = path.join(sessionDir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const sessionId = payload?.session_id || payload?.sessionId || process.env.CLAUDE_SESSION_ID || '';
  const projectsDir = home ? path.join(home, 'projects') : '';
  if (sessionId && projectsDir && fs.existsSync(projectsDir)) {
    const found = findBySessionId(projectsDir, sessionId, searchBudgetMs);
    if (found) return found;
  }

  if (opts.allowRecentFallback && projectsDir && fs.existsSync(projectsDir)) {
    const recent = findRecentTranscript(projectsDir, payload?.cwd || process.cwd());
    if (recent) return recent;
  }

  return '';
}

function findBySessionId(projectsDir, sessionId, budgetMs) {
  const expected = `${sessionId}.jsonl`.toLowerCase();
  const stack = [projectsDir];
  const deadline = Date.now() + budgetMs;
  while (stack.length > 0 && Date.now() < deadline) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === expected) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return '';
}

function projectSlugForCwd(cwd) {
  if (!cwd) return '';
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function findRecentTranscript(projectsDir, cwd, maxAgeMs = 2 * 60 * 1000) {
  const slug = projectSlugForCwd(cwd);
  if (!slug) return '';
  const preferredDir = path.join(projectsDir, slug);
  if (!fs.existsSync(preferredDir)) return '';

  const now = Date.now();
  const candidates = [];
  let entries;
  try {
    entries = fs.readdirSync(preferredDir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const fullPath = path.join(preferredDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs <= maxAgeMs) candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path || '';
}

module.exports = {
  resolveTranscriptPath,
  projectSlugForCwd,
  // 内部函数导出仅供合同测试；生产代码一律走 resolveTranscriptPath。
  _internal: { findBySessionId, findRecentTranscript },
};
