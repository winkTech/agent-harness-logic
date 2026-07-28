#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { gitSubcommand } = require('./verification-gate.cjs');

const MAX_STDIN = 1024 * 1024;
const WARN_FILES = Number.parseInt(process.env.DIFF_GATE_WARN_FILES || '20', 10);
const WARN_LINES = Number.parseInt(process.env.DIFF_GATE_WARN_LINES || '500', 10);
const BLOCK_FILES = Number.parseInt(process.env.DIFF_GATE_BLOCK_FILES || '40', 10);
const BLOCK_LINES = Number.parseInt(process.env.DIFF_GATE_BLOCK_LINES || '1000', 10);

function log(message) {
  process.stderr.write(`[DiffGate] ${message}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (raw.length < MAX_STDIN) raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw.replace(/^\uFEFF/, '')));
  });
}

function exec(command, args, opts = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    ...opts,
  });
}

function parseDiffStat(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const fileChangedMatch = text.match(/(\d+)\s+files?\s+changed/);
  const insertMatch = text.match(/(\d+)\s+insertion/);
  const deleteMatch = text.match(/(\d+)\s+deletion/);
  const fileCount = lines.filter((line) => line.includes('|')).length
    || (fileChangedMatch ? Number.parseInt(fileChangedMatch[1], 10) : 0);
  const totalChanges = (insertMatch ? Number.parseInt(insertMatch[1], 10) : 0)
    + (deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0);
  return { fileCount, totalChanges, statOutput: text };
}

function getDiffStats(runtime = {}) {
  const run = runtime.exec || exec;
  const opts = runtime.cwd ? { cwd: runtime.cwd } : {};
  const refs = ['origin/main...HEAD', 'origin/master...HEAD', 'main...HEAD'];
  for (const ref of refs) {
    const result = run('git', ['diff', '--stat', ref], opts);
    if (result.status === 0) return parseDiffStat(result.stdout);
  }
  return null;
}

function commandFrom(payload) {
  return String(
    payload?.tool_input?.command
    || payload?.tool?.input?.command
    || payload?.input?.command
    || payload?.command
    || ''
  ).trim();
}

function evaluate(payload, runtime = {}) {
  const command = commandFrom(payload);
  if (gitSubcommand(command) !== 'push' || command.includes('--no-verify')) {
    return { source: 'diff-size-gate', decision: 'allow', diagnostics: [] };
  }

  try {
    const stats = getDiffStats(runtime);
    if (!stats || (stats.fileCount === 0 && stats.totalChanges === 0)) {
      return { source: 'diff-size-gate', decision: 'allow', diagnostics: [], stats };
    }
    const isBlockThreshold = stats.fileCount >= BLOCK_FILES || stats.totalChanges >= BLOCK_LINES;
    const isWarnThreshold = stats.fileCount >= WARN_FILES || stats.totalChanges >= WARN_LINES;
    if (!isBlockThreshold && !isWarnThreshold) {
      return { source: 'diff-size-gate', decision: 'allow', diagnostics: [], stats };
    }

    const diagnostics = [
      '⚠️  变更集审计:',
      `   文件数: ${stats.fileCount} (警告 ${WARN_FILES} / 阻断 ${BLOCK_FILES})`,
      `   变更行: ${stats.totalChanges} (警告 ${WARN_LINES} / 阻断 ${BLOCK_LINES})`,
      `\n${stats.statOutput}`,
    ];
    if (isBlockThreshold) {
      diagnostics.push(
        `⚠️  变更很大 (文件≥${BLOCK_FILES} 或行≥${BLOCK_LINES})。`,
        '   强烈建议拆分为多个提交，便于审查与回滚。',
      );
    } else {
      diagnostics.push(
        '⚠️  变更较大，请确认是否应拆分为多个提交。',
        '   确认推送请重试: git push (无 --no-verify 也可放行)',
      );
    }
    return {
      source: 'diff-size-gate',
      decision: 'warn',
      diagnostics,
      stats,
      legacyExitCode: isBlockThreshold ? 1 : 0,
    };
  } catch (error) {
    return {
      source: 'diff-size-gate',
      decision: 'allow',
      diagnostics: [`跳过：${error.message}`],
      error: error.message,
    };
  }
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);
    const result = evaluate(JSON.parse(raw));
    for (const message of result.diagnostics) log(message);
    if (result.legacyExitCode === 1) process.exit(1);
  } catch (error) {
    log(`跳过：${error.message}`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  commandFrom,
  evaluate,
  getDiffStats,
  parseDiffStat,
};
