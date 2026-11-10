#!/usr/bin/env node
'use strict';

const { gitSubcommand } = require('./verification-gate.cjs');

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { TIMEOUT_MS, isLintable, lintFile } = require('../lib/lint-utils.cjs');

const MAX_STDIN = 1024 * 1024;
const PREFIX = 'PreCommit';

function log(message) {
  process.stderr.write(`[${PREFIX}] ${message}\n`);
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

function commandFrom(payload) {
  return String(
    payload?.tool_input?.command
    || payload?.tool?.input?.command
    || payload?.input?.command
    || payload?.command
    || ''
  ).trim();
}

function cwdFrom(payload, runtime = {}) {
  return runtime.cwd || payload?.cwd || payload?.workspace?.current_dir || process.cwd();
}

function getStagedFiles(payload, runtime = {}) {
  const spawn = runtime.spawnSync || spawnSync;
  const result = spawn('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    cwd: cwdFrom(payload, runtime),
  });
  if (result.status !== 0) return [];
  return String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
}

function runCheck(files, runtime = {}) {
  const lint = runtime.lintFile || lintFile;
  const failures = [];
  for (const file of files) {
    if (!isLintable(file)) continue;
    if (lint(path.resolve(cwdFrom(runtime.payload || {}, runtime), file), PREFIX)) failures.push(file);
  }
  return failures;
}

function evaluate(payload, runtime = {}) {
  const command = commandFrom(payload);
  if (gitSubcommand(command) !== 'commit') {
    return { source: 'pre-commit-lint', decision: 'allow', diagnostics: [] };
  }
  try {
    const diagnostics = ['检测到 git commit，启动预提交 lint 检查...'];
    const files = getStagedFiles(payload, runtime);
    const lintableFiles = files.filter(isLintable);
    if (lintableFiles.length === 0) {
      diagnostics.push('✅ 暂存区无可检查的 .v/.sv/.py 文件');
      return { source: 'pre-commit-lint', decision: 'allow', diagnostics, files: [] };
    }
    diagnostics.push(`检查 ${lintableFiles.length} 个暂存文件...`);
    const failures = runCheck(lintableFiles, { ...runtime, payload });
    if (failures.length > 0) {
      diagnostics.push(
        '❌ 失败 — 请修复后重试，或用 git commit --no-verify 绕过',
        '❌ 预提交 lint 检查未通过，已阻断 commit',
      );
      return {
        source: 'pre-commit-lint',
        decision: 'block',
        diagnostics,
        files: lintableFiles,
        failures,
      };
    }
    diagnostics.push('✅ 预提交检查全部通过');
    return {
      source: 'pre-commit-lint',
      decision: 'allow',
      diagnostics,
      files: lintableFiles,
      failures: [],
    };
  } catch (error) {
    return {
      source: 'pre-commit-lint',
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
    if (result.decision === 'block') process.exit(2);
  } catch (error) {
    log(`跳过：${error.message}`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  commandFrom,
  evaluate,
  getStagedFiles,
  runCheck,
};
