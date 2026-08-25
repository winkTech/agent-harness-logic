#!/usr/bin/env node
/**
 * engine/scripts/hooks/requirements-gate-guard.cjs — 需求澄清门禁 (P0)
 *
 * 建议规则: 创建新模块代码文件前，先完成 requirements-gate 六维澄清。
 * 未完成 → 打印提示，**不阻断**。
 *
 * 机制:
 *   PreToolUse(Write) on new .sv/.v/.py files — 检查门禁状态
 *     - 文件已存在 (修改已有代码) → 静默放行
 *     - 门禁状态 "completed" → 静默放行
 *     - 门禁状态 "pending" 或不存在 → stderr 提示缺失维度后放行
 *
 * 状态文件: ~/.claude/var/gates/requirements-gate.json
 *
 * 退出码:
 *   0 — 始终放行 (本 hook 不再有阻断路径)
 *
 * 集成: 注册在 settings.json PreToolUse(Write)
 *
 * ⚠️ 支持两种调用方式:
 *   1. 独立 hook: node requirements-gate-guard.cjs (读 stdin)
 *   2. 模块导入: const guard = require('./requirements-gate-guard.cjs') (传 toolUse 对象)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findProjectRoot, stateHasTaskTargetForFile } = require('../lib/project-scope.cjs');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');
const { evaluateGuardBypass } = require('../lib/gate-bypass.cjs');

const GATE_ID = 'requirements-gate-guard.cjs';

const HOME_GATES_DIR = path.join(HARNESS_ROOT, 'var', 'gates');
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

function hasValidScopeForFile(state, filePath) {
  return stateHasTaskTargetForFile(state, filePath);
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

function hookSuccessOutput(advisory, eventName = 'PreToolUse') {
  return {
    hookSpecificOutput: {
      hookEventName: eventName || 'PreToolUse',
      additionalContext: JSON.stringify(advisory),
    },
  };
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

  // ── 门禁未完成 → 提示, 不阻断 ────────────────────────────────────
  //
  // 这道门禁**不再硬阻断**。原因: 它唯一的放行条件是模型自己往
  // var/gates/requirements-gate.json 写一个 status:"completed" 的 JSON,
  // 既无 schema 校验、无有效期、也无写保护 —— 阻断只会训练模型伪造门禁
  // 记录, 并对临时脚本、工具文件等非项目代码大量误报。
  // 需求澄清的价值在于提示思考, 不在于拦住写操作。真正该硬拦的是
  // 有客观证据的节点 (见 hdl-coding-dag-workflow.js 的 Phase 4.5:
  // 校验 check_results/<mod>.json 真实存在且 status===PASS)。

  const pending = getPendingDimensions(state);
  const findings = pending.length > 0
    ? pending.map(d => ({ severity: 'warning', code: d.key, message: d.label }))
    : [{
      severity: 'warning',
      code: 'gate-status',
      message: 'Requirements dimensions exist, but the gate is not completed for this file scope.',
    }];

  return {
    schemaVersion: 1,
    kind: 'harness-advisory',
    source: 'requirements-gate',
    status: 'warning',
    blocking: false,
    target: filePath,
    gateStatus: state?.status || 'missing',
    summary: 'Before creating this code file, review the requirements dimensions from docs/rules/03-gates.md.',
    findings,
    guidance: 'When evidence is sufficient, record confirmed assumptions and continue without asking redundant questions.',
  };
}

// ── 独立运行入口 ──────────────────────────────────────────────────────────

function evaluate(payload, runtime = {}) {
  if (evaluateGuardBypass({ gateId: GATE_ID, payload, context: runtime.context }).allowed) {
    return { source: GATE_ID, decision: 'allow', diagnostics: [] };
  }
  const eventName = String(payload?.hook_event_name || payload?.event || '').toLowerCase();
  if (eventName && eventName !== 'pretooluse') return { source: GATE_ID, decision: 'allow', diagnostics: [] };
  const toolName = String(payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  if (toolName !== 'write' && toolName !== 'edit') return { source: GATE_ID, decision: 'allow', diagnostics: [] };
  const input = payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
  const filePath = String(runtime.filePath || input.file_path || input.filePath || '').trim();
  if (!filePath) return { source: GATE_ID, decision: 'allow', diagnostics: [] };
  const advisory = checkGate(filePath);
  if (!advisory) return { source: GATE_ID, decision: 'allow', diagnostics: [] };
  return { source: GATE_ID, decision: 'warn', diagnostics: advisory.findings || [], advisories: [advisory] };
}

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch { process.exit(0); }
  if (!raw) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  if (evaluateGuardBypass({ gateId: GATE_ID, payload }).allowed) process.exit(0);

  const eventName = payload?.hook_event_name || '';
  const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  const filePath = (payload?.tool_input?.file_path || payload?.tool?.input?.file_path || payload?.input?.file_path || payload?.arguments?.file_path || '').trim();

  // 仅在 PreToolUse(Write) 时触发
  if (toolName !== 'write' && toolName !== 'edit') process.exit(0);

  const advisory = checkGate(filePath);
  if (advisory) process.stdout.write(JSON.stringify(hookSuccessOutput(advisory, eventName)));
  process.exit(0);
}

// ── 模块导出（兼容 require 调用） ────────────────────────────────────────

module.exports = function requirementsGateGuard(toolUse, context) {
  if (evaluateGuardBypass({ gateId: GATE_ID, payload: toolUse, context }).allowed) return;
  if (!toolUse || (toolUse.name !== 'Write' && toolUse.name !== 'Edit')) return;
  const input = toolUse.input || {};
  const filePath = input.filePath || input.file_path;
  if (!filePath) return;
  return checkGate(filePath); // 只提示, 不阻断
};

// 直接运行时调用 main
if (require.main === module) {
  main();
}

module.exports.evaluate = evaluate;
