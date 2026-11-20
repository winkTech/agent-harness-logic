#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/codex-render-contract.test.cjs — Phase 3.1 合同
 *
 * H-1(codex) 渲染零漂移 + H-2(codex) wired=declared：
 *   1. 真源形态：占位、六事件族、22 条注册
 *   2. 渲染幂等：renderProduct 纯函数两次调用一致；展开后无占位残留
 *   3. manifest 一致性：注册脚本 ∈ manifest codex transports（负例：伪造 hostOnly 注册必须红）
 *   4. AGENTS.md 投影：真源 body 全文在内 + 渲染头注存在
 *   5. trusted_hash 检测：hash 函数稳定（同输入同输出）
 *   6. --check 语义：漂移 exit 1 / 零漂移 exit 0（对真源做等价渲染后比对）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RENDERER = path.join(ROOT, 'core', 'engine', 'scripts', 'render-codex-hooks.cjs');
const REGISTRATIONS = path.join(ROOT, 'hosts', 'codex', 'registrations.json');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-render-contract-'));
const CODEX_DIR = path.join(HOME, '.codex');
const runRenderer = (...args) => spawnSync(process.execPath, [RENDERER, ...args], {
  env: { ...process.env, HOME, USERPROFILE: HOME, CODEX_HOME: CODEX_DIR },
  encoding: 'utf8',
  timeout: 60000,
});
test.before(() => {
  const rendered = runRenderer();
  assert.equal(rendered.status, 0, rendered.stderr);
});
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// 渲染器不导出（CLI 本体）——子进程做行为验证；纯函数面用 require 时会跑 main，
// 所以这里用受控子进程 + 真源直接断言。

test('真源形态：占位/事件族/条目数', () => {
  const raw = fs.readFileSync(REGISTRATIONS, 'utf8');
  const reg = JSON.parse(raw);
  assert.ok(raw.includes('${HARNESS_ROOT}'), '真源命令必须用占位（不落绝对路径）');
  assert.ok(!raw.includes('Users') && !raw.includes('$HOME'), '真源不得含本机路径残留');
  const families = Object.keys(reg.hooks);
  for (const expected of ['PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit']) {
    assert.ok(families.includes(expected), `缺事件族 ${expected}`);
  }
  const n = Object.values(reg.hooks).flat().reduce((a, g) => a + g.hooks.length, 0);
  assert.equal(n, 22, '注册条目数');
});

test('渲染幂等：--check 在零漂移态 exit 0', () => {
  const r = runRenderer('--check');
  assert.equal(r.status, 0, `check 应零漂移: ${r.stderr}`);
  assert.ok(r.stdout.includes('零漂移'), r.stdout);
});

test('渲染幂等：重复 --check 稳定（两次输出一致）', () => {
  const a = runRenderer('--check');
  const b = runRenderer('--check');
  assert.equal(a.status, b.status);
  assert.equal(a.stdout, b.stdout);
});

test('产物展开：无占位残留 + 无本机绝对路径以外的形态', () => {
  const product = JSON.parse(fs.readFileSync(path.join(CODEX_DIR, 'hooks.json'), 'utf8'));
  const s = JSON.stringify(product);
  assert.doesNotMatch(s, /\$\{HARNESS_ROOT\}|\{\{HARNESS_ROOT\}\}/, '产物不得残留占位');
  const startupCommands = product.hooks.SessionStart.flatMap(group => group.hooks.map(hook => hook.command));
  for (const script of ['memory-knowledge-maintenance.cjs', 'consumer-scheduler.cjs']) {
    const command = startupCommands.find(value => value.includes(script));
    const expectedPath = path.join(ROOT, 'core', 'engine', 'scripts', script);
    assert.ok(command?.includes(expectedPath.replace(/\\/g, '/')), command);
    assert.ok(fs.existsSync(expectedPath), expectedPath);
  }
  let n = 0;
  for (const groups of Object.values(product.hooks)) {
    for (const g of groups) n += g.hooks.length;
  }
  assert.equal(n, 22);
});

test('H-2(codex)：manifest transports 含全部注册主脚本', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'core', 'engine', 'hooks', 'manifest.json'), 'utf8',
  ));
  const reg = JSON.parse(fs.readFileSync(REGISTRATIONS, 'utf8'));
  const byBase = new Map(manifest.entries.map((e) => [path.basename(e.script).replace(/\.cjs$/, ''), e]));
  const refs = new Set();
  for (const groups of Object.values(reg.hooks)) {
    for (const g of groups) {
      for (const hk of g.hooks) {
        for (const m of String(hk.command).matchAll(/([\w.-]+)\.cjs\b/g)) refs.add(m[1]);
      }
    }
  }
  for (const base of refs) {
    const entry = byBase.get(base);
    if (!entry) continue; // batch 辅助脚本（verification-gate 等独立 gate 面）
    assert.ok(entry.transports.includes('codex'),
      `${base} 在真源注册但 manifest transports 未含 codex`);
  }
});

