#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/hooks/loop-controller.cjs — Stop 钩子上的任务循环控制器。
 *
 * harness 原本只有门禁 (一次判决就结束) 和观测 (离线报表), 没有闭环: 判定"没
 * 收敛"之后没有任何机制把工作顶回去继续。Stop 是唯一能做这件事的位置 ——
 * decision:block 会让 agent 带着理由继续干。
 *
 * 每次 Stop 的处理:
 *   1. 没有 active 循环 → 直接放行 (普通会话零开销, 这是不敢把 Stop 变门禁的
 *      关键安全阀: 只有显式 loop-ctl start 过的任务才会被拦)
 *   2. stop_hook_active=true → 放行 (Claude Code 的防死循环协议, 必须遵守)
 *   3. 判据全绿 → converged, 放行并打印收敛摘要
 *   4. 预算耗尽 → exhausted, 放行并明确说"未收敛", 绝不谎报成功
 *   5. 其余 → 记一轮迭代, block 并注入未满足判据 + 失败指纹 + 换方法建议
 *
 * 任何内部异常一律 fail-open: 循环控制器是助推器, 不是安全门禁。
 */

const fs = require('node:fs');

const {
  payloadCwd, findProjectRoot, scopeId,
} = require('../lib/project-scope.cjs');

const BOM = new RegExp('^' + String.fromCharCode(0xFEFF));

function readPayload() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8').replace(BOM, ''); } catch { return {}; }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function readOnlyMode() {
  return process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1';
}

function sessionIdOf(payload) {
  return String(payload?.session_id || payload?.sessionId || payload?.thread_id || '').trim();
}

/**
 * 计算一次 Stop 的决定。纯函数式: 所有副作用集中在 store 调用上, 便于契约测试
 * 注入临时库。
 *
 * @param {object} payload — Stop hook 载荷
 * @param {object} [deps]
 * @returns {{ decision: 'allow'|'block', status: string, reason?: string, loopId?: string, detail?: object }}
 */
