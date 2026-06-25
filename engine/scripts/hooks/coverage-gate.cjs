#!/usr/bin/env node
/**
 * engine/scripts/coverage-gate.cjs — 覆盖率退化门禁 (P0)
 *
 * PreToolUse(Bash) on push/commit: 检查覆盖率是否退化。
 * 读取上次 coverage-runner 的结果，低于阈值时阻止提交。
 *
 * 退出码:
 *   0 — 通过
 *   2 — 覆盖率不达标
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = path.join(os.homedir(), '.claude');
const SUMMARY_FILE = path.join(HOME, 'var', 'coverage', 'coverage-summary.json');

const DEFAULT_THRESHOLD = 60;

function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
  });
}

function block(message) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║      📊  COVERAGE GATE — 覆盖率不达标                       ║');
  console.error('╠══════════════════════════════════════════════════════════════╣');
  console.error('║  原因: Hook 代码覆盖率低于阈值                                ║');
  console.error('║                                                              ║');
  console.error(`║  ${message.padEnd(60)}║`);
  console.error('║                                                              ║');
  console.error('║  请运行: node engine/scripts/coverage-runner.cjs               ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);
    const eventName = payload?.hook_event_name || '';
    const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();

    // 仅在 push/commit 时检查
    if (eventName !== 'PreToolUse' || toolName !== 'bash') process.exit(0);

    const command = (payload?.tool_input?.command
      || payload?.tool?.input?.command
      || payload?.input?.command
      || payload?.command
      || '').trim();

    if (!command) process.exit(0);

    // 仅检查 git push / git commit
    if (!/^git\s+(push|commit)\b/.test(command)) process.exit(0);

    // 读取上次覆盖率结果
    if (!fs.existsSync(SUMMARY_FILE)) {
      // 无覆盖率数据 — 允许但警告
      console.error('[CoverageGate] ⚠️ 无覆盖率数据。首次请运行 coverage-runner.cjs');
      process.exit(0);
    }

    let summary;
    try {
      summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
    } catch {
      process.exit(0);
    }

    const threshold = summary.threshold || DEFAULT_THRESHOLD;
    const percent = summary.percent || 0;

    if (percent >= threshold) {
      // 达标
      process.exit(0);
    }

    // 未达标 — 阻断
    block(`覆盖率 ${percent}% < ${threshold}%。请补充测试后重新运行 coverage-runner.cjs`);
    process.exit(2);

  } catch (e) {
    console.error(`[CoverageGate] 解析错误(放行): ${e.message}`);
    process.exit(0);
  }
}

main();
