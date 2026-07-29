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
const {
  bypassRequested,
  evaluateGateBypass,
  sessionIdFrom,
} = require('../lib/gate-bypass.cjs');

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

function structuredFailure(scriptName, details) {
  const record = {
    event: 'local-runner-failure',
    script: scriptName,
    status: details.status,
    timedOut: details.timedOut,
    signal: details.signal || null,
    errorCode: details.errorCode,
  };
  console.error(`[local-runner] ${JSON.stringify(record)}`);
}

function childEnvironment() {
  const env = {};
  const exact = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG',
    'TERM', 'LM_LICENSE_FILE', 'MGLS_LICENSE_FILE',
    'CLAUDE_SESSION_ID', 'CLAUDE_USER_MESSAGE', 'CLAUDE_TRANSCRIPT_PATH',
    'CLAUDE_SESSION_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_TOOL_NAME', 'CLAUDE_TOOL_INPUT',
    'CLAUDE_HARNESS_ROOT', 'CLAUDE_CONFIG_DIR', 'CLAUDE_NO_DIAGNOSTIC_WRITES',
    'CLAUDE_HARNESS_NO_PERSIST', 'CLAUDE_BENCH', 'CLAUDE_HOOK_DEADLINE_MS',
    'CLAUDE_RUNTIME_STATE_FILE', 'CLAUDE_REPAIR_SPEC', 'CLAUDE_VERIFICATION_LEDGER_FILE',
    'CLAUDE_VERIFY_GATE_TTL_MS', 'CLAUDE_RTL_SEMANTIC_ORACLE_DISABLED',
    'CLAUDE_PROTECTED_WRITE_APPROVAL', 'CLAUDE_PROTECTED_WRITE_REASON',
    'CLAUDE_TOOL_ACTION_CONTRACT_MODE', 'CLAUDE_TOOL_ACTION_CONTRACT_MAX_AGE_MS',
    'CLAUDE_TOOL_ACTION_CONTRACT_ALLOW_MISSING_USER', 'CLAUDE_TOOL_ACTION_CONTRACT_GATE_DISABLED',
    'CLAUDE_VISIBLE_CHECKLIST_GATE_MODE', 'CLAUDE_VISIBLE_CHECKLIST_GATE_STRICT',
    'CLAUDE_VISIBLE_CHECKLIST_GATE_DISABLED', 'CLAUDE_SKIP_HOOK',
    'CLAUDE_TRANSPARENCY_TRANSCRIPT_MAX_BYTES', 'CLAUDE_TRANSPARENCY_RUN_ID',
    'CLAUDE_TRANSPARENCY_RUN_DIR', 'CLAUDE_TRANSPARENCY_RUNS_DIR',
    'CLAUDE_TRANSPARENCY_CAPTURE_ALL', 'CLAUDE_TRANSPARENCY_MAX_EVENTS_BYTES',
    'CLAUDE_TRANSPARENCY_MAX_ROTATED_EVENTS', 'CLAUDE_TRANSPARENCY_MAX_RUNS',
    'CLAUDE_TRANSPARENCY_LEDGER_DISABLED', 'CLAUDE_TRANSPARENCY_DEBUG',
  ]);
  const prefixes = ['LC_', 'XILINX_', 'VIVADO_', 'QUESTA_', 'MODELSIM_'];
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('CLAUDE_GATES_DISABLE')) continue;
    if (exact.has(upper) || prefixes.some(prefix => upper.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

function evaluateScriptBypass(scriptName, payload) {
  if (!bypassRequested(process.env)) return { requested: false, allowed: false, errors: [] };
  const gateId = path.basename(resolveScript(scriptName));
  const result = evaluateGateBypass({
    gateId,
    sessionId: sessionIdFrom(payload),
  });
  const event = result.allowed ? 'local-runner-gate-bypass' : 'local-runner-gate-bypass-rejected';
  console.error(`[local-runner] ${JSON.stringify({
    event,
    gateId,
    target: result.target || null,
    errors: result.errors || [],
  })}`);
  return result;
}

function runSingle(scriptName, extraArgs, stdinData, timeoutMs) {
  const scriptPath = resolveScript(scriptName);
  if (!fs.existsSync(scriptPath)) {
    console.error(`[local-runner] 脚本不存在: ${scriptPath}`);
    return { status: 1, timedOut: false };
  }

  // POSIX: spawnSync 的 timeout 只向**直接子进程**发信号，子进程再 spawn 出来的孙进程
  // 会被 init 收养后继续跑，比 hook 活得还久。detached 让子进程成为进程组组长，
  // 其后代默认继承同一进程组，超时后即可按负 pid 整组回收。
  // Windows 上 libuv 把子进程挂进 job object 会级联终止，不需要也没有进程组语义。
  const groupKillable = process.platform !== 'win32';

  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    input: stdinData,
    encoding: 'utf8',
    env: childEnvironment(),
    cwd: process.cwd(),
    timeout: Math.max(1, timeoutMs),
    windowsHide: true,
    detached: groupKillable,
    stdio: stdinData ? ['pipe', 'pipe', 'pipe'] : 'inherit',
  });

  // 只在确实超时时整组回收：此时子进程刚被杀，pid 尚未被系统回收再分配，
  // 按负 pid 杀掉的必然是这一组，不会误伤无关进程。
  if (groupKillable && result.error?.code === 'ETIMEDOUT' && Number.isInteger(result.pid) && result.pid > 0) {
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch {
      // 进程组已自行退出：ESRCH，属正常路径
    }
  }

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error || result.status === null || result.signal) {
    const timedOut = result.error?.code === 'ETIMEDOUT';
    const status = timedOut ? 124 : 1;
    structuredFailure(scriptName, {
      status,
      timedOut,
      signal: result.signal,
      errorCode: timedOut
        ? 'HOOK_DEADLINE_EXCEEDED'
        : result.signal ? 'HOOK_SIGNALLED' : result.error?.code || 'HOOK_EXEC_ERROR',
    });
    return { status, timedOut };
  }

  return { status: result.status, timedOut: false };
}

