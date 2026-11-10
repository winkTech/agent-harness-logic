'use strict';

/**
 * loop-controller-contract — 任务循环闭环的行为契约。
 *
 * 这里锁死的是闭环最容易出事的四个语义:
 *   1. 没有 active 循环时 Stop 必须零干预 (否则整个 harness 都会被拦住)
 *   2. stop_hook_active 必须放行 (Claude Code 防死循环协议)
 *   3. 判据读不出结论 ≠ 通过 (账本自相矛盾那类事故的根源)
 *   4. 预算耗尽是 exhausted, 措辞里必须出现"未收敛", 绝不能读成完成
 * 外加: 同一失败连续两轮要给出换方法建议 (CLAUDE.md 的停止规则)。
 *
 * 全程用 :memory: 库与临时门禁目录, 不碰 var/ 与真实 memory.db。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');
const { openDb } = require('../../sqlite/index.cjs');
const { scopeId, findProjectRoot } = require('../lib/project-scope.cjs');

const HOOK = path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'loop-controller.cjs');
const controller = require(HOOK);
const store = require('../../sqlite/store-loops.cjs');
const criteriaLib = require('../lib/loop-criteria.cjs');

const PROJECT_ROOT = findProjectRoot(HARNESS_ROOT, { fallback: HARNESS_ROOT });
const SCOPE = scopeId(PROJECT_ROOT);

// runner 会注入只读开关。本契约要验证的正是"写迭代"这条路径, 而写入目标全部是
// :memory: 库, 不触碰 var/ 与真实 memory.db, 因此在进程内清掉开关;
// 只读语义本身另由 assertReadOnlyHonored 显式打开开关来验证。
delete process.env.CLAUDE_HARNESS_NO_PERSIST;
delete process.env.CLAUDE_NO_DIAGNOSTIC_WRITES;

/**
 * 每个断言拿到一个干净的库。
 *
 * 注意 openDb 按路径缓存连接, `:memory:` 每次返回的是**同一个**实例 —— 直接
 * 复用会让断言之间隐性耦合 (前一个用例留下的 active 循环会污染下一个)。
 * 因此显式清表, 而不是指望"新连接"。
 */
function freshDb() {
  const handle = openDb({ path: ':memory:' });
  handle.db.exec('DELETE FROM loop_iterations; DELETE FROM task_loops;');
  return handle.db;
}

function stopPayload(extra = {}) {
  return {
    hook_event_name: 'Stop',
    cwd: PROJECT_ROOT,
    session_id: 'loop-controller-contract',
    ...extra,
  };
}

/** 判据桩: 直接返回预设结论, 把控制器逻辑与真实门禁读取解耦。 */
/**
 * 只桩掉判据求值。进展评估默认走真实实现 —— 否则"停滞"这条出口在所有既有
 * 用例里都被桩成永不触发, 契约就锁不住它。要强制停滞时显式传 progress。
 */
function stubCriteria(verdict, progress) {
  return {
    evaluate: () => verdict,
    assessProgress: progress ? () => progress : criteriaLib.assessProgress,
  };
}

// ── 1. 无循环 = 零干预 ───────────────────────────────────────────────────────

function assertNoLoopIsTransparent() {
  const db = freshDb();
  const result = controller.evaluateStop(stopPayload(), { db, store });
  assert.equal(result.decision, 'allow');
  assert.equal(result.status, 'no_active_loop');
  assert.equal(result.reason, undefined, '无循环时不得往上下文里塞任何东西');
}

// ── 2. stop_hook_active 必须放行 ─────────────────────────────────────────────

function assertStopHookActiveIsHonored() {
  const db = freshDb();
  store.createLoop({
    scopeId: SCOPE,
    sessionId: 'loop-controller-contract',
    goal: '防死循环协议',
    exitCriteria: [{ type: 'gate_green', gate: 'never-green' }],
  }, { db });

  const result = controller.evaluateStop(stopPayload({ stop_hook_active: true }), {
    db,
    store,
    criteria: stubCriteria({ converged: false, results: [], unmet: [{ type: 'gate_green', detail: 'x' }], failureText: null }),
  });
  assert.equal(result.decision, 'allow', 'stop_hook_active 时必须放行, 否则会和框架的重入保护打架');
  assert.equal(result.status, 'stop_hook_active');
}

// ── 3. 未收敛 → block; 判据读不出结论也算未收敛 ──────────────────────────────

