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
 * 注册: settings.json UserPromptSubmit matcher="*"
 */

'use strict';

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { memoryScopeFromPayload } = require('./lib/project-scope.cjs');
const HARNESS = HARNESS_ROOT;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

function memoryHintCacheFile(opts = {}) {
  const namespace = crypto.createHash('sha256').update(HARNESS).digest('hex').slice(0, 16);
  const cacheRoot = opts.tempRoot
    || process.env.CLAUDE_MEMORY_HINT_CACHE_DIR
    || path.join(os.tmpdir(), 'claude-harness-cache', namespace, 'memory');
  return process.env.CLAUDE_MEMORY_HINT_CACHE_FILE || path.join(cacheRoot, 'memory-retrieve-cache.json');
}

function cacheDisabled() {
  return process.env.CLAUDE_MEMORY_HINT_CACHE_DISABLED === '1'
    || process.env.CLAUDE_HOOK_NO_WRITE === '1'
    || process.env.CLAUDE_BENCH === '1'
    || process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1';
}

function attributionPersistenceDisabled() {
  return process.env.CLAUDE_MEMORY_ATTRIBUTION_DISABLED === '1'
    || process.env.CLAUDE_HOOK_NO_WRITE === '1'
    || process.env.CLAUDE_BENCH === '1'
    || process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1';
}

// ── 层1: 用户消息触发模式 ──────────────────────────────────────────────────
const TRIGGER_PATTERNS = [
  /查/i, /找/i, /搜/i, /记得/i, /参考/i, /经验/i, /教训/i,
  /为什么/i, /怎么(回|办|处)/i, /如何/, /什么原因/, /错误/, /报错/,
  /(?:是否|是不是|有没有|没有|未).{0,8}(?:生效|启用|起作用)/,
  /还记得/, /参考一下/, /查一下/, /搜一下/, /找一下/,
  /类似/, /同类/, /之前/, /上次/, /以前/,
  /推荐/, /建议/, /最佳/, /模板/, /模式/,
  /find/i, /search/i, /remember/i, /look\s*up/i, /reference/i,
  /error/i, /bug/i, /issue/i, /problem/i, /similar/i,
  /how\s+(to|do|does|can|is|are)/i, /why\s+(did|is|are|does)/i,
  /best\s+practice/i, /lesson/i, /tip/i,
];

// ── 层2: 任务上下文 — 代码文件类型 → 检索增强词 ──────────────────────────
// harness 自身的代码扩展名 (2026-07-30 补): 旧清单只有 HDL/Python/C 系,
// 于是 harness 开发完全不触发层2 检索 —— 实测某会话 93 次 Edit + 21 次 Write
// 全是 .cjs, 两层触发都没命中, 51 条活跃事实里只有 2 条被暴露过, D5 的
// neverExposed 因此永远停在 0.96。刻意不含 .md/.json: 文档与配置改动频繁
// 且检索价值低, 纳入只会增加注入噪声与 token 开销。
const CODE_EXTENSIONS = ['.sv', '.v', '.vh', '.vhd', '.py', '.c', '.cpp', '.h', '.cjs', '.mjs', '.js', '.ts'];
// 增强词刻意保持在 6 个以内且偏判别性语汇。relevantResult 的门槛是
// overlap >= ceil(terms/4)(上限 3), 词表变大只会让过滤**更严**,
// 所以过度增强的风险是漏注入, 不是误注入。
const HARNESS_ENRICH = ['hook', 'harness', '门禁', '验证', '契约', '事件'];
const TYPE_ENRICH = {
  sv:  ['HDL', 'Verilog', 'FSM', '状态机', '时序', '接口', 'valid', 'ready', '握手', '复位', '流水线', '位宽', '锁存器', '跨时钟域', 'CDC'],
  v:   ['HDL', 'Verilog', 'FSM', '状态机', '时序', '接口', '复位', '位宽'],
  vhd: ['HDL', 'VHDL', 'FSM', '状态机', '时序', '接口'],
  py:  ['Python', 'pytest', 'ruff', '异常', '类型', '接口'],
  cjs: HARNESS_ENRICH,
  mjs: HARNESS_ENRICH,
  js:  HARNESS_ENRICH,
  ts:  HARNESS_ENRICH,
};
const GENERIC_PATH_PARTS = new Set([
  'users', 'home', 'repo', 'repository', 'project', 'workspace',
  'src', 'source', 'sources', 'rtl', 'hdl', 'tb', 'test', 'tests',
  'lib', 'libs', 'engine', 'scripts', 'include',
]);

