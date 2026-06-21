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

// 代码图触发模式（当消息提到代码符号时也查 cg_nodes_fts）
const CG_TRIGGER_PATTERNS = [
  // HDL 相关
  /module/i, /instance/i, /signal/i, /port/i, /wire/i, /register/i,
  /模块/i, /实例/i, /信号/i, /端口/i, /例化/i, /例化名/i,
  // 代码探索相关
  /symbol/i, /definition/i, /who\s+(calls|uses|instantiates)/i,
  /where\s+(is|are|defined|declared)/i, /what.*calls/i,
  /符号/i, /定义/i, /声明/i, /查找.*符号/i, /调用.*关系/i,
  /harness_cg_/i, /code.?graph/i,
];

function shouldRetrieve(userMessage) {
  if (!userMessage || userMessage.length < 3) return false;
  return TRIGGER_PATTERNS.some(p => p.test(userMessage));
}

function main() {
  const msg = process.env.CLAUDE_USER_MESSAGE || '';
  if (!msg || msg.length < 3) return;

  const shouldQueryMemories = shouldRetrieve(msg);
  const shouldQueryCode = CG_TRIGGER_PATTERNS.some(p => p.test(msg));
  if (!shouldQueryMemories && !shouldQueryCode) return; // 无触发 → 0 token

  try {
    const { openDb } = require('../sqlite/index.cjs');
    let memResults = [];
    let codeResults = [];

    // ── 1. FTS5 记忆检索（原有逻辑） ──
    if (shouldQueryMemories) {
      try {
        const { retrieveMemorySummary } = require('../sqlite/store-memory.cjs');
        const wDb = openDb();
        memResults = retrieveMemorySummary(msg, {
          limit: 3, maxChars: 200, minConfidence: 0.3,
        });
        wDb.close();
      } catch { /* 静默 */ }
    }

    // ── 2. 代码图检索（新增） ──
    if (shouldQueryCode) {
      try {
        const { searchNodes, resolveProject } = require('./cg-queries.cjs');
        // 尝试从当前工作目录或 .claude 上级目录找项目
        const cwd = process.env.CLAUDE_CWD || process.cwd();
        let projId;
        try { projId = resolveProject(cwd).projectId; } catch { projId = null; }
        if (projId) {
          // 从自然语言查询中提取代码关键词（去噪声词）
          const codeQuery = msg
            .replace(/^(find|show|where|what|who|which|how|is|are|the|a|an|for|in|at|of|to|with|does|did|can|could|will|would|has|have|been|get|list|search|locate)\s+/gi, '')
            .replace(/\b(module|instance|signal|port|symbol|definition|declaration|caller|callee|references?|instantiates?)\s+/gi, '')
            .replace(/[^\w\s一-鿿_-]/g, ' ')
            .trim();
          if (codeQuery.length >= 2) {
            codeResults = searchNodes(codeQuery, { projectId: projId, limit: 3, maxChars: 150 });
          }
        }
      } catch { /* 静默 */ }
    }

    // ── 3. 合并输出 ──
    const outputParts = [];

    if (memResults.length > 0) {
      const matches = memResults.map(r => ({
        namespace: r.namespace,
        name: r.name || '(unnamed)',
        summary: r.summary,
        confidence: Math.round(r.confidence * 100) / 100,
      }));
      outputParts.push({ type: 'memory', matches });

      // P1-M2: wiki-link 解析
      let wikiLinks = null;
      try {
        const { resolveWikiLinks } = require('./resolve-wiki-links.cjs');
        const allText = matches.map(m => m.summary).join(' ');
        const refs = (allText.match(/\[\[([^\]]+)\]\]/g) || []).map(r => r.slice(2, -2));
        if (refs.length > 0) {
          wikiLinks = resolveWikiLinks([...new Set(refs)]);
        }
      } catch { /* 静默 */ }
      if (wikiLinks?.resolved?.length > 0) {
        outputParts.push({ type: 'wiki-links', linkedMemories: wikiLinks.resolved.map(l => ({ name: l.name, file: l.file, summary: l.summary })) });
      }

      // 上报
      try {
        const { emitSync } = require('../hooks/learning/signal-collector.cjs');
        emitSync('memory_miss', {
          query: msg.slice(0, 40), hits: memResults.length,
          namespaces: [...new Set(memResults.map(r => r.namespace))],
        });
      } catch { /* 静默 */ }
    }

    if (codeResults.length > 0) {
      outputParts.push({
        type: 'code-graph',
        matches: codeResults.map(r => ({
          kind: r.kind, name: r.name, file: r.file,
          line: r.line, signature: (r.signature || '').slice(0, 100),
        })),
      });
    }

    if (outputParts.length > 0) {
      console.log(JSON.stringify({
        source: 'memory-retrieve-hook',
        type: 'hybrid-hint',
        trigger: shouldQueryCode && codeResults.length > 0 ? 'code+memory' : 'memory',
        query: msg.slice(0, 80),
        parts: outputParts,
      }));
    }
    // 无结果 → 无输出 (0 token)
  } catch {
    // 静默失败，不阻塞 hook 链
  }
}

if (require.main === module) {
  main();
}
