#!/usr/bin/env node
/**
 * engine/scripts/cross-link-memory.cjs — L2↔L4 交叉联动: 挫败→记忆检索
 *
 * 当挫败检测器标记高失败计数时，自动从 memory/errors/ 和
 * memory/learnings/ 检索相关经验，注入到 Claude 上下文。
 *
 * 这解决了"AI 失败时不知道查历史经验"的问题。
 *
 * 触发条件:
 *   PostMessage 时 runtime-state failureCount >= 2
 *
 * 输出:
 *   - 最近 3 条 memory/errors/ 记录摘要
 *   - 最近 2 条 memory/learnings/ 记录摘要
 *
 * 注册:
 *   settings.local.json PostMessage (异步, 低开销)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOMEDIR = os.homedir();
const HARNESS = path.join(HOMEDIR, '.claude');
const STATE_FILE = path.join(HARNESS, 'var', 'index', 'runtime-state.json');

function readJSON(fp) {
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) { console.error('[cross-link-memory] 错误:', e.message); }
  return null;
}

// ── 构建 FTS5 检索查询 ──────────────────────────────────────────────────────

/**
 * 从挫败上下文构建检索查询词。
 * 优先级: 当前模式 > 失败次数 > 通用查询
 */
function buildQuery(state) {
  if (!state) return '挫败 错误 失败';
  const parts = [];
  if (state.currentMode) parts.push(state.currentMode);
  if (state.failureCount >= 5) parts.push('循环 绕圈 卡住');
  if (state.failureCount >= 3) parts.push('失败 挫败');
  if (state.lastTool) parts.push(state.lastTool);
  parts.push('错误 教训 经验');
  return parts.join(' ');
}

// ── 触发条件判断 ──────────────────────────────────────────────────────────────

/**
 * 判断是否应该触发记忆交叉检索。
 * 主要条件: failureCount >= 2
 * 次要条件: 最近 15 分钟内有 failureHistory 记录（即使 de-escalation 已复位计数）
 */
function shouldTrigger(state) {
  if (!state) return false;

  // 主要: failureCount 直接 >= 2
  if ((state.failureCount || 0) >= 2) return true;

  // 次要: 最近 15 分钟内有挫败历史（补偿 frustration-detector 的 de-escalation 复位）
  if (state.failureHistory && Array.isArray(state.failureHistory)) {
    const recentWindow = Date.now() - 15 * 60 * 1000; // 15 分钟前
    const recentFailures = state.failureHistory.filter(f => {
      const at = new Date(f.at).getTime();
      return at >= recentWindow;
    });
    if (recentFailures.length >= 2) return true;

    // 特殊情况: 最近 30 分钟内有 >=3 次挫败但计数被复位
    const thirtyMinWindow = Date.now() - 30 * 60 * 1000;
    const totalRecent = state.failureHistory.filter(f =>
      new Date(f.at).getTime() >= thirtyMinWindow
    );
    if (totalRecent.length >= 3) return true;
  }

  return false;
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

function evaluate() {
  const state = readJSON(STATE_FILE);
  if (!shouldTrigger(state)) return null;

  const query = buildQuery(state);

  // 改用 SQLite FTS5 BM25 检索（替代原文件系统按 mtime 排序）
  try {
    const { openDb } = require('../sqlite/index.cjs');
    const { retrieveMemory } = require('../sqlite/store-memory.cjs');

    const wDb = openDb();

    // 从 errors 命名空间检索（挫败上下文查询）
    const errorResults = retrieveMemory(query, {
      db: wDb.db,
      namespaces: ['errors'],
      limit: 3,
      minConfidence: 0.3,
    });

    // 从 learnings 命名空间检索
    const learningsResults = retrieveMemory(query, {
      db: wDb.db,
      namespaces: ['learnings'],
      limit: 2,
      minConfidence: 0.4,
    });

    wDb.close();

    const errors = errorResults.map(r => ({
      name: r.name || '(unnamed)',
      desc: (r.description || r.content.slice(0, 120)).replace(/\n/g, ' '),
      score: Math.round(r.score * 100) / 100,
    }));

    const learnings = learningsResults.map(r => ({
      name: r.name || '(unnamed)',
      desc: (r.description || r.content.slice(0, 120)).replace(/\n/g, ' '),
      score: Math.round(r.score * 100) / 100,
    }));

    if (errors.length === 0 && learnings.length === 0) return null;

    return {
      source: 'cross-link-memory',
      type: 'memory-cross-ref',
      trigger: `failureCount=${state.failureCount}${state.failureHistory?.length > state.failureCount ? '+history' : ''}`,
      query,
      errors,
      learnings,
    };
  } catch (e) {
    console.error('[cross-link-memory] 错误:', e.message);
    return null;
  }
}

function main() {
  const result = evaluate();
  if (result) {
    // Emit signal: 记忆交叉检索事件
    try {
      const { emitSync } = require('../hooks/learning/signal-collector.cjs');
      emitSync('memory_cross_ref', {
        failureCount: result.errors?.length || 0,
        errorsFound: result.errors?.map(e => e.name) || [],
        learningsFound: result.learnings?.map(l => l.name) || [],
      });
    } catch (e) { console.error('[cross-link-memory] 错误:', e.message); }

    console.log(JSON.stringify(result));
  }
  // 无匹配 → 无输出 (0 token 开销)
}

if (require.main === module) {
  main();
}
