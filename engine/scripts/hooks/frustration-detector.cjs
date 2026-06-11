#!/usr/bin/env node
/**
 * Frustration Detector — L4 认知层
 *
 * 检测挫败感信号并触发推理模式切换。
 * 由 PreToolUse/PostMessage hook 触发。
 *
 * 信号类型：
 *   1. 用户消息中的挫败关键词（"不对" / "又错了" / "还是不行"）
 *   2. 工具调用连续失败（runtime-state failureCount 过高）
 *   3. 同一工具重复调用未产生 diff（工具调用轨迹分析）
 *
 * 输出：命中时打印 JSON 行，hook 框架将其注入到 Claude 的上下文中。
 */

const p = require('path');
const f = require('fs');
const os = require('os');

const HOME = p.join(os.homedir(), '.claude');
const STATE_FILE = p.join(HOME, 'var', 'index', 'runtime-state.json');
const MODES = ['根因分析', '第一性原理', '减法', '搜索优先', '倒推', '证据驱动', '闭环'];

// ── 挫败关键词（中英双语） ──────────────────────────────────────────────
const FRUSTRATION_PATTERNS = [
  // 中文
  /不对/i, /又错/i, /还是不行/i, /再试试/i, /换一种/i, /卡住/i, /绕圈/i,
  /没解决/i, /没用/i, /不行/i, /不对啊/i, /怎么还/i, /重来/i, /重新做/i,
  /不对呀/i, /还没好/i, /不行啊/i,
  // English
  /not working/i, /still broken/i, /wrong/i, /try again/i, /nope/i,
  /doesn't work/i, /failed/i, /stuck/i, /useless/i, /same error/i,
  // Mixed (tool failure signals)
  /exit code \d+/i, /non-zero exit/i, /timeout/i,
];

const MODE_SUGGESTIONS = [
  { patterns: [/不对/i, /又错/i, /还是不行/i, /wrong/i, /still broken/i], mode: '根因分析', reason: '检测到结果不符预期，需要 5-Why 追查根因' },
  { patterns: [/再试试/i, /换一种/i, /卡住/i, /绕圈/i, /stuck/i, /try again/i], mode: '搜索优先', reason: '当前路径未产生进展，需要先搜索同类方案再判断' },
  { patterns: [/太复杂/i, /精简/i], mode: '减法', reason: '检测到复杂度信号，优先删除而非增加' },
  { patterns: [/从用户/i, /预期/i], mode: '倒推', reason: '涉及用户体验决策，从终态倒推' },
  { patterns: [/测一下/i, /数据/i, /性能/i, /measure/i], mode: '证据驱动', reason: '需要测量数据替代直觉判断' },
  { patterns: [/重新/i, /从零/i, /从头/i], mode: '第一性原理', reason: '需要质疑所有假设，回归本质' },
];

