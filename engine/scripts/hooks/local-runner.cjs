#!/usr/bin/env node
/**
 * engine/scripts/hooks/local-runner.cjs — 本地 hook 运行器。
 *
 * 替代 settings.local.json 中 5 处内联 node -e wrapper（frustration-detector、
 * pre-commit-lint、diff-size-gate、file-protection-guard、lint-auto-gate）。
 *
 * 这些脚本在 engine/scripts/hooks/ 下，不走 ECC 插件路径。
 * 本 runner 将相对路径解析为绝对路径，直接 spawn 执行，确保 stdin/stdout 透传。
 *
 * 用法:
 *   node local-runner.cjs <script-name> [args...]
 *
 * 示例:
 *   node local-runner.cjs frustration-detector.cjs
 *   node local-runner.cjs pre-commit-lint.js
 *   node local-runner.cjs diff-size-gate.js
 *   node local-runner.cjs file-protection-guard.cjs
 *   node local-runner.cjs lint-auto-gate.js
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HOOKS_DIR = path.join(__dirname);

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('[local-runner] 用法: node local-runner.cjs <script-name> [args...]');
    process.exit(1);
  }

  const scriptName = args[0];
  const scriptPath = path.join(HOOKS_DIR, scriptName);

  if (!fs.existsSync(scriptPath)) {
    console.error(`[local-runner] 脚本不存在: ${scriptPath}`);
    process.exit(1);
  }

  // 读取 stdin（如果有）并透传给子进程
  let stdinData = null;
  try {
    if (!process.stdin.isTTY) {
      stdinData = fs.readFileSync(0, 'utf8');
    }
  } catch (_e) {
    // stdin 不可用，忽略
  }

  const result = spawnSync(process.execPath, [scriptPath, ...args.slice(1)], {
    input: stdinData,
    encoding: 'utf8',
    env: process.env,
    cwd: process.cwd(),
    timeout: 30000,
    windowsHide: true,
    stdio: stdinData !== null ? ['pipe', 'pipe', 'pipe'] : 'inherit',
  });

  // 透传 stdout/stderr
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error || result.status === null || result.signal) {
    const reason = result.error
      ? result.error.message
      : result.signal
        ? `signal ${result.signal}`
        : 'unknown error';
    console.error(`[local-runner] ${scriptName} 执行失败: ${reason}`);
    process.exit(1);
  }

  process.exit(result.status);
}

main();
