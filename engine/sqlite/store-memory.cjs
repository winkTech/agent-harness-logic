'use strict';

/**
 * engine/sqlite/store-memory.cjs — 记忆仓库 (CRUD + FTS5 + 链接)。
 *
 * 依赖:
 *   const { openDb } = require('./index.cjs');
 *   const mem = require('./store-memory.cjs');
 *   mem.write({ namespace:'learnings', name:'ldpc-tips', content:'...' });
 *   const results = mem.retrieve('LDPC 编码');
 *
 * 架构:
 *   - facts 表: 事实本体 (namespace/content/confidence/ttl)
 *   - facts_fts: FTS5 全文索引 (同步触发器自动维护)
 *   - fact_links: 事实间关系 (取代 [[links]])
 */

const { openDb, resolveDb } = require('./index.cjs');
const crypto = require('node:crypto');

// ── 常量 ──────────────────────────────────────────────────────────────────

const VALID_NAMESPACES = new Set([
  'user', 'feedback', 'project', 'projects', 'reference',
  'learnings', 'errors', 'archive',
]);

// ── ID 生成 ───────────────────────────────────────────────────────────────

/**
 * 基于内容生成稳定的事实 ID (sha256 前缀)。
 * 相同内容多次写入 → 同一 id → 幂等 upsert。
 */
function factId(content, namespace) {
  return crypto
    .createHash('sha256')
    .update(content)
    .update(namespace)
    .digest('hex')
    .slice(0, 16);
}

// ── 写入 ───────────────────────────────────────────────────────────────────

/**
 * 写入一条事实。幂等: 同 content+namespace 覆盖更新。
 *
 * @param {object} fact
 * @param {string} fact.namespace   — 'user'|'feedback'|'project'|'reference'|'learnings'|'errors'|'archive'
 * @param {string} [fact.name]       — 可选短名 (对应原文件名)
 * @param {string} fact.content      — 事实内容
 * @param {string} [fact.description] — 一句话摘要
 * @param {string} [fact.source]     — 'hook:stop' | 'skill:handoff' | 'manual' | 'dream'
 * @param {number} [fact.confidence] — 0.0-1.0 (默认 0.5 tentative)
 * @param {number} [fact.ttlDays]    — TTL 天数 (null=永久)
 * @param {object} [opts]           — 选项
 * @param {import('node:sqlite').DatabaseSync} [opts.db] — 注入式连接
 * @returns {{ id: string, isNew: boolean }}
 */
