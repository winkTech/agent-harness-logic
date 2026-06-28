#!/usr/bin/env node
/**
 * engine/scripts/hooks/verification-gate.cjs — 验证闭环硬门禁 (P0)
 *
 * ⚠️ 验证必须是功能验证，不只是语法检查 ⚠️
 *
 * 强制规则: 编辑文件后必须先运行**功能验证**命令，否则阻断后续 Bash 操作。
 * 所谓"功能验证"是指：用真实场景确认修改生效，而不是跑 lint/type-check 清门禁。
 *
 * 示例（正确）:
 *   - 改 Hook 脚本 → 用真实 stdin 格式调用 + 检查副作用
 *   - 改 RTL 模块   → vsim 仿真 + 波形检查
 *   - 改 Python 逻辑 → pytest 真实测试用例
 *
 * 示例（错误 — 仅清门禁，不算验证）:
 *   - 改 Hook 脚本 → 只跑 node --check
 *   - 改 RTL 模块   → 只跑 vlog -lint
 *   - 改 Python 逻辑 → 只跑 ruff check
 *
 * 门禁自身无法判断命令质量，它只检查命令名。真正的验证质量依赖开发者自律。
 * 见 memory: verification-must-be-functional
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

/**
 * ⚠️ 两层验证模式 ⚠️
 *
 * 第一层 — 语法检查 (LINT_PATTERNS): 仅检查语法/风格，不清除待验证标记。
 *   匹配时输出 "仅语法检查通过，仍需功能验证"，保留 edited=true 状态。
 *   目的: 防止"跑个 lint 就算验证了"的虚假通过。
 *
 * 第二层 — 功能验证 (TEST_PATTERNS): 用真实场景确认修改生效。
 *   匹配时输出 "✅ 功能验证通过" + 清除待验证标记。
 *   例: 改 Hook 脚本 → 用真实 stdin 格式调用 + 检查 SQLite
 *       改 RTL 模块   → vsim 仿真 + 波形/数据对比
 *       改 Python 逻辑 → pytest 加真实测试用例
 *
 * 自定义验证 (CUSTOM_PATTERNS): 项目特有功能验证，行为同第二层。
 */

/** 第二层: 功能验证命令 — 清除「待验证」标记 ✅ */
const TEST_PATTERNS = [
  // Python 测试
  /^pytest\b/,
  /^python\s+-m\s+pytest\b/,
  /^python\s+-m\s+unittest\b/,
  // HDL 仿真 — 运行仿真 = 功能验证
  /^vsim\b/,
  /^xsim\b/,
  /^make\b/,
  /^make\s+(regress|sim|test|check|run)\b/,
  // Node/JS 测试
  /^npm\s+test\b/,
  /^npm\s+run\s+test\b/,
  /^jest\b/,
  /^vitest\b/,
  /^uv\s+run\s+pytest\b/,
  /^uvx\s+pytest\b/,
  // Go
  /^go\s+test\b/,
  // Java/Scala
  /^sbt\s+test\b/,
  /^mvn\s+test\b/,
  /^gradle\s+test\b/,
  // Rust
  /^cargo\s+test\b/,
  /** 项目自定义功能验证 — 编辑此数组添加 */
];

/** 第一层: 仅语法/风格检查 — 不清除待验证标记，提示仍需功能验证 ⚠️ */
const LINT_PATTERNS = [
  // Python
  /^ruff\s+check\b/,
  /^ruff\s+format\s+--check\b/,
  /^flake8\b/,
  /^black\s+--check\b/,
  /^mypy\b/,
  // Node/JS
  /^tsc\s+--noEmit\b/,
  /^eslint\b/,
  /^biome\s+check\b/,
  /^biome\s+ci\b/,
  /^npm\s+run\s+check\b/,
  /^npm\s+run\s+lint\b/,
  // Go
  /^go\s+vet\b/,
  // Rust
  /^cargo\s+check\b/,
  // HDL — vlog 单独调用是语法检查，不算功能验证
  /^vlog\b/,
  // Node 脚本检查
  /^node\s+--check\b/,
  /** 项目自定义语法检查 — 编辑此数组添加 */
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
  // 逃生开关: CLAUDE_GATES_DISABLED=true 跳过所有门禁
  if (process.env.CLAUDE_GATES_DISABLED === 'true') process.exit(0);

  // --reset: 清除待验证标记
  if (process.argv.includes('--reset')) {
    writeState({ edited: false, verified: false, editCount: 0, lastEditTime: null, lastVerifyTime: null });
    console.error('[VerificationGate] ✅ 验证状态已重置');
    process.exit(0);
  }

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

  // ── PostToolUse: 编辑代码文件 → 标记待验证 ───────────────────────────────
  if ((eventName === 'PostToolUse' || !eventName) && ['edit', 'write', 'multiedit'].includes(toolName)) {
    // 仅代码文件触发验证标记，文档/配置/gate 文件不触发
    const fp = (payload?.tool_input?.file_path || payload?.tool?.input?.file_path || payload?.input?.file_path || '').toLowerCase();
    const isCode = /\.(sv|v|vh|py|c|cpp|h|vhd)$/i.test(fp);
    const isGateFile = /[\/\\]var[\/\\]gates[\/\\]/.test(fp) || fp.endsWith('verify-gate.json');
    if (isCode && !isGateFile) {
      markEdited();
    }
    process.exit(0);
  }

  // ── PreToolUse: Bash 命令 → 检查验证状态 ─────────────────────────────────
  if ((eventName === 'PreToolUse' || !eventName) && (toolName === 'bash' || payload?.tool_name === 'Bash') && command) {
    const state = readState();

    // 没有待验证的修改 → 放行
    if (!state.edited) process.exit(0);

    // 命令是第二层: 功能验证 → 放行 + 清除标记 ✅
    if (matchesAny(command, TEST_PATTERNS)) {
      markVerified();
      process.exit(0);
    }

    // 命令是第一层: 仅语法检查 → 放行但不清除标记，提示仍需功能验证 ⚠️
    if (matchesAny(command, LINT_PATTERNS)) {
      console.error('');
      console.error('╔══════════════════════════════════════════════════════════════╗');
      console.error('║  ⚠️  LINT PASSED — 仍需功能验证                           ║');
      console.error('╠══════════════════════════════════════════════════════════════╣');
      console.error('║  语法检查通过，但验证门禁仍为「待验证」状态。                ║');
      console.error('║  根据 rules/00-core.md: "验证 = 功能验证，不只是语法检查"     ║');
      console.error('║                                                              ║');
      console.error('║  请继续运行功能验证命令 (如 pytest / vsim / E2E stdin 调用):  ║');
      console.error('║  - Hook 脚本 → echo \'{"hook_event":...}\' | node hook.cjs   ║');
      console.error('║  - Python   → pytest <test_file>                            ║');
      console.error('║  - HDL      → vsim -c -do "run -all" <testbench>             ║');
      console.error('╚══════════════════════════════════════════════════════════════╝');
      console.error('');
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
    console.error('║  已编辑文件但尚未通过功能验证。                               ║');
    console.error('║  根据 rules/00-core.md 验证闭环铁律:                          ║');
    console.error('║    「改代码后必须跑对应的验证，不验证不提交」                 ║');
    console.error('║                                                              ║');
    console.error('║  ❌ 仅跑语法检查不算验证。                                     ║');
    console.error('║  ✅ 请运行功能验证 (pytest / vsim / E2E stdin 调用)           ║');
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
