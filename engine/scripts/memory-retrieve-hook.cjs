#!/usr/bin/env node
/**
 * engine/scripts/memory-retrieve-hook.cjs — L2 记忆检索注入 (v2)
 *
 * PreToolUse hook. 双层触发:
 *   [层1] 用户消息关键词 — 查/搜/记得/错误/经验 等 → FTS5 BM25
 *   [层2] 任务上下文 — Write 代码文件时自动检索相关教训 (文件名/类型/项目)
 *
 * 设计约束:
 *   - 无触发 → 无输出 (0 token 开销)
 *   - 层2 只在 Write 代码文件时触发，不依赖用户消息
 *   - SQLite 查询预计 <10ms
 *
 * 注册: settings.json PreToolUse matcher="*"
 */

'use strict';

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const HARNESS = HARNESS_ROOT;
const CACHE_FILE = path.join(HARNESS, 'var', 'index', 'memory-retrieve-cache.json');
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

// ── 层1: 用户消息触发模式 ──────────────────────────────────────────────────
const TRIGGER_PATTERNS = [
  /查/i, /找/i, /搜/i, /记得/i, /参考/i, /经验/i, /教训/i,
  /为什么/i, /怎么(回|办|处)/i, /如何/, /什么原因/, /错误/, /报错/,
  /还记得/, /参考一下/, /查一下/, /搜一下/, /找一下/,
  /类似/, /同类/, /之前/, /上次/, /以前/,
  /推荐/, /建议/, /最佳/, /模板/, /模式/,
  /find/i, /search/i, /remember/i, /look\s*up/i, /reference/i,
  /error/i, /bug/i, /issue/i, /problem/i, /similar/i,
  /how\s+(to|do|does|can|is|are)/i, /why\s+(did|is|are|does)/i,
  /best\s+practice/i, /lesson/i, /tip/i,
];

// ── 层2: 任务上下文 — 代码文件类型 → 检索增强词 ──────────────────────────
const CODE_EXTENSIONS = ['.sv', '.v', '.vh', '.vhd', '.py', '.c', '.cpp', '.h'];
const TYPE_ENRICH = {
  sv:  ['HDL', 'Verilog', 'FSM', '状态机', '时序', '接口', 'valid', 'ready', '握手', '复位', '流水线', '位宽', '锁存器', '跨时钟域', 'CDC'],
  v:   ['HDL', 'Verilog', 'FSM', '状态机', '时序', '接口', '复位', '位宽'],
  vhd: ['HDL', 'VHDL', 'FSM', '状态机', '时序', '接口'],
  py:  ['Python', 'pytest', 'ruff', '异常', '类型', '接口'],
};

function extractKeywords(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // 去掉常见前后缀
  const cleaned = base.replace(/^tb_/, '').replace(/_tb$/, '').replace(/^test_/, '').replace(/_test$/, '');
  const parts = cleaned.split(/[_\-\s.]+/).filter(p => p.length > 1 && !/^\d+$/.test(p));
  return parts;
}

function buildContextQuery(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const enrich = TYPE_ENRICH[ext] || [];
  const keywords = extractKeywords(filePath);
  // 文件名关键词 + 类型关键词（取4个最有区分度的）
  const allTerms = [...keywords, ...enrich.slice(0, 6)];
  return [...new Set(allTerms)].slice(0, 8).join(' ');
}

function shouldUserRetrieve(userMessage) {
  if (!userMessage || userMessage.length < 3) return false;
  return TRIGGER_PATTERNS.some(p => p.test(userMessage));
}

function isCodeFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return CODE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function extractFilePath(stdinRaw) {
  if (!stdinRaw) return null;
  try {
    const data = JSON.parse(stdinRaw);
    return data?.tool_input?.file_path || data?.tool?.input?.file_path ||
           data?.tool?.input?.filePath || data?.input?.file_path || data?.filePath || null;
  } catch {
    // 多行 JSON
    for (const line of stdinRaw.split('\n')) {
      try {
        const data = JSON.parse(line);
        const fp = data?.tool_input?.file_path || data?.tool?.input?.file_path ||
                   data?.tool?.input?.filePath || data?.input?.file_path || data?.filePath;
        if (fp) return fp;
      } catch { /* 跳过 */ }
    }
  }
  return null;
}

function cacheTtlMs() {
  const value = Number.parseInt(process.env.CLAUDE_MEMORY_HINT_TTL_MS || DEFAULT_CACHE_TTL_MS, 10);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CACHE_TTL_MS;
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const entries = Object.entries(cache)
      .sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')))
      .slice(0, 100);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8');
  } catch {
    // Cache failures should never affect tool use.
  }
}

function cacheKey(trigger, query) {
  return crypto.createHash('sha1').update(`${trigger}\n${query}`).digest('hex');
}

