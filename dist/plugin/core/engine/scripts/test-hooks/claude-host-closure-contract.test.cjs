#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/claude-host-closure-contract.test.cjs — Phase 3.3
 *
 *   1. permissions.template.json 形态：permissions.allow/deny 数组、本机 env 不入模板
 *   2. 模板与现网 settings.local.json 的权限面一致（拆分无损——现网是模板超集）
 *   3. manifest hostOnly 完备：SubagentStop/PreCompact 承载条目有 hostOnly+fallback 措辞
 *   4. core/engine/scripts 无 shell 运维残留（perf-monitor 归位 hosts/）
 *   5. H-1(claude)：render-hook-settings --check exit 0（三产物零漂移）
 *   6. H-2(claude)：settings.json hooks 注册 ⊆ manifest transports claude-code 面
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HOME = process.env.USERPROFILE || process.env.HOME;

test('permissions.template.json 形态', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'hosts', 'claude-code', 'permissions.template.json'), 'utf8');
  const t = JSON.parse(raw);
  assert.ok(raw.includes('Phase 3.3'), '模板须标注 Phase 3.3 出处');
  assert.ok(t.note && t.note.includes('settings.local.json'), 'note 须说明用法');
  assert.ok(Array.isArray(t.permissions.allow) && t.permissions.allow.length > 0);
  assert.ok(Array.isArray(t.permissions.deny) && t.permissions.deny.length > 0);
  assert.ok(!('env' in t), '本机 env 调参不得入模板（个性化面退出分发）');
});

test('模板权限面 = 已安装的 settings.local.json 权限面', {
  skip: !fs.existsSync(path.join(HOME, '.claude', 'settings.local.json')) && '当前用户未安装本机权限配置',
}, () => {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'hosts', 'claude-code', 'permissions.template.json'), 'utf8'));
  const local = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(t.permissions.allow, local.permissions.allow);
  assert.deepEqual(t.permissions.deny, local.permissions.deny);
});

test('manifest hostOnly 完备（SubagentStop/PreCompact 含 fallback 措辞）', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'engine', 'hooks', 'manifest.json'), 'utf8'));
  const byBase = new Map(m.entries.map((e) => [path.basename(e.script), e]));
  const pc = byBase.get('pre-compact.cjs');
  assert.ok(pc.hostOnly && pc.hostOnly[0].includes('fallback'), 'pre-compact hostOnly 须含 fallback 语义');
  const sv = byBase.get('subagent-verdict.cjs');
  assert.ok(sv.hostOnly && sv.hostOnly[0].includes('fallback'), 'subagent-verdict hostOnly 须含 fallback 语义');
});

test('core/engine/scripts 无 shell 运维残留', () => {
  const scriptsDir = path.join(ROOT, 'core', 'engine', 'scripts');
  const strays = fs.readdirSync(scriptsDir).filter((n) => /^(perf-monitor|statusline)/.test(n));
  assert.deepEqual(strays, [], '运维 shell 应归位 hosts/claude-code/');
  assert.ok(fs.existsSync(path.join(ROOT, 'hosts', 'claude-code', 'perf-monitor.sh')), 'perf-monitor 归位');
});

test('H-1(claude): render-hook-settings 三产物零漂移', () => {
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'core/engine/scripts/render-hook-settings.cjs'), '--check'],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('一致'), r.stdout);
});

test('H-2(claude): settings.json hooks ⊆ manifest claude-code 声明面', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8'));
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'engine', 'hooks', 'manifest.json'), 'utf8'));
  const claudeEntries = m.entries.filter((e) => (e.transports || []).includes('claude-code'));
  const declared = new Set(claudeEntries.map((e) => path.basename(e.script)));
  // settings 引用的脚本（含 batch 复合命令内联引用）
  const refs = new Set();
  for (const gs of Object.values(settings.hooks || {})) {
    for (const g of gs) {
      for (const hk of g.hooks || []) {
        for (const match of String(hk.command).matchAll(/([\w.-]+)\.cjs\b/g)) refs.add(`${match[1]}.cjs`);
      }
    }
  }
  const undeclared = [...refs].filter((r) => !declared.has(r));
  assert.ok(refs.size > 0, 'settings.json 缺少已注册的 hook 脚本');
  assert.deepEqual(undeclared, [], 'settings.json 引用了未在 claude-code transports 中声明的脚本');
  assert.ok(declared.size >= 12, `claude-code 声明面过小: ${declared.size}`);
});
