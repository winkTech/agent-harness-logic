'use strict';

/**
 * engine/sqlite/store-graph.cjs — 跨域图边仓库。
 *
 * 用法:
 *   const graph = require('./store-graph.cjs');
 *   graph.link({ src: ['evidence', sha], dst: ['file', 'rtl/top.sv'], rel: 'proves',
 *                provenance: 'evidence-ledger', projectId });
 *   graph.neighbors(['file', 'rtl/top.sv'], { rel: 'proves', direction: 'in' });
 *
 * 设计:
 *   - link() 幂等 (UNIQUE 冲突时更新 confidence/metadata, 不重复插);
 *   - 所有写操作都必须给 provenance —— 一条来路不明的边比没有边更糟;
 *   - 采集器全部内联在既有写路径上调用, 因此 link() 必须廉价且绝不抛到调用方
 *     (safeLink 包了一层: 图写失败不能影响账本/门禁这些权威写入)。
 */

const { resolveDb } = require('./index.cjs');

const KINDS = new Set([
  'code_node', 'file', 'fact', 'evidence', 'gate', 'requirement', 'session', 'rule', 'cbb',
]);
const RELATIONS = new Set([
  'proves', 'verifies', 'traces_to', 'recalled_for', 'certified_by', 'derived_from', 'covers',
]);

function normalizeRef(ref, label) {
  const [kind, id] = Array.isArray(ref) ? ref : [ref?.kind, ref?.id];
  const k = String(kind || '');
  const i = String(id || '');
  if (!KINDS.has(k)) throw new TypeError(`${label} kind 非法: ${k}`);
  if (!i) throw new TypeError(`${label} id 不能为空`);
  return { kind: k, id: i.slice(0, 400) };
}

/**
 * 建一条跨域边 (幂等)。
 * @param {object} input
 * @param {[string,string]|{kind:string,id:string}} input.src
 * @param {[string,string]|{kind:string,id:string}} input.dst
 * @param {string} input.rel
 * @param {string} input.provenance — 哪个采集器写的
 * @param {number} [input.confidence=1.0]
 * @param {string} [input.projectId]
 * @param {object} [input.metadata]
 * @param {object} [opts]
 */
function link(input, opts = {}) {
  const db = resolveDb(opts);
  const now = opts.now || Date.now();
  const src = normalizeRef(input.src, 'src');
  const dst = normalizeRef(input.dst, 'dst');
  const rel = String(input.rel || '');
  if (!RELATIONS.has(rel)) throw new TypeError(`rel 非法: ${rel}`);
  const provenance = String(input.provenance || '').trim();
  if (!provenance) throw new TypeError('provenance 必填: 不接受来路不明的边');

  const confidence = Number.isFinite(input.confidence)
    ? Math.min(1, Math.max(0, input.confidence)) : 1.0;
  let metadata = '{}';
  try { metadata = JSON.stringify(input.metadata || {}); } catch { /* 保留 {} */ }

  db.prepare(`
    INSERT INTO graph_edges
      (src_kind, src_id, dst_kind, dst_id, rel, confidence, provenance, project_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(src_kind, src_id, dst_kind, dst_id, rel) DO UPDATE SET
      confidence = excluded.confidence,
      provenance = excluded.provenance,
      metadata   = excluded.metadata
  `).run(
    src.kind, src.id, dst.kind, dst.id, rel, confidence, provenance,
    input.projectId || null, metadata, now,
  );
  return { src, dst, rel };
}

/** 永不抛出的 link —— 供内联采集器使用: 图是索引, 权威写入不能被它拖累。 */
function safeLink(input, opts = {}) {
  try { return link(input, opts); }
  catch { return null; }
}

function hydrate(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata); } catch { /* 元数据损坏时降级为空 */ }
  return {
    id: row.id,
    src: { kind: row.src_kind, id: row.src_id },
    dst: { kind: row.dst_kind, id: row.dst_id },
    rel: row.rel,
    confidence: row.confidence,
    provenance: row.provenance,
    projectId: row.project_id,
    metadata,
    createdAt: row.created_at,
  };
}

/**
 * 查某个节点的邻边。
 * @param {[string,string]} ref
 * @param {object} [filter]
 * @param {'in'|'out'|'both'} [filter.direction='both']
 * @param {string|string[]} [filter.rel]
 * @param {number} [filter.minConfidence=0]
 * @param {number} [filter.limit=50]
 */
function neighbors(ref, filter = {}, opts = {}) {
  const db = resolveDb(opts);
  const node = normalizeRef(ref, 'node');
  const direction = ['in', 'out', 'both'].includes(filter.direction) ? filter.direction : 'both';
  const rels = filter.rel ? [].concat(filter.rel) : null;
  const minConfidence = Number.isFinite(filter.minConfidence) ? filter.minConfidence : 0;
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 50;

  const clauses = [];
  const params = [];
  if (direction === 'out') {
    clauses.push('(src_kind = ? AND src_id = ?)');
    params.push(node.kind, node.id);
  } else if (direction === 'in') {
    clauses.push('(dst_kind = ? AND dst_id = ?)');
    params.push(node.kind, node.id);
  } else {
    clauses.push('((src_kind = ? AND src_id = ?) OR (dst_kind = ? AND dst_id = ?))');
    params.push(node.kind, node.id, node.kind, node.id);
  }
  if (rels) {
    clauses.push(`rel IN (${rels.map(() => '?').join(',')})`);
    params.push(...rels);
  }
  clauses.push('confidence >= ?');
  params.push(minConfidence);

  return db.prepare(`
    SELECT * FROM graph_edges WHERE ${clauses.join(' AND ')}
    ORDER BY confidence DESC, created_at DESC LIMIT ?
  `).all(...params, limit).map(hydrate);
}

/** 批量查邻边: 影响面查询要一次问几十个节点, 逐个查会放大成 N 次往返。 */
function neighborsOfMany(refs, filter = {}, opts = {}) {
  const db = resolveDb(opts);
  const nodes = (refs || []).map((ref) => normalizeRef(ref, 'node'));
  if (nodes.length === 0) return [];
  const rels = filter.rel ? [].concat(filter.rel) : null;
  const minConfidence = Number.isFinite(filter.minConfidence) ? filter.minConfidence : 0;
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? filter.limit : 200;

  const nodeClause = nodes
    .map(() => '((src_kind = ? AND src_id = ?) OR (dst_kind = ? AND dst_id = ?))')
    .join(' OR ');
  const params = nodes.flatMap((n) => [n.kind, n.id, n.kind, n.id]);
  let sql = `SELECT * FROM graph_edges WHERE (${nodeClause}) AND confidence >= ?`;
  params.push(minConfidence);
  if (rels) {
    sql += ` AND rel IN (${rels.map(() => '?').join(',')})`;
    params.push(...rels);
  }
  sql += ' ORDER BY confidence DESC, created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map(hydrate);
}

/** 统计 (供仪表盘与契约测试)。 */
function stats(opts = {}) {
  const db = resolveDb(opts);
  const total = db.prepare('SELECT COUNT(*) AS c FROM graph_edges').get().c;
  const byRel = db.prepare('SELECT rel, COUNT(*) AS c FROM graph_edges GROUP BY rel ORDER BY c DESC').all();
  return { total, byRel: byRel.map((row) => ({ rel: row.rel, count: row.c })) };
}

module.exports = { link, safeLink, neighbors, neighborsOfMany, stats, KINDS, RELATIONS };
