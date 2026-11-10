#!/usr/bin/env node

/**
 * engine/scripts/cg-queries.cjs — 代码图查询库。
 *
 * 供 MCP 服务器 (codegraph-server.cjs) 和 CLI (code-graph-index.cjs) 共用。
 * 所有查询通过 engine/sqlite/index.cjs 的 openDb() 单例连接池。
 *
 * 用法:
 *   const { searchNodes, getCallers, getSubgraphByNames } = require('./cg-queries.cjs');
 *   const results = searchNodes('uart_tx', { projectId: 'proj1', limit: 10 });
 */

'use strict';

const { openDb } = require('../sqlite/index.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

// ── 项目管理 ────────────────────────────────────────────────────────────────

/** 索引新鲜度窗口: 超过此时长未重新索引即视为陈旧 (默认 7 天)。 */
const DEFAULT_FRESHNESS_MS = (() => {
  const raw = Number.parseInt(process.env.CLAUDE_CG_FRESHNESS_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 7 * 24 * 60 * 60 * 1000;
})();

/**
 * 取路径的规范绝对形式。路径不存在时退回 path.resolve()。
 * @param {string} projectPath
 * @returns {string}
 */
function canonicalRootPath(projectPath) {
  const resolved = path.resolve(String(projectPath || '.'));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved; // 目录不存在或无权限: 仍可注册, 只是拿不到文件系统规范大小写
  }
}

/**
 * 由根路径计算 projectId。
 *
 * win32 文件系统大小写不敏感, 且分隔符可混用: `c:/x` 与 `C:\x` 是同一个目录。
 * 直接哈希 path.resolve() 结果会把同一项目劈成两个 projectId, 图数据各存一半,
 * 而 callers/callees 只查其中一半 —— 实测 cg_projects 里出现过仅盘符大小写不同
 * 的两行。因此 win32 上统一分隔符并小写化后再哈希; POSIX 保持大小写敏感语义。
 *
 * @param {string} rootPath — 绝对路径
 * @returns {string} 16 位十六进制 projectId
 */
function projectKey(rootPath) {
  const raw = String(rootPath || '');
  const normalized = process.platform === 'win32'
    ? raw.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : raw.replace(/\/+$/, '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 删除与 projectId 指向同一目录、但键值过时的项目行。
 *
 * 代码图是**派生缓存**, 可由源码完整重建, 所以对齐键值时直接丢弃旧行让下次
 * 索引重建, 而不是原地改键 —— cg_files/cg_nodes 的 id 都由 project_id 参与
 * 哈希, 原地改键会留下一批派生 id 与新 project_id 不自洽的行。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} projectId — 规范键
 * @returns {{ dropped: string[] }}
 */
function dropStaleProjectRows(db, projectId) {
  const dropped = [];
  let rows = [];
  try {
    rows = db.prepare('SELECT id, root_path FROM cg_projects WHERE id != ?').all(projectId);
  } catch { return { dropped }; }

  for (const row of rows) {
    if (projectKey(row.root_path) !== projectId) continue;
    for (const sql of [
      'DELETE FROM cg_edges WHERE project_id = ?',
      'DELETE FROM cg_nodes WHERE project_id = ?',
      'DELETE FROM cg_unresolved WHERE project_id = ?',
      'DELETE FROM cg_files WHERE project_id = ?',
      'DELETE FROM cg_projects WHERE id = ?',
    ]) {
      try { db.prepare(sql).run(row.id); } catch { /* 表缺失时跳过 */ }
    }
    dropped.push(row.id);
  }
  return { dropped };
}

/**
 * 解析项目路径，返回项目 ID。自动注册新项目。
 * @param {string} projectPath — 项目根路径
 * @returns {{ projectId: string, rootPath: string, droppedStaleRows?: string[] }}
 */
function resolveProject(projectPath) {
  const rootPath = canonicalRootPath(projectPath);
  const projectId = projectKey(rootPath);
  const db = openDb().db;

  const existing = db.prepare('SELECT id, root_path FROM cg_projects WHERE id = ?').get(projectId);
  if (existing) {
    // 键值已对, 但存的路径可能是旧的非规范写法 → 更新为规范形式
    if (existing.root_path !== rootPath) {
      try {
        db.prepare('UPDATE cg_projects SET root_path = ? WHERE id = ?').run(rootPath, projectId);
      } catch { /* root_path UNIQUE 冲突: 说明另有同路径行, 下次 resolve 会清理 */ }
    }
    return { projectId, rootPath };
  }

  const { dropped } = dropStaleProjectRows(db, projectId);
  db.prepare(
    'INSERT OR IGNORE INTO cg_projects (id, root_path, name, created_at) VALUES (?, ?, ?, ?)'
  ).run(projectId, rootPath, path.basename(rootPath), Date.now());

  return dropped.length
    ? { projectId, rootPath, droppedStaleRows: dropped }
    : { projectId, rootPath };
}

/**
 * 判定项目索引是否新鲜。
 *
 * 与语义检索的纪律一致 (docs/rules/05-harness.md #5): 索引不可信时失败关闭,
 * 返回 stale 而不是拿旧图给出"可能相关"的答案。
 *
 * @param {string} projectId
 * @param {object} [opts]
 * @param {number} [opts.freshnessMs] — 新鲜度窗口
 * @param {number} [opts.now]
 * @returns {{ fresh: boolean, reason: string, indexedAt: number|null, ageMs: number|null, nodeCount: number }}
 */
function indexFreshness(projectId, opts = {}) {
  const db = openDb().db;
  const now = opts.now || Date.now();
  const window = opts.freshnessMs || DEFAULT_FRESHNESS_MS;
  const base = { indexedAt: null, ageMs: null, nodeCount: 0 };

  let proj;
  try {
    proj = db.prepare('SELECT indexed_at, node_count FROM cg_projects WHERE id = ?').get(projectId);
  } catch {
    return { ...base, fresh: false, reason: 'no_index_tables' };
  }
  if (!proj) return { ...base, fresh: false, reason: 'not_registered' };

  const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM cg_nodes WHERE project_id = ?')
    .get(projectId).c;
  const indexedAt = proj.indexed_at || null;

  if (!indexedAt) return { ...base, nodeCount, fresh: false, reason: 'never_indexed' };
  const ageMs = now - indexedAt;
  if (nodeCount === 0) return { indexedAt, ageMs, nodeCount, fresh: false, reason: 'empty_index' };
  if (ageMs > window) return { indexedAt, ageMs, nodeCount, fresh: false, reason: 'stale_age' };

  return { indexedAt, ageMs, nodeCount, fresh: true, reason: 'fresh' };
}

/**
 * 获取项目统计信息。
 * @param {string} projectId
 * @returns {object|null}
 */
function getProjectStats(projectId) {
  const db = openDb().db;
  const proj = db.prepare('SELECT * FROM cg_projects WHERE id = ?').get(projectId);
  if (!proj) return null;
  return {
    id: proj.id,
    name: proj.name,
    rootPath: proj.root_path,
    indexedAt: proj.indexed_at,
    fileCount: proj.file_count,
    nodeCount: proj.node_count,
    edgeCount: proj.edge_count,
  };
}

// ── FTS5 搜索 ───────────────────────────────────────────────────────────────

/**
 * FTS5 全文搜索符号（含 LIKE 回退）。
 *
 * @param {string} query — 搜索关键词
 * @param {object} [opts]
 * @param {string}  [opts.projectId] — 限定项目
 * @param {string}  [opts.kind]      — 限定种类 (module|port|signal|...)
 * @param {number}  [opts.limit=10]  — 最大结果
 * @param {number}  [opts.maxChars=300] — 签名截断长度
 * @returns {object[]} — [{ id, kind, name, qualified_name, file, line, signature, score }]
 */
function searchNodes(query, opts = {}) {
  const db = openDb().db;
  const limit = opts.limit || 10;
  const maxChars = opts.maxChars || 300;
  const results = [];

  // 1. FTS5 BM25 搜索 (优先)
  const ftsQuery = query.replace(/[^\w\s一-鿿_-]/g, ' ').trim();
  if (ftsQuery.length >= 2) {
    // unicode61 tokenizer 的短语/前缀查询
    const terms = ftsQuery.split(/\s+/).filter(Boolean);
    const ftsTerm = terms.map(t => {
      // 对纯中文词用双引号精确匹配 + 前缀
      if (/^[一-鿿]+$/.test(t)) return `"${t}"*`;
      return `"${t}"*`;
    }).join(' ');

    let sql = `
      SELECT n.id, n.kind, n.name, n.qualified_name,
             f.relative_path AS file, n.start_line AS line,
             n.signature, n.metadata,
             rank AS score
      FROM cg_nodes_fts fts
      JOIN cg_nodes n ON n.rowid = fts.rowid
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE cg_nodes_fts MATCH ?
    `;
    const params = [ftsTerm];

    if (opts.projectId) {
      sql += ' AND n.project_id = ?';
      params.push(opts.projectId);
    }
    if (opts.kind) {
      sql += ' AND n.kind = ?';
      params.push(opts.kind);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit * 2); // 取多些后截断

    try {
      const rows = db.prepare(sql).all(...params);
      for (const r of rows) {
        results.push({
          id: r.id,
          kind: r.kind,
          name: r.name,
          qualified_name: r.qualified_name,
          file: r.file,
          line: r.line,
          signature: r.signature ? r.signature.slice(0, maxChars) : '',
          score: Number(r.score || 0).toFixed(3),
        });
      }
    } catch (e) {
      // FTS5 语法错误时静默，走 LIKE 回退
    }
  }

  // 2. LIKE 回退 (FTS5 无结果或语法错时)
  if (results.length === 0) {
    // 2a. 先试全短语匹配
    const likeFull = `%${query}%`;
    let sql = `
      SELECT n.id, n.kind, n.name, n.qualified_name,
             f.relative_path AS file, n.start_line AS line,
             n.signature, n.metadata
      FROM cg_nodes n
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE (n.name LIKE ? OR n.qualified_name LIKE ?)
    `;
    let params = [likeFull, likeFull];

    if (opts.projectId) {
      sql += ' AND n.project_id = ?';
      params.push(opts.projectId);
    }
    if (opts.kind) {
      sql += ' AND n.kind = ?';
      params.push(opts.kind);
    }

    sql += ' LIMIT ?';
    params.push(limit);

    try {
      const rows = db.prepare(sql).all(...params);
      for (const r of rows) {
        results.push({ id: r.id, kind: r.kind, name: r.name, qualified_name: r.qualified_name, file: r.file, line: r.line, signature: r.signature ? r.signature.slice(0, maxChars) : '', score: '0' });
      }
    } catch (e) { /* 静默 */ }

    // 2b. 全短语 0 结果且包含多个词 → 逐词 OR 匹配
    if (results.length === 0) {
      const terms = query.split(/\s+/).filter(t => t.length >= 2 && !/^(find|show|where|what|who|which|how|is|are|the|a|an|for|in|at|of|to|with|does|did|can|could|will|would|has|have|been|get|list|search|locate|module|instance|signal|port|symbol|definition|caller|callee)$/i.test(t));
      if (terms.length > 1) {
        let sql2 = `
          SELECT DISTINCT n.id, n.kind, n.name, n.qualified_name,
                 f.relative_path AS file, n.start_line AS line,
                 n.signature, n.metadata
          FROM cg_nodes n
          LEFT JOIN cg_files f ON f.id = n.file_id
          WHERE (${terms.map(() => '(n.name LIKE ? OR n.qualified_name LIKE ?)').join(' OR ')})
        `;
        let params2 = terms.flatMap(t => [`%${t}%`, `%${t}%`]);

        if (opts.projectId) {
          sql2 += ' AND n.project_id = ?';
          params2.push(opts.projectId);
        }
        if (opts.kind) {
          sql2 += ' AND n.kind = ?';
          params2.push(opts.kind);
        }

        sql2 += ' LIMIT ?';
        params2.push(limit);

        try {
          const rows = db.prepare(sql2).all(...params2);
          for (const r of rows) {
            results.push({ id: r.id, kind: r.kind, name: r.name, qualified_name: r.qualified_name, file: r.file, line: r.line, signature: r.signature ? r.signature.slice(0, maxChars) : '', score: '0' });
          }
        } catch (e) { /* 静默 */ }
      }
    }
  }

  return results.slice(0, limit);
}

// ── 节点查询 ────────────────────────────────────────────────────────────────

/**
 * 按 ID 或名称查询节点。
 * @param {string} projectId
 * @param {string} nodeIdOrName
 * @returns {object|null}
 */
function getNode(projectId, nodeIdOrName) {
  const db = openDb().db;
  // 先按 ID 查
  let row = db.prepare(`
    SELECT n.*, f.relative_path AS file
    FROM cg_nodes n
    LEFT JOIN cg_files f ON f.id = n.file_id
    WHERE n.id = ? AND n.project_id = ?
  `).get(nodeIdOrName, projectId);

  if (!row) {
    // 按 name + qualified_name 查
    row = db.prepare(`
      SELECT n.*, f.relative_path AS file
      FROM cg_nodes n
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE (n.name = ? OR n.qualified_name = ?) AND n.project_id = ?
      ORDER BY n.start_line
      LIMIT 1
    `).get(nodeIdOrName, nodeIdOrName, projectId);
  }

  if (!row) return null;

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualified_name: row.qualified_name,
    file: row.file,
    start_line: row.start_line,
    end_line: row.end_line,
    signature: row.signature,
    metadata: tryJSON(row.metadata),
  };
}

/**
 * 按种类查询节点。
 * @param {string} projectId
 * @param {string} kind
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function getNodesByKind(projectId, kind, limit = 50) {
  const db = openDb().db;
  const rows = db.prepare(`
    SELECT n.id, n.kind, n.name, n.qualified_name, f.relative_path AS file,
           n.start_line, n.signature
    FROM cg_nodes n
    LEFT JOIN cg_files f ON f.id = n.file_id
    WHERE n.project_id = ? AND n.kind = ?
    ORDER BY n.name
    LIMIT ?
  `).all(projectId, kind, limit);
  return rows;
}

/**
 * 查询文件内所有符号。
 * @param {string} projectId
 * @param {string} fileRelativePath — 相对路径
 * @returns {object[]}
 */
function getNodesInFile(projectId, fileRelativePath) {
  const db = openDb().db;
  const file = db.prepare('SELECT id FROM cg_files WHERE project_id = ? AND relative_path = ?').get(projectId, fileRelativePath);
  if (!file) return [];
  return db.prepare(`
    SELECT id, kind, name, qualified_name, start_line, end_line, signature
    FROM cg_nodes
    WHERE file_id = ?
    ORDER BY start_line
  `).all(file.id);
}

// ── 边查询 ──────────────────────────────────────────────────────────────────

/**
 * 查询入边 (谁引用/调用/实例化了此节点)。
 * @param {string} nodeId
 * @param {string} [kind]  — 边类型过滤
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function getIncomingEdges(nodeId, kind, limit = 50) {
  const db = openDb().db;
  let sql = `
    SELECT e.id, e.kind, e.line, e.provenance,
           n.id AS source_id, n.name AS source_name, n.kind AS source_kind,
           f.relative_path AS source_file
    FROM cg_edges e
    JOIN cg_nodes n ON n.id = e.source_id
    LEFT JOIN cg_files f ON f.id = n.file_id
    WHERE e.target_id = ?
  `;
  const params = [nodeId];
  if (kind) { sql += ' AND e.kind = ?'; params.push(kind); }
  sql += ' LIMIT ?'; params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * 查询出边 (此节点引用/调用/实例化了什么)。
 * @param {string} nodeId
 * @param {string} [kind]
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function getOutgoingEdges(nodeId, kind, limit = 50) {
  const db = openDb().db;
  let sql = `
    SELECT e.id, e.kind, e.line, e.provenance,
           n.id AS target_id, n.name AS target_name, n.kind AS target_kind,
           f.relative_path AS target_file
    FROM cg_edges e
    JOIN cg_nodes n ON n.id = e.target_id
    LEFT JOIN cg_files f ON f.id = n.file_id
    WHERE e.source_id = ?
  `;
  const params = [nodeId];
  if (kind) { sql += ' AND e.kind = ?'; params.push(kind); }
  sql += ' LIMIT ?'; params.push(limit);
  return db.prepare(sql).all(...params);
}

// ── 图遍历 ──────────────────────────────────────────────────────────────────

/**
 * 递归查询调用者 (入边遍历)。
 * 使用 SQLite 递归 CTE。
 *
 * @param {string} projectId
 * @param {string} name — 符号名（模块/函数）
 * @param {object} [opts]
 * @param {number}  [opts.maxDepth=3]
 * @param {string}  [opts.file] — 当有同名符号时指定文件
 * @param {number}  [opts.limit=20]
 * @returns {{ node: object, edges: object[], callers: object[] }}
 */
function getCallers(projectId, name, opts = {}) {
  const db = openDb().db;
  const maxDepth = opts.maxDepth || 3;
  const limit = opts.limit || 20;

  // 先找目标节点
  let targetNode;
  if (opts.file) {
    targetNode = db.prepare(`
      SELECT n.*, f.relative_path AS file
      FROM cg_nodes n
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE n.name = ? AND n.project_id = ? AND f.relative_path LIKE ?
      ORDER BY n.start_line LIMIT 1
    `).get(name, projectId, `%${opts.file}%`);
  }
  if (!targetNode) {
    targetNode = db.prepare(`
      SELECT n.*, f.relative_path AS file
      FROM cg_nodes n
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE (n.name = ? OR n.qualified_name = ?) AND n.project_id = ?
      ORDER BY n.start_line LIMIT 1
    `).get(name, name, projectId);
  }
  if (!targetNode) return { node: null, edges: [], callers: [] };

  // 递归 CTE: 入边遍历
  // 只追踪 instantiates 和 calls 边
  const callers = [];
  const seenEdges = new Set();
  try {
    const rows = db.prepare(`
      WITH RECURSIVE callers(id, depth, path) AS (
        SELECT ?, 0, ?
        UNION ALL
        SELECT e.source_id, c.depth + 1, c.path || ',' || e.source_id
        FROM cg_edges e
        JOIN callers c ON e.target_id = c.id
        WHERE e.kind IN ('instantiates', 'calls')
          AND c.depth < ?
          AND instr(c.path, ',' || e.source_id || ',') = 0
      )
      SELECT DISTINCT n.id, n.kind, n.name, n.qualified_name,
             f.relative_path AS file, n.start_line,
             c.depth
      FROM callers c
      JOIN cg_nodes n ON n.id = c.id
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE c.depth > 0
      ORDER BY c.depth, n.name
      LIMIT ?
    `).all(targetNode.id, ',' + targetNode.id + ',', maxDepth, limit);

    for (const r of rows) {
      callers.push({
        id: r.id, kind: r.kind, name: r.name,
        qualified_name: r.qualified_name,
        file: r.file, line: r.start_line,
        depth: r.depth,
      });
    }
  } catch (e) { /* 递归 CTE 错误 */ }

  // 直接入边
  const edges = getIncomingEdges(targetNode.id, null, limit);

  return {
    node: {
      id: targetNode.id, kind: targetNode.kind, name: targetNode.name,
      qualified_name: targetNode.qualified_name,
      file: targetNode.file, start_line: targetNode.start_line,
      signature: targetNode.signature,
    },
    edges,
    callers,
  };
}

/**
 * 递归查询被调用者 (出边遍历)。
 * @param {string} projectId
 * @param {string} name
 * @param {object} [opts]
 * @returns {{ node: object, edges: object[], callees: object[] }}
 */
function getCallees(projectId, name, opts = {}) {
  const db = openDb().db;
  const maxDepth = opts.maxDepth || 3;
  const limit = opts.limit || 20;

  // 找目标节点
  let targetNode;
  if (opts.file) {
    targetNode = db.prepare(`
      SELECT n.*, f.relative_path AS file
      FROM cg_nodes n
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE n.name = ? AND n.project_id = ? AND f.relative_path LIKE ?
      ORDER BY n.start_line LIMIT 1
    `).get(name, projectId, `%${opts.file}%`);
  }
  if (!targetNode) {
    targetNode = db.prepare(`
      SELECT n.*, f.relative_path AS file
      FROM cg_nodes n
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE (n.name = ? OR n.qualified_name = ?) AND n.project_id = ?
      ORDER BY n.start_line LIMIT 1
    `).get(name, name, projectId);
  }
  if (!targetNode) return { node: null, edges: [], callees: [] };

  const callees = [];
  try {
    const rows = db.prepare(`
      WITH RECURSIVE callees(id, depth, path) AS (
        SELECT ?, 0, ?
        UNION ALL
        SELECT e.target_id, c.depth + 1, c.path || ',' || e.target_id
        FROM cg_edges e
        JOIN callees c ON e.source_id = c.id
        WHERE e.kind IN ('instantiates', 'calls')
          AND c.depth < ?
          AND instr(c.path, ',' || e.target_id || ',') = 0
      )
      SELECT DISTINCT n.id, n.kind, n.name, n.qualified_name,
             f.relative_path AS file, n.start_line,
             c.depth
      FROM callees c
      JOIN cg_nodes n ON n.id = c.id
      LEFT JOIN cg_files f ON f.id = n.file_id
      WHERE c.depth > 0
      ORDER BY c.depth, n.name
      LIMIT ?
    `).all(targetNode.id, ',' + targetNode.id + ',', maxDepth, limit);

    for (const r of rows) {
      callees.push({
        id: r.id, kind: r.kind, name: r.name,
        qualified_name: r.qualified_name,
        file: r.file, line: r.start_line,
        depth: r.depth,
      });
    }
  } catch (e) { /* 静默 */ }

  const edges = getOutgoingEdges(targetNode.id, null, limit);

  return {
    node: {
      id: targetNode.id, kind: targetNode.kind, name: targetNode.name,
      qualified_name: targetNode.qualified_name,
      file: targetNode.file, start_line: targetNode.start_line,
      signature: targetNode.signature,
    },
    edges,
    callees,
  };
}

// ── Explore-flow 核心 ────────────────────────────────────────────────────────

/**
 * 核心"探索"查询 — 符号袋搜索 + 源码 + 关系。
 *
 * 接受一组符号名，返回:
 * - 匹配的节点列表
 * - 节点之间的调用/实例化关系
 * - 按文件分组的上下文
 * - 根符号集
 *
 * @param {string} projectId
 * @param {string[]} symbolNames — 要探索的符号名列表
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=1]  — 扩展深度
 * @param {number} [opts.maxFiles=8]  — 最大返回文件数
 * @returns {{ nodes: object[], edges: object[], roots: string[], files: object[] }}
 */
function getSubgraphByNames(projectId, symbolNames, opts = {}) {
  const db = openDb().db;
  const maxDepth = opts.maxDepth || 1;
  const maxFiles = opts.maxFiles || 8;
  const names = Array.isArray(symbolNames) ? symbolNames : [symbolNames];
  if (names.length === 0) return { nodes: [], edges: [], roots: [], files: [] };

  // 1. 找匹配节点 (FTS5 + 精确)
  const rootIds = new Set();
  const allNodeIds = new Set();

  for (const name of names) {
    // 精确匹配
    const exact = db.prepare(`
      SELECT id FROM cg_nodes
      WHERE project_id = ? AND (name = ? OR qualified_name = ?)
      LIMIT 5
    `).all(projectId, name, name);
    for (const r of exact) { rootIds.add(r.id); allNodeIds.add(r.id); }

    // FTS5 模糊匹配（如果精确不够）
    if (exact.length === 0 && name.length >= 2) {
      const fuzzy = db.prepare(`
        SELECT n.id
        FROM cg_nodes_fts fts
        JOIN cg_nodes n ON n.rowid = fts.rowid
        WHERE n.project_id = ? AND cg_nodes_fts MATCH ?
        ORDER BY rank
        LIMIT 3
      `).all(projectId, `"${name}"*`);
      for (const r of fuzzy) { rootIds.add(r.id); allNodeIds.add(r.id); }
    }
  }

  if (allNodeIds.size === 0) return { nodes: [], edges: [], roots: [], files: [] };

  // 2. 扩展遍历 (深度 1-2)
  const ids = [...allNodeIds];
  if (maxDepth >= 1) {
    // 出边: 实例化/调用
    const outRows = db.prepare(`
      SELECT DISTINCT e.target_id AS id
      FROM cg_edges e
      WHERE e.source_id IN (${ids.map(() => '?').join(',')})
        AND e.kind IN ('instantiates', 'calls', 'contains')
    `).all(...ids);
    for (const r of outRows) allNodeIds.add(r.id);

    // 入边: 被实例化/调用
    const inRows = db.prepare(`
      SELECT DISTINCT e.source_id AS id
      FROM cg_edges e
      WHERE e.target_id IN (${ids.map(() => '?').join(',')})
        AND e.kind IN ('instantiates', 'calls')
    `).all(...ids);
    for (const r of inRows) allNodeIds.add(r.id);
  }

  const allIds = [...allNodeIds];
  if (allIds.length === 0) return { nodes: [], edges: [], roots: [], files: [] };

  // 3. 获取节点详情
  const placeholders = allIds.map(() => '?').join(',');
  const nodes = db.prepare(`
    SELECT n.id, n.kind, n.name, n.qualified_name,
           f.relative_path AS file, n.start_line, n.end_line,
           n.signature, n.metadata
    FROM cg_nodes n
    LEFT JOIN cg_files f ON f.id = n.file_id
    WHERE n.id IN (${placeholders})
    ORDER BY n.kind, n.name
  `).all(...allIds).map(r => ({
    id: r.id, kind: r.kind, name: r.name,
    qualified_name: r.qualified_name,
    file: r.file, start_line: r.start_line, end_line: r.end_line,
    signature: r.signature ? r.signature.slice(0, 200) : '',
    is_root: rootIds.has(r.id),
  }));

  // 4. 获取边
  const edges = db.prepare(`
    SELECT e.id, e.kind, e.line, e.provenance,
           src.name AS source_name, src.kind AS source_kind,
           tgt.name AS target_name, tgt.kind AS target_kind
    FROM cg_edges e
    JOIN cg_nodes src ON src.id = e.source_id
    JOIN cg_nodes tgt ON tgt.id = e.target_id
    WHERE e.source_id IN (${placeholders}) AND e.target_id IN (${placeholders})
    ORDER BY e.kind
  `).all(...allIds, ...allIds);

  // 5. 按文件分组
  const fileMap = new Map();
  for (const n of nodes) {
    const key = n.file || 'unknown';
    if (!fileMap.has(key)) fileMap.set(key, { file: key, symbols: [] });
    fileMap.get(key).symbols.push({
      name: n.name, kind: n.kind, line: n.start_line,
      signature: n.signature,
    });
  }
  const sortedFiles = [...fileMap.entries()]
    .sort((a, b) => b[1].symbols.length - a[1].symbols.length)
    .slice(0, maxFiles)
    .map(([_, v]) => v);

  return {
    nodes,
    edges,
    roots: [...rootIds],
    files: sortedFiles,
  };
}

// ── 影响面查询 ───────────────────────────────────────────────────────────────

/**
 * 反向影响传播: 从种子节点出发, 沿入边找出所有会被波及的符号。
 *
 * 关键在于**穿透实例节点**。SV 解析器建的是三段式关系:
 *   mid --contains--> u_leaf --instantiates--> leaf
 * 只走 instantiates/calls 的话, 从 leaf 往回只能走到实例 u_leaf 就断了 ——
 * 而真正受影响的是持有这个实例的模块 mid。因此反向遍历必须同时吃 contains 边,
 * 且实例节点不计入逻辑深度 (它是同一层的中转, 不是新一层依赖)。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} seedIds
 * @param {{depth: number, limit: number}} opts
 * @returns {object[]} 按逻辑深度升序
 */
function reverseImpact(db, seedIds, opts = {}) {
  const depth = opts.depth || 3;
  const limit = opts.limit || 40;
  const seen = new Set(seedIds);
  const out = [];
  let frontier = seedIds.map(id => ({ id, logical: 0 }));

  // 每一逻辑层最多两跳 (实例中转 + 父模块), 加一跳裕量
  const maxHops = depth * 2 + 1;

  for (let hop = 0; hop < maxHops && frontier.length > 0 && out.length < limit; hop++) {
    const ids = frontier.map(item => item.id);
    const logicalById = new Map(frontier.map(item => [item.id, item.logical]));
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT e.target_id AS via, e.source_id AS id, n.kind, n.name, n.qualified_name,
               n.start_line AS line, f.relative_path AS file
        FROM cg_edges e
        JOIN cg_nodes n ON n.id = e.source_id
        LEFT JOIN cg_files f ON f.id = n.file_id
        WHERE e.target_id IN (${ids.map(() => '?').join(',')})
          AND e.kind IN ('instantiates', 'calls', 'contains')
        LIMIT ?
      `).all(...ids, limit * 4);
    } catch { break; }

    const next = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // 实例是中转节点, 不占一层深度
      const logical = (logicalById.get(row.via) ?? 0) + (row.kind === 'instance' ? 0 : 1);
      if (logical > depth) continue;
      next.push({ id: row.id, logical });
      if (row.kind !== 'instance') {
        out.push({
          id: row.id,
          kind: row.kind,
          name: row.name,
          qualified_name: row.qualified_name,
          file: row.file,
          line: row.line,
          depth: logical,
        });
      }
    }
    frontier = next;
  }

  return out.sort((a, b) => a.depth - b.depth).slice(0, limit);
}

/**
 * 给定一个改动点, 返回它的影响面。
 *
 * 这是"代码图 + 跨域图"合起来才能回答的问题, 也是整套 graph engineering 的
 * 落点: 改一个模块 → 下游哪些模块受影响 → 哪些证据因此失效 → 哪些门禁要重跑。
 *
 * 失败关闭: 索引不新鲜时返回 staleIndex=true 且**不给结果**, 与语义检索同一纪律
 * (docs/rules/05-harness.md #5) —— 拿过期的图算影响面, 比不算更危险。
 *
 * @param {string} projectId
 * @param {string} target — 符号名 / qualified_name / 节点 id / 相对文件路径
 * @param {object} [opts]
 * @param {number} [opts.depth=3] — 反向依赖遍历深度
 * @param {number} [opts.limit=40]
 * @param {boolean} [opts.allowStale=false] — 显式允许用陈旧索引 (仅诊断用)
 * @returns {{
 *   target: object|null, staleIndex: boolean, staleReason: string|null,
 *   downstream: object[], files: string[], staleEvidence: object[],
 *   gatesToRerun: string[], requirements: object[], relatedFacts: object[]
 * }}
 */
function getBlastRadius(projectId, target, opts = {}) {
  const db = openDb().db;
  const depth = Number.isInteger(opts.depth) && opts.depth > 0 ? opts.depth : 3;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 40;
  const empty = {
    target: null,
    staleIndex: false,
    staleReason: null,
    downstream: [],
    files: [],
    staleEvidence: [],
    gatesToRerun: [],
    requirements: [],
    relatedFacts: [],
  };

  const freshness = indexFreshness(projectId, opts);
  if (!freshness.fresh && !opts.allowStale) {
    return { ...empty, staleIndex: true, staleReason: freshness.reason };
  }

  // 1. 定位改动点。先当符号查, 再当文件路径查。
  const node = getNode(projectId, target);
  let seedFile = null;
  if (!node) {
    const normalized = String(target || '').replace(/\\/g, '/');
    const file = db.prepare(`
      SELECT id, relative_path FROM cg_files
      WHERE project_id = ? AND (relative_path = ? OR relative_path LIKE ?)
      ORDER BY LENGTH(relative_path) LIMIT 1
    `).get(projectId, normalized, `%${normalized.split('/').pop()}`);
    if (!file) return { ...empty, staleIndex: false };
    seedFile = file;
  }

  // 2. 反向依赖: 谁例化/调用了它 (含传递闭包)
  const seedNodes = node
    ? [node]
    : getNodesInFile(projectId, seedFile.relative_path).filter(n => n.kind === 'module');
  const downstream = reverseImpact(db, seedNodes.map(n => n.id), { depth, limit });

  // 3. 受影响文件集合 = 改动点自身 + 下游节点所在文件
  const files = new Set();
  if (seedFile) files.add(seedFile.relative_path);
  if (node?.file) files.add(node.file);
  for (const item of downstream) if (item.file) files.add(item.file);

  // 4. 跨域边: 证据 / 需求 / 记忆
  const graph = require('../sqlite/store-graph.cjs');
  const refs = [
    ...[...files].map(file => ['file', file]),
    ...downstream.map(item => ['code_node', item.id]),
    ...(node ? [['code_node', node.id]] : []),
  ];
  const edges = refs.length ? graph.neighborsOfMany(refs, { limit: 200 }) : [];

  const staleEvidence = [];
  const requirements = [];
  const relatedFacts = [];
  const gates = new Set();

  for (const edge of edges) {
    if (edge.rel === 'proves' && edge.src.kind === 'evidence') {
      staleEvidence.push({
        evidenceSha: edge.src.id,
        target: edge.dst.id,
        command: edge.metadata?.command || null,
        recordedAt: edge.metadata?.recordedAt || null,
      });
      if (edge.metadata?.gate) gates.add(edge.metadata.gate);
    } else if (edge.rel === 'traces_to' && edge.src.kind === 'requirement') {
      requirements.push({ requirement: edge.src.id, target: edge.dst.id, gate: edge.metadata?.gate || null });
      if (edge.metadata?.gate) gates.add(edge.metadata.gate);
    } else if (edge.rel === 'recalled_for' && edge.src.kind === 'fact') {
      relatedFacts.push({ factId: edge.src.id, confidence: edge.confidence, target: edge.dst.id });
    } else if (edge.rel === 'verifies' && edge.dst.kind === 'gate') {
      gates.add(edge.dst.id);
    }
  }

  return {
    target: node || { kind: 'file', name: seedFile.relative_path, file: seedFile.relative_path },
    staleIndex: false,
    staleReason: null,
    downstream: downstream.slice(0, limit),
    files: [...files],
    staleEvidence,
    gatesToRerun: [...gates],
    requirements,
    relatedFacts,
  };
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function tryJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const projectId = args[1];
  const query = args[2];

  switch (cmd) {
    case 'search':
      console.log(JSON.stringify(searchNodes(query, { projectId, limit: 10 }), null, 2));
      break;
    case 'node':
      console.log(JSON.stringify(getNode(projectId, query), null, 2));
      break;
    case 'callers':
      console.log(JSON.stringify(getCallers(projectId, query, { maxDepth: 3 }), null, 2));
      break;
    case 'callees':
      console.log(JSON.stringify(getCallees(projectId, query, { maxDepth: 3 }), null, 2));
      break;
    case 'explore': {
      const names = args.slice(2);
      console.log(JSON.stringify(getSubgraphByNames(projectId, names, { maxDepth: 1 }), null, 2));
      break;
    }
    case 'blast':
      console.log(JSON.stringify(getBlastRadius(projectId, query, { depth: 3 }), null, 2));
      break;
    default:
      console.error('用法: node cg-queries.cjs <search|node|callers|callees|explore> <projectId> [query...]');
  }
}

if (require.main === module) main();

module.exports = {
  resolveProject,
  canonicalRootPath,
  projectKey,
  indexFreshness,
  getProjectStats,
  searchNodes,
  getNode,
  getNodesByKind,
  getNodesInFile,
  getIncomingEdges,
  getOutgoingEdges,
  getCallers,
  getCallees,
  getSubgraphByNames,
  getBlastRadius,
};
