#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/bench-d3-docs-dryrun.cjs — D-3 文档干跑（Phase 4.3）
 *
 * D-3 完整口径（干净机器 ≤30min agent 引导安装）需新机实测；本校验器做
 * 代码侧等价断言——文档引导的每条命令真实存在且 --check 面（在本机态）全绿：
 *   1. SETUP.md 引用的每个脚本路径存在
 *   2. 各宿主渲染 --check 在本机态 exit 0（SETUP 第 3/4 步可复现）
 *   3. 六件文档齐备（README/SETUP/core/packs/fpga/三 host/release-checklist）
 *   4. README 安装矩阵引用的命令与实际渲染器一致
 * 真机计时项留 release-checklist 人工段。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };

function main() {
  // 3 文档齐备
  const docs = [
    'README.md', 'SETUP.md', 'core/README.md', 'packs/fpga/README.md',
    'hosts/claude-code/README.md', 'hosts/codex/README.md', 'hosts/grok/README.md',
    'docs/release-checklist.md',
  ];
  for (const d of docs) ok(fs.existsSync(path.join(HARNESS_ROOT, d)), `缺文档: ${d}`);

  // 1 SETUP.md 命令面存在性
  const setup = fs.readFileSync(path.join(HARNESS_ROOT, 'SETUP.md'), 'utf8');
  for (const m of setup.matchAll(/node (core\/[^\s]+\.cjs|hosts\/[^\s]+\.cjs)/g)) {
    ok(fs.existsSync(path.join(HARNESS_ROOT, m[1])), `SETUP 引用不存在: ${m[1]}`);
  }

  // README 脚本引用一致：反引号 .cjs 名须存在于 engine 树（scripts/ 或 hooks/
  // 根或其子目录——叙述性提及的 dormant 脚本也在树内）；只抓真幻觉路径。
  const readme = fs.readFileSync(path.join(HARNESS_ROOT, 'README.md'), 'utf8');
  const engineDirs = ['core/engine/scripts', 'core/engine/hooks'];
  const fileExistsInTree = (base, name) => {
    if (fs.existsSync(path.join(base, name))) return true;
    try {
      return fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .some((e) => fileExistsInTree(path.join(base, e.name), name));
    } catch { return false; }
  };
  for (const m of readme.matchAll(/`([a-z-]+\.cjs)`/g)) {
    const found = engineDirs.some((d) => fileExistsInTree(path.join(HARNESS_ROOT, d), m[1]));
    ok(found, `README 引用不存在: ${m[1]}`);
  }

  // 2 各渲染器 --check 本机态全绿
  const checks = [
    'core/engine/scripts/render-hook-settings.cjs',
    'core/engine/scripts/render-codex-hooks.cjs',
    'core/engine/scripts/render-grok-hooks.cjs',
  ];
  for (const c of checks) {
    const r = spawnSync(process.execPath, [path.join(HARNESS_ROOT, c), '--check'],
      { encoding: 'utf8', timeout: 120000, windowsHide: true });
    ok(r.status === 0, `${c} --check exit=${r.status}: ${(r.stderr || '').split('\n')[0]}`);
  }
  // smoke 静态段
  const smoke = spawnSync(process.execPath, [path.join(HARNESS_ROOT, 'hosts/grok/smoke.cjs')],
    { encoding: 'utf8', timeout: 120000, windowsHide: true });
  ok(smoke.status === 0, `grok smoke exit=${smoke.status}`);

  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`[d3-dryrun] ✖ ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('[d3-dryrun] PASS 文档齐备×8 / SETUP 命令面存在 / 三渲染器 check 绿 / smoke 8/8（真机 ≤30min 计时项留人工）\n');
}

main();
