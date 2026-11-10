'use strict';

/**
 * codegraph-sync-contract — 代码图索引调度器的行为契约。
 *
 * 覆盖的是"图为什么一直是空的"这个真实故障:
 *   1. 单文件模式真的把符号写进了库 (不是只更新 mtime)
 *   2. 会话模式在图为空时必须索引, 索引过且新鲜后必须节流
 *   3. 只读开关下一个字节都不写
 *   4. 两种模式都不产生 stdout —— stdout 会被 Claude Code 当成 hook 协议解析
 *   5. 危险根路径 (盘符根 / 用户主目录) 一律拒绝遍历
 *
 * 全程用临时 DB (CLAUDE_SQLITE_PATH) 与临时节流文件, 不碰 var/ 与真实 memory.db。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const HOOK = path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'codegraph-sync.cjs');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-'));
  const project = path.join(dir, 'proj');
  fs.mkdirSync(path.join(project, 'rtl'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true }); // findProjectRoot 的根标记
  fs.writeFileSync(path.join(project, 'rtl', 'leaf.sv'),
    'module leaf (input logic clk, input logic ri_d, output logic ro_q);\n'
    + '  always_ff @(posedge clk) ro_q <= ri_d;\n'
    + 'endmodule\n');
  fs.writeFileSync(path.join(project, 'rtl', 'top.sv'),
    'module top (input logic clk, input logic ri_d, output logic ro_q);\n'
    + '  leaf u_leaf (.clk(clk), .ri_d(ri_d), .ro_q(ro_q));\n'
    + 'endmodule\n');
  return {
    dir,
    project,
    dbPath: path.join(dir, 'graph.db'),
    statePath: path.join(dir, 'sync-state.json'),
  };
}

function runHook(ws, mode, payload, extraEnv = {}) {
  const result = spawnSync(process.execPath, [HOOK, mode], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      // 本契约就是要验证"写入路径"本身, 因此显式清掉 runner 注入的只读开关;
      // 写入目标全部指向临时 DB 与临时状态文件, 不碰 var/ 和真实 memory.db。
      // 只读语义另由 assertReadOnly 显式打开开关来验证。
      CLAUDE_HARNESS_NO_PERSIST: '',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '',
      CLAUDE_SQLITE_PATH: ws.dbPath,
      CLAUDE_CG_SYNC_STATE_FILE: ws.statePath,
      CLAUDE_CG_SYNC_DEBUG: '1',
      ...extraEnv,
    },
  });
  const match = /\[codegraph-sync:[a-z]+\] (\{.*\})/.exec(result.stderr || '');
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    report: match ? JSON.parse(match[1]) : null,
  };
}

function countNodes(dbPath, kind) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sql = kind
      ? 'SELECT COUNT(*) AS c FROM cg_nodes WHERE kind = ?'
      : 'SELECT COUNT(*) AS c FROM cg_nodes';
    return kind ? db.prepare(sql).get(kind).c : db.prepare(sql).get().c;
  } finally {
    db.close();
  }
}

function countEdges(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare('SELECT COUNT(*) AS c FROM cg_edges').get().c; }
  finally { db.close(); }
}

// ── 1. 单文件模式真的写入符号 ────────────────────────────────────────────────

function assertFileMode(ws) {
  const result = runHook(ws, '--file', {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    cwd: ws.project,
    tool_input: { file_path: path.join(ws.project, 'rtl', 'leaf.sv') },
    session_id: 'codegraph-sync-contract',
  });

  assert.equal(result.status, 0, 'file 模式必须以 0 退出 (索引不是门禁)');
  assert.equal(result.stdout, '', 'hook 不得产生 stdout');
  assert.ok(result.report, `缺少 debug 报告: ${result.stderr}`);
  assert.equal(result.report.indexed, true, `单文件索引失败: ${JSON.stringify(result.report)}`);
  assert.ok(countNodes(ws.dbPath, 'module') >= 1, '索引后应至少有一个 module 节点');
}

// ── 2. 会话模式: 空图必索引, 新鲜后必节流 ────────────────────────────────────

function assertSessionMode(ws) {
  const payload = {
    hook_event_name: 'SessionStart',
    source: 'startup',
    cwd: ws.project,
    session_id: 'codegraph-sync-contract',
  };

  const first = runHook(ws, '--session', payload);
  assert.equal(first.status, 0);
  assert.equal(first.stdout, '');
  assert.ok(first.report?.synced === true, `首次会话同步应真的跑索引: ${first.stderr}`);
  assert.ok(first.report.nodeCount > 0, '全量同步后 nodeCount 必须 > 0');

  // top 例化 leaf: 跨文件引用解析应产出 instantiates 边
  assert.ok(countEdges(ws.dbPath) > 0, '跨文件引用解析应产出边');

  const second = runHook(ws, '--session', payload);
  assert.equal(second.report?.synced, false, '新鲜索引 + 未过节流窗口应跳过');
  assert.equal(second.report?.reason, 'throttled', `期望 throttled, 实得 ${second.report?.reason}`);

  // 节流窗口设为 0 → 必须重新同步 (证明跳过来自节流而不是别的原因)
  const forced = runHook(ws, '--session', payload, { CLAUDE_CG_SYNC_INTERVAL_MS: '0' });
  assert.equal(forced.report?.synced, true, '节流窗口归零后应重新同步');
}

// ── 3. 只读开关 ──────────────────────────────────────────────────────────────

function assertReadOnly(ws) {
  const fresh = makeWorkspace();
  try {
    const result = runHook(fresh, '--file', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      cwd: fresh.project,
      tool_input: { file_path: path.join(fresh.project, 'rtl', 'leaf.sv') },
    }, { CLAUDE_HARNESS_NO_PERSIST: '1' });

    assert.equal(result.report?.indexed, false);
    assert.equal(result.report?.reason, 'read_only');
    assert.equal(fs.existsSync(fresh.dbPath), false, '只读模式不得创建数据库文件');
  } finally {
    fs.rmSync(fresh.dir, { recursive: true, force: true });
  }
}

// ── 4. 危险根路径拒绝 ────────────────────────────────────────────────────────

function assertRootGuard() {
  const { indexableRoot } = require(HOOK);
  const home = process.env.USERPROFILE || process.env.HOME;
  assert.equal(indexableRoot(path.parse(process.cwd()).root), false, '盘符根不得被索引');
  if (home) assert.equal(indexableRoot(home), false, '用户主目录不得被索引');
  assert.equal(indexableRoot(path.join(os.tmpdir(), 'definitely-missing-dir')), false);
  assert.equal(indexableRoot(HARNESS_ROOT), true, 'harness 自身应可索引');
}

// ── 5. 坏输入不炸 ────────────────────────────────────────────────────────────

function assertBadInput(ws) {
  const result = spawnSync(process.execPath, [HOOK, '--file'], {
    input: 'not json at all',
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_HARNESS_NO_PERSIST: '',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '',
      CLAUDE_SQLITE_PATH: ws.dbPath,
      CLAUDE_CG_SYNC_STATE_FILE: ws.statePath,
    },
  });
  assert.equal(result.status, 0, '非法 JSON 输入必须 fail-open');
  assert.equal(result.stdout || '', '', '非法输入时也不得产生 stdout');
}

function main() {
  assert.ok(fs.existsSync(HOOK), 'codegraph-sync.cjs is missing');
  const ws = makeWorkspace();
  try {
    assertFileMode(ws);
    assertSessionMode(ws);
    assertReadOnly(ws);
    assertRootGuard();
    assertBadInput(ws);
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
  process.stdout.write('CODEGRAPH_SYNC_RESULT: PASS\n');
}

main();