function evaluateStop(payload = {}, deps = {}) {
  const store = deps.store || require('../../sqlite/store-loops.cjs');
  const criteria = deps.criteria || require('../lib/loop-criteria.cjs');
  const dbOpts = deps.db ? { db: deps.db } : {};

  const cwd = payloadCwd(payload, process.cwd());
  const projectRoot = findProjectRoot(cwd, { fallback: cwd });
  const sessionId = sessionIdOf(payload);
  const scope = scopeId(projectRoot);

  const loop = store.getActiveLoop({ scopeId: scope, sessionId }, dbOpts);
  if (!loop) return { decision: 'allow', status: 'no_active_loop' };

  // Claude Code 的防死循环协议: 上一次 Stop 已经 block 过, 这次必须放行。
  if (payload?.stop_hook_active === true) {
    return { decision: 'allow', status: 'stop_hook_active', loopId: loop.id };
  }

  const verdict = criteria.evaluate(loop.exitCriteria, {
    projectRoot,
    sessionId,
    loopCreatedAt: loop.createdAt,
  });

  // ── 收敛 ────────────────────────────────────────────────────────────────
  if (verdict.converged) {
    if (!readOnlyMode()) {
      store.recordIteration(loop.id, {
        verdict: 'pass',
        actionSummary: 'exit criteria all met',
        verdictDetail: verdict.results,
        evidenceSha: verdict.results.map((r) => r.evidenceSha).find(Boolean) || null,
      }, dbOpts);
      store.closeLoop(loop.id, 'converged', dbOpts);
    }
    return {
      decision: 'allow',
      status: 'converged',
      loopId: loop.id,
      reason: `[loop ${loop.iteration + 1}/${loop.budgetIters}] 收敛: ${loop.goal} — `
        + verdict.results.map((r) => `${r.type}✓`).join(' '),
      detail: verdict,
    };
  }

  // ── 未收敛: 先落一轮迭代, 才能判断"是不是同一个坑" ──────────────────────
  const { signature, strategyHint } = require('../lib/failure-signature.cjs');
  const sig = signature(verdict.failureText || verdict.unmet.map((u) => u.detail).join(' '), {
    scope: loop.id,
  });

  const nextIteration = loop.iteration + 1;
  const exhausted = nextIteration >= loop.budgetIters;

  let repeats = 1;
  if (!readOnlyMode()) {
    repeats = store.repeatStreak(loop.id, sig.fingerprint, dbOpts) + 1;
    store.recordIteration(loop.id, {
      verdict: 'fail',
      actionSummary: `unmet: ${verdict.unmet.map((u) => u.type).join(',')}`,
      failureFp: sig.empty ? null : sig.fingerprint,
      failureFamily: sig.empty ? null : sig.family,
      unmet: verdict.unmet,
      verdictDetail: verdict.results,
      strategy: repeats >= 2 ? strategyHint(sig.family, repeats) : null,
    }, dbOpts);
  }

  const unmetText = verdict.unmet
    .map((u) => `${u.type}${u.unreadable ? '(读不出结论)' : ''}: ${u.detail}`)
    .join('; ');

  // ── 预算耗尽: 放行, 但如实说未收敛 ─────────────────────────────────────
  if (exhausted) {
    if (!readOnlyMode()) store.closeLoop(loop.id, 'exhausted', dbOpts);
    return {
      decision: 'allow',
      status: 'exhausted',
      loopId: loop.id,
      reason: `[loop ${nextIteration}/${loop.budgetIters}] 迭代预算耗尽但**未收敛** — 剩余未满足判据: ${unmetText}。`
        + '不要把它当作完成: 如实报告未闭环的部分, 或用 loop-ctl start 重开一个预算更大的循环。',
      detail: verdict,
    };
  }

  // ── 停滞: 预算还没烧完, 但再跑一轮也不会绿 ─────────────────────────────
  //
  // 此前的出口只有"收敛"和"预算耗尽"两个, 于是一个早就陷在同一个坑里的循环,
  // 仍会把剩下的预算一轮轮烧完才停 —— 满足了"继续下一轮"的条件, 却没满足
  // "这一轮值得继续"的条件。
  //
  // 停滞不关闭循环, 也不判定放弃: 放行 + 如实说清停在哪, 由人决定继续、换判据
  // 还是显式 abandon。系统替人做这个决定, 就是把责任接口也一起自动化掉了。
  // 只读诊断模式下不评估 —— 那时本轮迭代没有落库, 历史是残缺的。
  const progress = readOnlyMode()
    ? { stalled: false, reason: null, signals: {} }
    : criteria.assessProgress(store.listIterations(loop.id, dbOpts));
  if (progress.stalled) {
    return {
      decision: 'allow',
      status: 'stalled',
      loopId: loop.id,
      reason: `[loop ${nextIteration}/${loop.budgetIters}] 循环停滞: ${progress.reason}。\n`
        + `剩余未满足判据 — ${unmetText}\n`
        + '这不是完成: 循环仍是 active, 继续推进、修正判据或 loop-ctl abandon 由你判断。',
      detail: { ...verdict, progress },
    };
  }

  // ── 继续干 ──────────────────────────────────────────────────────────────
  const lines = [
    `[loop ${nextIteration}/${loop.budgetIters}] 目标未收敛: ${loop.goal}`,
    `未满足判据 — ${unmetText}`,
  ];
  if (repeats >= 2 && !sig.empty) {
    lines.push(`⚠ 同一失败指纹 ${sig.fingerprint} 已连续 ${repeats} 轮 — ${strategyHint(sig.family, repeats)}`);
  }
  lines.push('继续推进直到判据全绿; 若判定判据本身有误, 用 loop-ctl abandon 显式关闭并说明原因。');

  return {
    decision: 'block',
    status: 'not_converged',
    loopId: loop.id,
    reason: lines.join('\n'),
    detail: { ...verdict, repeats, fingerprint: sig.fingerprint },
  };
}

function emit(result) {
  if (result.decision === 'block') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason }));
    return;
  }
  // 放行路径只写 stderr: Stop 钩子的 stdout 一旦有内容就会被当成协议输出。
  if (result.reason) process.stderr.write(`[loop-controller] ${result.reason}\n`);
}

function main() {
  const payload = readPayload();
  let result;
  try {
    result = evaluateStop(payload);
  } catch (error) {
    process.stderr.write(`[loop-controller] fail-open: ${error.message}\n`);
    return;
  }
  emit(result);
}

if (require.main === module) main();

module.exports = { main, evaluateStop, readOnlyMode };