function assertUnreadableIsNotPass() {
  const db = freshDb();
  const loop = store.createLoop({
    scopeId: SCOPE,
    sessionId: 'loop-controller-contract',
    goal: '读不出结论不算通过',
    exitCriteria: [{ type: 'gate_green', gate: 'missing-gate' }],
    budgetIters: 4,
  }, { db });

  const result = controller.evaluateStop(stopPayload(), {
    db,
    store,
    criteria: stubCriteria({
      converged: false,
      results: [{ type: 'gate_green', met: false, detail: '门禁状态不可读', unreadable: true }],
      unmet: [{ type: 'gate_green', met: false, detail: '门禁状态不可读', unreadable: true }],
      failureText: null,
    }),
  });

  assert.equal(result.decision, 'block', '判据读不出结论必须判未收敛');
  assert.match(result.reason, /读不出结论/, '必须明确标注是"读不出"而不是"不通过"');

  const after = store.getLoop(loop.id, { db });
  assert.equal(after.iteration, 1, '未收敛应记一轮迭代');
  assert.equal(store.listIterations(loop.id, { db })[0].verdict, 'fail');
}

// ── 4. 同一失败连续两轮 → 给出换方法建议 ─────────────────────────────────────

function assertRepeatTriggersStrategySwitch() {
  const db = freshDb();
  const loop = store.createLoop({
    scopeId: SCOPE,
    sessionId: 'loop-controller-contract',
    goal: '重复失败要换方法',
    exitCriteria: [{ type: 'command', run: 'node x.cjs' }],
    budgetIters: 6,
  }, { db });

  const verdict = {
    converged: false,
    results: [{ type: 'command', met: false, detail: 'exit=1' }],
    unmet: [{ type: 'command', met: false, detail: 'exit=1' }],
    // 同一个失败, 但每次路径/行号/耗时都不同 —— 归一化后必须仍判为同一个坑
    failureText: 'ETIMEDOUT at C:\\a\\b\\run.js:12:3 after 1200ms',
  };
  const deps = { db, store, criteria: stubCriteria(verdict) };

  const first = controller.evaluateStop(stopPayload(), deps);
  assert.equal(first.decision, 'block');
  assert.equal(first.detail.repeats, 1);
  assert.doesNotMatch(first.reason, /连续/, '第一轮不该喊"换方法"');

  const verdict2 = { ...verdict, failureText: 'ETIMEDOUT at D:\\zzz\\run.js:998:1 after 30ms' };
  const second = controller.evaluateStop(stopPayload(), { ...deps, criteria: stubCriteria(verdict2) });
  assert.equal(second.decision, 'block');
  assert.equal(second.detail.repeats, 2, '路径/行号/耗时变化不得让重复计数归零');
  assert.match(second.reason, /连续 2 轮/, '连续两轮同一失败必须提示换方法');

  const history = store.listIterations(loop.id, { db });
  assert.equal(history.length, 2);
  assert.equal(history[0].failureFp, history[1].failureFp, '两轮应落到同一指纹');
  assert.ok(history[1].strategy, '第二轮必须记录换方法建议');
}

// ── 5. 预算耗尽 = exhausted, 措辞不得读成完成 ────────────────────────────────

function assertExhaustedIsNotSuccess() {
  const db = freshDb();
  const loop = store.createLoop({
    scopeId: SCOPE,
    sessionId: 'loop-controller-contract',
    goal: '预算耗尽',
    exitCriteria: [{ type: 'command', run: 'node x.cjs' }],
    budgetIters: 1,
  }, { db });

  const result = controller.evaluateStop(stopPayload(), {
    db,
    store,
    criteria: stubCriteria({
      converged: false,
      results: [{ type: 'command', met: false, detail: 'exit=1' }],
      unmet: [{ type: 'command', met: false, detail: 'exit=1' }],
      failureText: 'exit=1',
    }),
  });

  assert.equal(result.decision, 'allow', '预算耗尽必须放行, 否则会卡死会话');
  assert.equal(result.status, 'exhausted');
  assert.match(result.reason, /未收敛/, '耗尽的措辞必须明说未收敛');
  assert.equal(store.getLoop(loop.id, { db }).status, 'exhausted');
}

// ── 5b. 停滞 = 提前止损, 但既不算完成也不替人判定放弃 ────────────────────────
//
// 此前循环只有"收敛"和"预算耗尽"两个出口, 早就陷在同一个坑里的循环仍会把剩下
// 的预算一轮轮烧完。停滞这条出口锁三件事: 放行、措辞不读成完成、循环仍 active。

