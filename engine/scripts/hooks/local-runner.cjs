#!/usr/bin/env node
/**
 * local-runner.cjs — 本地 hook 运行器（v2 高性能版）
 *
 * 功能:
 *   1. 向后兼容:  node local-runner.cjs <script-name> [args...]
 *   2. 批量模式:  node local-runner.cjs --batch "<s1>,<s2>" [通用参数]
 *      将多个 hook 在同一个 Node.js 进程内顺序执行，只需启动一次 Node，
 *      节省 (N-1) × ~72ms 进程启动开销。
 *
 * 设计原则:
 *   每个 hook 仍然以子进程运行（不侵入修改各个 hook 脚本），
 *   但外层"启动器"进程从 N 次合并为 1 次。
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const HOOKS_DIR = __dirname;
const SCRIPTS_DIR = path.join(HOOKS_DIR, '..'); // engine/scripts/

/**
 * 将脚本名解析为绝对路径。
 * 支持: "script.cjs" → engine/scripts/hooks/script.cjs
 *       "../script.cjs" → engine/scripts/script.cjs
 *       绝对路径 → 原样
 */
function resolveScript(name) {
  if (path.isAbsolute(name)) return name;
  // 含路径分隔符的视为相对路径
  if (name.includes('/') || name.includes('\\')) {
    return path.resolve(HOOKS_DIR, name);
  }
  return path.join(HOOKS_DIR, name);
}

function parsePayload(stdinData) {
  if (!stdinData || !String(stdinData).trim().startsWith('{')) return {};
  try {
    return JSON.parse(stdinData);
  } catch {
    return {};
  }
}

function toolNameFrom(payload) {
  if (typeof payload?.tool === 'string') return payload.tool;
  return payload?.tool?.name || payload?.tool_name || payload?.name || '';
}

function toolInputFrom(payload) {
  return payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
}

function commandFrom(payload) {
  const input = toolInputFrom(payload);
  return String(input.command || payload?.command || '').trim();
}

function filePathFrom(payload) {
  const input = toolInputFrom(payload);
  return String(input.file_path || payload?.file_path || '').trim();
}

function isReadOnlyShellCommand(command) {
  return /^(?:git\s+(?:status|diff|show|log|branch|rev-parse|ls-files)|pwd|ls|dir|rg|grep|findstr|Get-Content|Select-String)\b/i.test(command);
}

function shouldSkipScript(scriptName, payload) {
  const base = path.basename(resolveScript(scriptName)).toLowerCase();
  const tool = toolNameFrom(payload);
  const command = commandFrom(payload);
  const filePath = filePathFrom(payload);

  if (['hdl-gate.cjs', 'requirements-gate-guard.cjs', 'verification-quality-guard.cjs'].includes(base)) {
    return !['Write', 'Edit', 'MultiEdit'].includes(tool) || !/\.(sv|v|py)$/i.test(filePath);
  }

  if (base === 'pre-commit-lint.js') {
    return !/\bgit\s+commit\b/i.test(command);
  }

  if (base === 'diff-size-gate.js') {
    return Boolean(command) && isReadOnlyShellCommand(command);
  }

  if (base === 'resource-budget-gate.js') {
    return Boolean(command)
      && isReadOnlyShellCommand(command)
      && !/\b(vivado|xsim|vsim|pytest|npm\s+(?:test|run)|python|node)\b/i.test(command);
  }

  return false;
}

function runSingle(scriptName, extraArgs, stdinData) {
  const scriptPath = resolveScript(scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`[local-runner] 脚本不存在: ${scriptPath}`);
    return { status: 1 };
  }

  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    input: stdinData,
    encoding: 'utf8',
    env: process.env,
    cwd: process.cwd(),
    timeout: 30000,
    windowsHide: true,
    stdio: stdinData ? ['pipe', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error || result.status === null || result.signal) {
    const reason = result.error
      ? result.error.message
      : result.signal ? `signal ${result.signal}` : 'unknown error';
    console.error(`[local-runner] ${scriptName} 执行失败: ${reason}`);
    return { status: 1 };
  }

  return { status: result.status };
}

function main() {
  // 逃生开关: CLAUDE_GATES_DISABLED=true 跳过所有门禁
  if (process.env.CLAUDE_GATES_DISABLED === 'true') {
    process.exit(0);
  }

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('[local-runner] 用法:');
    console.error('  node local-runner.cjs <script-name> [args...]');
    console.error('  node local-runner.cjs --batch "s1,s2,s3" [通用args...]');
    process.exit(1);
  }

  // 读取 stdin 一次，所有子进程共享
  let stdinData = null;
  try {
    if (!process.stdin.isTTY) {
      stdinData = fs.readFileSync(0, 'utf8');
    }
  } catch (_e) { /* ignore */ }

  if (args[0] === '--batch') {
    // 批量模式: args[1] = "script1.cjs,script2.cjs,script3.cjs"
    const scripts = (args[1] || '').split(',').map(s => s.trim()).filter(Boolean);
    const extraArgs = args.slice(2);
    if (scripts.length === 0) {
      console.error('[local-runner] --batch 需要至少一个脚本名');
      process.exit(1);
    }

    let highestStatus = 0;
    const payload = parsePayload(stdinData);
    for (const script of scripts) {
      if (shouldSkipScript(script, payload)) continue;
      const { status } = runSingle(script, extraArgs, stdinData);
      if (status > highestStatus) highestStatus = status;
      if (status === 2) break; // 硬拦截信号，停止后续检查
    }
    process.exit(highestStatus);
  }

  // 单脚本模式（向后兼容）
  const { status } = runSingle(args[0], args.slice(1), stdinData);
  process.exit(status);
}

main();
