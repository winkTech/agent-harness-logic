'use strict';

/**
 * 012-unified-graph — 跨域图边 (graph engineering)。
 *
 * harness 里原本有四张互不相连的"图":
 *   代码图 cg_nodes/cg_edges、记忆图 facts/fact_links、DAG (只活在进程内存里)、
 *   证据账本 (var/verification-ledger.json, 纯文件)。
 * 于是没法回答一个最要紧的问题: **改这个模块, 哪些证据失效、哪些门禁要重跑、
 * 哪条经验相关**。这张表就是把四者接起来的那条边。
 *
 * 边界: 域内边不动 —— cg_edges 继续管代码调用, fact_links 继续管记忆互链。
 * graph_edges 只存**跨域**边, 避免重写已经在跑的两套图。
 *
 * confidence 的语义: 1.0 = 机器可核对的事实 (证据条目指向哪个文件);
 * <1.0 = 启发式关联 (检索命中), 只能用于提示, 不得进认证链。
 */
module.exports = {
  name: '012-unified-graph',
  up: `
    CREATE TABLE IF NOT EXISTS graph_edges (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      src_kind   TEXT NOT NULL CHECK(src_kind IN
                 ('code_node','file','fact','evidence','gate','requirement','session','rule','cbb')),
      src_id     TEXT NOT NULL,
      dst_kind   TEXT NOT NULL CHECK(dst_kind IN
                 ('code_node','file','fact','evidence','gate','requirement','session','rule','cbb')),
      dst_id     TEXT NOT NULL,
      rel        TEXT NOT NULL CHECK(rel IN
                 ('proves','verifies','traces_to','recalled_for','certified_by','derived_from','covers')),
      confidence REAL NOT NULL DEFAULT 1.0,
      provenance TEXT NOT NULL,
      project_id TEXT,
      metadata   TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(src_kind, src_id, dst_kind, dst_id, rel)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(src_kind, src_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(dst_kind, dst_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_rel ON graph_edges(rel, project_id);
  `,
};
