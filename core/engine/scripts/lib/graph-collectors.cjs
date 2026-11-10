'use strict';

/**
 * engine/scripts/lib/graph-collectors.cjs — 跨域边采集器。
 *
 * 三条边, 全部内联在既有写路径上采集, **不新增事件消费者**:
 *   evidence → file    (proves)       证据账本写入时 —— 哪次运行证明了哪个文件
 *   requirement → file (traces_to)    需求门禁 completed 时 —— 需求覆盖了哪些文件
 *   fact → file        (recalled_for) 记忆检索命中时 —— 哪条经验和这个文件相关
 *
 * 为什么内联而不是起 consumer: 新的 event consumer 必须注册 watermark + 心跳 +
 * 真实调度, 否则记忆健康检查会红 (docs/rules/05-harness.md #3)。内联采集绕开
 * 整套负担, 代价是必须**绝不抛异常** —— 图是索引, 账本和门禁才是权威。
 *
 * 置信度约定: proves/traces_to = 1.0 (机器可核对); recalled_for = 0.6 (启发式,
 * 只作提示, 不进认证链)。
 */

const path = require('node:path');

/** 单次采集最多建多少条边 —— 防止一条命令扫到上百个文件时把图写爆。 */
const MAX_LINKS_PER_CALL = 40;

/** 从文本里抽取"看起来像代码文件路径"的 token。 */
const PATH_TOKEN = /[\w./\\:-]*\.(sv|svh|vh?|py|c?js|mjs|ts|m|tcl|do|c|cpp|h)\b/gi;

function graphStore() {
  return require('../../sqlite/store-graph.cjs');
}

