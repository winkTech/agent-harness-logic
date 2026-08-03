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

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');
const { updateJsonFileSync } = require('../lib/project-scope.cjs');

const p = require('node:path');
const f = require('node:fs');

const HOME = HARNESS_ROOT;
const STATE_FILE = process.env.CLAUDE_RUNTIME_STATE_FILE || p.join(HOME, 'var', 'index', 'runtime-state.json');
const FAILURE_SIGNAL_THROTTLE_MS = 60 * 1000;
// failureCount 的语义是"连续失败"——证据超过时效窗口后不再构成强制切换的依据。
// 没有可解析时间戳的计数同样视为陈旧:宁可少注入一次提醒,不可跨会话误报。
const FAILURE_EVIDENCE_TTL_MS = 60 * 60 * 1000;

const MODES = ['根因分析', '第一性原理', '减法', '搜索优先', '倒推', '证据驱动', '闭环'];

// ── 挫败关键词（中英双语） ──────────────────────────────────────────────
//
// 这里只收**用户表达不满**的措辞, 不收技术词汇。
//
// 曾经收过 /timeout/i、/failed/i、/exit code \d+/i、/non-zero exit/i, 后果是:
// 用户只要在提示词里提到 "timeout" 就被记一次失败 —— 实测 runtime-state 的
// failureHistory 里连续三条 trigger 都是 "timeout", 而那段时间没有任何工具失败,
// 于是每条后续提示都被注入"已连续失败 3 次, 强制切换到根因分析"。
// 真实的工具失败证据来自 runtime_events 的 tool_fail (见 realFailureStreak),
// 不需要也不应该靠在自然语言里猜技术词。
const FRUSTRATION_PATTERNS = [
  // 中文
  /不对/i, /又错/i, /还是不行/i, /再试试/i, /换一种/i, /卡住/i, /绕圈/i,
  /没解决/i, /没用/i, /不行/i, /不对啊/i, /怎么还/i, /重来/i, /重新做/i,
  /不对呀/i, /还没好/i, /不行啊/i,
  // English
  /not working/i, /still broken/i, /wrong/i, /try again/i, /nope/i,
  /doesn't work/i, /stuck/i, /useless/i, /same error/i,
];

/** 真实失败流的回看窗口: 超过此时长的 tool_fail 不再构成"连续失败"。 */
const FAILURE_STREAK_WINDOW_MS = 30 * 60 * 1000;
/** 同一失败指纹重复到该次数即触发换方法 (对应 CLAUDE.md 的停止规则)。 */
const REPEAT_THRESHOLD = 2;

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

function updateState(mutator) {
  return updateJsonFileSync(STATE_FILE, () => ({}), (state) => mutator(state) || state);
}

