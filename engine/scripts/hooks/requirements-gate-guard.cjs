#!/usr/bin/env node
/**
 * engine/scripts/hooks/requirements-gate-guard.cjs — 需求澄清门禁 (P0)
 *
 * 强制规则: 创建新模块代码文件前，必须先完成 requirements-gate 六维澄清。
 * 未完成 → exit 2 硬阻断。
 *
 * 机制:
 *   PreToolUse(Write) on new .sv/.v/.py files — 检查门禁状态
 *     - 文件已存在 (修改已有代码) → 放行
 *     - 门禁状态 "completed" → 放行
 *     - 门禁状态 "pending" 或不存在 → exit 2 阻断
 *
 * 状态文件: ~/.claude/var/gates/requirements-gate.json
 *
 * 退出码:
 *   0 — 放行
 *   2 — 硬拦截
 *
 * 集成: 注册在 settings.json PreToolUse(Write)
 *
 * ⚠️ 支持两种调用方式:
 *   1. 独立 hook: node requirements-gate-guard.cjs (读 stdin)
 *   2. 模块导入: const guard = require('./requirements-gate-guard.cjs') (传 toolUse 对象)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findProjectRoot, stateHasScopeForFile } = require('../lib/project-scope.cjs');

const HOMEDIR = os.homedir();
const HOME_GATES_DIR = path.join(HOMEDIR, '.claude', 'var', 'gates');
const HOME_STATE_FILE = path.join(HOME_GATES_DIR, 'requirements-gate.json');

// ── 哪些文件类型触发门禁检查 ──────────────────────────────────────────────
const CODE_EXTENSIONS = ['.sv', '.v', '.vh', '.py', '.c', '.cpp', '.h', '.vhd'];
const EXCLUDED_PATTERNS = [
  /[/\\]tb_/,           // TB 文件由 verification-quality-guard 管辖
  /[/\\]test_/,          // 测试文件
  /_tb\.(sv|v|vhd)$/i,
  /_test\.(py|cpp)$/i,
  /[/\\]golden[/\\]/i,   // Golden model 目录
  /[/\\]matlab[/\\]/i,   // MATLAB 目录
];

// ── 维度定义（用于显示缺失维度）───────────────────────────────────────────
const REQUIRED_DIMENSIONS = [
  { key: 'D1_scope',              label: 'D1 范围与边界 — 做什么？不做什么？与谁交互？' },
  { key: 'D2_data_contract',      label: 'D2 数据契约 — 输入/输出格式？时序？帧边界？极端情况？' },
  { key: 'D3_success_criteria',   label: 'D3 成功标准 — 什么算对？有GM吗？怎么验证？' },
  { key: 'D4_algorithm',          label: 'D4 算法路径 — 处理步骤？决策点？数据依赖？' },
  { key: 'D5_micro_arch',         label: 'D5 微架构 — 流水线？FSM？位宽？存储？复位？' },
  { key: 'D6_risks',              label: 'D6 风险与未知 — 不确定什么？什么可能出错？' },
];

// ── 辅助函数 ──────────────────────────────────────────────────────────────

function isCodeFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  return CODE_EXTENSIONS.includes(ext);
}

function isExcluded(filePath) {
  return EXCLUDED_PATTERNS.some(re => re.test(filePath));
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function candidateStateFiles(filePath) {
  const files = [];
  const projectRoot = findProjectRoot(filePath || process.cwd(), { fallback: process.cwd() });
  files.push(path.join(projectRoot, 'var', 'gates', 'requirements-gate.json'));
  files.push(HOME_STATE_FILE);
  const seen = new Set();
  return files.filter((file) => {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadState(filePath = '') {
  for (const stateFile of candidateStateFiles(filePath)) {
    try {
      if (!fs.existsSync(stateFile)) continue;
      const raw = fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function normalizePath(p) {
  if (!p || typeof p !== 'string') return '';
  return path.resolve(p).toLowerCase();
}

function isInsidePath(child, parent) {
  const childPath = normalizePath(child);
  const parentPath = normalizePath(parent);
  if (!childPath || !parentPath) return false;
  return childPath === parentPath || childPath.startsWith(parentPath + path.sep);
}

function getScopeRoots(state) {
  const roots = [];
  if (!state || typeof state !== 'object') return roots;
  if (typeof state.projectRoot === 'string') roots.push(state.projectRoot);
  if (Array.isArray(state.projectRoots)) roots.push(...state.projectRoots);
  if (state.scope && typeof state.scope.projectRoot === 'string') roots.push(state.scope.projectRoot);
  if (state.scope && Array.isArray(state.scope.projectRoots)) roots.push(...state.scope.projectRoots);
  return roots.filter(Boolean);
}

function hasValidScopeForFile(state, filePath) {
  return stateHasScopeForFile(state, filePath);
}

function isGateCompletedForFile(state, filePath) {
  return state && state.status === 'completed' && hasValidScopeForFile(state, filePath);
}

function getPendingDimensions(state) {
  if (!state || !state.dimensions) return REQUIRED_DIMENSIONS;
  return REQUIRED_DIMENSIONS.filter(d => {
    const v = state.dimensions[d.key];
    return v !== 'confirmed' && v !== 'assumed' && v !== 'na';
  });
}

// ── 门禁检查核心逻辑 ─────────────────────────────────────────────────────

function checkGate(filePath) {
  // 只检查代码文件
  if (!isCodeFile(filePath)) return false;

  // 排除 TB/测试/golden/matlab
  if (isExcluded(filePath)) return false;

  // 文件已存在 = 修改已有代码 → 放行
  if (fileExists(filePath)) return false;

  // ── 新代码文件 → 检查门禁状态 ──────────────────────────────────────

  const state = loadState(filePath);
  const gateCompleted = isGateCompletedForFile(state, filePath);

  if (gateCompleted) {
    // 门禁已完成 → 放行
    return false;
  }

  // ── 门禁未完成 → 硬阻断 ──────────────────────────────────────────

  const pending = getPendingDimensions(state);
  const pendingList = pending.map(d => `  ❌ ${d.label}`).join('\n');

  const boxWidth = 66;
  const line = '═'.repeat(boxWidth);

  console.error(`
╔${line}╗
║  🔒 需求澄清门禁 — REQUIREMENTS GATE                          ║
╠${line}╣
║                                                                ║
║  创建新代码文件前，必须先完成六维需求澄清。                      ║
║  根据 rules/15-requirements-gate.md:                             ║
║    「认知边界不清晰 → 代码可靠性不可能高」                      ║
║                                                                ║
║  ${state && state.task ? `当前任务: ${state.task}`.padEnd(boxWidth - 4) + '║' : '暂无活跃任务记录'.padEnd(boxWidth - 4) + '║'}
║                                                                ║
║  未完成的维度:                                                  ║
${pendingList.split('\n').map(l => `║  ${l}`.padEnd(boxWidth + 1) + '║').join('\n')}
║                                                                ║
║  操作:                                                          ║
║  1. 与用户完成六维澄清对话                                      ║
║  2. 确认所有维度后，将结果写入                                   ║
║     var/gates/requirements-gate.json (status: "completed")       ║
║  3. 重新执行 Write/Edit                                         ║
║                                                                ║
║  详细: rules/15-requirements-gate.md                             ║
║  证据: memory/learnings/requirements-gate-wifi-evidence.md       ║
╚${line}╝
`);

  return true; // 需要阻断
}

// ── 独立运行入口 ──────────────────────────────────────────────────────────

async function main() {
  // 逃生开关
  if (process.env.CLAUDE_GATES_DISABLED === 'true') process.exit(0);

  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch { process.exit(0); }
  if (!raw) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const eventName = payload?.hook_event_name || '';
  const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  const filePath = (payload?.tool_input?.file_path || payload?.tool?.input?.file_path || payload?.input?.file_path || payload?.arguments?.file_path || '').trim();

  // 仅在 PreToolUse(Write) 时触发
  if (toolName !== 'write' && toolName !== 'edit') process.exit(0);

  if (checkGate(filePath)) {
    process.exit(2);
  }
  process.exit(0);
}

// ── 模块导出（兼容 require 调用） ────────────────────────────────────────

module.exports = function requirementsGateGuard(toolUse, context) {
  if (process.env.CLAUDE_GATES_DISABLED === 'true') return;
  if (!toolUse || (toolUse.name !== 'Write' && toolUse.name !== 'Edit')) return;
  const input = toolUse.input || {};
  const filePath = input.filePath || input.file_path;
  if (!filePath) return;
  if (checkGate(filePath)) {
    process.exit(2);
  }
};

// 直接运行时调用 main
if (require.main === module) {
  main();
}
