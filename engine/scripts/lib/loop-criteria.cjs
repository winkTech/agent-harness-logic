'use strict';

/**
 * engine/scripts/lib/loop-criteria.cjs — 循环收敛判据求值。
 *
 * 判据是**声明式**的: 一个 JSON 数组, 每项 {type, ...}。求值只回答一个问题 ——
 * "这个任务可以停了吗"。
 *
 * 硬语义 (与 docs/rules/05-harness.md #1/#2 一致):
 *   - 判据读不出结论 → met=false, 且 reason 说明为什么读不出。
 *     "看不出来"绝不等于"通过": 这正是账本自我矛盾那类事故的来源。
 *   - 没有任何判据 → 直接判未收敛, 不允许"空判据 = 全绿"。
 *
 * 支持的判据:
 *   { "type": "no_pending_verification" }
 *       var/verify-gate.json 里本 scope+session 没有未过期的待验证条目
 *   { "type": "evidence_passed", "contractHash": "...", "commandPattern": "..." }
 *       verification-ledger 里有 status=passed 且匹配的条目 (默认只认循环创建后的)
 *   { "type": "gate_green", "gate": "requirements-gate" }
 *       var/gates/<gate>.json 的 status 属于绿色集合
 *   { "type": "command", "run": "node x.cjs --check", "expectExit": 0 }
 *       白名单内的命令实际执行并核对退出码
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('./harness-root.cjs');
const { readJson, findProjectRoot, resolvePath } = require('./project-scope.cjs');

const GREEN_GATE_STATUS = new Set(['completed', 'passed', 'green', 'ok', 'approved']);

/** command 判据的可执行文件白名单 —— Stop 钩子不能变成任意命令执行器。 */
const COMMAND_ALLOWLIST = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn',
  'python', 'python3', 'pytest', 'uv',
  'make', 'cargo', 'go', 'git',
]);

