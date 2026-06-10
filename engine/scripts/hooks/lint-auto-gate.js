#!/usr/bin/env node
/**
 * Stop Hook: Lint Auto Gate
 *
 * 响应结束时自动对修改过的 .v/.sv/.py 文件运行 linter。
 * 非阻断（Stop hook）——仅报告警告。
 * 跨平台，依赖 git diff --name-only。
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { LINTABLE_EXTS, TIMEOUT_MS, isLintable, lintFile } = require('../lib/lint-utils.cjs');

const PREFIX = 'LintGate';

function log(msg) {
  process.stderr.write(`[${PREFIX}] ${msg}\n`);
}

/**
 * 获取工作树中已修改但未暂存的文件列表。
 * @returns {string[]}
 */
function getModifiedFiles() {
  const r1 = spawnSync('git', ['diff', '--name-only'], {
    encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true,
  });
  const r2 = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true,
  });
  const modified = r1.status === 0 ? r1.stdout.trim().split('\n').filter(Boolean) : [];
  const untracked = r2.status === 0 ? r2.stdout.trim().split('\n').filter(Boolean) : [];
  return [...modified, ...untracked];
}

function main() {
  try {
    const files = getModifiedFiles();
    const toLint = files.filter(isLintable);

    if (toLint.length === 0) return;

    log(`本轮修改涉及 ${toLint.length} 个可检查文件`);
    toLint.forEach(f => lintFile(f, PREFIX));
  } catch (e) {
    log(`跳过（${e.message}）`);
  }
  // Stop hook 始终 exit 0（非阻断）
  process.exit(0);
}

main();
