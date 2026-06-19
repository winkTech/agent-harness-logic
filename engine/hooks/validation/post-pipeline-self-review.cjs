#!/usr/bin/env node
/**
 * Hook: post-pipeline-self-review.cjs
 *
 * PostToolUse hook: 在文件修改操作(Write/Edit/Bash)后运行轻量级自审。
 *
 * 检查项:
 *   1. 语法检查 — 对修改的文件检测明显的语法错误
 *   2. 残留调试输出 — 检测 $display / console.log 等调试语句
 *   3. 完成度检查 — 检查是否有 TODO/FIXME/HACK 标记
 *
 * 仅检查最近修改的文件（通过 git diff 或状态跟踪）。
 * 输出 JSON 到 stderr 供框架捕获。
 *
 * 注册 (hook-config.json):
 *   "validation/post-pipeline-self-review.cjs": { enabled: true, frequency: "medium", ... }
 */

'use strict';

const p = require('node:path');
const f = require('node:fs');
const { execSync } = require('node:child_process');

const HOME = p.join(require('node:os').homedir(), '.claude');
const REVIEW_FILE = p.join(HOME, 'var', 'index', 'self-review-state.json');

// 检查间隔：记录上次检查的文件列表，避免重复检查
const CHECK_INTERVAL_MS = 30_000;

const DEBUG_PATTERNS = [
  { pattern: /console\.log\(/, fileExt: /\.(js|cjs|mjs)$/, label: 'console.log' },
  { pattern: /\$display\(/, fileExt: /\.(sv|v|vh)$/, label: '$display' },
  { pattern: /\$monitor\(/, fileExt: /\.(sv|v|vh)$/, label: '$monitor' },
  { pattern: /\/\/\s*TODO/, fileExt: /\.(sv|v|vh|js|cjs|py)$/, label: 'TODO (需确认是否遗留)' },
  { pattern: /\/\/\s*FIXME/, fileExt: /\.(sv|v|vh|js|cjs|py)$/, label: 'FIXME (需确认是否修复)' },
  { pattern: /\/\/\s*HACK/, fileExt: /\.(sv|v|vh|js|cjs|py)$/, label: 'HACK (需确认是否临时)' },
];

const SYNTAX_CHECK = [
  { ext: '.cjs', cmd: function(file) { return 'node -c "' + file + '" 2>&1'; } },
  { ext: '.js', cmd: function(file) { return 'node -c "' + file + '" 2>&1'; } },
];

/**
 * 读取审查状态。
 */
function readReviewState() {
  try {
    if (f.existsSync(REVIEW_FILE)) {
      return JSON.parse(f.readFileSync(REVIEW_FILE, 'utf8'));
    }
  } catch { /* 静默降级 */ }
  return { lastCheckAt: null, checkedFiles: [], recentFiles: [] };
}

/**
 * 写入审查状态。
 */
function writeReviewState(state) {
  try {
    const dir = p.dirname(REVIEW_FILE);
    if (!f.existsSync(dir)) f.mkdirSync(dir, { recursive: true });
    f.writeFileSync(REVIEW_FILE, JSON.stringify(state), 'utf8');
  } catch { /* 静默降级 */ }
}

/**
 * 获取最近修改的文件列表（通过 git diff 或 mtime 对比）。
 * @returns {string[]}
 */
function getRecentFiles() {
  try {
    const result = execSync('git diff --name-only --diff-filter=M HEAD 2>/dev/null', {
      cwd: HOME,
      encoding: 'utf8',
      timeout: 5000,
    });
    return result.split('\n').filter(Boolean).map(function(f) { return p.join(HOME, f); });
  } catch {
    // 不是 git 仓库或 git 命令失败，使用文件系统时间
    return [];
  }
}

/**
 * 对单个文件执行语法检查。
 * @param {string} filePath
 * @returns {string|null} 错误信息，无错误返回 null
 */
function checkSyntax(filePath) {
  for (const check of SYNTAX_CHECK) {
    if (filePath.endsWith(check.ext)) {
      try {
        const cmd = check.cmd(filePath);
        execSync(cmd, { timeout: 5000, encoding: 'utf8' });
      } catch (e) {
        return (e.stderr || e.stdout || '语法检查失败').trim();
      }
    }
  }
  return null;
}

/**
 * 对单个文件检查残留调试输出。
 * @param {string} filePath
 * @returns {string[]} 发现的问题列表
 */
function checkDebugOutput(filePath) {
  try {
    if (!f.existsSync(filePath)) return [];
    const content = f.readFileSync(filePath, 'utf8');
    const issues = [];

    for (const dp of DEBUG_PATTERNS) {
      if (dp.fileExt.test(filePath) && dp.pattern.test(content)) {
        issues.push('发现 ' + dp.label + '（文件: ' + p.basename(filePath) + '）');
      }
    }

    return issues;
  } catch { return []; }
}

/**
 * 主入口。
 * @param {object} [toolUse]
 * @param {object} [context]
 */
function main(toolUse, context) {
  try {
    const toolName = (toolUse && toolUse.name) || '';
    const prodTools = ['Write', 'Edit', 'Bash'];

    // 只对写操作后进行检查
    if (!prodTools.includes(toolName)) return;

    // 检查时间间隔，避免频繁检查
    const state = readReviewState();
    const now = Date.now();
    if (state.lastCheckAt && (now - state.lastCheckAt) < CHECK_INTERVAL_MS) return;

    const recentFiles = getRecentFiles();
    if (recentFiles.length === 0) return;

    state.lastCheckAt = now;
    state.recentFiles = recentFiles;

    const findings = [];

    // 语法检查
    for (const file of recentFiles) {
      const err = checkSyntax(file);
      if (err) {
        findings.push({ file: p.basename(file), type: 'syntax', detail: err });
      }
    }

    // 调试输出检查
    for (const file of recentFiles) {
      const issues = checkDebugOutput(file);
      for (const issue of issues) {
        findings.push({ file: p.basename(file), type: 'debug_output', detail: issue });
      }
    }

    state.checkedFiles = recentFiles;
    writeReviewState(state);

    if (findings.length > 0) {
      console.error(JSON.stringify({
        source: 'post-pipeline-self-review',
        type: 'self-review',
        findings: findings,
        message: '自审查发现 ' + findings.length + ' 个问题:\n'
          + findings.map(function(f) { return '  - [' + f.type + '] ' + f.file + ': ' + f.detail; }).join('\n'),
        filesChecked: recentFiles.length,
      }));
    }

  } catch { /* 静默降级 */ }
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'check') {
    main({ name: 'Write' });
  } else if (cmd === 'status') {
    const state = readReviewState();
    console.log('Self-review state:');
    console.log('  Last check:', state.lastCheckAt ? new Date(state.lastCheckAt).toISOString() : 'never');
    console.log('  Files checked:', state.checkedFiles ? state.checkedFiles.length : 0);
    console.log('  Recent files:', state.recentFiles ? state.recentFiles.join(', ') : 'none');
  } else {
    console.error('用法: node post-pipeline-self-review.cjs [check|status]');
  }
}

module.exports = { main, checkSyntax, checkDebugOutput };
