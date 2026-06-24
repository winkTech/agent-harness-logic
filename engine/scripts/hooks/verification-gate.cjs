#!/usr/bin/env node
/**
 * engine/scripts/hooks/verification-gate.cjs — 验证闭环硬门禁 (P0)
 *
 * 强制规则: 编辑文件后必须先运行验证命令，否则阻断后续 Bash 操作。
 *
 * 机制:
 *   PostToolUse(Edit|Write|MultiEdit) — 标记「有待验证的修改」
 *   PreToolUse(Bash) — 检查标记:
 *     - 无标记 → 放行
 *     - 命令匹配 VERIFY_PATTERNS → 放行 + 清除标记
 *     - 命令匹配 SAFE_PATTERNS → 放行（保留标记）
 *     - 其他 → exit 2 拦截 + 提示先验证
 *
 * 状态文件: ~/.claude/var/verify-gate.json
 *
 * 退出码:
 *   0 — 放行
 *   2 — 硬拦截 (exit 2 = Hook 系统硬拦截)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOMEDIR = os.homedir();
const STATE_DIR = path.join(HOMEDIR, '.claude', 'var');
const STATE_FILE = path.join(STATE_DIR, 'verify-gate.json');

// ── 模式定义 ────────────────────────────────────────────────────────────────

/** 验证命令模式 — 执行后清除「待验证」标记 */
const VERIFY_PATTERNS = [
  /^pytest\b/,
  /^python\s+-m\s+pytest\b/,
  /^python\s+-m\s+unittest\b/,
  /^vlog\b/,
  /^vsim\b/,
  /^make\b/,
  /^make\s+test\b/,
  /^make\s+check\b/,
  /^ruff\s+check\b/,
  /^ruff\s+format\s+--check\b/,
  /^flake8\b/,
  /^mypy\b/,
  /^black\s+--check\b/,
  /^npm\s+test\b/,
  /^npm\s+run\s+test\b/,
  /^npm\s+run\s+check\b/,
  /^cargo\s+test\b/,
  /^cargo\s+check\b/,
  /^go\s+test\b/,
  /^go\s+vet\b/,
  /^sbt\s+test\b/,
  /^mvn\s+test\b/,
  /^gradle\s+test\b/,
  /^jest\b/,
  /^vitest\b/,
  /^uv\s+run\s+pytest\b/,
  /^uvx\s+pytest\b/,
  /^tsc\s+--noEmit\b/,
  /^eslint\b/,
  /^biome\s+check\b/,
  /^biome\s+ci\b/,
  /** 用户自定义验证命令 — 可编辑此数组添加项目特有验证 */
];

/** 安全只读命令 — 放行但保留「待验证」标记 */
const SAFE_PATTERNS = [
  /^ls\b/,
  /^cd\b/,
  /^which\b/,
  /^type\b/,
  /^pwd\b/,
  /^dir\b/,
  /^date\b/,
  /^whoami\b/,
  /^id\b/,
  /^printenv\b/,
  /^env\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^less\b/,
  /^more\b/,
  /^git\s+status\b/,
  /^git\s+diff\b/,
  /^git\s+log\b/,
  /^git\s+blame\b/,
  /^git\s+show\b/,
  /^git\s+branch\b/,
  /^git\s+remote\b/,
  /^git\s+config\b/,
  /^(?:python|node|go|rustc|javac)\s+--version\b/,
  /^(?:python|node|go|rustc)\s+-V\b/,
  /^\s*#/,
  /^\s*$/,
];

// ── 状态管理 ─────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* 忽略损坏文件 */ }
  return { edited: false, verified: false, editCount: 0, lastEditTime: null, lastVerifyTime: null };
}

function writeState(state) {
  ensureDir(STATE_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function markEdited() {
  const state = readState();
  state.edited = true;
  state.verified = false;
  state.editCount = (state.editCount || 0) + 1;
  state.lastEditTime = new Date().toISOString();
  writeState(state);
}

function markVerified() {
  const state = readState();
  state.edited = false;
  state.verified = true;
  state.lastVerifyTime = new Date().toISOString();
  writeState(state);
}

// ── stdin 读取 ───────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
  });
}

// ── 模式匹配 ─────────────────────────────────────────────────────────────────

function matchesAny(cmd, patterns) {
  for (const re of patterns) {
    if (re.test(cmd)) return true;
  }
  return false;
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // 解析失败不阻断
  }

  // 提取事件名和工具名 (兼容多种 stdin 格式)
  const eventName = payload?.hook_event_name || '';
  const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  const command = (payload?.tool_input?.command || payload?.tool?.input?.command || payload?.input?.command || payload?.command || '').trim();

  // ── PostToolUse: 编辑工具 → 标记待验证 ───────────────────────────────────
  if ((eventName === 'PostToolUse' || !eventName) && ['edit', 'write', 'multiedit'].includes(toolName)) {
    markEdited();
    process.exit(0);
  }

  // ── PreToolUse: Bash 命令 → 检查验证状态 ─────────────────────────────────
  if ((eventName === 'PreToolUse' || !eventName) && (toolName === 'bash' || payload?.tool_name === 'Bash') && command) {
    const state = readState();

    // 没有待验证的修改 → 放行
    if (!state.edited) process.exit(0);

    // 命令是验证命令 → 放行 + 清除标记
    if (matchesAny(command, VERIFY_PATTERNS)) {
      markVerified();
      process.exit(0);
    }

    // 命令是安全只读命令 → 放行（保留标记）
    if (matchesAny(command, SAFE_PATTERNS)) {
      process.exit(0);
    }

    // 其他命令 → 拦截
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║    🔒 VERIFICATION GATE — 验证闭环硬门禁                   ║');
    console.error('╠══════════════════════════════════════════════════════════════╣');
    console.error('║                                                              ║');
    console.error('║  已编辑文件但尚未验证。                                       ║');
    console.error('║  根据 rules/00-core.md 验证闭环铁律:                          ║');
    console.error('║    「改代码后必须跑对应的验证，不验证不提交」                 ║');
    console.error('║                                                              ║');
    console.error('║  请先运行验证命令 (如 pytest / vlog / make / ruff check)      ║');
    console.error('║  然后重试此操作。                                             ║');
    console.error('║                                                              ║');
    console.error('║  [VerificationGate] 命令被阻断:                              ║');
    console.error(`║  ${command.slice(0, 72).padEnd(72)}║`);
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
    process.exit(2);
  }

  process.exit(0);
}

main();
