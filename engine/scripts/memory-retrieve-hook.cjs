#!/usr/bin/env node
/**
 * engine/scripts/memory-retrieve-hook.cjs — P0-B1: FTS5 记忆检索注入
 *
 * PreToolUse hook. 当用户消息命中记忆检索关键词时，自动查询 SQLite FTS5 BM25
 * 并将相关记忆摘要注入上下文。
 *
 * 工作原理:
 *   1. 读取 CLAUDE_USER_MESSAGE
 *   2. 检测记忆检索触发模式（查/搜/记得/error等）
 *   3. 调用 store-memory.cjs retrieveMemorySummary() 进行 FTS5 BM25 检索
 *   4. 输出 JSON 到 stdout，由 hook 框架注入上下文
 *
 * 与 rule-loader.cjs 的关系:
 *   rule-loader 负责注入规则级指令（"该用哪个规则"），
 *   memory-retrieve 负责注入经验级记忆（"之前遇到过什么"）。
 *   两者互补，分别处理 L1 和 L2 层。
 *
 * 设计约束:
 *   - 无关键词命中 → 无输出 (0 token 开销)
 *   - 检索结果为空 → 无输出
 *   - 只查 FTS5，不跑 4 引擎全量（全量留给需要时手动调用 memory-retrieve.sh）
 *   - SQLite 查询预计 <10ms
 *
 * 注册:
 *   settings.local.json PreToolUse matcher="*"
 *
 * 输出格式:
 *   {
 *     source: "memory-retrieve-hook",
 *     type: "memory-hint",
 *     trigger: "user:request",
 *     matches: [{ namespace, name, summary, confidence }]
 *   }
 */

'use strict';

const path = require('node:path');
const HARNESS = path.join(require('node:os').homedir(), '.claude');

// ── 触发模式 ────────────────────────────────────────────────────────────────
// 当用户消息匹配这些模式时触发 FTS5 检索
const TRIGGER_PATTERNS = [
  // 中文检索信号
  /查/i, /找/i, /搜/i, /记得/i, /参考/i, /经验/i, /教训/i,
  /为什么/i, /怎么(回|办|处)/i, /如何/, /什么原因/, /错误/, /报错/,
  /还记得/, /参考一下/, /查一下/, /搜一下/, /找一下/,
  /类似/, /同类/, /之前/, /上次/, /以前/,
  /推荐/, /建议/, /最佳/, /模板/, /模式/,
  // English
  /find/i, /search/i, /remember/i, /look\s*up/i, /reference/i,
  /error/i, /bug/i, /issue/i, /problem/i, /similar/i,
  /how\s+(to|do|does|can|is|are)/i, /why\s+(did|is|are|does)/i,
  /what\s+(was|is|about|does)/i, /have\s+you\s+seen/i,
  /best\s+practice/i, /lesson/i, /tip/i,
];

function shouldRetrieve(userMessage) {
  if (!userMessage || userMessage.length < 3) return false;
  return TRIGGER_PATTERNS.some(p => p.test(userMessage));
}

function main() {
  const msg = process.env.CLAUDE_USER_MESSAGE || '';
  if (!shouldRetrieve(msg)) return; // 无触发 → 0 token

  try {
    const { openDb } = require('../sqlite/index.cjs');
    const { retrieveMemorySummary } = require('../sqlite/store-memory.cjs');

    const wDb = openDb();
    const results = retrieveMemorySummary(msg, {
      limit: 3,
      maxChars: 200,
      minConfidence: 0.3,
    });
    wDb.close();

    if (results.length > 0) {
      const matches = results.map(r => ({
        namespace: r.namespace,
        name: r.name || '(unnamed)',
        summary: r.summary,
        confidence: Math.round(r.confidence * 100) / 100,
      }));

      // P1-M2: 解析结果摘要中的 wiki-link → 注入关联记忆上下文
      let wikiLinks = null;
      try {
        const { resolveWikiLinks, extractReferences } = require('./resolve-wiki-links.cjs');
        // 从所有摘要中提取 [[name]] 引用
        const allText = matches.map(m => m.summary).join(' ');
        const refs = (allText.match(/\[\[([^\]]+)\]\]/g) || []).map(r => r.slice(2, -2));
        if (refs.length > 0) {
          wikiLinks = resolveWikiLinks([...new Set(refs)]);
        }
      } catch { /* wiki-link 解析器不可用时不阻塞 */ }

      const output = {
        source: 'memory-retrieve-hook',
        type: 'memory-hint',
        trigger: 'user:request',
        query: msg.slice(0, 80),
        matches,
        ...(wikiLinks?.resolved?.length > 0 ? { linkedMemories: wikiLinks.resolved.map(l => ({ name: l.name, file: l.file, summary: l.summary })) } : {}),
      };

      // 通过 signal-collector 上报检索命中
      try {
        const { emitSync } = require('../hooks/learning/signal-collector.cjs');
        emitSync('memory_miss', {
          query: msg.slice(0, 40),
          hits: results.length,
          wikiResolved: wikiLinks?.resolved?.length || 0,
          namespaces: [...new Set(results.map(r => r.namespace))],
        });
      } catch { /* 静默 */ }

      console.log(JSON.stringify(output));
    }
    // 无结果 → 无输出 (0 token)
  } catch {
    // 静默失败，不阻塞 hook 链
  }
}

if (require.main === module) {
  main();
}