function hash12(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const value = String(text || '');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

/**
 * 把路径样式的字符串解析成项目内已索引的相对路径。
 *
 * 只认**索引里真实存在**的文件 —— 命令行里随便提到的一个路径不构成一条边。
 *
 * @param {string} projectId
 * @param {string[]} candidates — 绝对路径 / 相对路径 / glob (支持尾部 ** 与 *)
 * @param {object} [opts]
 * @returns {string[]} cg_files.relative_path 列表
 */
function resolveIndexedFiles(projectId, candidates, opts = {}) {
  if (!projectId || !candidates?.length) return [];
  let db = opts.db;
  if (!db) {
    try { db = require('../../sqlite/index.cjs').openDb().db; } catch { return []; }
  }
  const matched = new Set();

  for (const raw of candidates) {
    if (matched.size >= MAX_LINKS_PER_CALL) break;
    const token = String(raw || '').trim().replace(/\\/g, '/').replace(/^["']|["']$/g, '');
    if (!token || token.length > 300) continue;

    const isGlob = /[*?]/.test(token);
    try {
      if (isGlob) {
        const prefix = token.replace(/\/?\*+.*$/, '');
        if (!prefix) continue;
        const rows = db.prepare(`
          SELECT relative_path FROM cg_files
          WHERE project_id = ? AND relative_path LIKE ? LIMIT ?
        `).all(projectId, `${prefix}%`, MAX_LINKS_PER_CALL);
        for (const row of rows) matched.add(row.relative_path);
        continue;
      }

      // 绝对路径 → 先削成相对路径的尾巴; 相对路径直接用
      const exact = db.prepare(
        'SELECT relative_path FROM cg_files WHERE project_id = ? AND relative_path = ? LIMIT 1',
      ).get(projectId, token);
      if (exact) { matched.add(exact.relative_path); continue; }

      const suffix = token.split('/').filter(Boolean).slice(-3).join('/');
      if (!suffix) continue;
      const rows = db.prepare(`
        SELECT relative_path FROM cg_files
        WHERE project_id = ? AND relative_path LIKE ?
        ORDER BY LENGTH(relative_path) LIMIT 3
      `).all(projectId, `%${suffix}`);
      for (const row of rows) matched.add(row.relative_path);
    } catch { /* 表缺失或查询异常: 该 token 放弃 */ }
  }

  return [...matched].slice(0, MAX_LINKS_PER_CALL);
}

/** 从命令文本里抽出候选文件路径。 */
function extractPathTokens(text) {
  const value = String(text || '');
  if (!value) return [];
  const tokens = new Set();
  for (const match of value.matchAll(PATH_TOKEN)) {
    const token = match[0];
    // 跳过纯选项 (-Wall.c 这类不会出现, 但 --flag=x.py 要剥掉前缀)
    tokens.add(token.includes('=') ? token.split('=').pop() : token);
  }
  return [...tokens];
}

/**
 * 证据 → 文件 (proves)。只对 **通过** 的证据建边: "proves" 的语义是"证明了",
 * 失败的运行什么也没证明, 给它建 proves 边会让影响面查询把失败当成保护伞。
 *
 * @param {object} entry — 证据账本条目
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} [opts.gate]
 * @returns {{ linked: number, evidenceId: string|null }}
 */
function collectEvidenceEdges(entry, opts = {}) {
  const result = { linked: 0, evidenceId: null };
  try {
    if (!entry || entry.status !== 'passed') return result;
    const projectId = opts.projectId;
    if (!projectId) return result;

    const evidenceId = entry.contractHash || entry.behaviorContractHash
      || hash12(`${entry.command}|${entry.recordedAt}`);
    result.evidenceId = evidenceId;

    const files = resolveIndexedFiles(projectId, extractPathTokens(entry.command), opts);
    const graph = graphStore();
    for (const file of files) {
      graph.safeLink({
        src: ['evidence', evidenceId],
        dst: ['file', file],
        rel: 'proves',
        provenance: 'evidence-ledger',
        projectId,
        metadata: {
          command: String(entry.command || '').slice(0, 200),
          recordedAt: entry.recordedAt || null,
          ...(opts.gate ? { gate: opts.gate } : {}),
        },
      }, opts);
      result.linked++;
    }
  } catch { /* 图写失败绝不影响账本写入 */ }
  return result;
}

/**
 * 需求 → 文件 (traces_to)。读 completed 的需求门禁状态, 把 scope 落到已索引文件。
 * 幂等 (link 是 upsert), 因此可以在每次门禁通过时无脑调用。
 *
 * @param {object} state — var/gates/requirements-gate.json 的内容
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} [opts.gate='requirements-gate']
 */
function collectRequirementEdges(state, opts = {}) {
  const result = { linked: 0, requirementId: null };
  try {
    if (!state || String(state.status || '').toLowerCase() !== 'completed') return result;
    const projectId = opts.projectId;
    if (!projectId) return result;

    const task = String(state.task || '').trim();
    if (!task) return result;
    const requirementId = `req:${hash12(task)}`;
    result.requirementId = requirementId;

    const scope = Array.isArray(state.scope) ? state.scope : [];
    const files = resolveIndexedFiles(projectId, scope, opts);
    const graph = graphStore();
    for (const file of files) {
      graph.safeLink({
        src: ['requirement', requirementId],
        dst: ['file', file],
        rel: 'traces_to',
        provenance: 'requirements-gate',
        projectId,
        metadata: {
          task: task.slice(0, 200),
          gate: opts.gate || 'requirements-gate',
          plan: state.plan || null,
        },
      }, opts);
      result.linked++;
    }
  } catch { /* 同上 */ }
  return result;
}

/**
 * 记忆 → 文件 (recalled_for, confidence 0.6)。
 * 低置信度边: 只用于"改这里时提醒你看过这条经验", 不得进入认证链。
 *
 * @param {Array<{id?: string, key?: string}>} facts
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} opts.filePath — 触发检索的文件 (绝对或相对)
 */
function collectFactEdges(facts, opts = {}) {
  const result = { linked: 0 };
  try {
    const projectId = opts.projectId;
    if (!projectId || !Array.isArray(facts) || facts.length === 0) return result;
    const files = resolveIndexedFiles(projectId, [opts.filePath].filter(Boolean), opts);
    if (files.length === 0) return result;

    const graph = graphStore();
    for (const fact of facts.slice(0, 5)) {
      const factId = String(fact?.id || fact?.key || '').trim();
      if (!factId) continue;
      for (const file of files) {
        graph.safeLink({
          src: ['fact', factId],
          dst: ['file', file],
          rel: 'recalled_for',
          provenance: 'cross-link-memory',
          confidence: 0.6,
          projectId,
          metadata: { recalledAt: new Date(opts.now || Date.now()).toISOString() },
        }, opts);
        result.linked++;
      }
    }
  } catch { /* 同上 */ }
  return result;
}

module.exports = {
  MAX_LINKS_PER_CALL,
  hash12,
  extractPathTokens,
  resolveIndexedFiles,
  collectEvidenceEdges,
  collectRequirementEdges,
  collectFactEdges,
};
