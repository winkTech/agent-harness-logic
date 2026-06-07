#!/usr/bin/env node
/**
 * PreToolUse Hook: Pre-Commit Lint Check
 *
 * 在 git commit 前对暂存区中的 .v/.sv/.py 文件运行 linter。
 * 检查失败则阻断绝 commit（exit 1），防止不合格代码入库。
 *
 * 格式（原生 Claude Code PreToolUse hook）：
 *   从 stdin 接收 JSON，包含 { tool, input: { command } }
 *   仅匹配 Bash(tool) + git commit 开头(command)
 *
 * 跳过方式：git commit --no-verify
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const MAX_STDIN = 1024 * 1024;
const LINTABLE_EXTS = new Set(['.v', '.sv', '.py']);
const TIMEOUT_MS = 30000;

function log(msg) {
  process.stderr.write(`[PreCommit] ${msg}\n`);
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

function exec(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    ...opts,
  });
}

/**
 * 获取暂存区中待提交的文件列表。
 * @returns {string[]}
 */
function getStagedFiles() {
  const r = exec('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
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
    const ext = path.extname(file).toLowerCase();
    if (!LINTABLE_EXTS.has(ext)) return;

    const absPath = path.resolve(file);

    if (ext === '.v' || ext === '.sv') {
      log(`🔍 vlog -lint ${file}`);
      const r = exec('vlog', ['-lint', absPath]);
      if (r.status !== 0) {
        const out = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(0, 8);
        out.forEach(l => log(`      ${l}`));
        log(`╚════ ✖ 失败 — 请修复后重试，或用 git commit --no-verify 跳过`);
        hasError = true;
      } else {
        log(`╚════ ✓ 通过`);
      }
    } else if (ext === '.py') {
      log(`🔍 ruff check ${file}`);
      const r = exec('ruff', ['check', '--quiet', absPath]);
      if (r.status !== 0) {
        const out = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(0, 8);
        out.forEach(l => log(`      ${l}`));
        log(`╚════ ✖ 失败 — 请修复后重试，或用 git commit --no-verify 跳过`);
        hasError = true;
      } else {
        log(`╚════ ✓ 通过`);
      }
    }
  });

  return hasError;
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);

    // PreToolUse stdin 结构: { tool: "Bash", input: { command: "..." }, ... }
    const command = (payload?.input?.command || payload?.command || '').trim();

    // 只关心 git commit（排除 git commit --amend 中 amend 不加 --no-verify 的场景）
    if (!/^git\s+commit(\s|$)/.test(command)) process.exit(0);

    log('检测到 git commit，启动预提交 lint 检查...');

    const files = getStagedFiles();
    const toCheck = files.filter(f => LINTABLE_EXTS.has(path.extname(f).toLowerCase()));

    if (toCheck.length === 0) {
      log('✓ 暂存区无可检查的 .v/.sv/.py 文件');
      process.exit(0);
    }

    log(`检查 ${toCheck.length} 个暂存文件...`);
    const failed = runCheck(toCheck);

    if (failed) {
      log('✖ 预提交 lint 检查未通过，已阻断 commit');
      process.exit(1); // 阻断
    }

    log('✓ 预提交检查全部通过');
  } catch (e) {
    log(`跳过（${e.message}）`);
  }
  process.exit(0);
}

main();