function assertStallSemantics() {
  const it = (fp, family, unmet, verdict = 'fail') => ({
    failureFp: fp, failureFamily: family, unmet, verdict,
  });

  // 同一指纹连续 3 轮 → 停滞
  const sameFp = criteriaLib.assessProgress([
    it('aaa', 'timeout', [{ type: 'command' }]),
    it('aaa', 'timeout', [{ type: 'command' }]),
    it('aaa', 'timeout', [{ type: 'command' }]),
  ]);
  assert.equal(sameFp.stalled, true, '同一指纹 3 轮应判停滞');
  assert.match(sameFp.reason, /指纹/);

  // 未满足数在下降 = 有实质进展, 不判停滞 (即使指纹家族相同)
  const improving = criteriaLib.assessProgress([
    it('a1', 'assert', [{}, {}, {}, {}]),
    it('a2', 'assert', [{}, {}, {}]),
    it('a3', 'assert', [{}, {}]),
    it('a4', 'assert', [{}]),
  ]);
  assert.equal(improving.stalled, false, '未满足数在下降就不是停滞');

  // 换写法但同一家族连续 4 轮 → 停滞 (CLAUDE.md: 计数针对同一假设)
  const sameFamily = criteriaLib.assessProgress([
    it('b1', 'assert', [{}, {}]),
    it('b2', 'assert', [{}, {}]),
    it('b3', 'assert', [{}, {}]),
    it('b4', 'assert', [{}, {}]),
  ]);
  assert.equal(sameFamily.stalled, true, '同一家族 4 轮应判停滞');

  // 一次 pass 之后重新计数 —— 坑填过了, 之前的连败不该继续累计
  const afterPass = criteriaLib.assessProgress([
    it('ccc', 'timeout', [{}]),
    it('ccc', 'timeout', [{}]),
    it(null, null, [], 'pass'),
    it('ccc', 'timeout', [{}]),
  ]);
  assert.equal(afterPass.stalled, false, 'pass 之后必须重新计数');
  assert.equal(afterPass.signals.iterationsSincePass, 1);

  // 读不出 unmet 既不算进展也不算停滞 (与 evaluate 的"读不出≠通过"对偶)
  const unreadable = criteriaLib.assessProgress([
    it(null, null, 'not json'),
    it(null, null, 'not json'),
    it(null, null, 'not json'),
    it(null, null, 'not json'),
    it(null, null, 'not json'),
  ]);
  assert.equal(unreadable.stalled, false, '读不出结论不得判成停滞');

  // 空历史不判停滞
  assert.equal(criteriaLib.assessProgress([]).stalled, false);
  assert.equal(criteriaLib.assessProgress(null).stalled, false);
}

function assertStalledIsNotSuccess() {
  const db = freshDb();
  const loop = store.createLoop({
    scopeId: SCOPE,
    sessionId: 'loop-controller-contract',
    goal: '停滞路径',
    exitCriteria: [{ type: 'command', run: 'node x.cjs' }],
    budgetIters: 20,          // 预算充足: 停的原因必须是停滞而不是耗尽
  }, { db });

  const result = controller.evaluateStop(stopPayload(), {
    db,
    store,
    criteria: stubCriteria(
      {
        converged: false,
        results: [{ type: 'command', met: false, detail: 'exit=1' }],
        unmet: [{ type: 'command', met: false, detail: 'exit=1' }],
        failureText: 'exit=1',
      },
      { stalled: true, reason: '同一失败指纹连续 3 轮未变 —— 再跑一轮大概率还是这个坑', signals: {} },
    ),
  });

  assert.equal(result.decision, 'allow', '停滞必须放行, 不能把会话卡死');
  assert.equal(result.status, 'stalled');
  assert.match(result.reason, /停滞/);
  assert.match(result.reason, /这不是完成/, '停滞的措辞不得读成完成');
  assert.equal(store.getLoop(loop.id, { db }).status, 'active',
    '停滞不替人判定放弃: 循环必须保持 active');
}

// ── 6. 收敛 → 放行并关闭 ────────────────────────────────────────────────────

function assertConvergence() {
  const db = freshDb();
  const loop = store.createLoop({
    scopeId: SCOPE,
    sessionId: 'loop-controller-contract',
    goal: '收敛路径',
    exitCriteria: [{ type: 'gate_green', gate: 'g' }],
  }, { db });

  const result = controller.evaluateStop(stopPayload(), {
    db,
    store,
    criteria: stubCriteria({
      converged: true,
      results: [{ type: 'gate_green', met: true, detail: 'g=completed' }],
      unmet: [],
      failureText: null,
    }),
  });

  assert.equal(result.decision, 'allow');
  assert.equal(result.status, 'converged');
  assert.equal(store.getLoop(loop.id, { db }).status, 'converged');
}

// ── 7. 判据求值的硬语义 ─────────────────────────────────────────────────────

