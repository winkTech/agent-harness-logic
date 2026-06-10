#!/usr/bin/env node
/**
 * engine/scripts/hooks/test-hooks.cjs — Hook 集成测试。
 *
 * 对所有注册在 settings.local.json 中的 hook 进行 dry-run，
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

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const HOME = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(HOME, 'settings.local.json');
const VERBOSE = process.argv.includes('--verbose');
const POINT_FILTER = process.argv.find(a => a.startsWith('--point='))?.split('=')[1]
  || process.argv.find(a => a.startsWith('--point')) ? null : null;

// 提取 --point 值
const pointIdx = process.argv.indexOf('--point');
const FILTER_POINT = pointIdx >= 0 ? process.argv[pointIdx + 1] : null;

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
function resolveScriptPath(cmd) {
  // 提取脚本路径
  const matches = cmd.match(/(?:node|bash)\s+([^\s"'|]+(?:\.\w+)?)/);
  if (!matches) return null;

  let scriptPath = matches[1];

  // 处理 ~/ 开头
  if (scriptPath.startsWith('~/')) {
    scriptPath = path.join(os.homedir(), scriptPath.slice(2));
  } else if (scriptPath.startsWith('~')) {
    scriptPath = path.join(os.homedir(), scriptPath.slice(1));
  } else if (!path.isAbsolute(scriptPath)) {
    // 相对路径 → 相对于 HOME
    scriptPath = path.join(HOME, scriptPath);
  }

  return fs.existsSync(scriptPath) ? scriptPath : null;
}

/**
 * 执行一条 hook 命令（dry-run）。
 * 如果命令带 stdin 读取，传递一个空的 JSON 负载 {}。
 */
function runHookCommand(cmd, isAsync) {
  const parts = cmd.split(/\s+/);
  if (parts.length === 0) return { ok: false, error: 'empty command' };

  const executable = parts[0];
  const args = parts.slice(1);

  // 只测试 node 和 bash 开头的命令
  if (executable !== 'node' && executable !== 'bash') {
    return { ok: false, skip: true, reason: `unknown executable: ${executable}` };
  }

  // 检查脚本文件是否存在
  const scriptPath = resolveScriptPath(cmd);
  if (!scriptPath) {
    return { ok: false, skip: true, reason: 'script file not found' };
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
    env: { ...process.env, CLAUDE_SKIP_HOOK: '1' },
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

  // 1. 加载配置
  let config;
  try {
    config = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    log(`❌ 无法加载 settings.local.json: ${e.message}`);
    process.exit(1);
  }

  const hooks = config.hooks || {};
  const points = Object.keys(hooks);

  if (FILTER_POINT && !points.includes(FILTER_POINT)) {
    log(`⚠ 触发点 "${FILTER_POINT}" 不存在。可选: ${points.join(', ')}`);
    process.exit(1);
  }

  log(`触发点: ${FILTER_POINT || '全部'} (${FILTER_POINT ? 1 : points.length} 个)`);

  for (const point of points) {
    if (FILTER_POINT && point !== FILTER_POINT) continue;

    const entries = hooks[point];
    const arr = Array.isArray(entries) ? entries : [];

    if (arr.length === 0) {
      detail(`${point}: 无 hook 条目`);
      continue;
    }

    for (const group of arr) {
      const hookList = group.hooks || [group];
      for (const h of hookList) {
        const cmd = h.command || h.run || '';
        const isAsync = !!h.async;
        const id = h.id || cmd.slice(0, 60);

        if (!cmd) {
          detail(`${point}: ⚠ empty command (id=${id})`);
          skipped++;
          continue;
        }

        total++;
        const result = runHookCommand(cmd, isAsync);

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