function readState() {
  try { return JSON.parse(f.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function writeState(state) {
  f.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function detect(text) {
  if (!text) return { frustrated: false };

  const matches = [];
  for (const pattern of FRUSTRATION_PATTERNS) {
    const m = text.match(pattern);
    if (m) matches.push(m[0]);
  }

  if (matches.length === 0) return { frustrated: false };

  // Find mode suggestion
  let suggestion = null;
  for (const entry of MODE_SUGGESTIONS) {
    for (const pattern of entry.patterns) {
      if (text.match(pattern)) {
        suggestion = { mode: entry.mode, reason: entry.reason };
        break;
      }
    }
    if (suggestion) break;
  }

  // Default suggestion if none matched
  if (!suggestion) {
    suggestion = { mode: '第一性原理', reason: '检测到挫败信号，需要回归本质重新分析' };
  }

  return { frustrated: true, matches, suggestion };
}

function checkToolFailure(state) {
  if (!state) return null;

  // ── 降级检测: 如果最近 5 次工具调用全部成功 → 复位 failureCount ────
  const recentCalls = (state.toolCalls || []).slice(-5);
  if (recentCalls.length >= 3 && recentCalls.every(c => c.result === 'ok' || c.result === 'success')) {
    // 连续成功 → 降级: 清除 failureCount 和 currentMode（切回闭环）
    if (state.failureCount > 0) {
      state.failureCount = 0;
      const oldMode = state.currentMode;
      state.currentMode = '';
      writeState(state);
      return { mode: '闭环', reason: `${recentCalls.length} 次连续成功，从 ${oldMode || '高失败'} 模式降级回闭环`, deEscalate: true };
    }
  }

  // ── 升级检测: 根据失败次数升级模式 ────────────────────────────────
  // 已有模式 + 仍失败 → 建议更强模式
  if (state.failureCount >= 5 && state.currentMode) {
    // 已在某种模式但还在失败 → 升到第一性原理
    if (state.currentMode !== '第一性原理') {
      return {
        mode: '第一性原理',
        reason: `已在 ${state.currentMode} 模式但累计失败 ${state.failureCount} 次，当前范式已证明不可行，强制切换到第一性原理`,
        forceModeSwitch: true,
      };
    }
    // 已到第一性原理还失败 → 建议 session 重置
    return {
      mode: '第一性原理',
      reason: `累计失败 ${state.failureCount} 次，即便第一性原理也无法突破。建议: 执行 /handoff 保存进度后 /compact 重置会话`,
      forceModeSwitch: true,
      suggestReset: true,
    };
  }

  // 连续失败 ≥3 次且无模式 → 切入根因分析
  if (state.failureCount >= 3 && !state.currentMode) {
    return { mode: '根因分析', reason: `已连续失败 ${state.failureCount} 次，需要切换到根因分析模式`, forceModeSwitch: true };
  }
  if (state.failureCount >= 5) {
    return { mode: '第一性原理', reason: `累计失败 ${state.failureCount} 次，当前范式已证明不可行，需要回归第一性原理`, forceModeSwitch: true };
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────

// Try arg first, then env var, then stdin
let input = process.argv[2];
if (!input) {
  input = process.env.CLAUDE_USER_MESSAGE || '';
}
// If still empty, try reading from stdin (non-blocking)
if (!input && !process.stdin.isTTY) {
  try {
    const fd = require('fs').readFileSync(0, 'utf8').slice(0, 2000);
    if (fd) input = fd;
  } catch { /* stdin not available */ }
}
const state = readState();

// 1. Check tool failure count
const failureSignal = checkToolFailure(state);
if (failureSignal) {
  const isForce = failureSignal.forceModeSwitch === true;
  console.log(JSON.stringify({
    source: 'frustration-detector',
    type: isForce ? 'mode-switch-force' : 'mode-switch-suggest',
    mode: failureSignal.mode,
    reason: failureSignal.reason,
    trigger: 'failure-count',
    count: state?.failureCount || 0,
    deEscalate: failureSignal.deEscalate || false,
    forceModeSwitch: isForce,
    suggestReset: failureSignal.suggestReset || false,
    // 注入强制指令（Claude 必须执行的切换命令）
    instruction: isForce
      ? `【强制模式切换】failureCount=${state?.failureCount || 0}。立即切换到 ${failureSignal.mode} 模式。${failureSignal.suggestReset ? '当前 session 上下文可能已污染，建议保存进度后 /compact。' : ''}`
      : failureSignal.deEscalate
        ? `【自动降级】检测到连续成功，复位 failureCount 并切回闭环模式。`
        : `【模式切换建议】考虑切换到 ${failureSignal.mode} 模式以适应当前进展。`,
  }));
  process.exit(0);
}

// 2. Check for frustration keywords in input
const result = detect(input);
if (result.frustrated) {
  // Bump failure count
  if (state) {
    state.failureCount = (state.failureCount || 0) + 1;
    state.failureHistory = state.failureHistory || [];
    state.failureHistory.push({
      count: state.failureCount,
      at: new Date().toISOString(),
      trigger: result.matches[0],
      suggestedMode: result.suggestion?.mode,
    });
    writeState(state);
  }

  console.log(JSON.stringify({
    source: 'frustration-detector',
    type: 'mode-switch-force',
    mode: result.suggestion.mode,
    reason: result.suggestion.reason,
    trigger: 'keyword',
    keyword: result.matches[0],
    failureCount: state?.failureCount || 0,
    forceModeSwitch: true,
    instruction: `【强制模式切换】检测到挫败关键词"${result.matches[0]}"。切换到 ${result.suggestion.mode} 模式。`,
  }));
  process.exit(0);
}
