#!/usr/bin/env node
/**
 * engine/scripts/hooks/isolation-check.cjs — 隔离环境检查 (P0)
 *
 * SessionStart hook: 检查当前是否运行在隔离环境（容器/VM）中。
 * 如果在 bare-metal Windows/Git-Bash 中使用了 bypassPermissions 模式，
 * 发出警告。
 *
 * 隔离检测方法:
 *   1. 检查容器/VM 标记文件或环境变量
 *   2. 检查主机名是否暗示容器
 *   3. 记录检查结果供后续审计
 *
 * 退出码: 0 (仅警告，不阻断)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const HARNESS = HARNESS_ROOT;
const STATE_FILE = path.join(HARNESS, 'var', 'index', 'runtime-state.json');

// ── 隔离检测 ─────────────────────────────────────────────────────────────────

/**
 * 检测是否在容器/VM 中运行。
 * 返回 { isIsolated: boolean, indicators: string[], method: string }
 */
function detectIsolation() {
  const indicators = [];

  // 方法 1: /.dockerenv 文件
  try {
    if (fs.existsSync('/.dockerenv')) {
      indicators.push('/.dockerenv exists');
      return { isIsolated: true, indicators, method: 'docker' };
    }
  } catch { /* Windows 上 stat 根目录可能失败 */ }

  // 方法 2: /proc/1/cgroup 含 docker/kubepods
  try {
    if (fs.existsSync('/proc/1/cgroup')) {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      if (/docker|kubepods|lxc/i.test(cgroup)) {
        indicators.push('/proc/1/cgroup matches container pattern');
        return { isIsolated: true, indicators, method: 'cgroup' };
      }
    }
  } catch { /* Windows 无 /proc */ }

  // 方法 3: WSL 检测
  try {
    const release = os.release().toLowerCase();
    if (release.includes('wsl') || release.includes('microsoft')) {
      indicators.push(`kernel release: ${os.release()}`);
      return { isIsolated: true, indicators, method: 'wsl' };
    }
  } catch { /* ignore */ }

  // 方法 4: 环境变量标记
  const envFlags = [
    'RUNNING_IN_CONTAINER',
    'CLAUDE_CODE_ISOLATED',
    'DEVCONTAINER',
  ];
  for (const flag of envFlags) {
    if (process.env[flag] === 'true' || process.env[flag] === '1') {
      indicators.push(`${flag}=${process.env[flag]}`);
      return { isIsolated: true, indicators, method: 'env-flag' };
    }
  }

  // 方法 5: devcontainer 标记文件
  try {
    const cwd = process.cwd() || '.';
    if (fs.existsSync(path.join(cwd, '.devcontainer'))) {
      indicators.push('.devcontainer/ exists in workspace');
      return { isIsolated: true, indicators, method: 'devcontainer' };
    }
  } catch { /* ignore */ }

  return { isIsolated: false, indicators, method: 'bare-metal' };
}

/**
 * 读取当前权限模式。
 */
function getPermissionMode() {
  try {
    const settingsPath = path.join(HARNESS, 'settings.local.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const config = JSON.parse(raw);
      const mode = config?.permissions?.defaultMode || 'unknown';
      return mode;
    }
  } catch { /* ignore */ }
  return 'unknown';
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

function main() {
  const isolation = detectIsolation();
  const mode = getPermissionMode();

  // 记录到 runtime state
  try {
    let state = {};
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    state.lastIsolationCheck = {
      timestamp: new Date().toISOString(),
      isIsolated: isolation.isIsolated,
      method: isolation.method,
      permissionMode: mode,
      platform: process.platform,
    };
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch { /* ignore */ }

  // ── 警告逻辑 ──────────────────────────────────────────────────────────────
  let warnings = [];

  // 场景 1: bypassPermissions + 非隔离环境 = 高危
  if (mode === 'bypassPermissions' && !isolation.isIsolated) {
    warnings.push(
      '⚠️  高风险: bypassPermissions 模式 + 非隔离环境\n' +
      '    bypassPermissions 跳过了所有安全检查，包括提示注入防护。\n' +
      '    此模式仅应在隔离容器/VM/WSL 中使用。\n' +
      '    建议: 切换到 auto 模式以获得有分类器兜底的体验，\n' +
      '    或在 WSL/容器中运行后再使用 bypassPermissions。'
    );
  }

  // 场景 2: 非隔离环境但无 sandbox（Windows 不支持 sandbox）
  if (process.platform === 'win32' && !isolation.isIsolated) {
    warnings.push(
      'ℹ️  提示: Windows 原生不支持沙箱 (Sandbox)\n' +
      '    在 WSL2 中运行 Claude Code 可以获得沙箱隔离能力。\n' +
      '    当前防护依赖: 权限规则(deny) + Hook 硬拦截 + 断路器。'
    );
  }

  // 输出警告到 stderr（会显示在终端但不会阻断）
  if (warnings.length > 0) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║           🛡️  ISOLATION CHECK — 环境安全检查              ║');
    console.error('╠══════════════════════════════════════════════════════════════╣');
    for (const w of warnings) {
      console.error(`║  ${w.replace(/\n/g, '\n║  ')}`);
      console.error('║                                                              ║');
    }
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
  }

  process.exit(0); // 仅警告，不阻断
}

main();
