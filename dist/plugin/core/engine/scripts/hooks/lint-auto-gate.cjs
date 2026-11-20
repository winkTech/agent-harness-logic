#!/usr/bin/env node
/**
 * Stop Hook: Lint Auto Gate — 增强版
 *
 * 响应结束时自动对修改过的 .v/.sv/.py 文件运行 linter。
 * 非阻断（Stop hook）——仅报告警告。
 *
 * 增强:
 *   - 超时保护（30s，超时出 warning 不阻断）
 *   - 规模保护（最多 lint 20 个文件，超出报 "还有 N 个未检查"）
 *   - 跨平台，依赖 git diff --name-only
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { LINTABLE_EXTS, TIMEOUT_MS, isLintable, lintFile } = require('../lib/lint-utils.cjs');

const PREFIX = 'LintGate';

// 规模保护阈值
const MAX_LINT_FILES = 20;
// 超时保护（lint-utils.cjs 的 TIMEOUT_MS 已经是 30000）
const GLOBAL_TIMEOUT_MS = 35000;

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

    // 规模保护：最多检查 MAX_LINT_FILES 个
    const toCheck = toLint.slice(0, MAX_LINT_FILES);
    const remaining = toLint.length - toCheck.length;

    if (remaining > 0) {
      log(`⚠ 可检查文件过多，只 lint 前 ${MAX_LINT_FILES} 个（还有 ${remaining} 个未检查）`);
    }

    // 超时保护：用整体超时兜底
    const startTime = Date.now();
    let checkedCount = 0;

    for (const file of toCheck) {
      if (Date.now() - startTime > GLOBAL_TIMEOUT_MS) {
        log(`⚠ lint 超时（${GLOBAL_TIMEOUT_MS / 1000}s），已检查 ${checkedCount}/${toCheck.length} 个文件`);
        break;
      }
      lintFile(file, PREFIX);
      checkedCount++;
    }

    log(`✅ lint 完成: ${checkedCount}/${toCheck.length} 个文件`);

    // 为 remaining 生成一个 warning 但不清零
    if (remaining > 0) {
      log(`⚠ 本次跳过 ${remaining} 个文件。用 "make lint" 全量检查。`);
    }
  } catch (e) {
    log(`跳过（${e.message}）`);
  }
  // Stop hook 始终 exit 0（非阻断）
  process.exit(0);
}

main();
