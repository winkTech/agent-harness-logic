#!/usr/bin/env node
/**
 * PreToolUse Hook: Pre-Commit Lint Check
 *
 * 在 git commit 前对暂存区中的 .v/.sv/.py 文件运行 linter。
 * 检查失败则阻断 commit（exit 1），防止不合格代码入库。
 *
 * 格式（原生 Claude Code PreToolUse hook）：
 *   从 stdin 接收 JSON，包含 { tool, input: { command } }
 *   仅匹配 Bash(tool) + git commit 开头(command)
 *
 * 跳过方式：git commit --no-verify
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { LINTABLE_EXTS, TIMEOUT_MS, isLintable, lintFile } = require('../lib/lint-utils.cjs');

const MAX_STDIN = 1024 * 1024;
const PREFIX = 'PreCommit';

function log(msg) {
  process.stderr.write(`[${PREFIX}] ${msg}\n`);
}

/** 从 stdin 读取完整内容 */
function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
  });
}

/**
 * 获取暂存区中待提交的文件列表。
 * @returns {string[]}
 */
function getStagedFiles() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true,
  });
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean);
}

/**
 * 对暂存文件批量运行 lint 检查。
 * @param {string[]} files
 * @returns {boolean} true=有错误
 */
function runCheck(files) {
  let hasError = false;
  files.forEach(file => {
    if (!isLintable(file)) return;
    const failed = lintFile(path.resolve(file), PREFIX);
    if (failed) {
      log(`╚════ ✖ 失败 — 请修复后重试，或用 git commit --no-verify 跳过`);
      hasError = true;
    }
  });
  return hasError;
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);
    const command = (payload?.input?.command || payload?.command || '').trim();

    // 只关心 git commit
    if (!/^git\s+commit(\s|$)/.test(command)) process.exit(0);

    log('检测到 git commit，启动预提交 lint 检查...');

    const files = getStagedFiles();
    const toCheck = files.filter(isLintable);

    if (toCheck.length === 0) {
      log('✓ 暂存区无可检查的 .v/.sv/.py 文件');
      process.exit(0);
    }

    log(`检查 ${toCheck.length} 个暂存文件...`);
    const failed = runCheck(toCheck);

    if (failed) {
      log('✖ 预提交 lint 检查未通过，已阻断 commit');
      process.exit(1);
    }

    log('✓ 预提交检查全部通过');
  } catch (e) {
    log(`跳过（${e.message}）`);
  }
  process.exit(0);
}

main();
