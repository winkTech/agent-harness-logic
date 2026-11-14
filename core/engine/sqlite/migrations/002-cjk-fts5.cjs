'use strict';

/**
 * 002-cjk-fts5 — 重建 FTS5 表, 添加前缀索引以支持 CJK 查询。
 *
 * 问题:
 *   unicode61 tokenizer 将连续的中文字符视为一个 token, 导致 "卷积"
 *   无法匹配 token "卷积编码是一种技术"(精确匹配失败)。
 *   也没有前缀索引, `"term" *` 前缀查询无法工作。
 *
 * 变更:
 *   1. 重建 facts_fts, 添加 prefix='2 3 4' (为 2/3/4 字符前缀建索引)
 *   2. 同步触发器继承自 001-init, 无需重建 (DROP TABLE 不删触发器,
 *      SQLite 自动重新解析到新表)
 *   3. 从 facts 表重建 FTS5 索引
 *
 * 应用层配合:
 *   store-memory.cjs retrieveMemory() — 对纯中文词使用 `"词" *`
 *   前缀查询, 非中文词保持精确匹配。LIKE fallback 兜底。
 */
module.exports = {
  name: '002-cjk-fts5',

  up: `
    -- 1. 丢弃旧 FTS5 表 (包括全部 shadow 表与索引内容)
    DROP TABLE IF EXISTS facts_fts;

    -- 2. 重建 FTS5 表, 添加前缀索引
    --    prefix='2 3 4' = 为长度 2/3/4 的 token 前缀建索引,
    --    使 "卷积" * 这样的前缀查询可高效执行
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      name, content, description,
      content='facts',
      content_rowid='rowid',
      tokenize='unicode61',
      prefix='2 3 4'
    );

    -- 3. 从 facts 表重建全文索引
    --    注意: BEFORE INSERT/UPDATE/DELETE 触发器仍保留在 facts 表上,
    --    SQLite 会在下次触发时自动重新解析它们以引用新的 facts_fts。
    INSERT INTO facts_fts(rowid, name, content, description)
    SELECT rowid, name, content, description FROM facts;
  `,
};