function parseDeadline(args) {
  const cleaned = [];
  let deadlineMs = Number.parseInt(process.env.CLAUDE_HOOK_DEADLINE_MS || '', 10);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) deadlineMs = 30000;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--deadline-ms') {
      const value = Number.parseInt(args[index + 1] || '', 10);
      if (Number.isFinite(value) && value > 0) deadlineMs = value;
      index += 1;
      continue;
    }
    cleaned.push(args[index]);
  }
  return { args: cleaned, deadlineMs };
}

function main() {
  const parsed = parseDeadline(process.argv.slice(2));
  const args = parsed.args;
  const deadlineAt = Date.now() + parsed.deadlineMs;
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
      const bypass = evaluateScriptBypass(script, payload);
      if (bypass.allowed) {
        continue;
      }
      if (shouldSkipScript(script, payload)) continue;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        structuredFailure(script, {
          status: 124,
          timedOut: true,
          signal: null,
          errorCode: 'HOOK_DEADLINE_EXCEEDED',
        });
        highestStatus = Math.max(highestStatus, 124);
        break;
      }
      const { status, timedOut } = runSingle(script, extraArgs, stdinData, remainingMs);
      if (status > highestStatus) highestStatus = status;
      if (timedOut) break;
      if (status === 2) break; // 硬拦截信号，停止后续检查
    }
    process.exit(highestStatus);
  }

  // 单脚本模式（向后兼容）
  const payload = parsePayload(stdinData);
  const bypass = evaluateScriptBypass(args[0], payload);
  if (bypass.allowed) {
    process.exit(0);
  }
  const { status } = runSingle(args[0], args.slice(1), stdinData, parsed.deadlineMs);
  process.exit(status);
}

main();
