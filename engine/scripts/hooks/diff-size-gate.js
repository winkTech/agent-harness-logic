#!/usr/bin/env node
/**
 * PreToolUse Hook: Diff-Size Gate
 *
 * 在 git push 前检查当前分支变更规模。如果 diff 过大（文件数 > 40 或
 * 变更行 > 1000），阻断 push 并建议拆分提交，防止大型未审查变更入库。
 *
 * 阈值（可在 env 中覆写）:
 *   DIFF_GATE_WARN_FILES  — 文件数警告阈值（默认 20）
 *   DIFF_GATE_WARN_LINES  — 变更行警告阈值（默认 500）
 *   DIFF_GATE_BLOCK_FILES — 文件数阻断阈值（默认 40）
 *   DIFF_GATE_BLOCK_LINES — 变更行阻断阈值（默认 1000）
 *
 * 跳过方式：git push --no-verify
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MAX_STDIN = 1024 * 1024;

// 可配置阈值
const WARN_FILES = parseInt(process.env.DIFF_GATE_WARN_FILES || '20', 10);
const WARN_LINES = parseInt(process.env.DIFF_GATE_WARN_LINES || '500', 10);
const BLOCK_FILES = parseInt(process.env.DIFF_GATE_BLOCK_FILES || '40', 10);
const BLOCK_LINES = parseInt(process.env.DIFF_GATE_BLOCK_LINES || '1000', 10);

function log(msg) {
  process.stderr.write(`[DiffGate] ${msg}\n`);
}

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
    timeout: 15000,
    windowsHide: true,
    ...opts,
  });
}

/**
 * 获取当前分支相对 main 的 diff 统计。
 * @returns {{ fileCount: number, totalChanges: number, statOutput: string } | null}
 */
function getDiffStats() {
  // 尝试 origin/main...HEAD
  let r = exec('git', ['diff', '--stat', 'origin/main...HEAD']);
  if (r.status !== 0) {
    // 回退: origin/master...HEAD
    r = exec('git', ['diff', '--stat', 'origin/master...HEAD']);
  }
  if (r.status !== 0) {
    // 回退: main...HEAD
    r = exec('git', ['diff', '--stat', 'main...HEAD']);
  }
  if (r.status !== 0) return null;

  const output = r.stdout.trim();
  if (!output) return null;

  const lines = output.split('\n');
  const fileCount = lines.filter(l => l.includes('|')).length;

  // 解析 "X files changed, N insertions(+), M deletions(-)"
  const fileChangedMatch = output.match(/(\d+)\s+files?\s+changed/);
  const insertMatch = output.match(/(\d+)\s+insertion/);
  const deleteMatch = output.match(/(\d+)\s+deletion/);

  const totalChanges = (insertMatch ? parseInt(insertMatch[1], 10) : 0)
                     + (deleteMatch ? parseInt(deleteMatch[1], 10) : 0);

  return { fileCount: fileCount || (fileChangedMatch ? parseInt(fileChangedMatch[1], 10) : 0),
           totalChanges,
           statOutput: output };
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);
    const command = (payload?.input?.command || payload?.command || '').trim();

    // 只关心 git push
    if (!/^git\s+push(\s|$)/.test(command)) process.exit(0);
    // 忽略 --no-verify
    if (command.includes('--no-verify')) process.exit(0);

    const stats = getDiffStats();
    if (!stats) process.exit(0); // 无 base 分支可比较，放行

    const { fileCount, totalChanges, statOutput } = stats;

    // 无变更或极小变更，放行
    if (fileCount === 0 && totalChanges === 0) process.exit(0);

    // 判断级别
    const isBlock = fileCount >= BLOCK_FILES || totalChanges >= BLOCK_LINES;
    const isWarn = fileCount >= WARN_FILES || totalChanges >= WARN_LINES;

    if (isBlock || isWarn) {
      log(`⚠  变更集审计:`);
      log(`   文件数: ${fileCount} (警告 ${WARN_FILES} / 阻断 ${BLOCK_FILES})`);
      log(`   变更行: ${totalChanges} (警告 ${WARN_LINES} / 阻断 ${BLOCK_LINES})`);
      log(`\n${statOutput}`);
    }

    if (isBlock) {
      // 注意: 这里是**警告不是阻断**。Claude Code 只把 exit 2 视为阻断,
      // exit 1 等同放行。大规模重构是合法操作, 不该被变更体积硬拦 ——
      // 与其伪称"已阻断"(实际没拦), 不如如实说这是建议。
      log(`⚠  变更很大 (文件≥${BLOCK_FILES} 或行≥${BLOCK_LINES})。`);
      log(`   强烈建议拆分为多个提交，便于审查与回滚。`);
      process.exit(1);
    }

    if (isWarn) {
      log(`⚠  变更较大，请确认是否应拆分为多个提交。`);
      log(`   确认推送请重试: git push (无 --no-verify 也可放行)`);
      // 警告不阻断
    }
  } catch (e) {
    log(`跳过（${e.message}）`);
  }
  process.exit(0);
}

main();