function writeMemory(fact, opts = {}) {
  const db = resolveDb(opts);

  // 验证 namespace
  if (!fact.namespace || !VALID_NAMESPACES.has(fact.namespace)) {
    throw new Error(
      `[store-memory] 无效的 namespace '${fact.namespace}'. ` +
      `有效值: ${[...VALID_NAMESPACES].join(', ')}`
    );
  }

  const id = factId(fact.content, fact.namespace);
  const now = Date.now();
  const ttlUntil = fact.ttlDays ? now + fact.ttlDays * 86_400_000 : null;

  // 检查是否已存在
  const existing = db.prepare('SELECT id, content FROM facts WHERE id = ?').get(id);
  const isNew = !existing;

  if (existing) {
    db.prepare(`
      UPDATE facts SET
        name = COALESCE(?, name),
        content = ?,
        description = COALESCE(?, description),
        source      = COALESCE(?, source),
        confidence  = COALESCE(?, confidence),
        ttl_until   = COALESCE(?, ttl_until),
        updated_at  = ?
      WHERE id = ?
    `).run(
      fact.name || null,
      fact.content,
      fact.description || null,
      fact.source || null,
      fact.confidence ?? null,
      ttlUntil,
      now,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO facts (id, namespace, name, content, description, source, confidence, ttl_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fact.namespace,
      fact.name || null,
      fact.content,
      fact.description || '',
      fact.source || 'manual',
      fact.confidence ?? 0.5,
      ttlUntil,
      now,
      now,
    );
  }

  return { id, isNew };
}

/**
 * 批量写入多条事实 (事务内)。
 * @param {Array<{ namespace: string; name?: string; content: string; description?: string; source?: string; confidence?: number }>} facts
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 * @returns {{ total: number; ids: string[] }}
 */
function writeBatch(facts, opts = {}) {
  const db = resolveDb(opts);
  const ids = [];

  // 注意: node:sqlite 的 DatabaseSync 不支持常规的 transaction() 方法,
  // 我们使用 BEGIN/COMMIT 包裹
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const fact of facts) {
      const result = writeMemory(fact, { db });
      ids.push(result.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { total: facts.length, ids };
}

// ── 检索 ───────────────────────────────────────────────────────────────────

/**
 * 混合检索: FTS5 BM25 + 命名空间过滤 + 置信度排序。
 *
 * @param {string} query           — 检索词
 * @param {object} [opts]
 * @param {string[]} [opts.namespaces]  — 限制命名空间
 * @param {number} [opts.limit]         — 返回条数 (默认 5)
 * @param {number} [opts.minConfidence] — 最低置信度 (默认 0)
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 * @returns {Array<{ id: string; namespace: string; name: string|null; content: string; description: string; confidence: number; hit_count: number; score: number }>}
 */
function retrieveMemory(query, opts = {}) {
  const db = resolveDb(opts);
  const limit = opts.limit ?? 5;
  const minConfidence = opts.minConfidence ?? 0;

  // 清理查询词 (移除特殊字符防 FTS5 语法错误)
  const cleanQuery = query.replace(/[^\p{L}\p{N}_\-\s]+/gu, ' ').trim();
  if (!cleanQuery) return [];

  const terms = cleanQuery.split(/\s+/).filter(Boolean);

  // 构建 FTS5 查询: 纯中文词使用字符级 bigram 前缀匹配
  // unicode61 将连续中文字符合并为一个 token, 导致子串查询失败。
  // 解法: 将中文词拆为所有相邻字符对 (bigram), 每对做前缀匹配。
  // 例如 "编码" → "编码" * ;  "卷积编码" → "卷积" * OR "积编" * OR "编码" *
  // 这要求 FTS5 表有 prefix='2 3 4' (002 迁移已加)。
  const CJK_PURE = /^[一-鿿㐀-䶿豈-﫿]+$/;
  const ftsQuery = terms.map(t => {
    if (!CJK_PURE.test(t)) return `"${t}"`;  // 非中文: 精确匹配
    // 中文: 生成所有相邻字符对作为前缀查询
    const bigrams = new Set();
    for (let i = 0; i < t.length - 1; i++) bigrams.add(t.slice(i, i + 2));
    // 至少有一个 bigram 才走前缀匹配, 否则退化为精确匹配 (单字符中文)
    return bigrams.size > 0
      ? [...bigrams].map(b => `"${b}" *`).join(' OR ')
      : `"${t}"`;
  }).join(' OR ');

  let sql;
  let params;

  if (opts.namespaces && opts.namespaces.length > 0) {
    const placeholders = opts.namespaces.map(() => '?').join(',');
    sql = `
      SELECT f.id, f.namespace, f.name, f.content, f.description,
             f.confidence, f.hit_count, f.created_at,
             fts.rank AS score
      FROM facts_fts fts
      JOIN facts f ON f.rowid = fts.rowid
      WHERE facts_fts MATCH ?
        AND f.namespace IN (${placeholders})
        AND f.confidence >= ?
        AND (f.ttl_until IS NULL OR f.ttl_until > ?)
      ORDER BY score
      LIMIT ?
    `;
    params = [ftsQuery, ...opts.namespaces, minConfidence, Date.now(), limit];
  } else {
    sql = `
      SELECT f.id, f.namespace, f.name, f.content, f.description,
             f.confidence, f.hit_count, f.created_at,
             fts.rank AS score
      FROM facts_fts fts
      JOIN facts f ON f.rowid = fts.rowid
      WHERE facts_fts MATCH ?
        AND f.confidence >= ?
        AND (f.ttl_until IS NULL OR f.ttl_until > ?)
      ORDER BY score
      LIMIT ?
    `;
    params = [ftsQuery, minConfidence, Date.now(), limit];
  }

  let results;
  try {
    const stmt = db.prepare(sql);
    results = stmt.all(...params);
  } catch (err) {
    // FTS5 查询失败 (语法错误等) → 降级到 LIKE 搜索
    return fallbackSearch(db, query, opts);
  }

  // FTS5 返回 0 结果 + 查询包含中文 → 尝试 LIKE 回退（解决 CJK 长句 tokenization 问题）
  if (results.length === 0 && /[一-鿿]{2,}/.test(query)) {
    return fallbackSearch(db, query, opts);
  }

  // 更新 hit_count
  const touchStmt = db.prepare('UPDATE facts SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?');
  for (const r of results) {
    touchStmt.run(Date.now(), r.id);
  }

  return results.map(r => ({
    id: r.id,
    namespace: r.namespace,
    name: r.name,
    content: r.content,
    description: r.description,
    confidence: r.confidence,
    hit_count: r.hit_count,
    score: r.score,
  }));
}

/**
 * FTS5 降级方案: LIKE 搜索。
 */
function fallbackSearch(db, query, opts = {}) {
  const limit = opts.limit ?? 5;
  const minConfidence = opts.minConfidence ?? 0;
  const likeQuery = `%${query}%`;

  let sql;
  let params;

  if (opts.namespaces && opts.namespaces.length > 0) {
    const placeholders = opts.namespaces.map(() => '?').join(',');
    sql = `
      SELECT id, namespace, name, content, description, confidence, hit_count
      FROM facts
      WHERE (content LIKE ? OR name LIKE ?)
        AND namespace IN (${placeholders})
        AND confidence >= ?
        AND (ttl_until IS NULL OR ttl_until > ?)
      ORDER BY hit_count DESC, confidence DESC
      LIMIT ?
    `;
    params = [likeQuery, likeQuery, ...opts.namespaces, minConfidence, Date.now(), limit];
  } else {
    sql = `
      SELECT id, namespace, name, content, description, confidence, hit_count
      FROM facts
      WHERE (content LIKE ? OR name LIKE ?)
        AND confidence >= ?
        AND (ttl_until IS NULL OR ttl_until > ?)
      ORDER BY hit_count DESC, confidence DESC
      LIMIT ?
    `;
    params = [likeQuery, likeQuery, minConfidence, Date.now(), limit];
  }

  return db.prepare(sql).all(...params).map(r => ({
    id: r.id,
    namespace: r.namespace,
    name: r.name,
    content: r.content,
    description: r.description,
    confidence: r.confidence,
    hit_count: r.hit_count,
    score: 0,
  }));
}

// ── 删除 / 清理 ────────────────────────────────────────────────────────────

/**
 * 软删: 标记 ttl_until 为过去, 置信度归零。
 */
function softDeleteMemory(id, opts = {}) {
  const db = resolveDb(opts);
  db.prepare('UPDATE facts SET confidence = 0, ttl_until = 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
}

/**
 * 清理过期事实 (硬删除)。
 * @returns {number} 删除条数
 */
function purgeExpired(opts = {}) {
  const db = resolveDb(opts);
  const now = Date.now();

  // FTS5 需要先删再删主表 (cascade)
  const expired = db.prepare('SELECT rowid FROM facts WHERE ttl_until IS NOT NULL AND ttl_until < ?').all(now);
  for (const r of expired) {
    db.prepare("INSERT INTO facts_fts (facts_fts, rowid) VALUES ('delete', ?)").run(r.rowid);
  }

  const result = db.prepare('DELETE FROM facts WHERE ttl_until IS NOT NULL AND ttl_until < ?').run(now);
  return result.changes;
}

// ── 上下文注入版检索 ──────────────────────────────────────────────────────

/**
 * 轻量版检索: 返回截断内容 (用于 context 注入, 避免全文撑爆窗口)。
 * 与 retrieveMemory 同逻辑, 但 content 截断为 maxChars 字符。
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  — 每条事实最大字符数 (默认 300)
 * @param {number} [opts.limit]     — 返回条数 (默认 3)
 * @returns {Array<{ id: string; namespace: string; name: string|null; summary: string; confidence: number }>}
 */
function retrieveMemorySummary(query, opts = {}) {
  const full = retrieveMemory(query, { ...opts, limit: opts.limit ?? 3 });
  const maxChars = opts.maxChars ?? 300;

  return full.map(r => ({
    id: r.id,
    namespace: r.namespace,
    name: r.name,
    summary: summarizeContent(r).slice(0, maxChars),
    confidence: r.confidence,
    hit_count: r.hit_count,
  }));
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
}

function summarizeContent(record) {
  const body = stripFrontmatter(record.content).replace(/\n{3,}/g, '\n\n').trim();
  const description = String(record.description || '').trim();
  if (description && body && !body.startsWith(description)) {
    return `${description}\n\n${body}`;
  }
  return body || description || '';
}

function memoryStats(opts = {}) {
  const db = resolveDb(opts);
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN confidence >= 0.8 THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN confidence < 0.8 AND confidence >= 0.3 THEN 1 ELSE 0 END) AS tentative,
      SUM(CASE WHEN confidence < 0.3 THEN 1 ELSE 0 END) AS low,
      COUNT(DISTINCT namespace) AS namespaces
    FROM facts
  `).get();
}

module.exports = {
  writeMemory,
  writeBatch,
  retrieveMemory,
  retrieveMemorySummary,
  softDeleteMemory,
  purgeExpired,
  memoryStats,
  factId,
  VALID_NAMESPACES,
};
