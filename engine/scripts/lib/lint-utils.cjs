'use strict';

/**
 * engine/scripts/lib/lint-utils.cjs — Lint 工具共享库。
 *
 * 被 pre-commit-lint.js 和 lint-auto-gate.js 共用。
 * 职责: 文件过滤 + vlog/ruff 调用 + 格式化输出。
 */

const { spawnSync } = require('child_process');
const path = require('path');

// ── 常量 ──────────────────────────────────────────────────────────────────

const LINTABLE_EXTS = new Set(['.v', '.sv', '.py']);
const TIMEOUT_MS = 30000;

// ── 工具函数 ───────────────────────────────────────────────────────────────

/** 带统一前缀的日志输出 */
function log(msg) {
  process.stderr.write(`[LintGate] ${msg}\n`);
}

/**
 * 执行外部命令（同步，超时保护）。
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function exec(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    ...opts,
  });
}

/**
 * 判断文件扩展名是否可被 lint。
 * @param {string} filePath
 * @returns {boolean}
 */
function isLintable(filePath) {
  return LINTABLE_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * 对单个文件运行 linter，输出结果到 stderr。
 * @param {string} filePath       — 相对路径（用于显示）
 * @param {string} [prefix]       — 日志前缀，默认 'LintGate'
 * @returns {boolean} true=有错误
 */
function lintFile(filePath, prefix) {
  const tag = prefix || 'LintGate';
  const ext = path.extname(filePath).toLowerCase();
  if (!LINTABLE_EXTS.has(ext)) return false;

  const writeLog = (msg) => process.stderr.write(`[${tag}] ${msg}\n`);

  if (ext === '.v' || ext === '.sv') {
    writeLog(`🔍 vlog -lint ${filePath}`);
    const r = exec('vlog', ['-lint', filePath]);
    if (r.status !== 0) {
      const out = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(0, 8);
      out.forEach(l => writeLog(`      ${l}`));
      writeLog(`╚════ ✖ 失败`);
      return true;
    }
    writeLog(`╚════ ✓ 通过`);
  } else if (ext === '.py') {
    writeLog(`🔍 ruff check ${filePath}`);
    const r = exec('ruff', ['check', '--quiet', filePath]);
    if (r.status !== 0) {
      const out = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(0, 8);
      out.forEach(l => writeLog(`      ${l}`));
      writeLog(`╚════ ✖ 失败`);
      return true;
    }
    writeLog(`╚════ ✓ 通过`);
  }

  return false;
}

module.exports = {
  LINTABLE_EXTS,
  TIMEOUT_MS,
  log,
  exec,
  isLintable,
  lintFile,
};