/** 出现即拒绝的 shell 元字符 (命令以 shell:false 执行, 这些字符只会是注入企图)。 */
const SHELL_METACHARS = /[|&;<>`$(){}\[\]!*?~\n\r]/;

const COMMAND_TIMEOUT_MS = 30_000;

function ledgerPath() {
  return process.env.CLAUDE_EVIDENCE_LEDGER_FILE
    || path.join(HARNESS_ROOT, 'var', 'verification-ledger.json');
}

function gatesDir() {
  return process.env.CLAUDE_GATES_DIR || path.join(HARNESS_ROOT, 'var', 'gates');
}

// ── 单项判据 ────────────────────────────────────────────────────────────────

function evalNoPendingVerification(criterion, ctx) {
  let state;
  try {
    const vs = require('./verification-state.cjs');
    state = vs.readVerificationState();
    const pending = vs.pendingForCwd(state, ctx.projectRoot, { sessionId: ctx.sessionId || '' });
    return pending.length === 0
      ? { met: true, detail: '无未过期的待验证条目' }
      : {
        met: false,
        detail: `${pending.length} 条待验证未清: ${pending
          .flatMap((entry) => entry.files || [])
          .slice(0, 3)
          .map((file) => path.basename(file))
          .join(', ') || '(未记录文件)'}`,
      };
  } catch (error) {
    return { met: false, detail: `验证状态读取失败: ${error.message}`, unreadable: true };
  }
}

function evalEvidencePassed(criterion, ctx) {
  const ledger = readJson(ledgerPath(), null);
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : null;
  if (!entries) return { met: false, detail: '证据账本不可读', unreadable: true };

  const since = criterion.since === 'any' ? 0 : (ctx.loopCreatedAt || 0);
  const wantHash = criterion.contractHash ? String(criterion.contractHash) : null;
  let pattern = null;
  if (criterion.commandPattern) {
    try { pattern = new RegExp(criterion.commandPattern); }
    catch (error) { return { met: false, detail: `commandPattern 非法: ${error.message}`, unreadable: true }; }
  }
  if (!wantHash && !pattern) {
    return { met: false, detail: 'evidence_passed 需要 contractHash 或 commandPattern', unreadable: true };
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.status !== 'passed') continue;
    const at = Date.parse(entry.recordedAt || entry.completedAt || '');
    if (Number.isFinite(at) && at < since) break; // 账本按时间追加: 早于循环创建即可停止回溯
    if (wantHash && entry.contractHash !== wantHash && entry.behaviorContractHash !== wantHash) continue;
    if (pattern && !pattern.test(String(entry.command || ''))) continue;
    return {
      met: true,
      detail: `证据命中: ${String(entry.command || '').slice(0, 80)}`,
      evidenceSha: entry.contractHash || entry.behaviorContractHash || null,
    };
  }
  return { met: false, detail: '账本中没有匹配且通过的证据条目' };
}

function evalGateGreen(criterion) {
  const gate = String(criterion.gate || '').trim();
  if (!gate) return { met: false, detail: 'gate_green 缺少 gate 名', unreadable: true };
  if (gate.includes('..') || gate.includes('/') || gate.includes('\\')) {
    return { met: false, detail: `gate 名非法: ${gate}`, unreadable: true };
  }
  const file = path.join(gatesDir(), `${gate}.json`);
  const data = readJson(file, null);
  if (!data) return { met: false, detail: `门禁状态不可读: ${gate}.json`, unreadable: true };
  const status = String(data.status || '').toLowerCase();
  return GREEN_GATE_STATUS.has(status)
    ? { met: true, detail: `${gate}=${status}` }
    : { met: false, detail: `${gate}=${status || '(无 status 字段)'}` };
}

function evalCommand(criterion, ctx) {
  const raw = String(criterion.run || '').trim();
  if (!raw) return { met: false, detail: 'command 判据缺少 run', unreadable: true };
  if (SHELL_METACHARS.test(raw)) {
    return { met: false, detail: 'command 含 shell 元字符, 拒绝执行', unreadable: true };
  }
  const parts = raw.split(/\s+/);
  const exe = path.basename(parts[0]).replace(/\.(exe|cmd|bat)$/i, '');
  if (!COMMAND_ALLOWLIST.has(exe)) {
    return { met: false, detail: `命令不在白名单: ${exe}`, unreadable: true };
  }

  const expectExit = Number.isInteger(criterion.expectExit) ? criterion.expectExit : 0;
  const result = spawnSync(parts[0], parts.slice(1), {
    cwd: ctx.projectRoot || HARNESS_ROOT,
    encoding: 'utf8',
    timeout: criterion.timeoutMs || COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });

  if (result.error) {
    return { met: false, detail: `命令无法执行: ${result.error.message}`, unreadable: true };
  }
  if (result.signal) {
    return { met: false, detail: `命令被信号终止: ${result.signal}`, unreadable: true };
  }
  const met = result.status === expectExit;
  return {
    met,
    detail: met
      ? `exit=${result.status} (期望 ${expectExit})`
      : `exit=${result.status} ≠ 期望 ${expectExit}: ${(result.stderr || result.stdout || '').trim().slice(-160)}`,
    failureText: met ? null : `${raw}\n${(result.stderr || result.stdout || '').slice(-800)}`,
  };
}

const EVALUATORS = {
  no_pending_verification: evalNoPendingVerification,
  evidence_passed: evalEvidencePassed,
  gate_green: evalGateGreen,
  command: evalCommand,
};

// ── 进展评估 ────────────────────────────────────────────────────────────────
//
// evaluate() 回答"能不能停"—— 判据全绿即任务做完。这一段回答的是另一个问题:
// **"还值不值得继续"** —— 判据没绿, 而且再跑一轮大概率还是不绿。
//
// 两者必须分开。若把停滞并进 converged, `converged=true` 会同时意味着"做完了"
// 和"放弃了", 而这两件事对调用方的后续动作完全相反: 前者可以交付, 后者必须
// 如实报告未闭环。循环控制器此前只有"收敛"和"预算耗尽"两个出口, 于是一个
// 早就陷在同一个坑里的循环, 仍会把剩下的预算一轮轮烧完才停。
//
// 判据全部来自 loop_iterations 已有的列, 不新增采集:
//   failure_fp      同一个坑
//   failure_family  换了写法但同一个错误假设 —— 对应 CLAUDE.md 停止规则
//                   "计数针对同一假设而非同一条命令"
//   unmet           未满足判据数; 连续不下降 = 新增轮次没有让 done 更近
//
// 硬语义与 evaluate() 对偶但方向相反: 那边"读不出结论 ≠ 通过", 这边
// **"读不出结论 ≠ 停滞"**。停滞会放行并把决定交还给人, 误判的代价是打断一个
// 本来正在收敛的循环, 所以证据不足时一律判为未停滞。
const STALL_FINGERPRINT_STREAK = 3;   // 同一失败指纹连续 N 轮
const STALL_FAMILY_STREAK = 4;        // 同一失败家族连续 N 轮(换写法但同一假设)
const STALL_UNMET_PLATEAU = 4;        // 未满足判据数连续 N 轮不下降

/** 单轮的未满足判据数; 读不出返回 null(既不算进展也不算停滞)。 */
function unmetCount(iteration) {
  const raw = iteration?.unmet;
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : null;
    } catch { return null; }
  }
  return null;
}

/** 末尾连续取到同一非空值的轮数。 */
function trailingStreak(list, pick) {
  if (!list.length) return 0;
  const last = pick(list[list.length - 1]);
  if (!last) return 0;
  let streak = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (pick(list[i]) !== last) break;
    streak++;
  }
  return streak;
}

/**
 * 评估循环是否已经停滞。
 *
 * @param {Array<object>} iterations 按 iteration 升序的迭代历史
 * @returns {{stalled: boolean, reason: string|null, signals: object}}
 */
function assessProgress(iterations, opts = {}) {
  const list = Array.isArray(iterations) ? iterations : [];
  const fpStreakMax = opts.fingerprintStreak || STALL_FINGERPRINT_STREAK;
  const familyStreakMax = opts.familyStreak || STALL_FAMILY_STREAK;
  const plateauMax = opts.unmetPlateau || STALL_UNMET_PLATEAU;

  // 一次 pass 说明那个坑被填过, 之前的连败不该再累计到当前判断上。
  let lastPass = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.verdict === 'pass') { lastPass = i; break; }
  }
  const recent = list.slice(lastPass + 1);

  const fingerprintStreak = trailingStreak(recent, (it) => it?.failureFp || null);
  const familyStreak = trailingStreak(recent, (it) => it?.failureFamily || null);

  // 平台期: 从最后一轮往回数, 到最近一次"未满足数下降"为止。
  // 列表按时间升序, 所以 counts[i+1] 是更晚的一轮, 下降意味着 counts[i] > counts[i+1]。
  const counts = recent.map(unmetCount).filter((n) => Number.isInteger(n));
  let unmetPlateau = counts.length ? 1 : 0;
  for (let i = counts.length - 2; i >= 0; i--) {
    if (counts[i] > counts[i + 1]) break;  // 出现过下降 = 有实质进展
    unmetPlateau++;
  }

  const signals = { fingerprintStreak, familyStreak, unmetPlateau, iterationsSincePass: recent.length };

  // 所有指纹/家族判据都以"确认无实质进展"为前提。同一家族的失败被一个个消掉
  // 恰恰是收敛的样子 —— 只看 streak 会把正在收敛的循环判成停滞, 而停滞的误判
  // 代价正是打断它。证据不足(可读轮次 <2)时同样不判, 与"读不出结论≠停滞"一致。
  if (counts.length < 2) {
    return { stalled: false, reason: null, signals };
  }
  if (unmetPlateau === 1) {
    return { stalled: false, reason: null, signals };  // 最近一轮未满足数在下降
  }

  if (fingerprintStreak >= fpStreakMax) {
    return {
      stalled: true,
      reason: `同一失败指纹连续 ${fingerprintStreak} 轮未变 —— 再跑一轮大概率还是这个坑`,
      signals,
    };
  }
  if (familyStreak >= familyStreakMax) {
    return {
      stalled: true,
      reason: `失败家族 ${recent[recent.length - 1]?.failureFamily} 连续 ${familyStreak} 轮未变 —— `
        + '换过写法但假设没换, 按停止规则这应当计入换方法的计数',
      signals,
    };
  }
  if (unmetPlateau >= plateauMax) {
    return {
      stalled: true,
      reason: `未满足判据数连续 ${unmetPlateau} 轮没有下降 —— 新增轮次没有让目标变近`,
      signals,
    };
  }
  return { stalled: false, reason: null, signals };
}

/** 判据类型是否受支持 —— 供 loop-ctl 在创建时就拒绝错别字。 */
function isSupportedType(type) {
  return Object.hasOwn(EVALUATORS, String(type || ''));
}

/**
 * 求值全部判据。
 *
 * @param {Array<object>} criteria
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.sessionId]
 * @param {number} [ctx.loopCreatedAt]
 * @returns {{ converged: boolean, results: object[], unmet: object[], failureText: string|null }}
 */
function evaluate(criteria, ctx = {}) {
  const list = Array.isArray(criteria) ? criteria : [];
  const projectRoot = ctx.projectRoot
    ? findProjectRoot(resolvePath(ctx.projectRoot), { fallback: resolvePath(ctx.projectRoot) })
    : HARNESS_ROOT;
  const scoped = { ...ctx, projectRoot };

  if (list.length === 0) {
    // 空判据不得视为收敛 —— 否则"没写判据"就成了万能通行证。
    return {
      converged: false,
      results: [],
      unmet: [{ type: '(none)', met: false, detail: '未声明任何收敛判据' }],
      failureText: null,
    };
  }

  const results = list.map((criterion) => {
    const type = String(criterion?.type || '');
    const evaluator = EVALUATORS[type];
    if (!evaluator) {
      return { type, met: false, detail: `未知判据类型: ${type || '(空)'}`, unreadable: true };
    }
    try {
      return { type, ...evaluator(criterion, scoped) };
    } catch (error) {
      return { type, met: false, detail: `判据求值异常: ${error.message}`, unreadable: true };
    }
  });

  const unmet = results.filter((result) => !result.met);
  const failureText = results.map((result) => result.failureText).filter(Boolean).join('\n') || null;

  return { converged: unmet.length === 0, results, unmet, failureText };
}

module.exports = {
  assessProgress,
  evaluate,
  isSupportedType,
  COMMAND_ALLOWLIST,
  GREEN_GATE_STATUS,
  STALL_FAMILY_STREAK,
  STALL_FINGERPRINT_STREAK,
  STALL_UNMET_PLATEAU,
  SUPPORTED_TYPES: Object.keys(EVALUATORS),
};