function extractKeywords(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  // 去掉常见前后缀
  const cleaned = base.replace(/^tb_/, '').replace(/_tb$/, '').replace(/^test_/, '').replace(/_test$/, '');
  const parts = cleaned.split(/[_\-\s.]+/).filter(p => p.length > 1 && !/^\d+$/.test(p));
  return parts;
}

function extractDirectoryKeywords(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean).slice(0, -1);
  const candidates = segments.slice(-3).flatMap((segment) => segment
    .toLowerCase()
    .split(/[_\-\s.]+/)
    .filter(Boolean));
  return candidates
    .filter((part) => part.length > 1 && !part.includes(':')
      && !GENERIC_PATH_PARTS.has(part) && !/^\d+$/.test(part))
    .slice(-2);
}

function buildContextQuery(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const enrich = TYPE_ENRICH[ext] || [];
  const keywords = extractKeywords(filePath);
  const directoryKeywords = extractDirectoryKeywords(filePath);
  // 文件名 + 最近两级有区分度目录 + 类型词，避免绝对路径身份进入查询。
  const allTerms = [...keywords, ...directoryKeywords, ...enrich.slice(0, 6)];
  return [...new Set(allTerms)].slice(0, 8).join(' ');
}

function fileTriggerSignature(filePath) {
  return extractKeywords(filePath).join('_').toLowerCase() || null;
}

function shouldUserRetrieve(userMessage) {
  if (!userMessage || userMessage.length < 3) return false;
  return TRIGGER_PATTERNS.some(p => p.test(userMessage));
}

function isCodeFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return CODE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function filePathFromPayload(data = {}) {
  const direct = data?.tool_input?.file_path || data?.tool_input?.filePath
    || data?.toolInput?.file_path || data?.toolInput?.filePath
    || data?.tool?.input?.file_path || data?.tool?.input?.filePath
    || data?.input?.file_path || data?.input?.filePath || data?.filePath;
  if (direct) return direct;

  const edits = data?.tool_input?.edits || data?.toolInput?.edits
    || data?.tool?.input?.edits || data?.input?.edits || [];
  if (!Array.isArray(edits)) return null;
  const paths = edits.map(edit => edit?.file_path || edit?.filePath).filter(Boolean);
  return paths.find(isCodeFile) || paths[0] || null;
}

function extractFilePath(stdinRaw) {
  if (!stdinRaw) return null;
  try {
    const data = JSON.parse(stdinRaw);
    return filePathFromPayload(data);
  } catch {
    // 多行 JSON
    for (const line of stdinRaw.split('\n')) {
      try {
        const data = JSON.parse(line);
        const fp = filePathFromPayload(data);
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
    const cacheFile = memoryHintCacheFile();
    if (!fs.existsSync(cacheFile)) return {};
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    const cacheFile = memoryHintCacheFile();
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const entries = Object.entries(cache)
      .sort((a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || '')))
      .slice(0, 100);
    fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8');
  } catch {
    // Cache failures should never affect tool use.
  }
}

function cacheKey(trigger, query, scope = {}) {
  const normalize = value => String(value || '').replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha1').update([
    trigger,
    query,
    normalize(scope.project),
    normalize(scope.cwd),
    String(scope.session || ''),
  ].join('\n')).digest('hex');
}

