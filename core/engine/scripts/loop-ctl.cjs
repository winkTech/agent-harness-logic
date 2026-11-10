#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/loop-ctl.cjs — 任务循环的显式控制入口。
 *
 * 循环**只能显式创建**。自动给每个会话开循环会把所有正常 Stop 都变成潜在的
 * block, 那是把助推器改造成路障 —— 绝不做。
 *
 * 用法:
 *   node engine/scripts/loop-ctl.cjs start --goal "crc32 位真通过" \
 *        --criteria '[{"type":"gate_green","gate":"requirements-gate"}]' [--budget 5]
 *   node engine/scripts/loop-ctl.cjs start --goal "..." --criteria-file criteria.json
 *   node engine/scripts/loop-ctl.cjs status            # 当前 scope 的 active 循环 + 迭代史
 *   node engine/scripts/loop-ctl.cjs list [--all]
 *   node engine/scripts/loop-ctl.cjs check             # 只求值判据, 不写库 (dry-run)
 *   node engine/scripts/loop-ctl.cjs abandon [--id <loopId>] --reason "判据写错了"
 *
 * 判据类型见 engine/scripts/lib/loop-criteria.cjs。
 */

const fs = require('node:fs');
const path = require('node:path');

const { findProjectRoot, scopeId } = require('./lib/project-scope.cjs');
const store = require('../sqlite/store-loops.cjs');
const criteriaLib = require('./lib/loop-criteria.cjs');

function parseFlags(argv) {
  const flags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      flags.positional.push(argv[i]);
    }
  }
  return flags;
}

function currentScope(flags) {
  const root = findProjectRoot(flags.project || process.cwd(), {
    fallback: flags.project || process.cwd(),
  });
  return { projectRoot: root, scope: scopeId(root) };
}

function sessionIdFromEnv(flags) {
  return String(flags.session || process.env.CLAUDE_SESSION_ID || '').trim();
}

function loadCriteria(flags) {
  let raw = flags.criteria;
  if (flags['criteria-file']) {
    raw = fs.readFileSync(path.resolve(String(flags['criteria-file'])), 'utf8');
  }
  if (!raw || raw === true) {
    throw new Error('需要 --criteria <JSON> 或 --criteria-file <路径>');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`判据 JSON 解析失败: ${error.message}`); }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('判据必须是非空数组');
  }
  for (const item of parsed) {
    if (!criteriaLib.isSupportedType(item?.type)) {
      throw new Error(
        `不支持的判据类型: ${item?.type} (支持: ${criteriaLib.SUPPORTED_TYPES.join(', ')})`,
      );
    }
  }
  return parsed;
}

function cmdStart(flags) {
  const { projectRoot, scope } = currentScope(flags);
  const goal = String(flags.goal || '').trim();
  if (!goal) throw new Error('需要 --goal "<目标>"');
  const exitCriteria = loadCriteria(flags);
  const budgetIters = Number.parseInt(flags.budget, 10);

  const loop = store.createLoop({
    scopeId: scope,
    sessionId: sessionIdFromEnv(flags),
    goal,
    exitCriteria,
    budgetIters: Number.isFinite(budgetIters) ? budgetIters : 5,
  });

  console.log(JSON.stringify({
    started: loop.id,
    goal: loop.goal,
    projectRoot,
    budgetIters: loop.budgetIters,
    criteria: loop.exitCriteria.map((c) => c.type),
  }, null, 2));
}

function cmdStatus(flags) {
  const { projectRoot, scope } = currentScope(flags);
  const loop = store.getActiveLoop({ scopeId: scope, sessionId: sessionIdFromEnv(flags) });
  if (!loop) {
    console.log(JSON.stringify({ active: null, projectRoot }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    active: loop,
    iterations: store.listIterations(loop.id),
    projectRoot,
  }, null, 2));
}

function cmdCheck(flags) {
  const { projectRoot, scope } = currentScope(flags);
  const loop = store.getActiveLoop({ scopeId: scope, sessionId: sessionIdFromEnv(flags) });
  if (!loop) {
    console.log(JSON.stringify({ active: null, note: '无 active 循环, 无判据可求值' }, null, 2));
    return;
  }
  // dry-run: 只求值, 不写迭代、不改状态
  const verdict = criteriaLib.evaluate(loop.exitCriteria, {
    projectRoot,
    sessionId: loop.sessionId,
    loopCreatedAt: loop.createdAt,
  });
  console.log(JSON.stringify({
    loopId: loop.id,
    goal: loop.goal,
    converged: verdict.converged,
    results: verdict.results,
  }, null, 2));
  if (!verdict.converged) process.exitCode = 1;
}

function cmdList(flags) {
  const { scope } = currentScope(flags);
  const filter = flags.all ? {} : { scopeId: scope };
  console.log(JSON.stringify(store.listLoops({ ...filter, limit: 20 }), null, 2));
}

function cmdAbandon(flags) {
  const { scope } = currentScope(flags);
  const loopId = flags.id && flags.id !== true
    ? String(flags.id)
    : store.getActiveLoop({ scopeId: scope, sessionId: sessionIdFromEnv(flags) })?.id;
  if (!loopId) throw new Error('没有可关闭的循环 (用 --id 指定)');
  const reason = String(flags.reason || '').trim();
  if (!reason) throw new Error('放弃循环必须给出 --reason (为什么这个目标不再追)');

  store.recordIteration(loopId, {
    verdict: 'unknown',
    actionSummary: `abandoned: ${reason}`,
  });
  const loop = store.closeLoop(loopId, 'abandoned');
  console.log(JSON.stringify({ abandoned: loop.id, reason, iterations: loop.iteration }, null, 2));
}

const COMMANDS = {
  start: cmdStart,
  status: cmdStatus,
  check: cmdCheck,
  list: cmdList,
  abandon: cmdAbandon,
};

function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`用法: loop-ctl.cjs <${Object.keys(COMMANDS).join('|')}> [flags]

  start   --goal "<目标>" --criteria '<JSON数组>' [--budget N] [--project <路径>]
  status  [--project <路径>]        当前 active 循环与迭代史
  check   [--project <路径>]        只求值判据 (dry-run), 未收敛时退出码 1
  list    [--all]                   列出循环
  abandon [--id <loopId>] --reason "<原因>"

判据类型: ${criteriaLib.SUPPORTED_TYPES.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  try {
    handler(parseFlags(rest));
  } catch (error) {
    console.error(`[loop-ctl] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main, parseFlags, loadCriteria };
