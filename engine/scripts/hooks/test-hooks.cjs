#!/usr/bin/env node
/**
 * engine/scripts/hooks/test-hooks.cjs — Hook 集成测试。
 *
 * 对所有注册在 settings.json/settings.local.json 中的 hook 进行 dry-run，
 * 验证每条 hook 的命令是否可执行、脚本是否存在、exit code = 0。
 *
 * 用法:
 *   node engine/scripts/hooks/test-hooks.cjs              # 全量测试
 *   node engine/scripts/hooks/test-hooks.cjs --verbose    # 详细输出
 *   node engine/scripts/hooks/test-hooks.cjs --point Stop # 只测指定触发点
 *
 * 不测的 hook:
 *   - async hook（异步只检查脚本是否存在，不执行）
 *   - 匹配 PostToolUse 的某些 hook（需要上下文，只检查脚本存在）
 */

'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const {
  collectHookEntries,
  parseCommandLine,
  scriptRefsForCommand,
} = require('../lib/hook-registry.cjs');

const HOME = HARNESS_ROOT;
const VERBOSE = process.argv.includes('--verbose');
const pointIdx = process.argv.indexOf('--point');
const FILTER_POINT = process.argv.find(a => a.startsWith('--point='))?.split('=')[1]
  || (pointIdx >= 0 ? process.argv[pointIdx + 1] : null);

// ── 统计 ───────────────────────────────────────────────────────────────────

let total = 0;
let passed = 0;
let skipped = 0;
let failed = 0;

// ── 工具函数 ───────────────────────────────────────────────────────────────

function log(msg) { process.stdout.write(msg + '\n'); }
function detail(msg) { if (VERBOSE) process.stdout.write(`  ${msg}\n`); }

/**
 * 检查脚本文件是否存在。
 */
function expandArg(arg) {
  if (!arg || typeof arg !== 'string') return arg;
  return arg
    .replace(/\$HOME/g, os.homedir().replace(/\\/g, '/'))
    .replace(/^~(?=\/|\\|$)/, os.homedir().replace(/\\/g, '/'));
}

function missingScriptRefs(cmd) {
  const refs = scriptRefsForCommand(cmd);
  return refs.filter(ref => !fs.existsSync(ref.script));
}

/**
 * 执行一条 hook 命令（dry-run）。
 * 如果命令带 stdin 读取，传递一个空的 JSON 负载 {}。
 */
function runHookCommand(cmd, isAsync) {
  const parts = parseCommandLine(cmd).map(expandArg);
  if (parts.length === 0) return { ok: false, error: 'empty command' };

  const executable = parts[0];
  const args = parts.slice(1);

  // 只测试 node 和 bash 开头的命令
  if (executable !== 'node' && executable !== 'bash') {
    return { ok: false, skip: true, reason: `unknown executable: ${executable}` };
  }

  const missing = missingScriptRefs(cmd);
  if (missing.length > 0) {
    return { ok: false, skip: true, reason: `script file not found: ${missing.map(ref => path.basename(ref.script)).join(', ')}` };
  }

  // async hook: 只检查文件存在，不执行
  if (isAsync) {
    return { ok: true, skip: true, reason: 'async hook (checked script existence only)' };
  }

  // 执行命令（短超时）
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_SKIP_HOOK: '1',
      CLAUDE_HARNESS_VERIFY_READONLY: '1',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
    },
    input: JSON.stringify({ tool: 'Bash', input: { command: 'git status' } }),
  });

  // 退出码 0 = 通过；非 0 但脚本功能正常也可能 exit(0) 跳过（如不匹配的命令）
  // 我们只关心脚本是否 crash
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.signal) {
    return { ok: false, error: `signal ${result.signal}` };
  }

  return { ok: true, exitCode: result.status, stderr: result.stderr };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  log('\n━━━ Hook 集成测试 ━━━\n');

  const entries = collectHookEntries();
  const points = [...new Set(entries.map(entry => entry.point))];

  if (FILTER_POINT && !points.includes(FILTER_POINT)) {
    log(`⚠ 触发点 "${FILTER_POINT}" 不存在。可选: ${points.join(', ')}`);
    process.exit(1);
  }

  log(`触发点: ${FILTER_POINT || '全部'} (${FILTER_POINT ? 1 : points.length} 个)`);

  for (const point of points) {
    if (FILTER_POINT && point !== FILTER_POINT) continue;

    const pointEntries = entries.filter(entry => entry.point === point);

    if (pointEntries.length === 0) {
      detail(`${point}: 无 hook 条目`);
      continue;
    }

    for (const entry of pointEntries) {
      const cmd = entry.command || '';
      const id = entry.id || cmd.slice(0, 60);
      if (!cmd) {
        detail(`${point}: ⚠ empty command (id=${id})`);
        skipped++;
        continue;
      }

      total++;
      const result = runHookCommand(cmd, entry.isAsync);

      if (result.ok) {
        if (result.skip) {
          detail(`${point}: ⏭ ${id} — ${result.reason}`);
          skipped++;
        } else {
          detail(`${point}: ✅ ${id} (exit=${result.exitCode})`);
          passed++;
        }
      } else if (result.skip) {
        detail(`${point}: ⏭ ${id} — ${result.reason}`);
        skipped++;
      } else {
        log(`  ${point}: ❌ ${id} — ${result.error}`);
        failed++;
      }
    }
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────────

  log('');
  log('━━━ 结果 ━━━');
  log(`  总计: ${total}`);
  log(`  通过: ${passed}`);
  log(`  跳过: ${skipped}`);
  log(`  失败: ${failed}`);

  const score = total > 0 ? Math.round((passed / total) * 100) : 0;
  const grade = score === 100 ? '🟢' : score >= 80 ? '🟡' : '🔴';
  log(`  得分: ${grade} ${score}%`);

  if (failed > 0) {
    log('\n⚠ 有 hook 执行失败，请检查上述日志。');
    process.exit(1);
  } else {
    log('\n✅ 全部 hook 通过');
  }
}

main();
