'use strict';

/**
 * context-monitor.cjs — PreToolUse safety hook
 *
 * 监控上下文使用率，在每次工具调用前检查并注入告警。
 * 使用本地轮次计数器估算上下文占用，不依赖运行时 budget-tracker.json。
 *
 * 阈值：>= 40% 注入告警，要求立即 /compact
 * 同一会话仅告警一次（哨兵文件防重复）。
 *
 * 状态持久化在 .claude/context/runtime/context-monitor-state.json。
 *
 * Fail-open: 任何错误时静默退出（allow: true，不阻塞工作流）。
 */

const fs = require('fs');
const path = require('path');

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 触发阈值：上下文使用 >= 40% 即要求立即 /compact */
const TRIGGER_THRESHOLD_PCT = 0.4;

/** 默认上下文预算（token 数）*/
const DEFAULT_BUDGET = 200_000;

/** 每轮对话的估算 token 数 */
const TOKENS_PER_TURN = 5_000;

/** 状态文件路径（相对于项目根目录）*/
const STATE_REL_PATH = path.join('.claude', 'context', 'runtime', 'context-monitor-state.json');
const RUNTIME_DIR_REL = path.join('.claude', 'context', 'runtime');

// ─── 路径工具 ───────────────────────────────────────────────────────────────

function findProjectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'CLAUDE.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();

// ─── 状态管理 ───────────────────────────────────────────────────────────────

function getStatePath() {
  return path.join(PROJECT_ROOT, STATE_REL_PATH);
}

function getRuntimeDir() {
  return path.join(PROJECT_ROOT, RUNTIME_DIR_REL);
}

/**
 * 读取持久化状态。文件不存在时返回 null。
 */
function readState() {
  const statePath = getStatePath();
  try {
    if (fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (_e) {
    // 忽略，返回默认值
  }
  return null;
}

/**
 * 写入持久化状态。
 */
function writeState(state) {
  try {
    const dir = getRuntimeDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (_e) {
    // 非致命
  }
}

// ─── Token 估算 ─────────────────────────────────────────────────────────────

/**
 * 估算当前上下文 token 使用量。
 *
 * 主方案：基于工具调用轮次 * TOKENS_PER_TURN
 * 交叉验证：读取 history.jsonl 文件大小作为参照（~0.25 token/byte）
 * 取两者较大值（偏保守，宁可早告警）
 */
function estimateTokens(state) {
  const turnEstimate = (state.callCount || 0) * TOKENS_PER_TURN;

  // 交叉验证：history.jsonl 文件大小（粗略参照）
  const historyPath = path.join(PROJECT_ROOT, 'history.jsonl');
  try {
    if (fs.existsSync(historyPath)) {
      const stats = fs.statSync(historyPath);
      // 每个字节约 0.25 token，但上限不超过 turnEstimate 的 2 倍
      const fileEstimate = Math.min(stats.size * 0.25, turnEstimate * 2);
      return Math.max(turnEstimate, Math.round(fileEstimate));
    }
  } catch (_e) {
    // 降级为轮次估算
  }

  return turnEstimate;
}

// ─── 阈值检查 ───────────────────────────────────────────────────────────────

/**
 * 检查是否达到告警水位。
 * 返回 { message }（触发告警）或 null（无需告警）。
 * 同一会话仅触发一次（哨兵文件防重复）。
 */
function checkThreshold(usagePct, tokensUsed, budget) {
  const usedPct = Math.round(usagePct * 100);
  const remaining = budget - tokensUsed;

  // 已触发过 → 静默
  if (sentinelExists('triggered')) return null;

  if (usagePct >= TRIGGER_THRESHOLD_PCT) {
    writeSentinel('triggered');
    return {
      message:
        `[context-monitor] ⚠️ 上下文已使用 ${usedPct}% ` +
        `(约 ${tokensUsed.toLocaleString()} / ${budget.toLocaleString()} tokens，` +
        `剩余 ~${remaining.toLocaleString()})。` +
        `请立即 /compact，否则响应速度严重下降。`,
    };
  }

  return null;
}

// ─── 哨兵管理（防止重复告警）─────────────────────────────────────────────────

function sentinelPath(tier) {
  return path.join(getRuntimeDir(), `context-monitor-${tier}.sentinel`);
}

function sentinelExists(tier) {
  return fs.existsSync(sentinelPath(tier));
}

function writeSentinel(tier) {
  try {
    fs.mkdirSync(getRuntimeDir(), { recursive: true });
    fs.writeFileSync(sentinelPath(tier), new Date().toISOString(), 'utf8');
  } catch (_e) {
    // 非致命
  }
}

/**
 * 清除哨兵文件（用于测试或会话重置）。
 */
function resetSentinels() {
  ['triggered'].forEach(tier => {
    try {
      const sp = sentinelPath(tier);
      if (fs.existsSync(sp)) fs.unlinkSync(sp);
    } catch (_e) { /* ignore */ }
  });
}

/**
 * 清除状态文件（用于测试或会话重置）。
 */
function resetState() {
  try {
    const sp = getStatePath();
    if (fs.existsSync(sp)) fs.unlinkSync(sp);
  } catch (_e) { /* ignore */ }
}

/**
 * 完整的会话重置：清除状态和哨兵文件。
 */
function resetAll() {
  resetSentinels();
  resetState();
}

// ─── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * PreToolUse hook 主函数。
 * 读取 stdin（hook 协议），完成后输出 JSON 响应。
 */
function main() {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    try {
      // 读取或初始化状态
      let state = readState();
      if (!state) {
        state = {
          callCount: 0,
          budget: DEFAULT_BUDGET,
          tokensPerTurn: TOKENS_PER_TURN,
          createdAt: new Date().toISOString(),
        };
      }

      // 增加工具调用计数器
      state.callCount = (state.callCount || 0) + 1;
      state.lastCallAt = new Date().toISOString();

      // 估算 token 用量
      const estimatedTokens = estimateTokens(state);
      const usagePct = estimatedTokens / state.budget;

      // 持久化更新后的状态
      writeState(state);

      // 检查水位
      const warning = checkThreshold(usagePct, estimatedTokens, state.budget);

      if (warning) {
        process.stdout.write(
          JSON.stringify({ allow: true, additionalContext: warning.message })
        );
      } else {
        process.stdout.write(JSON.stringify({ allow: true }));
      }

      process.exit(0);
    } catch (_err) {
      // 安全兜底：绝不阻塞工作流
      process.stdout.write(JSON.stringify({ allow: true }));
      process.exit(0);
    }
  });
}

// ─── 导出（便于测试）─────────────────────────────────────────────────────────

module.exports = {
  readState,
  writeState,
  estimateTokens,
  checkThreshold,
  resetSentinels,
  resetState,
  resetAll,
  TRIGGER_THRESHOLD_PCT,
  TOKENS_PER_TURN,
  DEFAULT_BUDGET,
};

if (require.main === module) {
  main();
}
