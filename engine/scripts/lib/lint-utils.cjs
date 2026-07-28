'use strict';

/**
 * engine/scripts/lib/lint-utils.cjs — Lint 工具共享库 (v2)。
 *
 * 被 pre-commit-lint.js 和 lint-auto-gate.js 共用。
 * 职责: 文件过滤 + EDA 工具链自适应 + 格式化输出。
 *
 * 增强 v2:
 *   - 自动检测系统中可用的 EDA 工具链
 *   - 如果 vlog 不可用，自动降级到 xvlog/verilator/iverilog
 *   - 每次 lint 操作有超时保护
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { detect, pickLintTool, withScratchCwd, resolveWin32Cmd } = require('../eda-detect.cjs');

// ── 常量 ──────────────────────────────────────────────────────────────────

const LINTABLE_EXTS = new Set(['.v', '.sv', '.py']);
const TIMEOUT_MS = 30000;

// ── 缓存检测结果（进程级，避免每次 lint 都重测） ──────────────────────────

let _cachedLintTool = null;

function getLintTool() {
  if (_cachedLintTool) return _cachedLintTool;

  const tools = detect({ quick: true });
  const tool = pickLintTool(tools);

  if (tool) {
    _cachedLintTool = tool;
    process.stderr.write(`[LintUtils] 检测到 lint 工具: ${tool.lintLabel}\n`);
  } else {
    _cachedLintTool = { name: 'vlog', lintCmd: (f) => ['-lint', f], lintLabel: 'vlog -lint' };
    process.stderr.write(`[LintUtils] 未检测到 EDA 工具，默认 vlog\n`);
  }

  return _cachedLintTool;
}

/**
 * 清除工具链缓存（用于测试）。
 */
function clearCache() {
  _cachedLintTool = null;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

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
 * 自动选择系统中可用的 EDA 工具链。
 *
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
    const tool = getLintTool();
    writeLog(`🔍 ${tool.lintLabel} ${filePath}`);

    // 走与版本探测同一条跨平台解析: win32 上 xvlog 实际是 xvlog.bat, 而 Node 不带
    // shell 无法执行 .bat —— 直接 spawnSync('xvlog') 一律 ENOENT, 这条 lint 从未真正跑过。
    const cmd = resolveWin32Cmd(tool.name);
    const needsShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd);
    // 子进程 CWD 移到临时目录, 避免 xsim 的 .pb/.log/xsim.dir 落进仓库(见 eda-detect.cjs)。
    // 相应地, 文件路径必须先按**当前** CWD 解析成绝对路径 ——
    // lint-auto-gate 传的是 git 输出的仓库相对路径, 原样传进去会找不到文件。
    const args = tool.lintCmd(path.resolve(filePath));
    const r = exec(
      needsShell ? `"${cmd}"` : cmd,
      // shell 模式下 Node 只做拼接不做转义, 含空格的路径必须自己加引号。
      needsShell ? args.map(a => (/\s/.test(a) ? `"${a}"` : a)) : args,
      withScratchCwd({ shell: needsShell }),
    );

    // 工具没跑起来 ≠ 代码有问题。ENOENT/超时的 status 是 null,
    // 旧代码 `status !== 0` 一刀切会把它判成 lint 失败, 且 stdout/stderr 都是空的 ——
    // 使用者只看到一个没有任何原因的 "✖ 失败", pre-commit 据此 exit 2 阻断提交。
    if (r.error || r.status === null) {
      writeLog(`╚════ ⚠ 工具未能执行（${r.error ? r.error.code : '超时'}），跳过，不判为失败`);
      return false;
    }

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
  clearCache,
  getLintTool,
};
