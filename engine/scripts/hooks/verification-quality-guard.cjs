#!/usr/bin/env node
/**
 * engine/scripts/hooks/verification-quality-guard.cjs — 验证质量门禁 (P0)
 *
 * 规则: 创建新 Testbench/测试文件前，应先完成:
 *   1. 项目环境画像 (A.1)
 *   2. 最少场景集 (A.2)
 *
 * ⚠️ 这是 **advisory 门禁，不阻断**（2026-07 刻意降级，见 §降级理由）。
 *
 * 机制:
 *   PreToolUse(Write|Edit|MultiEdit) on new tb_* or test_* files — check gate status
 *     - 文件已存在 (修改已有 TB) → 放行
 *     - 门禁状态 "completed" → 放行
 *     - 门禁状态 "pending" 或不存在 → 输出 advisory (additionalContext)，仍放行
 *
 * 降级理由: 放行的唯一条件是模型自己往状态 JSON 里写 status:"completed"，
 * 而那份 JSON 无 schema 校验、无有效期、无写保护。硬阻断在这种结构下不会带来
 * 更强的约束，只会训练模型伪造门禁记录；对临时脚本还会大量误报。
 * 真正的硬门禁应该建立在**可独立复核的产物**上，例见
 * workflows/hdl-coding-dag-workflow.js 的 Phase 4.5（校验 check_results/<mod>.json
 * 真实存在且 status===PASS）。
 *
 * 状态文件: ~/.claude/var/gates/verification-quality.json
 *
 * 退出码:
 *   0 — 始终（advisory 不阻断）
 *
 * 集成: 注册在 settings.json PreToolUse(Edit|Write|MultiEdit)
 *
 * ⚠️ 支持两种调用方式:
 *   1. 独立 hook: node verification-quality-guard.cjs (读 stdin)
 *   2. 模块导入: const guard = require('./verification-quality-guard.cjs') (传 toolUse 对象)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateGuardBypass } = require('../lib/gate-bypass.cjs');

const GATE_ID = 'verification-quality-guard.cjs';
const { findProjectRoot, stateHasScopeForFile } = require('../lib/project-scope.cjs');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const HOME_GATES_DIR = path.join(HARNESS_ROOT, 'var', 'gates');
const HOME_STATE_FILE = path.join(HOME_GATES_DIR, 'verification-quality.json');

// ── 哪些文件触发验证质量门禁 ────────────────────────────────────────────
const TB_PATTERNS = [
  /[/\\]tb_[\w-]+\.(sv|v|vhd)$/i,
  /[\w-]+_tb\.(sv|v|vhd)$/i,
  /[/\\]test_[\w-]+\.py$/i,
  /[\w-]+_test\.py$/i,
  /[/\\]testbench[\w-]*\.(sv|v|vhd)$/i,
  /[/\\]sim[/\\].+\.(sv|v)$/i,
  /[/\\]tb[/\\].+\.(sv|v)$/i,
];

// ── 环境画像必需项 ──────────────────────────────────────────────────────
const REQUIRED_PROFILE_ITEMS = [
  { key: 'clock',        label: '时钟 — 频率？几个时钟域？相位关系？' },
  { key: 'reset',        label: '复位 — 异步/同步？极性？持续 cycle 数？' },
  { key: 'interface',    label: '接口协议 — AXI-Stream？valid/ready？tlast/tkeep？' },
  { key: 'data_format',  label: '数据格式 — 位宽？打包方式？字节序？' },
  { key: 'frame_struct', label: '帧/包结构 — 帧长？tlast 何时置位？按什么粒度？' },
  { key: 'backpressure', label: '背压特征 — 下游反压模式？FIFO 深度？' },
  { key: 'throughput',   label: '吞吐模式 — 连续流？突发？最小间隔？' },
  { key: 'neighbor',     label: '邻居行为 — 上游/下游的数据节奏？' },
];

// ── 最少场景集必需类别 ──────────────────────────────────────────────────
const REQUIRED_SCENARIO_CATEGORIES = [
  { key: 'S1_basic',        label: 'S1 基础功能 — 单次激励 + GM 对比' },
  { key: 'S2_backpressure', label: 'S2 背压流控 — 随机/连续/恢复/背靠背反压' },
  { key: 'S3_frame_boundary', label: 'S3 帧/包边界 — 单帧/连续多帧/最小/最大/帧间间隙' },
  { key: 'S4_reset',        label: 'S4 复位异常 — 启动复位/运行中复位/帧间复位/异常输入' },
  { key: 'S5_throughput',   label: 'S5 吞吐极限 — 连续最大/最小间隔/突发模式' },
];

// ── 辅助函数 ──────────────────────────────────────────────────────────────

function isTBFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return TB_PATTERNS.some(re => re.test(filePath));
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
  files.push(path.join(projectRoot, 'var', 'gates', 'verification-quality.json'));
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

function getMissingProfileItems(state) {
  if (!state || !state.env_profile) return REQUIRED_PROFILE_ITEMS;
  return REQUIRED_PROFILE_ITEMS.filter(d => {
    const v = state.env_profile[d.key];
    return v !== true && v !== 'done' && v !== 'na';
  });
}

function getMissingScenarios(state) {
  if (!state || !state.scenarios) return REQUIRED_SCENARIO_CATEGORIES;
  return REQUIRED_SCENARIO_CATEGORIES.filter(d => {
    const v = state.scenarios[d.key];
    return v !== true && v !== 'done' && v !== 'na';
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
  // 只检查 TB/测试文件
  if (!isTBFile(filePath)) return false;

  // 文件已存在 = 修改已有 TB → 放行
  if (fileExists(filePath)) return false;

  // ── 新 TB 文件 → 检查门禁状态 ──────────────────────────────────────

  const state = loadState(filePath);
  const gateCompleted = isGateCompletedForFile(state, filePath);

  if (gateCompleted) {
    return false;
  }

  // ── 门禁未完成 → 硬阻断 ──────────────────────────────────────────

  const missingProfile = getMissingProfileItems(state);
  const missingScenarios = getMissingScenarios(state);

  const boxWidth = 66;
  const line = '═'.repeat(boxWidth);

  let sections = '';

  if (missingProfile.length > 0) {
    sections += `║  环境画像 — 缺失项:\n`;
    sections += missingProfile.map(d => `║    ❌ ${d.label}`).join('\n') + '\n';
    sections += `║\n`;
  }

  if (missingScenarios.length > 0) {
    sections += `║  最少场景集 — 缺失类别:\n`;
    sections += missingScenarios.map(d => `║    ❌ ${d.label}`).join('\n') + '\n';
    sections += `║\n`;
  }

  if (missingProfile.length === 0 && missingScenarios.length === 0 && !gateCompleted) {
    sections += `║  门禁状态未标记为 "completed"。\n`;
    sections += `║  请将验证方案写入 var/gates/verification-quality.json\n`;
    sections += `║\n`;
  }

  // ── 门禁未完成 → 提示, 不阻断 ────────────────────────────────────
  // 与 requirements-gate-guard 同理: 放行条件是模型自己写一份
  // var/gates/verification-quality.json, 阻断只会诱导伪造记录。
  // 验证质量的真实证据是 check_results/<mod>.json (Phase 4.5 校验)。
  const findings = [
    ...missingProfile.map(d => ({
      severity: 'warning',
      category: 'environment-profile',
      code: d.key,
      message: d.label,
    })),
    ...missingScenarios.map(d => ({
      severity: 'warning',
      category: 'verification-scenario',
      code: d.key,
      message: d.label,
    })),
  ];
  if (findings.length === 0) {
    findings.push({
      severity: 'warning',
      category: 'gate-status',
      code: 'gate-status',
      message: 'Verification profile exists, but the gate is not completed for this file scope.',
    });
  }

  return {
    schemaVersion: 1,
    kind: 'harness-advisory',
    source: 'verification-quality',
    status: 'warning',
    blocking: false,
    target: filePath,
    gateStatus: state?.status || 'missing',
    summary: 'Before creating this test, review the environment profile and applicable scenarios from docs/rules/03-gates.md.',
    findings,
    guidance: 'Mark genuinely inapplicable items as na with a reason; do not weaken executable checks to manufacture a pass.',
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
  if (toolName !== 'write') return { source: GATE_ID, decision: 'allow', diagnostics: [] };
  const input = payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
  const filePath = String(runtime.filePath || input.file_path || input.filePath || '').trim();
  if (!filePath) return { source: GATE_ID, decision: 'allow', diagnostics: [] };
  const advisory = checkGate(filePath);
  if (!advisory) return { source: GATE_ID, decision: 'allow', diagnostics: [] };
  return { source: GATE_ID, decision: 'warn', diagnostics: advisory.findings || [], advisories: [advisory] };
}

async function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  if (!raw) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }
  if (evaluateGuardBypass({ gateId: GATE_ID, payload }).allowed) process.exit(0);

  const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  const filePath = (payload?.tool_input?.file_path || payload?.tool?.input?.file_path || payload?.input?.file_path || payload?.arguments?.file_path || '').trim();
  const eventName = payload?.hook_event_name || 'PreToolUse';

  if (toolName !== 'write') process.exit(0);
  const advisory = checkGate(filePath);
  if (advisory) process.stdout.write(JSON.stringify(hookSuccessOutput(advisory, eventName)));
  process.exit(0);
}

// ── 模块导出（兼容 require 调用） ────────────────────────────────────────

module.exports = function verificationQualityGuard(toolUse, context) {
  if (evaluateGuardBypass({ gateId: GATE_ID, payload: toolUse, context }).allowed) return;
  if (!toolUse || toolUse.name !== 'Write') return;
  const input = toolUse.input || {};
  const filePath = input.filePath || input.file_path;
  if (!filePath) return;
  return checkGate(filePath); // 只提示, 不阻断
};

if (require.main === module) {
  main();
}

module.exports.evaluate = evaluate;
