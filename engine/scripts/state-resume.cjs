#!/usr/bin/env node
/**
 * engine/scripts/state-resume.cjs — L3 交接增强: 跨 session 状态恢复
 *
 * 在 SessionStart 时读取 runtime-state.json，将前 session 的关键状态
 * （failureCount、currentMode、lastActivityAt）注入新 session 的上下文。
 *
 * 这解决了"Claude 启动时不知道自己上次 session 发生了什么"的问题。
 *
 * 注册:
 *   settings.local.json SessionStart
 *
 * 输出格式 (JSON 行):
 *   { source: "state-resume", type: "session-handoff", ... }
 *
 * 无 runtime-state 或为空 → 无输出 (0 token 开销)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const scope = require('./lib/project-scope.cjs');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const STATE_FILE = path.join(HARNESS_ROOT, 'var', 'index', 'runtime-state.json');
const TASK_FILE = path.join(HARNESS_ROOT, 'var', 'active-task.yaml');
const WORK_DIR = path.join(HARNESS_ROOT, 'memory', 'work');
const HOME_ROOT = HARNESS_ROOT;

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

function normalizePath(p) {
  return scope.keyPath(p);
}

function isSamePath(a, b) {
  return scope.isSamePath(a, b);
}

function isInsidePath(child, parent) {
  return scope.isInsidePath(child, parent);
}

function readTaskProjectRoot() {
  try {
    if (!fs.existsSync(TASK_FILE)) return '';
    const raw = fs.readFileSync(TASK_FILE, 'utf8');
    const match = raw.match(/^\s*(?:project_root|workspace_root|root|cwd)\s*:\s*["']?([^"'\r\n#]+)["']?/mi);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function shouldInjectForCwd(cwd) {
  const projectRoot = readTaskProjectRoot();
  if (projectRoot) {
    return isInsidePath(cwd, projectRoot);
  }

  // Legacy active-task.yaml has no project scope. Inject it only at the harness
  // root, not inside child workspaces/evals where it becomes stale context.
  return isSamePath(cwd, HOME_ROOT);
}

function main(opts = {}) {
  const state = readJSON(STATE_FILE);

  // 无 state 或新 session → 无输出
  if (!state || !state.sessionId || state.sessionId === 'unknown') {
    return;
  }

  // 检查是否与当前 session 相同
  const currentSessionId = process.env.CLAUDE_SESSION_ID || '';
  if (state.sessionId === currentSessionId) {
    // 同一 session 继续 → 不输出 handoff 摘要
    return;
  }

  if (!shouldInjectForCwd(process.cwd())) {
    return;
  }

  const lastActivity = state.lastActivityAt ? new Date(state.lastActivityAt + 'Z') : null;
  const now = new Date();
  const hoursSinceLast = lastActivity ? Math.round((now - lastActivity) / (1000 * 60 * 60)) : 0;

  const summary = {
    source: 'state-resume',
    type: 'session-handoff',
    previousSession: state.sessionId ? state.sessionId.slice(0, 8) + '...' : 'unknown',
    lastActivityAt: state.lastActivityAt,
    hoursSinceLastActivity: hoursSinceLast,
    previousFailureCount: state.failureCount || 0,
    previousMode: state.currentMode || '',
    // 活跃项目信息（从 active-task.yaml 提取）
    taskFileExists: fs.existsSync(TASK_FILE),
  };

  // 检查是否有 task YAML 可以读取
  let taskSummary = '';
  if (summary.taskFileExists) {
    try {
      const taskContent = fs.readFileSync(TASK_FILE, 'utf8');
      const firstLine = taskContent.split('\n').find(l => l.trim() && !l.trim().startsWith('#'));
      if (firstLine) taskSummary = firstLine.trim();
    } catch { /* ignore */ }
  }

  // 检查 active-task.yaml 是否陈旧
  let taskStale = false;
  if (summary.taskFileExists) {
    try {
      const taskMtime = fs.statSync(TASK_FILE).mtime;
      const daysSinceTaskUpdate = Math.round((now - taskMtime) / (1000 * 60 * 60 * 24));
      if (daysSinceTaskUpdate > 7) taskStale = true;
    } catch { /* ignore */ }
  }

  // Emit signal: session交接事件
  try {
    const { emitSync } = require('../hooks/learning/signal-collector.cjs');
    emitSync('session_handoff', {
      hoursSinceLast: summary.hoursSinceLastActivity,
      prevFailureCount: summary.previousFailureCount,
      prevMode: summary.previousMode,
      taskStale,
    });
  } catch { /* 静默 */ }

  // ── P2-m2: 工作记忆初始化 ─────────────────────────────────────────────
  let workMemory = null;
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const workFiles = fs.existsSync(WORK_DIR)
      ? fs.readdirSync(WORK_DIR).filter(f => f.startsWith(today) && f.endsWith('.md'))
      : [];

    if (workFiles.length === 0) {
      // 今日尚无工作记忆文件 → 从模板创建
      const templatePath = path.join(WORK_DIR, 'TEMPLATE.md');
      if (fs.existsSync(templatePath)) {
        let template = fs.readFileSync(templatePath, 'utf8');
        template = template.replace(/\{\{date\}\}/g, today);
        const newFile = path.join(WORK_DIR, `${today}-session.md`);
        fs.writeFileSync(newFile, template);
        workMemory = { file: `${today}-session.md`, created: true };
      }
    } else {
      workMemory = { file: workFiles[0], created: false };
    }
  } catch { /* 工作记忆初始化失败不阻塞 */ }

  const output = {
    ...summary,
    taskSummary,
    taskStale,
    ...(workMemory ? { workMemory } : {}),
    handoffBrief: hoursSinceLast > 24
      ? `上次活动在 ${hoursSinceLast} 小时前。前 session 失败 ${state.failureCount || 0} 次，最后模式为 ${state.currentMode || '闭环'}。${taskStale ? 'active-task.yaml 可能已过期。' : ''}`
      : `前 session 失败 ${state.failureCount || 0} 次，最后模式为 ${state.currentMode || '闭环'}。`,
  };
  if (opts.emit !== false) {
    const write = typeof opts.write === 'function' ? opts.write : console.log;
    write(JSON.stringify(output));
  }
  return output;
}

if (require.main === module) {
  main();
}

module.exports = { main };
