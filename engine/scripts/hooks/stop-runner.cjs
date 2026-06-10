#!/usr/bin/env node
/**
 * engine/scripts/hooks/stop-runner.cjs — Stop hook 统一运行器。
 *
 * 替代 settings.local.json 中 Stop/SessionEnd 下 6 处内联 node -e 模式。
 * 这些 hook 需要：
 *   1. 读取 stdin（Claude Code 传递给 Stop hook 的上下文 JSON）
 *   2. 解析 ECC 插件根路径
 *   3. 通过 run-with-flags.js 调用目标脚本
 *   4. stdout 透传（原样输出 stdin 或脚本输出）
 *   5. 优雅降级（ECC 插件不存在时原样透传 stdin）
 *
 * 用法:
 *   node stop-runner.cjs <flag-name> <script-rel-path> <flags> [timeout]
 *
 * 示例:
 *   node stop-runner.cjs stop:format-typecheck    scripts/hooks/stop-format-typecheck.js standard,strict 300000
 *   node stop-runner.cjs stop:check-console-log   scripts/hooks/check-console-log.js standard,strict 30000
 *   node stop-runner.cjs stop:session-end         scripts/hooks/session-end.js minimal,standard,strict 30000
 *   node stop-runner.cjs stop:evaluate-session    scripts/hooks/evaluate-session.js minimal,standard,strict 30000
 *   node stop-runner.cjs stop:cost-tracker        scripts/hooks/cost-tracker.js minimal,standard,strict 30000
 *   node stop-runner.cjs session:end:marker       scripts/hooks/session-end-marker.js minimal,standard,strict 30000
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── ECC 根目录解析 ─────────────────────────────────────────────────────────

const HOME = path.join(os.homedir(), '.claude');
const UTILS_REL = path.join('scripts', 'lib', 'utils.js');

function check(dir) {
  try { return fs.existsSync(path.join(dir, UTILS_REL)) ? dir : null; }
  catch (_) { return null; }
}

function eccRoot() {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  if (env && env.trim()) return env.trim();

  const slugs = ['ecc', 'ecc@ecc', 'everything-claude-code', 'everything-claude-code@everything-claude-code'];

  for (const base of [
    HOME, path.join(HOME, 'var', 'plugins'), path.join(HOME, 'plugins'),
    path.join(HOME, 'var', 'plugins', 'marketplaces'), path.join(HOME, 'plugins', 'marketplaces'),
  ]) {
    for (const slug of slugs) {
      const dir = check(path.join(base, slug));
      if (dir) return dir;
    }
  }

  try {
    const cacheDir = path.join(HOME, 'var', 'plugins', 'cache');
    if (fs.existsSync(cacheDir)) {
      for (const entry of fs.readdirSync(cacheDir)) {
        const dir = check(path.join(cacheDir, entry));
        if (dir) return dir;
      }
    }
  } catch (_) { /* ignore */ }

  return null;
}

// ── 主逻辑 ─────────────────────────────────────────────────────────────────

function main() {
  const [, , flagName, scriptRelPath, flags, timeoutStr] = process.argv;
  const timeout = parseInt(timeoutStr, 10) || 30000;

  // 1. 读取 stdin
  let raw = '';
  try {
    if (!process.stdin.isTTY) {
      raw = fs.readFileSync(0, 'utf8');
    }
  } catch (_e) {
    // stdin 不可用
  }

  // 2. 尝试通过 ECC 插件执行
  const root = eccRoot();
  const runWithFlags = root
    ? path.join(root, 'scripts', 'hooks', 'run-with-flags.js')
    : null;

  if (runWithFlags && fs.existsSync(runWithFlags)) {
    const result = spawnSync(process.execPath, [
      runWithFlags,
      flagName,
      scriptRelPath,
      flags || 'standard,strict',
    ], {
      input: raw,
      encoding: 'utf8',
      env: process.env,
      cwd: process.cwd(),
      timeout,
      windowsHide: true,
    });

    // 透传 stdout
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    if (stdout) {
      process.stdout.write(stdout);
    } else {
      process.stdout.write(raw);
    }

    // 透传 stderr
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    // 错误处理
    if (result.error || result.status === null || result.signal) {
      const reason = result.error
        ? result.error.message
        : result.signal
          ? `signal ${result.signal}`
          : 'missing exit status';
      process.stderr.write(`[stop-runner] ERROR: ${flagName} 执行失败: ${reason}\n`);
      process.exit(1);
    }

    process.exit(Number.isInteger(result.status) ? result.status : 0);
  }

  // 3. 降级：ECC 插件不可用，原样透传 stdin
  process.stderr.write(`[stop-runner] WARNING: 无法解析 ECC 插件根目录，跳过 ${flagName}\n`);
  process.stdout.write(raw);
  process.exit(0);
}

main();
