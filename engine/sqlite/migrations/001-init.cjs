'use strict';

/**
 * 001-init — 全系统初始表结构。
 *
 * 包含: 事实/记忆表, FTS5 全文搜索, 链接表, 运行时事件, 技能注册表, 成本记账。
 * 所有 CREATE 使用 IF NOT EXISTS, 幂等可重入。
 */
module.exports = {
  name: '001-init',

  up: `
    -- ── 事实表 (取代 memory/*.md 文件) ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS facts (
      id          TEXT PRIMARY KEY,
      namespace   TEXT NOT NULL DEFAULT 'learnings'
                    CHECK(namespace IN ('user','feedback','project','projects','reference','learnings','errors','archive')),
      name        TEXT,
      content     TEXT NOT NULL,
      description TEXT DEFAULT '',
      source      TEXT DEFAULT 'manual',
      confidence  REAL DEFAULT 0.5 CHECK(confidence >= 0.0 AND confidence <= 1.0),
      ttl_until   INTEGER,
      hit_count   INTEGER DEFAULT 0,
      last_hit_at INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- ── FTS5 全文搜索 (主检索路径) ──────────────────────────────────────────
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      name, content, description,
      content='facts',
      content_rowid='rowid',
      tokenize='unicode61'
    );

    -- FTS5 同步触发器: 保持 facts_fts 与 facts 表同步
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts (rowid, name, content, description)
      VALUES (new.rowid, new.name, new.content, new.description);
    END;

    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts (facts_fts, rowid, name, content, description)
      VALUES ('delete', old.rowid, old.name, old.content, old.description);
    END;

    CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts (facts_fts, rowid, name, content, description)
      VALUES ('delete', old.rowid, old.name, old.content, old.description);
      INSERT INTO facts_fts (rowid, name, content, description)
      VALUES (new.rowid, new.name, new.content, new.description);
    END;

    -- ── 事实链接表 (取代 [[links]] 文本) ────────────────────────────────────
    CREATE TABLE IF NOT EXISTS fact_links (
      from_id    TEXT NOT NULL REFERENCES facts(id),
      to_id      TEXT NOT NULL REFERENCES facts(id),
      relation   TEXT DEFAULT 'related',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id)
    );

    -- ── 运行时事件 (Dream 自学习输入源) ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS runtime_events (
      event_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type       TEXT NOT NULL
                   CHECK(type IN ('drift_stuck','tool_fail','user_correct','hard_problem','memory_miss','skill_trigger','dream_output')),
      payload    TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON runtime_events(type);
    CREATE INDEX IF NOT EXISTS idx_events_session ON runtime_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON runtime_events(created_at);

    -- ── 运行时水印 (Dream 消费进度追踪) ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS runtime_watermark (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      watermark INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO runtime_watermark (id, watermark) VALUES (1, 0);

    -- ── 技能注册表 ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS skills (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      description     TEXT DEFAULT '',
      tier            TEXT NOT NULL DEFAULT 'on-demand'
                        CHECK(tier IN ('core','on-demand','quarantine','tombstone')),
      trigger_count   INTEGER DEFAULT 0,
      success_count   INTEGER DEFAULT 0,
      last_triggered_at INTEGER,
      created_at      INTEGER NOT NULL
    );

    -- ── 技能触发事件 ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS skill_triggers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id      TEXT NOT NULL REFERENCES skills(id),
      matched_query TEXT NOT NULL,
      success       INTEGER,
      duration_ms   INTEGER,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_triggers_skill ON skill_triggers(skill_id);
    CREATE INDEX IF NOT EXISTS idx_skill_triggers_created ON skill_triggers(created_at);

    -- ── 成本记账 ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      phase       TEXT DEFAULT 'general',
      tokens_in   INTEGER DEFAULT 0,
      tokens_out  INTEGER DEFAULT 0,
      cost_credits REAL DEFAULT 0,
      notes       TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_ledger(session_id);

    -- ── 事实的 FTS5 内容同步触发器 (content 同步更新) ─────────────────────
    -- 这个 AFTER UPDATE 已经涵盖了 content 变更, 上面 facts_au 已经做 delete+insert

    -- ── 默认技能种子数据 ────────────────────────────────────────────────────
    INSERT OR IGNORE INTO skills (id, name, description, tier, created_at)
    VALUES
      ('sk_hdl_coding',     'hdl-coding',     'HDL 编码规范 — Verilog/SystemVerilog FPGA 设计', 'core',       strftime('%s','now') * 1000),
      ('sk_tdd',            'tdd',            '测试驱动开发',                                    'core',       strftime('%s','now') * 1000),
      ('sk_debugging',      'debugging',      '系统化调试 — 4 阶段根因分析',                     'core',       strftime('%s','now') * 1000),
      ('sk_code_review',    'code-review',    '代码审查统一入口',                                'core',       strftime('%s','now') * 1000),
      ('sk_rag_skill',      'rag-skill',      '知识库检索问答',                                  'core',       strftime('%s','now') * 1000),
      ('sk_git_expert',     'git-expert',     'Git 操作专家',                                   'core',       strftime('%s','now') * 1000),
      ('sk_handoff',        'handoff',        'Session 收尾仪式',                               'core',       strftime('%s','now') * 1000),
      ('sk_start',          'start',          'Session 开局仪式',                               'core',       strftime('%s','now') * 1000),
      ('sk_project_init',   'project-init',   'FPGA 项目/模块脚手架',                            'core',       strftime('%s','now') * 1000),
      ('sk_doc_gen',        'doc-gen',        '文档生成',                                       'on-demand',  strftime('%s','now') * 1000),
      ('sk_security_review','security-review','安全审查',                                       'on-demand',  strftime('%s','now') * 1000),
      ('sk_doc_gen_rtl',    'rtl-gen',        'RTL 快速代码生成',                               'on-demand',  strftime('%s','now') * 1000)
  `,
};
