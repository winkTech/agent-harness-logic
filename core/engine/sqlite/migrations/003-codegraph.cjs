'use strict';

/**
 * 003-codegraph — 代码图符号表 + 关系图 + FTS5 全文搜索。
 *
 * 与 memory.db 共存（facts 表独立不重叠）, cg_ 前缀隔离。
 * 支持多项目独立存储。
 *
 * 表清单:
 *   cg_projects     — 注册的项目根路径
 *   cg_files        — 已索引的文件（哈希用于增量检测）
 *   cg_nodes        — 符号节点（模块/端口/信号/实例/函数…）
 *   cg_edges        — 关系边（包含/调用/例化/引用…）
 *   cg_nodes_fts    — FTS5 全文搜索
 *   cg_unresolved   — 跨文件待解析引用
 */
module.exports = {
  name: '003-codegraph',

  up: `
    -- ── 0. 项目表 ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS cg_projects (
      id            TEXT PRIMARY KEY,        -- sha256(absolute_path)[:16]
      root_path     TEXT NOT NULL UNIQUE,
      name          TEXT,                    -- basename
      indexed_at    INTEGER,                 -- unix ms
      file_count    INTEGER DEFAULT 0,
      node_count    INTEGER DEFAULT 0,
      edge_count    INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL         -- unix ms
    );

    -- ── 1. 文件表（增量同步依据） ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS cg_files (
      id            TEXT PRIMARY KEY,        -- sha256(project_id + rel_path)[:16]
      project_id    TEXT NOT NULL REFERENCES cg_projects(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      language      TEXT NOT NULL DEFAULT 'unknown',
      content_hash  TEXT,                    -- sha256(前4096字节) + "_" + mtime
      size_bytes    INTEGER DEFAULT 0,
      modified_at   INTEGER,                -- 文件 mtime (unix ms)
      indexed_at    INTEGER,
      UNIQUE(project_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_cg_files_project ON cg_files(project_id);

    -- ── 2. 符号节点 ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS cg_nodes (
      id              TEXT PRIMARY KEY,      -- sha256(project_id + "::" + qualified_name + start_line)[:16]
      project_id      TEXT NOT NULL REFERENCES cg_projects(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL,         -- module|port|signal|instance|function|task|always|assign|parameter|interface|package|generate|assertion
      name            TEXT NOT NULL,
      qualified_name  TEXT,                  -- top::sub::inst 层次路径
      file_id         TEXT NOT NULL REFERENCES cg_files(id) ON DELETE CASCADE,
      start_line      INTEGER,
      end_line        INTEGER,
      signature       TEXT,                  -- 端口列表/参数列表/信号宽度
      metadata        TEXT DEFAULT '{}',     -- JSON: {direction, width, type, always_type, ...}
      visibility      TEXT DEFAULT 'local'   -- local|exported|public
    );
    CREATE INDEX IF NOT EXISTS idx_cg_nodes_project ON cg_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_cg_nodes_kind ON cg_nodes(project_id, kind);
    CREATE INDEX IF NOT EXISTS idx_cg_nodes_name ON cg_nodes(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_cg_nodes_qualified ON cg_nodes(project_id, qualified_name);
    CREATE INDEX IF NOT EXISTS idx_cg_nodes_file ON cg_nodes(file_id);

    -- ── 3. 关系边 ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS cg_edges (
      id            TEXT PRIMARY KEY,        -- sha256(source_id + target_id + kind)[:16]
      project_id    TEXT NOT NULL REFERENCES cg_projects(id) ON DELETE CASCADE,
      source_id     TEXT NOT NULL REFERENCES cg_nodes(id) ON DELETE CASCADE,
      target_id     TEXT NOT NULL REFERENCES cg_nodes(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,           -- contains|calls|instantiates|references|imports|reads|writes|extends
      line          INTEGER,
      provenance    TEXT DEFAULT 'regex',    -- regex|heuristic|manual|ast
      metadata      TEXT DEFAULT '{}'        -- JSON
    );
    CREATE INDEX IF NOT EXISTS idx_cg_edges_project ON cg_edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_cg_edges_source ON cg_edges(source_id, kind);
    CREATE INDEX IF NOT EXISTS idx_cg_edges_target ON cg_edges(target_id, kind);

    -- ── 4. FTS5 全文搜索 ──────────────────────────────────────────
    CREATE VIRTUAL TABLE IF NOT EXISTS cg_nodes_fts USING fts5(
      name, qualified_name, signature,
      content='cg_nodes',
      content_rowid='rowid',
      tokenize='unicode61',
      prefix='2 3 4'
    );

    -- FTS5 同步触发器
    CREATE TRIGGER IF NOT EXISTS cg_nodes_ai AFTER INSERT ON cg_nodes BEGIN
      INSERT INTO cg_nodes_fts (rowid, name, qualified_name, signature)
      VALUES (new.rowid, new.name, new.qualified_name, new.signature);
    END;

    CREATE TRIGGER IF NOT EXISTS cg_nodes_ad AFTER DELETE ON cg_nodes BEGIN
      INSERT INTO cg_nodes_fts (cg_nodes_fts, rowid, name, qualified_name, signature)
      VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature);
    END;

    CREATE TRIGGER IF NOT EXISTS cg_nodes_au AFTER UPDATE ON cg_nodes BEGIN
      INSERT INTO cg_nodes_fts (cg_nodes_fts, rowid, name, qualified_name, signature)
      VALUES ('delete', old.rowid, old.name, old.qualified_name, old.signature);
      INSERT INTO cg_nodes_fts (rowid, name, qualified_name, signature)
      VALUES (new.rowid, new.name, new.qualified_name, new.signature);
    END;

    -- ── 5. 跨文件待解析引用 ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS cg_unresolved (
      id              TEXT PRIMARY KEY,      -- sha256(project_id + file_id + name + line)[:16]
      project_id      TEXT NOT NULL REFERENCES cg_projects(id) ON DELETE CASCADE,
      file_id         TEXT NOT NULL REFERENCES cg_files(id) ON DELETE CASCADE,
      source_node_id  TEXT,                  -- 发出引用的节点（可为 NULL）
      name            TEXT NOT NULL,         -- 被引用的符号名
      kind            TEXT DEFAULT 'unknown',-- 预期类型
      line            INTEGER,
      context         TEXT,                  -- 周围的代码片段
      resolved_node_id TEXT,                 -- 解析后指向 cg_nodes.id
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cg_unresolved_project ON cg_unresolved(project_id);
    CREATE INDEX IF NOT EXISTS idx_cg_unresolved_name ON cg_unresolved(project_id, name);
  `,
};
