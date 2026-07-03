#!/usr/bin/env node
/**
 * engine/scripts/context-resume.cjs — 压缩后上下文恢复
 *
 * 在 /compact 后执行，读取 pre-compact 保存的状态，
 * 向当前上下文注入关键信息，确保压缩后不丢失进度。
 *
 * 用法:
 *   node engine/scripts/context-resume.cjs          — 输出恢复摘要到 stdout
 *   node engine/scripts/context-resume.cjs --inject  — 输出 JSON 供 hook 注入
 *   node engine/scripts/context-resume.cjs --check   — 仅检查是否有可恢复的状态
 *
 * 整合:
 *   与 engine/hooks/session/pre-compact.cjs 配对使用。
 *   pre-compact save → /compact → context-resume → 继续工作
 */

'use strict';

const p = require('node:path');
const f = require('node:fs');
const os = require('node:os');
const scope = require('./lib/project-scope.cjs');

const HOME = p.join(os.homedir(), '.claude');
const STATE_FILE = p.join(HOME, 'var', 'index', 'pre-compact-state.json');
const HOME_ROOT = HOME;

function normalizePath(value) {
  return scope.keyPath(value);
}

function isSamePath(a, b) {
  return scope.isSamePath(a, b);
}

function isInsidePath(child, parent) {
  return scope.isInsidePath(child, parent);
}

function snapshotRoot(snapshot) {
  return snapshot?.projectRoot || snapshot?.workspaceRoot || snapshot?.cwd || '';
}

function shouldInjectForCwd(snapshot, cwd) {
  const root = snapshotRoot(snapshot);
  if (root) return isInsidePath(cwd, root);

  // Legacy snapshots have no scope. They are only safe at the harness root.
  return isSamePath(cwd, HOME_ROOT);
}

/**
 * 读取 pre-compact 保存的状态。
 * @returns {object|null}
 */
function readSnapshot() {
  try {
    if (f.existsSync(STATE_FILE)) {
      return JSON.parse(f.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* 静默降级 */ }
  return null;
}

/**
 * 生成人类可读的状态摘要。
 * @param {object} snapshot
 * @returns {string}
 */
function formatSummary(snapshot) {
  if (!snapshot) return '⚠️ 没有可恢复的上下文状态。';

  const lines = [];
  lines.push('━'.repeat(40));
  lines.push('📋 上下文恢复 — 压缩前状态摘要');
  lines.push('━'.repeat(40));

  if (snapshot.currentMode) {
    lines.push('  推理模式: ' + snapshot.currentMode);
  }

  if (snapshot.spawnedAgents && snapshot.spawnedAgents.length > 0) {
    lines.push('  活跃子Agent: ' + snapshot.spawnedAgents.length + ' 个');
    for (const a of snapshot.spawnedAgents) {
      lines.push('    - ' + a.agentType + ' (tier: ' + (a.tier || 'unknown') + ')');
    }
  }

  if (snapshot.cognitive) {
    if (snapshot.cognitive.currentHypothesis) {
      lines.push('  当前假设: ' + snapshot.cognitive.currentHypothesis);
    }
    if (snapshot.cognitive.triedApproaches && snapshot.cognitive.triedApproaches.length > 0) {
      lines.push('  已尝试的方法: ' + snapshot.cognitive.triedApproaches.join(', '));
    }
  }

  if (snapshot.failureCount && snapshot.failureCount > 0) {
    lines.push('  失败计数: ' + snapshot.failureCount + ' 次');
  }

  if (snapshot.pressureFlags && snapshot.pressureFlags.length > 0) {
    lines.push('  压力标志: ' + snapshot.pressureFlags.join(', '));
  }

  lines.push('');
  lines.push('  保存时间: ' + (snapshot.savedAt ? new Date(snapshot.savedAt).toLocaleString('zh-CN') : '未知'));
  lines.push('━'.repeat(40));
  lines.push('  提示：在 scratchpad 顶部恢复"已完成"日志和关键决策。');
  lines.push('  如果这是跨 session 恢复，优先查看 memory/ 中的项目约定。');
  lines.push('━'.repeat(40));

  return lines.join('\n');
}

/**
 * 生成格式化的注入字符串 (供 hook 或 system prompt 注入)。
 * @param {object} snapshot
 * @returns {string}
 */
function formatInjectPrompt(snapshot) {
  if (!snapshot) return '';

  const parts = [];

  if (snapshot.currentMode) {
    parts.push('压缩前推理模式: ' + snapshot.currentMode);
  }
  if (snapshot.spawnedAgents && snapshot.spawnedAgents.length > 0) {
    const types = snapshot.spawnedAgents.map(function(a) { return a.agentType; }).join(', ');
    parts.push('压缩前活跃 Agent: ' + types);
  }
  if (snapshot.failureCount && snapshot.failureCount > 0) {
    parts.push('注意: 压缩前有 ' + snapshot.failureCount + ' 次失败记录，避免重复试错');
  }

  return parts.length > 0
    ? '[上下文恢复] ' + parts.join('; ') + '。请参考"已完成"日志继续工作。'
    : '';
}

/**
 * 主入口。
 * @returns {object} { hasState, summary, injectPrompt }
 */
function resume() {
  const snapshot = readSnapshot();
  if (snapshot && !shouldInjectForCwd(snapshot, process.cwd())) {
    return {
      hasState: false,
      snapshot: null,
      summary: '',
      injectPrompt: '',
    };
  }
  return {
    hasState: !!snapshot,
    snapshot,
    summary: formatSummary(snapshot),
    injectPrompt: formatInjectPrompt(snapshot),
  };
}

// ── CLI ──

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--check')) {
    const snap = readSnapshot();
    if (snap) {
      console.log('✅ 有可恢复的上下文状态 (保存于 ' + snap.savedAt + ')');
      process.exit(0);
    } else {
      console.log('ℹ️  没有可恢复的上下文状态');
      process.exit(0);
    }
  }

  if (args.includes('--inject')) {
    const result = resume();
    if (result.injectPrompt) {
      console.log(JSON.stringify({
        source: 'context-resume',
        type: 'context-restore',
        injectPrompt: result.injectPrompt,
        summary: result.summary,
      }));
    } else {
      console.log(JSON.stringify({ source: 'context-resume', type: 'context-restore', injectPrompt: '', summary: '无状态' }));
    }
    process.exit(0);
  }

  // 默认: 输出人类可读摘要
  const result = resume();
  console.log(result.summary);
}

if (require.main === module) {
  main();
}

module.exports = { resume, readSnapshot, formatSummary, formatInjectPrompt };