function assertCriteriaSemantics() {
  const empty = criteriaLib.evaluate([], { projectRoot: PROJECT_ROOT });
  assert.equal(empty.converged, false, '空判据不得视为收敛');

  const unknown = criteriaLib.evaluate([{ type: 'no_such_type' }], { projectRoot: PROJECT_ROOT });
  assert.equal(unknown.converged, false);
  assert.equal(unknown.results[0].unreadable, true, '未知判据类型必须标记为读不出结论');

  // command 判据的注入防护
  const injected = criteriaLib.evaluate(
    [{ type: 'command', run: 'node -e 1 && rm -rf /' }], { projectRoot: PROJECT_ROOT },
  );
  assert.equal(injected.converged, false);
  assert.match(injected.results[0].detail, /shell 元字符/);

  const notAllowed = criteriaLib.evaluate(
    [{ type: 'command', run: 'curl http://example.com' }], { projectRoot: PROJECT_ROOT },
  );
  assert.match(notAllowed.results[0].detail, /白名单/);

  // 真实执行一条白名单内的命令
  const realPass = criteriaLib.evaluate(
    [{ type: 'command', run: `node --version` }], { projectRoot: PROJECT_ROOT },
  );
  assert.equal(realPass.converged, true, 'node --version 应当 exit=0');

  // 门禁绿判定
  const gatesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-gates-'));
  const prev = process.env.CLAUDE_GATES_DIR;
  process.env.CLAUDE_GATES_DIR = gatesDir;
  try {
    fs.writeFileSync(path.join(gatesDir, 'demo.json'), JSON.stringify({ status: 'completed' }));
    const green = criteriaLib.evaluate([{ type: 'gate_green', gate: 'demo' }], { projectRoot: PROJECT_ROOT });
    assert.equal(green.converged, true);

    fs.writeFileSync(path.join(gatesDir, 'demo.json'), JSON.stringify({ status: 'blocked' }));
    const red = criteriaLib.evaluate([{ type: 'gate_green', gate: 'demo' }], { projectRoot: PROJECT_ROOT });
    assert.equal(red.converged, false);

    const traversal = criteriaLib.evaluate(
      [{ type: 'gate_green', gate: '../../etc/passwd' }], { projectRoot: PROJECT_ROOT },
    );
    assert.match(traversal.results[0].detail, /非法/, 'gate 名必须防路径穿越');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_GATES_DIR;
    else process.env.CLAUDE_GATES_DIR = prev;
    fs.rmSync(gatesDir, { recursive: true, force: true });
  }
}

// ── 8. store 的并发/唯一性约束 ──────────────────────────────────────────────

function assertStoreInvariants() {
  const db = freshDb();
  const first = store.createLoop({
    scopeId: SCOPE, sessionId: 's', goal: 'a', exitCriteria: [{ type: 'gate_green', gate: 'g' }],
  }, { db });
  const second = store.createLoop({
    scopeId: SCOPE, sessionId: 's', goal: 'b', exitCriteria: [{ type: 'gate_green', gate: 'g' }],
  }, { db });

  assert.equal(store.getLoop(first.id, { db }).status, 'abandoned', '新循环必须挤掉旧的 active 循环');
  assert.equal(store.getActiveLoop({ scopeId: SCOPE, sessionId: 's' }, { db }).id, second.id);

  assert.throws(
    () => store.createLoop({ scopeId: SCOPE, sessionId: 's', goal: 'c', exitCriteria: [] }, { db }),
    /exitCriteria/,
    '无判据的循环必须被拒绝 —— 它永远无法收敛',
  );

  // 会话换了 id (compact/重启) 仍应找回同 scope 的循环
  const other = store.getActiveLoop({ scopeId: SCOPE, sessionId: 'brand-new-session' }, { db });
  assert.equal(other?.id, second.id, '换会话 id 后循环不该凭空消失');
}

// ── 9. 只读开关: 影响持久化, 不影响判定 ─────────────────────────────────────

function assertReadOnlyHonored() {
  const db = freshDb();
  const loop = store.createLoop({
    scopeId: SCOPE,
    sessionId: 'loop-controller-contract',
    goal: '只读模式',
    exitCriteria: [{ type: 'gate_green', gate: 'g' }],
    budgetIters: 3,
  }, { db });

  process.env.CLAUDE_HARNESS_NO_PERSIST = '1';
  try {
    const result = controller.evaluateStop(stopPayload(), {
      db,
      store,
      criteria: stubCriteria({
        converged: false,
        results: [{ type: 'gate_green', met: false, detail: 'g=blocked' }],
        unmet: [{ type: 'gate_green', met: false, detail: 'g=blocked' }],
        failureText: 'g=blocked',
      }),
    });
    assert.equal(result.decision, 'block', '只读模式不得改变判定, 只该跳过写库');
    assert.equal(store.getLoop(loop.id, { db }).iteration, 0, '只读模式不得写迭代');
    assert.equal(store.listIterations(loop.id, { db }).length, 0);
  } finally {
    delete process.env.CLAUDE_HARNESS_NO_PERSIST;
  }
}