function recentlyInjected(key) {
  if (process.env.CLAUDE_MEMORY_HINT_CACHE_DISABLED === '1') return false;
  const ttl = cacheTtlMs();
  if (ttl === 0) return false;
  const cache = readCache();
  const at = Date.parse(cache[key]?.at || '');
  return Number.isFinite(at) && Date.now() - at < ttl;
}

function markInjected(key, detail = {}) {
  if (process.env.CLAUDE_MEMORY_HINT_CACHE_DISABLED === '1') return;
  const cache = readCache();
  cache[key] = { at: new Date().toISOString(), ...detail };
  writeCache(cache);
}

function doMemoryQuery(query, label) {
  try {
    const { openDb } = require('../sqlite/index.cjs');
    const { retrieveMemorySummary } = require('../sqlite/store-memory.cjs');
    const wDb = openDb();
    const results = retrieveMemorySummary(query, {
      limit: 3, maxChars: 200, minConfidence: 0.3,
    });
    wDb.close();
    if (results.length > 0) {
      return results.map(r => ({
        namespace: r.namespace,
        name: r.name || '(unnamed)',
        summary: r.summary,
        confidence: Math.round(r.confidence * 100) / 100,
      }));
    }
  } catch { /* 静默 */ }
  return [];
}

function main() {
  const msg = process.env.CLAUDE_USER_MESSAGE || '';
  const toolName = (process.env.CLAUDE_TOOL_NAME || '').toLowerCase();

  // ── 层1: 用户消息触发 ──
  const userTriggered = shouldUserRetrieve(msg);

  // ── 层2: 任务上下文触发 (Write 代码文件) ──
  let contextQuery = null;
  if (toolName === 'write' || toolName === 'edit') {
    let stdinRaw = '';
    try { stdinRaw = fs.readFileSync(0, 'utf8'); } catch { /* 无 stdin */ }
    const filePath = extractFilePath(stdinRaw);
    if (filePath && isCodeFile(filePath)) {
      contextQuery = buildContextQuery(filePath);
    }
  }

  // 无触发 → 0 token
  if (!userTriggered && !contextQuery) return;

  const triggerKind = contextQuery && userTriggered ? 'context+user' : contextQuery ? 'task-context' : 'user-query';
  const queryText = [userTriggered ? msg : '', contextQuery || ''].filter(Boolean).join('\n').slice(0, 500);
  const key = cacheKey(triggerKind, queryText);
  if (recentlyInjected(key)) return;

  try {
    const allMemMatches = [];

    // 用户消息检索
    if (userTriggered && msg.length >= 3) {
      const results = doMemoryQuery(msg, 'user');
      allMemMatches.push(...results);
    }

    // 任务上下文检索（去重：不同 query 词避免重复结果）
    if (contextQuery && contextQuery.length >= 3) {
      // 只在用户没触发或 query 完全不同时才做上下文检索
      if (!userTriggered || !msg.includes(contextQuery.split(' ')[0])) {
        const results = doMemoryQuery(contextQuery, 'context');
        // 去重：按 name 去重
        const existingNames = new Set(allMemMatches.map(m => m.name));
        for (const r of results) {
          if (!existingNames.has(r.name)) {
            allMemMatches.push(r);
            existingNames.add(r.name);
          }
        }
      }
    }

    if (allMemMatches.length === 0) return;
    markInjected(key, { trigger: triggerKind, query: queryText.slice(0, 120), count: allMemMatches.length });

    // wiki-link 解析
    const outputParts = [{
      type: 'memory',
      trigger: contextQuery ? 'context+user' : 'user',
      matches: allMemMatches.slice(0, 5),
    }];

    try {
      const { resolveWikiLinks } = require('./resolve-wiki-links.cjs');
      const allText = allMemMatches.map(m => m.summary).join(' ');
      const refs = (allText.match(/\[\[([^\]]+)\]\]/g) || []).map(r => r.slice(2, -2));
      if (refs.length > 0) {
        const wikiLinks = resolveWikiLinks([...new Set(refs)]);
        if (wikiLinks?.resolved?.length > 0) {
          outputParts.push({
            type: 'wiki-links',
            linkedMemories: wikiLinks.resolved.map(l => ({ name: l.name, file: l.file, summary: l.summary })),
          });
        }
      }
    } catch { /* 静默 */ }

    console.log(JSON.stringify({
      source: 'memory-retrieve-hook',
      type: 'memory-hint',
      trigger: contextQuery ? 'task-context' : 'user-query',
      query: contextQuery ? contextQuery.slice(0, 80) : msg.slice(0, 80),
      parts: outputParts,
    }));
  } catch {
    // 静默失败
  }
}

if (require.main === module) {
  main();
}
