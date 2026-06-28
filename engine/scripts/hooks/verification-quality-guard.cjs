#!/usr/bin/env node
/**
 * engine/scripts/hooks/verification-quality-guard.cjs — 验证质量门禁 (P0)
 *
 * 强制规则: 创建新 Testbench/测试文件前，必须先完成:
 *   1. 项目环境画像 (A.1)
 *   2. 最少场景集 (A.2)
 * 未完成 → exit 2 硬阻断。
 *
 * 机制:
 *   PreToolUse(Write) on new tb_* or test_* files — check gate status
 *     - 文件已存在 (修改已有 TB) → 放行
 *     - 门禁状态 "completed" → 放行
 *     - 门禁状态 "pending" 或不存在 → exit 2 阻断
 *
 * 状态文件: ~/.claude/var/gates/verification-quality.json
 *
 * 退出码:
 *   0 — 放行
 *   2 — 硬拦截
 *
 * 集成: 注册在 settings.json PreToolUse(Write)
 *
 * ⚠️ 支持两种调用方式:
 *   1. 独立 hook: node verification-quality-guard.cjs (读 stdin)
 *   2. 模块导入: const guard = require('./verification-quality-guard.cjs') (传 toolUse 对象)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOMEDIR = os.homedir();
const GATES_DIR = path.join(HOMEDIR, '.claude', 'var', 'gates');
const STATE_FILE = path.join(GATES_DIR, 'verification-quality.json');

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

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getMissingProfileItems(state) {
  if (!state || !state.env_profile) return REQUIRED_PROFILE_ITEMS;
  return REQUIRED_PROFILE_ITEMS.filter(d => {
    const v = state.env_profile[d.key];
    return v !== true && v !== 'done';
  });
}

function getMissingScenarios(state) {
  if (!state || !state.scenarios) return REQUIRED_SCENARIO_CATEGORIES;
  return REQUIRED_SCENARIO_CATEGORIES.filter(d => {
    const v = state.scenarios[d.key];
    return v !== true && v !== 'done';
  });
}

// ── 门禁检查核心逻辑 ─────────────────────────────────────────────────────

function checkGate(filePath) {
  // 只检查 TB/测试文件
  if (!isTBFile(filePath)) return false;

  // 文件已存在 = 修改已有 TB → 放行
  if (fileExists(filePath)) return false;

  // ── 新 TB 文件 → 检查门禁状态 ──────────────────────────────────────

  const state = loadState();
  const gateCompleted = state && state.status === 'completed';

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

  console.error(`
╔${line}╗
║  🧪 验证质量门禁 — VERIFICATION QUALITY GATE                     ║
╠${line}╣
║                                                                ║
║  创建新 Testbench 前，必须先完成:                                ║
║    A.1 项目环境画像 (8 项)                                       ║
║    A.2 最少场景集 (5 类)                                         ║
║  根据 rules/16-verification-quality-gate.md:                     ║
║    「单元验证失真 → 集成爆炸 → agent 无法独立调试 → 人工救火」 ║
║                                                                ║
║  ${state && state.module ? `目标模块: ${state.module}`.padEnd(boxWidth - 4) + '║' : '暂无活跃模块记录'.padEnd(boxWidth - 4) + '║'}
║                                                                ║
${sections}║  操作:                                                          ║
║  1. 完成项目环境画像 (A.1: 时钟/复位/接口/数据/帧/背压/吞吐/邻居) ║
║  2. 定义最少场景集 (A.2: S1~S5 每类至少 1 个用例)                ║
║  3. 将结果写入                                                   ║
║     var/gates/verification-quality.json (status: "completed")     ║
║  4. 重新执行 Write                                               ║
║                                                                ║
║  详细: rules/16-verification-quality-gate.md                     ║
║  证据: memory/learnings/verification-quality-wifi-evidence.md    ║
╚${line}╝
`);

  return true; // 需要阻断
}

// ── 独立运行入口 ──────────────────────────────────────────────────────────

async function main() {
  if (process.env.CLAUDE_GATES_DISABLED === 'true') process.exit(0);

  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  if (!raw) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  const filePath = (payload?.tool_input?.file_path || payload?.tool?.input?.file_path || payload?.input?.file_path || payload?.arguments?.file_path || '').trim();

  if (toolName !== 'write') process.exit(0);
  if (checkGate(filePath)) process.exit(2);
  process.exit(0);
}

// ── 模块导出（兼容 require 调用） ────────────────────────────────────────

module.exports = function verificationQualityGuard(toolUse, context) {
  if (process.env.CLAUDE_GATES_DISABLED === 'true') return;
  if (!toolUse || toolUse.name !== 'Write') return;
  const input = toolUse.input || {};
  const filePath = input.filePath || input.file_path;
  if (!filePath) return;
  if (checkGate(filePath)) process.exit(2);
};

if (require.main === module) {
  main();
}
