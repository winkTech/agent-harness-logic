#!/usr/bin/env node
/**
 * engine/scripts/hooks/ecc-runner.cjs — ECC 插件 hook 运行器。
 *
 * 替代 settings.local.json 中 20+ 处内联 node -e 长字符串。
 * 解析 ECC 插件根目录，引导 plugin-hook-bootstrap.js 加载目标 hook。
 *
 * 用法:
 *   node ecc-runner.cjs <rel_script_path> [args...]
 *
 * 示例:
 *   node ecc-runner.cjs scripts/hooks/run-with-flags.js stop:cost-tracker scripts/hooks/cost-tracker.js minimal,standard,strict
 *   node ecc-runner.cjs scripts/hooks/session-start-bootstrap.js
 *   node ecc-runner.cjs scripts/hooks/pre-bash-dispatcher.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── ECC 根目录解析（与 ecc-root-resolver.cjs 同步） ─────────────────────────

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

const root = eccRoot();
if (!root) {
  console.error('[ecc-runner] 无法解析 ECC 插件根目录', file.stderr);
  process.exit(1);
}

const bootstrap = path.join(root, 'scripts', 'hooks', 'plugin-hook-bootstrap.js');
if (!fs.existsSync(bootstrap)) {
  console.error('[ecc-runner] bootstrap 不存在: ' + bootstrap);
  process.exit(1);
}

// 从命令行参数中分离脚本路径和额外参数
// 用法: node ecc-runner.cjs <rel_path> [args...]
const [, , relPath, ...extraArgs] = process.argv;

if (!relPath) {
  console.error('[ecc-runner] 用法: node ecc-runner.cjs <rel_path> [args...]');
  process.exit(1);
}

// 设置环境变量，让 bootstrap 能定位 ECC 插件根目录
process.env.CLAUDE_PLUGIN_ROOT = root;

// 重构 process.argv 以匹配 bootstrap 的期望:
//   argv[0] = node
//   argv[1] = bootstrap 路径
//   argv[2] = 运行模式 ('node' 或 'shell')
//   argv[3] = 脚本相对路径
//   argv[4+] = 额外参数
process.argv = [
  process.argv[0],           // node
  bootstrap,                 // argv[1] - bootstrap 路径
  'node',                    // argv[2] - 模式
  relPath,                   // argv[3] - 脚本路径
  ...extraArgs,               // argv[4+] - 额外参数
];

// 加载 bootstrap，它会读取 stdin、resolve root、spawn 目标脚本
require(bootstrap);
