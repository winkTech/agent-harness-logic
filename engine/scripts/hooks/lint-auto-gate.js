#!/usr/bin/env node
/**
 * Stop Hook: Lint Auto Gate
 *
 * 响应结束时自动对修改过的 .v/.sv/.py 文件运行 linter。
 *   - .v / .sv → vlog -lint
 *   - .py       → ruff check
 *
 * 非阻断（Stop hook）——仅报告警告。
 * 跨平台（Windows/macOS/Linux），依赖 git diff --name-only。
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const LINTABLE_EXTS = new Set(['.v', '.sv', '.py']);
const TIMEOUT_MS = 30000;

function log(msg) {
  process.stderr.write(`[LintGate] ${msg}\n`);
}

function exec(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    ...opts,
  });
}

/**
 * 获取工作树中已修改但未暂存的文件列表。
 * @returns {string[]}
 */
function getModifiedFiles() {
  // 已修改（未暂存）+ 未跟踪（新建）
  const r1 = exec('git', ['diff', '--name-only']);
  const r2 = exec('git', ['ls-files', '--others', '--exclude-standard']);
  const modified = r1.status === 0 ? r1.stdout.trim().split('\n').filter(Boolean) : [];
  const untracked = r2.status === 0 ? r2.stdout.trim().split('\n').filter(Boolean) : [];
  return [...modified, ...untracked];
}

/**
 * 对单个文件运行 linter。
 * @param {string} filePath
 */
function lintFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!LINTABLE_EXTS.has(ext)) return;
  if (!filePath || !spawnSync('git', ['ls-files', '--error-unmatch', filePath],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 }).status !== 0) {
    // 文件不在 git 中 — 跳过
    return;
  }

  if (ext === '.v' || ext === '.sv') {
    log(`🔍 vlog -lint ${filePath}`);
    const r = exec('vlog', ['-lint', filePath]);
    if (r.status !== 0) {
      log(`╚════ ⚠ vlog 报告警告/错误:`);
      const out = (r.stderr || r.stdout || '').split('\n').filter(Boolean);
      out.forEach(l => log(`      ${l}`));
    } else {
      log(`╚════ ✓ 通过`);
    }
  } else if (ext === '.py') {
    log(`🔍 ruff check ${filePath}`);
    const r = exec('ruff', ['check', '--quiet', filePath]);
    if (r.status !== 0) {
      log(`╚════ ⚠ ruff 报告错误:`);
      const out = (r.stderr || r.stdout || '').split('\n').filter(Boolean);
      out.forEach(l => log(`      ${l}`));
    } else {
      log(`╚════ ✓ 通过`);
    }
  }
}

function main() {
  try {
    const files = getModifiedFiles();
    const toLint = files.filter(f => LINTABLE_EXTS.has(path.extname(f).toLowerCase()));

    if (toLint.length === 0) return;

    log(`本轮修改涉及 ${toLint.length} 个可检查文件`);
    toLint.forEach(f => lintFile(f));
  } catch (e) {
    log(`跳过（${e.message}）`);
  }
  // Stop hook 始终 exit 0（非阻断）
  process.exit(0);
}

main();
