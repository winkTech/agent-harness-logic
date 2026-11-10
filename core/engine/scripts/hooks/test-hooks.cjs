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
const DRY_RUN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-dry-run-state-'));

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
function runHookCommand(cmd, isAsync, configuredTimeoutSec) {
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

  // async hook 同样是普通进程, 只是平台不等它返回 —— 它一样会崩、一样会
  // 写坏状态文件。测试里没有理由不跑它。(早期版本在这里 skip 掉全部 async
  // hook, 直接造成 17/41 项从未被测过。)

  // 执行命令（短超时）
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    // 用该 hook **自己配置的** timeout 作为判据: 跑不进自己的配额就是失败,
    // 因为线上平台正是按这个配额杀进程的。给 2s 余量吸收进程启动开销。
    timeout: Math.max(10000, (Number(configuredTimeoutSec) || 10) * 1000 + 2000),
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_SKIP_HOOK: '1',
      CLAUDE_HARNESS_VERIFY_READONLY: '1',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
      PROGRESS_WATCHDOG_STATE_FILE: path.join(DRY_RUN_STATE_DIR, 'progress-watchdog-state.json'),
      PROGRESS_WATCHDOG_ARCHIVE_DIR: path.join(DRY_RUN_STATE_DIR, 'progress-watchdog-archive'),
    },
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: DRY_RUN_STATE_DIR,
      session_id: 'hook-registry-dry-run',
    }),
  });

  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.signal) {
    return { ok: false, error: `signal ${result.signal}` };
  }

  // 退出码语义 (Claude Code):
  //   0 — 放行, 正常
  //   2 — 阻断。喂进去的是一条无害的 git status, 任何 hook 都不该拦它,
  //       所以这里的 2 是**误报**, 必须计为失败。
  //   其他非 0 — 脚本内部错误。
  // 早期版本无条件 return ok:true, 于是 hook 崩溃/误拦都被记成"通过"。
  if (result.status === 2) {
    return {
      ok: false,
      exitCode: 2,
      error: `hook blocked a harmless probe command (exit 2) — false positive`,
      stderr: result.stderr,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      exitCode: result.status,
      error: `non-zero exit ${result.status}`,
      stderr: result.stderr,
    };
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
      const result = runHookCommand(cmd, entry.isAsync, entry.raw && entry.raw.timeout);

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

  // skip 预算: 跳过的项不是"通过"。跳过太多说明这套测试没有覆盖力,
  // 必须显式失败, 否则 "59% + 17 跳过" 也会打印"全部通过"并 exit 0 ——
  // 一个永远绿灯的自检比没有自检更危险, 因为它会让人以为改动是安全的。
  const SKIP_BUDGET = Math.max(2, Math.ceil(total * 0.15));

  if (failed > 0) {
    log('\n❌ 有 hook 执行失败或误拦无害命令，见上述日志。');
    process.exit(1);
  }
  if (skipped > SKIP_BUDGET) {
    log(`\n❌ 跳过 ${skipped} 项，超出预算 ${SKIP_BUDGET}（总计 ${total}）。`);
    log('   跳过不等于通过 —— 请补齐这些 hook 的可测性或修正其调用形态。');
    process.exit(1);
  }
  log(`\n✅ 全部 hook 通过（跳过 ${skipped}/${SKIP_BUDGET} 预算内）`);
}

main();