test('AGENTS.md 投影：真源 body 全文 + 渲染头注', () => {
  const deployed = fs.readFileSync(path.join(CODEX_DIR, 'AGENTS.md'), 'utf8');
  assert.ok(deployed.includes('render-codex-hooks.cjs'), '渲染来源头注');
  const sourceBody = fs.readFileSync(
    path.join(ROOT, 'hosts', 'claude-code', 'AGENTS.md'), 'utf8',
  ).replace(/^# Codex 项目指导\n?/, '').trimEnd();
  assert.ok(deployed.includes(sourceBody), '真源 body 必须全文投影（消灭手工双拷贝）');
});

test('Codex 信任记录区分缺失、失配和实际匹配', () => {
  const target = path.join(CODEX_DIR, 'hooks.json');
  const product = JSON.parse(fs.readFileSync(target, 'utf8'));
  const group = product.hooks.PreToolUse[0];
  const hash = createHash('sha256').update(JSON.stringify({
    event_name: 'pre_tool_use',
    hooks: [{ async: false, command: group.hooks[0].command, timeout: 600, type: 'command' }],
    matcher: group.matcher,
  })).digest('hex');
  fs.writeFileSync(path.join(CODEX_DIR, 'config.toml'), [
    `[hooks.state.'${target}:pre_tool_use:0:0']`,
    `trusted_hash = "sha256:${hash}"`,
    `[hooks.state.${JSON.stringify(`${target}:pre_tool_use:0:1`)}]`,
    `trusted_hash = 'sha256:${'0'.repeat(64)}'`,
  ].join('\r\n'));
  const checked = runRenderer('--check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stderr, /缺失 20 条.*失配 1 条/, checked.stderr);
});

test('Codex tracks multi-file patches and clears only edits present at shell start', () => {
  const gateState = path.join(HOME, 'verify-gate.json');
  const root = path.join(HOME, 'project');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture');
  const env = { ...process.env, HARNESS_VERIFY_GATE_STATE_FILE: gateState,
    HARNESS_VERIFICATION_LEDGER_FILE: path.join(HOME, 'ledger.json'), HARNESS_STATE_DIR: HOME };
  const product = JSON.parse(fs.readFileSync(path.join(CODEX_DIR,'hooks.json')));
  function invoke(event, name, input, id, response) {
    const group = product.hooks[event].find(g => g.matcher.split('|').includes(name === 'apply_patch' ? 'Edit' : 'Bash')
      && g.hooks.some(h => /patch-hook.*verify|local-runner.*verification-gate/.test(h.command)));
    assert.ok(group, event + ' ' + name);
    const shellPre = event === 'PreToolUse';
    const executable = shellPre ? 'core/engine/scripts/hooks/local-runner.cjs' : 'hosts/codex/patch-hook.cjs';
    const args = shellPre ? ['--batch', 'verification-gate.cjs'] : ['verify'];
    assert.ok(group.hooks.some(h => h.command.includes(executable)));
    const r = spawnSync(process.execPath, [path.join(ROOT,executable), ...args], { cwd: root, env, encoding: 'utf8',
      input: JSON.stringify({ cwd: root, session_id: 'patch-test', hook_event_name: event, tool_name: name,
        tool_use_id: id, tool_input: { command: input }, tool_response: response }) });
    assert.equal(r.status, 0, r.stderr);
  }
  const pending = () => Object.values(JSON.parse(fs.readFileSync(gateState)).pending);
  const patch = "*** Begin Patch\n*** Add File: a.py\n+x=1\n*** Update File: b.py\n*** Move to: c.py\n@@\n-x=1\n+x=2\n*** End Patch";
  invoke('PostToolUse','apply_patch',patch,'edit1',{ output: 'Success', metadata: { exit_code: 0 } });
  assert.equal(pending()[0].files.length,3);
  invoke('PreToolUse','Bash','pytest -q','run1');
  invoke('PostToolUse','apply_patch',patch,'edit2',{ output: 'Success' });
  invoke('PostToolUse','Bash','pytest -q','run1',{ output: '3 passed', metadata: { exit_code: 0 } });
  assert.equal(pending().length,1);
  invoke('PreToolUse','Bash','pytest -q','run2');
  invoke('PostToolUse','Bash','pytest -q','run2',{ output: '3 passed', metadata: { exit_code: 1 } });
  assert.equal(pending().length,1);
  invoke('PreToolUse','Bash','pytest -q','run3');
  invoke('PostToolUse','Bash','pytest -q','run3',{ output: '3 passed', metadata: { exit_code: 0 } });
  assert.equal(pending().length,0);
});