// ── 10. SubagentStop 判定回灌 ───────────────────────────────────────────────

function assertSubagentVerdictFeedback() {
  const subagent = require(path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'subagent-verdict.cjs'));
  const db = freshDb();

  // 无循环时什么也不记
  assert.equal(
    subagent.evaluateSubagentStop(stopPayload({ hook_event_name: 'SubagentStop' }), { db, store }).recorded,
    false,
  );

  const loop = store.createLoop({
    scopeId: SCOPE,
    sessionId: 'loop-controller-contract',
    goal: '子 agent 回灌',
    exitCriteria: [{ type: 'gate_green', gate: 'g' }],
    budgetIters: 9,
  }, { db });

  // 显式失败标记 → fail + 指纹
  const failed = subagent.evaluateSubagentStop(stopPayload({
    hook_event_name: 'SubagentStop',
    agent_name: 'logic-engineer',
    tool_response: 'RESULT: FAIL\nxsim exited with code 1',
  }), { db, store });
  assert.equal(failed.verdict, 'fail');
  assert.equal(failed.recorded, true);

  // 显式通过标记 → pass
  const passed = subagent.evaluateSubagentStop(stopPayload({
    hook_event_name: 'SubagentStop',
    tool_response: 'ALL TESTS PASSED',
  }), { db, store });
  assert.equal(passed.verdict, 'pass');

  // 无可判读结果 → unknown, 绝不猜 pass
  const silent = subagent.evaluateSubagentStop(stopPayload({
    hook_event_name: 'SubagentStop',
  }), { db, store });
  assert.equal(silent.verdict, 'unknown', '载荷没有结果时不得猜成功');
  assert.equal(silent.source, 'none');

  const history = store.listIterations(loop.id, { db });
  assert.equal(history.length, 3, '三次子 agent 收尾应各记一轮');
  assert.equal(history[0].verdict, 'fail');
  assert.ok(history[0].failureFp, '失败的子 agent 必须留下指纹, 否则主循环无从判断是不是同一个坑');
  assert.equal(history[1].verdict, 'pass');
  assert.equal(history[2].verdict, 'unknown');
  assert.match(history[2].actionSummary, /未提供可判读结果/);
}

// ── 11. CLI 冒烟 + fail-open ────────────────────────────────────────────────

function assertCliBehavior() {
  const cli = path.join(HARNESS_ROOT, 'engine', 'scripts', 'loop-ctl.cjs');
  const bad = spawnSync(process.execPath, [cli, 'start', '--goal', 'x', '--criteria', '[{"type":"bogus"}]'], {
    encoding: 'utf8', cwd: HARNESS_ROOT, windowsHide: true,
  });
  assert.notEqual(bad.status, 0, '未知判据类型必须在创建时就被拒绝');
  assert.match(bad.stderr, /不支持的判据类型/);

  const help = spawnSync(process.execPath, [cli], { encoding: 'utf8', windowsHide: true });
  assert.match(help.stderr, /用法/);

  // Stop 钩子拿到非法 JSON 必须 fail-open 且不产生 stdout
  const hook = spawnSync(process.execPath, [HOOK], {
    input: 'definitely not json', encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_HARNESS_NO_PERSIST: '1' },
  });
  assert.equal(hook.status, 0, 'Stop 钩子异常必须 fail-open');
  assert.equal(hook.stdout, '', '放行路径不得写 stdout');
}

function main() {
  assert.ok(fs.existsSync(HOOK), 'loop-controller.cjs is missing');
  assertNoLoopIsTransparent();
  assertStopHookActiveIsHonored();
  assertUnreadableIsNotPass();
  assertRepeatTriggersStrategySwitch();
  assertExhaustedIsNotSuccess();
  assertStallSemantics();
  assertStalledIsNotSuccess();
  assertConvergence();
  assertCriteriaSemantics();
  assertStoreInvariants();
  assertReadOnlyHonored();
  assertSubagentVerdictFeedback();
  assertCliBehavior();
  process.stdout.write('LOOP_CONTROLLER_RESULT: PASS\n');
}

main();
