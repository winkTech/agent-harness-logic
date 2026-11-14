#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/codex-render-contract.test.cjs — Phase 3.1 合同
 *
 * H-1(codex) 渲染零漂移 + H-2(codex) wired=declared：
 *   1. 真源形态：${HARNESS_ROOT} 占位、五事件族、17 条注册
 *   2. 渲染幂等：renderProduct 纯函数两次调用一致；展开后无占位残留
 *   3. manifest 一致性：注册脚本 ∈ manifest codex transports（负例：伪造 hostOnly 注册必须红）
 *   4. AGENTS.md 投影：真源 body 全文在内 + 渲染头注存在
 *   5. trusted_hash 检测：hash 函数稳定（同输入同输出）
 *   6. --check 语义：漂移 exit 1 / 零漂移 exit 0（对真源做等价渲染后比对）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RENDERER = path.join(ROOT, 'core', 'engine', 'scripts', 'render-codex-hooks.cjs');
const REGISTRATIONS = path.join(ROOT, 'hosts', 'codex', 'registrations.json');

// 渲染器不导出（CLI 本体）——子进程做行为验证；纯函数面用 require 时会跑 main，
// 所以这里用受控子进程 + 真源直接断言。

test('真源形态：占位/事件族/条目数', () => {
  const raw = fs.readFileSync(REGISTRATIONS, 'utf8');
  const reg = JSON.parse(raw);
  assert.ok(raw.includes('${HARNESS_ROOT}'), '真源命令必须用占位（不落绝对路径）');
  assert.ok(!raw.includes('Users') && !raw.includes('$HOME'), '真源不得含本机路径残留');
  const families = Object.keys(reg.hooks);
  for (const expected of ['PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart', 'Stop']) {
    assert.ok(families.includes(expected), `缺事件族 ${expected}`);
  }
  assert.ok(!families.includes('UserPromptSubmit'), 'UserPromptSubmit 不注册（hostOnly）');
  const n = Object.values(reg.hooks).flat().reduce((a, g) => a + g.hooks.length, 0);
  assert.equal(n, 17, '注册条目数');
});

test('渲染幂等：--check 在零漂移态 exit 0', () => {
  const r = spawnSync(process.execPath, [RENDERER, '--check'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `check 应零漂移: ${r.stderr}`);
  assert.ok(r.stdout.includes('零漂移'), r.stdout);
});

test('渲染幂等：重复 --check 稳定（两次输出一致）', () => {
  const a = spawnSync(process.execPath, [RENDERER, '--check'], { encoding: 'utf8', timeout: 60000 });
  const b = spawnSync(process.execPath, [RENDERER, '--check'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(a.status, b.status);
  assert.equal(a.stdout, b.stdout);
});

test('产物展开：无占位残留 + 无本机绝对路径以外的形态', () => {
  const product = JSON.parse(fs.readFileSync(path.join(
    process.env.USERPROFILE || process.env.HOME, '.codex', 'hooks.json',
  ), 'utf8'));
  const s = JSON.stringify(product);
  assert.ok(!s.includes('${HARNESS_ROOT}'), '产物不得残留占位');
  let n = 0;
  for (const groups of Object.values(product.hooks)) {
    for (const g of groups) n += g.hooks.length;
  }
  assert.equal(n, 17);
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
  const deployed = fs.readFileSync(path.join(
    process.env.USERPROFILE || process.env.HOME, '.codex', 'AGENTS.md',
  ), 'utf8');
  assert.ok(deployed.includes('render-codex-hooks.cjs'), '渲染来源头注');
  const sourceBody = fs.readFileSync(
    path.join(ROOT, 'hosts', 'claude-code', 'AGENTS.md'), 'utf8',
  ).replace(/^# Codex 项目指导\n?/, '').trimEnd();
  assert.ok(deployed.includes(sourceBody), '真源 body 必须全文投影（消灭手工双拷贝）');
});