function recentlyInjected(key) {
  if (cacheDisabled()) return false;
  const ttl = cacheTtlMs();
  if (ttl === 0) return false;
  const cache = readCache();
  const at = Date.parse(cache[key]?.at || '');
  return Number.isFinite(at) && Date.now() - at < ttl;
}

function markInjected(key, detail = {}) {
  if (cacheDisabled()) return;
  const cache = readCache();
  cache[key] = { at: new Date().toISOString(), ...detail };
  writeCache(cache);
}

const GENERIC_QUERY_TERMS = new Set([
  'how', 'to', 'fix', 'error', 'bug', 'issue', 'problem', 'find', 'search',
  'remember', 'reference', 'why', 'best', 'practice', 'lesson', 'tip',
]);

function distinctiveQueryTerms(query) {
  const reduced = String(query || '').toLowerCase()
    .replace(/之前|上次|以前|这个|那个|错误|报错|问题|怎么|如何|解决|处理|经验|教训|查一下|找一下|搜一下/g, ' ');
  const asciiTerms = (reduced.match(/[a-z0-9_-]{2,}/g) || [])
    .filter(term => !GENERIC_QUERY_TERMS.has(term));
  const cjkTerms = [];
  for (const run of reduced.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (run.length === 2) {
      cjkTerms.push(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      cjkTerms.push(run.slice(index, index + 2));
    }
  }
  return [...new Set([...asciiTerms, ...cjkTerms])];
}

function relevantResult(query, result) {
  const terms = distinctiveQueryTerms(query);
  if (terms.length === 0) return true;
  const haystack = `${result.name || ''} ${result.summary || ''} ${result.source_key || ''}`.toLowerCase();
  const overlap = terms.filter(term => haystack.includes(term)).length;
  const required = Math.min(3, Math.max(1, Math.ceil(terms.length / 4)));
  return overlap >= required;
}

function toMatch(r) {
  return {
    memoryId: r.id || r.memory_id || null,
    namespace: r.namespace,
    name: r.name || '(unnamed)',
    summary: r.summary,
    confidence: Math.round(r.confidence * 100) / 100,
    source: r.source || 'unknown',
    sourceKey: r.source_key || null,
    status: r.status || 'active',
    verification: r.verification_state || 'candidate',
    updatedAt: r.updated_at || r.created_at || null,
  };
}

/**
 * 默认召回只接受 verified 事实。candidate 与 unscoped 事实属于审计素材，
 * 不得因为 verified 数量不足就进入普通 Agent 上下文。
 */
function doMemoryQuery(query, label, deps = {}) {
  let wDb;
  try {
    const openDb = deps.openDb || require('../sqlite/index.cjs').openDb;
    const retrieveMemorySummary = deps.retrieveMemorySummary
      || require('../sqlite/store-memory.cjs').retrieveMemorySummary;
    wDb = openDb({ readonly: true });
    const verified = retrieveMemorySummary(query, {
      db: wDb.db, limit: 5, maxChars: 200, minConfidence: 0.7, trackHit: false,
      scope: deps.scope,
    }).filter(r => relevantResult(query, r)).slice(0, 3);

    return verified.map(toMatch);
  } catch { /* 静默 */ }
  finally {
    try { wDb?.close(); } catch { /* readonly cleanup */ }
  }
  return [];
}

function sessionIdFromPayload(payload = {}) {
  return String(
    payload.session_id || payload.sessionId || payload.thread_id || payload.threadId || '',
  ).trim();
}

function platformCorrelationId(payload = {}) {
  return String(
    payload.tool_use_id || payload.toolUseId || payload.tool_call_id
      || payload.toolCallId || payload.invocation_id || payload.invocationId || '',
  ).trim();
}

function recordInjectedExposures(payload, matches, detail, deps = {}) {
  const selected = matches.filter(match => String(match.memoryId || '').trim()).slice(0, 5);
  const sessionId = sessionIdFromPayload(payload);
  const projectId = String(detail.projectId || '').trim();
  const persistenceDisabled = deps.attributionPersistenceDisabled || attributionPersistenceDisabled;
  if (selected.length === 0 || !sessionId || !projectId || persistenceDisabled()) {
    return { recorded: 0, rejected: true, reason: 'missing-attribution-identity' };
  }

  let wDb;
  try {
    const attribution = deps.attribution || require('../sqlite/store-memory-attribution.cjs');
    const openAttributionDb = deps.openAttributionDb || require('../sqlite/index.cjs').openDb;
    wDb = openAttributionDb({});
    const retrievalId = attribution.createRetrievalId();
    const correlationId = platformCorrelationId(payload) || retrievalId;
    const eventName = String(payload.hook_event_name || payload.event || '');
    const rawToolName = String(
      payload.tool_name || payload.toolName || payload.tool?.name
        || (typeof payload.tool === 'string' ? payload.tool : ''),
    ).trim();
    const anchored = (eventName === 'PreToolUse' || detail.anchorCurrentTool === true)
      && rawToolName;
    let recorded = 0;
    wDb.db.exec('BEGIN IMMEDIATE');
    try {
      selected.forEach((match, index) => {
        const result = attribution.recordExposure({
          sessionId,
          projectId,
          memoryId: match.memoryId,
          retrievalId,
          correlationId,
          triggerKind: detail.triggerKind,
          query: detail.query,
          targetPath: detail.targetPath || null,
          rank: index + 1,
          confidence: Number(match.confidence),
          anchorTool: anchored ? rawToolName : null,
          anchorInputSha256: anchored ? attribution.toolInputSha256(payload) : null,
        }, {
          db: wDb.db,
          now: typeof deps.now === 'function' ? deps.now() : deps.now,
        });
        if (result.created) recorded += 1;
      });
      wDb.db.exec('COMMIT');
    } catch (error) {
      wDb.db.exec('ROLLBACK');
      throw error;
    }
    return { recorded, rejected: false, retrievalId, correlationId };
  } catch (error) {
    if (typeof deps.warn === 'function') deps.warn(error);
    return { recorded: 0, rejected: true, reason: 'attribution-write-failed' };
  } finally {
    try { wDb?.close(); } catch { /* fail-open attribution cleanup */ }
  }
}

function retrieveContext(payload = {}, deps = {}) {
  const msg = payload.prompt || payload.user_prompt || process.env.CLAUDE_USER_MESSAGE || '';
  const toolName = String(
    payload.tool_name || payload.toolName || payload.tool?.name
    || (typeof payload.tool === 'string' ? payload.tool : '')
    || process.env.CLAUDE_TOOL_NAME || '',
  ).toLowerCase();
  const eventName = payload.hook_event_name || '';
  // ── 层1: 用户消息触发 ──
  const userTriggered = shouldUserRetrieve(msg);

  // ── 层2: 任务上下文触发 (Write 代码文件) ──
  let contextQuery = null;
  if (toolName === 'write' || toolName === 'edit' || toolName === 'multiedit') {
    const filePath = extractFilePath(JSON.stringify(payload));
    if (filePath && isCodeFile(filePath)) {
      contextQuery = buildContextQuery(filePath);
    }
  }

  const contextFilePath = contextQuery ? extractFilePath(JSON.stringify(payload)) : '';
  const projectScope = memoryScopeFromPayload(
    contextFilePath ? { ...payload, file_path: contextFilePath } : payload,
  );
  const cacheScope = {
    project: projectScope.projectId,
    cwd: projectScope.cwd,
    session: payload.session_id || payload.sessionId || payload.thread_id || payload.threadId || '',
  };
  const userRetrievalScope = {
    projectId: projectScope.projectId,
    relativePath: projectScope.relativePath,
    triggerKind: 'user_query',
    triggerSignature: null,
  };
  const contextRetrievalScope = {
    projectId: projectScope.projectId,
    relativePath: projectScope.relativePath,
    triggerKind: 'file_edit',
    triggerSignature: fileTriggerSignature(contextFilePath),
  };

  // 无触发 → 0 token
  if (!userTriggered && !contextQuery) return null;

  const triggerKind = contextQuery && userTriggered ? 'context+user' : contextQuery ? 'task-context' : 'user-query';
  const queryText = [userTriggered ? msg : '', contextQuery || ''].filter(Boolean).join('\n').slice(0, 500);
  const key = cacheKey(triggerKind, queryText, cacheScope);
  const wasRecentlyInjected = deps.recentlyInjected || recentlyInjected;
  const rememberInjection = deps.markInjected || markInjected;
  const queryMemory = deps.doMemoryQuery
    || ((query, label, retrievalScope) => doMemoryQuery(query, label, { ...deps, scope: retrievalScope }));
  if (wasRecentlyInjected(key)) return null;

  try {
    const allMemMatches = [];

    // 用户消息检索
    if (userTriggered && msg.length >= 3) {
      const results = queryMemory(msg, 'user', userRetrievalScope);
      allMemMatches.push(...results);
    }

    // 任务上下文检索（去重：不同 query 词避免重复结果）
    if (contextQuery && contextQuery.length >= 3) {
      const results = queryMemory(contextQuery, 'context', contextRetrievalScope);
      // 去重：按 name 去重
      const existingNames = new Set(allMemMatches.map(m => m.name));
      for (const r of results) {
        if (!existingNames.has(r.name)) {
          allMemMatches.push(r);
          existingNames.add(r.name);
        }
      }
    }

    if (allMemMatches.length === 0) return null;
    rememberInjection(key, { trigger: triggerKind, query: queryText.slice(0, 120), count: allMemMatches.length });

    // 只有 hookSpecificOutput.additionalContext 才会进入模型上下文;
    // 裸 JSON 的 console.log 仅进日志, 等于没注入。
    // 摘要压到单行 —— 记忆条目正文可能是整篇 markdown, 原样注入会淹没上下文。
    const brief = (s) => String(s || '')
      .replace(/^#+\s.*$/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    const lines = ['[memory] 与当前任务相关的既往记忆:'];
    for (const m of allMemMatches.slice(0, 5)) {
      const updated = Number.isFinite(Number(m.updatedAt))
        ? new Date(Number(m.updatedAt)).toISOString()
        : String(m.updatedAt || 'unknown');
      const tag = m.verification === 'verified' ? '' : '候选(未验证,仅供参考) ';
      lines.push(`- (${m.namespace}) ${tag}${m.name}: ${brief(m.summary)} `
        + `[source=${m.source}; key=${m.sourceKey || 'none'}; confidence=${m.confidence}; `
        + `verify=${m.verification}; status=${m.status}; updated=${updated}]`);
    }
    const output = {
      hookSpecificOutput: {
        hookEventName: eventName || 'UserPromptSubmit',
        additionalContext: lines.join('\n'),
      },
    };
    recordInjectedExposures(payload, allMemMatches, {
      projectId: projectScope.projectId,
      triggerKind: contextQuery ? 'task-context' : 'user-query',
      query: queryText,
      targetPath: projectScope.relativePath,
    }, deps);
    return output;
  } catch {
    return null;
  }
}

function main() {
  // 输入走 stdin 的 hook payload；环境变量仅保留为手工调用回退。
  let stdinRaw = '';
  try { stdinRaw = fs.readFileSync(0, 'utf8'); } catch { /* 无 stdin */ }
  let payload = {};
  try { payload = stdinRaw.trim().startsWith('{') ? JSON.parse(stdinRaw) : {}; } catch { payload = {}; }
  const output = retrieveContext(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

if (require.main === module) {
  main();
}

module.exports = {
  memoryHintCacheFile,
  cacheDisabled,
  attributionPersistenceDisabled,
  cacheKey,
  doMemoryQuery,
  recordInjectedExposures,
  retrieveContext,
  distinctiveQueryTerms,
  relevantResult,
  buildContextQuery,
};