function shouldThrottleFailureSignal(state, signal, mutateState = updateState) {
  if (!signal) return false;
  const now = Date.now();
  let throttled = false;
  mutateState((current) => {
    const key = [
      signal.mode || '',
      signal.forceModeSwitch ? 'force' : 'suggest',
      signal.deEscalate ? 'deescalate' : 'active',
      current.failureCount || 0,
      // 指纹进入节流键: 换了一个新的坑就该重新提醒, 不能被上一个坑的节流吞掉
      signal.streak?.fingerprint || '',
      signal.streak?.repeats || 0,
    ].join(':');
    const last = current.frustrationDetectorLastSignal || {};
    const lastAt = Date.parse(last.at || '');
    throttled = last.key === key
      && Number.isFinite(lastAt)
      && now - lastAt < FAILURE_SIGNAL_THROTTLE_MS;
    if (!throttled) current.frustrationDetectorLastSignal = { key, at: new Date(now).toISOString() };
    return current;
  });
  return throttled;
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

function lastFailureEvidenceAt(state) {
  let latest = NaN;
  for (const entry of state?.failureHistory || []) {
    const at = Date.parse(entry?.at || '');
    if (Number.isFinite(at) && !(at <= latest)) latest = at;
  }
  for (const call of state?.toolCalls || []) {
    if (call?.result === 'ok' || call?.result === 'success') continue;
    const at = Date.parse(call?.at || '');
    if (Number.isFinite(at) && !(at <= latest)) latest = at;
  }
  return latest;
}

function isFailureEvidenceStale(state, now = Date.now()) {
  if (!state || !(state.failureCount > 0)) return false;
  const evidenceAt = lastFailureEvidenceAt(state);
  return !Number.isFinite(evidenceAt) || now - evidenceAt > FAILURE_EVIDENCE_TTL_MS;
}

/**
 * 从 runtime_events 的 tool_fail 里算出**真实**失败流。
 *
 * 与 state.failureCount 的区别: 这里的每一条都是真的工具失败, 且按共享的失败
 * 指纹分组 —— "同一个坑重复 N 次"才是换方法的依据, "失败了 N 次但每次都是不同
 * 的坑"说明在推进, 不该打断。
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionId] — 限定会话; 缺省则不查询 (跨会话计数无意义)
 * @param {number} [opts.windowMs]
 * @param {number} [opts.now]
 * @param {object} [opts.db] — 注入连接 (测试用)
 * @returns {{ total: number, repeats: number, fingerprint: string|null, family: string|null, tool: string|null }}
 */
function realFailureStreak(opts = {}) {
  const empty = { total: 0, repeats: 0, fingerprint: null, family: null, tool: null };
  const sessionId = String(opts.sessionId || '').trim();
  if (!sessionId) return empty;

  const now = opts.now || Date.now();
  const windowMs = opts.windowMs ?? FAILURE_STREAK_WINDOW_MS;
  const since = new Date(now - windowMs).toISOString();

  let handle = null;
  try {
    let db = opts.db;
    if (!db) {
      handle = require('../../sqlite/index.cjs').openDb({ readonly: true });
      db = handle.db;
    }
    const rows = db.prepare(`
      SELECT payload FROM runtime_events
      WHERE session_id = ? AND type = 'tool_fail' AND created_at >= ?
      ORDER BY event_id DESC LIMIT 40
    `).all(sessionId, since);
    if (rows.length === 0) return empty;

    const { signature } = require('../lib/failure-signature.cjs');
    const counts = new Map();
    let top = null;
    for (const row of rows) {
      let payload = {};
      try { payload = JSON.parse(row.payload); } catch { /* 载荷损坏: 跳过该条 */ }
      const sig = signature(payload.error || payload.stderr || payload.message, {
        tool: payload.tool || '',
      });
      if (sig.empty) continue;
      const entry = counts.get(sig.fingerprint) || { count: 0, sig };
      entry.count++;
      counts.set(sig.fingerprint, entry);
      if (!top || entry.count > top.count) top = entry;
    }
    if (!top) return { ...empty, total: rows.length };
    return {
      total: rows.length,
      repeats: top.count,
      fingerprint: top.sig.fingerprint,
      family: top.sig.family,
      tool: top.sig.tool || null,
    };
  } catch {
    return empty; // 库不可读时退化为"无真实证据", 不臆造失败
  } finally {
    try { handle?.close(); } catch { /* 关闭失败不影响判定 */ }
  }
}

function checkToolFailure(state, opts = {}) {
  // ── 真实失败流优先: 同一指纹重复 ≥2 次 → 按停止规则强制换方法 ────────
  const streak = opts.streak || realFailureStreak(opts);
  if (streak.repeats >= REPEAT_THRESHOLD) {
    const { strategyHint } = require('../lib/failure-signature.cjs');
    return {
      mode: '根因分析',
      reason: `同一失败指纹 ${streak.fingerprint} (${streak.family}${streak.tool ? '/' + streak.tool : ''}) `
        + `在近期已重复 ${streak.repeats} 次 — ${strategyHint(streak.family, streak.repeats)}`,
      forceModeSwitch: true,
      evidence: 'tool_fail-events',
      streak,
    };
  }

  if (!state) return null;

  // ── 降级检测: 如果最近 5 次工具调用全部成功 → 复位 failureCount ────
  const recentCalls = (state.toolCalls || []).slice(-5);
  if (recentCalls.length >= 3 && recentCalls.every(c => c.result === 'ok' || c.result === 'success')) {
    // 连续成功 → 降级: 清除 failureCount 和 currentMode（切回闭环）
    if (state.failureCount > 0) {
      const oldMode = state.currentMode;
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

function persistenceDisabled(deps = {}) {
  return deps.persist === false
    || process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HOOK_NO_WRITE === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1';
}

function emitModeSignal(type, payload, deps = {}) {
  if (persistenceDisabled(deps)) return false;
  try {
    const emit = deps.emitSignal || require('../../hooks/learning/signal-collector.cjs').emitSync;
    emit(type, payload);
    return true;
  } catch {
    return false;
  }
}

function evaluateSignal(input, deps = {}, context = {}) {
  if (process.env.CLAUDE_BENCH === '1' && deps.allowBench !== true) return null;
  const loadState = deps.readState || readState;
  const mutateState = deps.updateState || updateState;
  const canPersist = !persistenceDisabled(deps);
  let state = loadState();

  if (isFailureEvidenceStale(state)) {
    if (canPersist) {
      state = mutateState((current) => {
        current.failureCount = 0;
        current.currentMode = '';
        return current;
      });
      emitModeSignal('mode_switch', {
        mode: '闭环',
        trigger: 'stale-failure-evidence',
        deEscalate: true,
        failureCount: 0,
      }, deps);
    } else {
      state = { ...state, failureCount: 0, currentMode: '' };
    }
  }

  const failureSignal = checkToolFailure(state, {
    sessionId: context.sessionId,
    ...(deps.streak ? { streak: deps.streak } : {}),
    ...(deps.db ? { db: deps.db } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (failureSignal) {
    if (canPersist && failureSignal.deEscalate) {
      state = mutateState((current) => {
        current.failureCount = 0;
        current.currentMode = '';
        return current;
      });
    }
    if (canPersist && shouldThrottleFailureSignal(state, failureSignal, mutateState)) return null;
    const isForce = failureSignal.forceModeSwitch === true;
    const trigger = failureSignal.evidence === 'tool_fail-events'
      ? 'repeated-failure-signature'
      : 'failure-count';
    const count = failureSignal.streak?.repeats ?? state?.failureCount ?? 0;
    emitModeSignal('mode_switch', {
      mode: failureSignal.mode,
      trigger,
      forceModeSwitch: isForce,
      deEscalate: failureSignal.deEscalate || false,
      failureCount: state?.failureCount || 0,
      ...(failureSignal.streak ? { fingerprint: failureSignal.streak.fingerprint } : {}),
    }, deps);
    return {
      source: 'frustration-detector',
      type: isForce ? 'mode-switch-force' : 'mode-switch-suggest',
      mode: failureSignal.mode,
      reason: failureSignal.reason,
      trigger,
      count,
      deEscalate: failureSignal.deEscalate || false,
      forceModeSwitch: isForce,
      suggestReset: failureSignal.suggestReset || false,
      instruction: isForce
        ? `【强制模式切换】${failureSignal.streak
            ? `同一失败重复 ${failureSignal.streak.repeats} 次 (指纹 ${failureSignal.streak.fingerprint})`
            : `failureCount=${state?.failureCount || 0}`}。立即切换到 ${failureSignal.mode} 模式。${failureSignal.suggestReset ? '当前 session 上下文可能已污染，建议保存进度后 /compact。' : ''}`
        : failureSignal.deEscalate
          ? '【自动降级】检测到连续成功，复位 failureCount 并切回闭环模式。'
          : `【模式切换建议】考虑切换到 ${failureSignal.mode} 模式以适应当前进展。`,
    };
  }

  const result = detect(input);
  if (!result.frustrated) return null;
  if (state && canPersist) {
    state = mutateState((current) => {
      current.failureCount = (current.failureCount || 0) + 1;
      current.failureHistory = current.failureHistory || [];
      current.failureHistory.push({
        count: current.failureCount,
        at: new Date().toISOString(),
        trigger: result.matches[0],
        suggestedMode: result.suggestion?.mode,
      });
      return current;
    });
  }
  emitModeSignal('mode_switch', {
    mode: result.suggestion.mode,
    trigger: 'keyword',
    keyword: result.matches[0],
    failureCount: state?.failureCount || 0,
  }, deps);
  return {
    source: 'frustration-detector',
    type: 'mode-switch-force',
    mode: result.suggestion.mode,
    reason: result.suggestion.reason,
    trigger: 'keyword',
    keyword: result.matches[0],
    failureCount: state?.failureCount || 0,
    forceModeSwitch: true,
    instruction: `【强制模式切换】检测到挫败关键词"${result.matches[0]}"。切换到 ${result.suggestion.mode} 模式。`,
  };
}

function retrieveContext(payload = {}, deps = {}) {
  const input = String(payload.prompt || payload.user_prompt || payload.message || '').slice(0, 2000);
  const signal = evaluateSignal(input, deps, {
    sessionId: payload.session_id || payload.sessionId || payload.thread_id || '',
  });
  if (!signal) return null;
  return {
    hookSpecificOutput: {
      hookEventName: payload.hook_event_name || 'UserPromptSubmit',
      additionalContext: [
        '[frustration-detector] 认知模式调整:',
        signal.instruction,
        `原因: ${signal.reason}`,
      ].join('\n'),
    },
  };
}

function readCliInput(deps = {}) {
  let input = deps.argv?.[0] || process.argv[2] || process.env.CLAUDE_USER_MESSAGE || '';
  if (!input && !process.stdin.isTTY) {
    try {
      const raw = (deps.readStdin || (() => f.readFileSync(0, 'utf8')))();
      if (raw) input = String(raw).slice(0, 2000);
    } catch { /* stdin not available */ }
  }
  return input;
}

function main(deps = {}) {
  const signal = evaluateSignal(readCliInput(deps), deps);
  if (!signal) return null;
  const write = deps.writeStdout || ((value) => process.stdout.write(value));
  write(`${JSON.stringify(signal)}\n`);
  return signal;
}

if (require.main === module) main();

module.exports = {
  MODES,
  FAILURE_EVIDENCE_TTL_MS,
  FAILURE_STREAK_WINDOW_MS,
  REPEAT_THRESHOLD,
  detect,
  realFailureStreak,
  checkToolFailure,
  lastFailureEvidenceAt,
  isFailureEvidenceStale,
  persistenceDisabled,
  evaluateSignal,
  retrieveContext,
  readCliInput,
  main,
};
