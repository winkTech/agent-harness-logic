#!/usr/bin/env node
/**
 * gate-registry-contract.cjs — 门禁「注册表 ↔ 实现 ↔ 文档」一致性检查
 *
 * 为什么需要这个:
 *   2026-07-27 的审查发现 fix-in-place-guard.cjs 三重失效同时存在——未注册、
 *   没有 CLI 入口(只导出函数, 注册了也不会执行)、读错字段名——而四处文档和三条
 *   memory 记录都声称它在 PreToolUse 阻断变体文件。三个独立故障叠加, 说明它
 *   **从未被端到端验证过一次**。
 *
 *   同一类漂移在别处也出现过: 文档写"拦截", 代码却 exit 1(等同放行);
 *   注册在 PostToolUse(命令已执行完)却宣称能预防。
 *
 *   这些都不是逻辑 bug, 而是**契约漂移**——单看代码或单看文档都发现不了,
 *   必须交叉比对。所以单独立一条检查。
 *
 * 检查项:
 *   C1 已注册的 hook 脚本必须有 CLI 入口(读 stdin + 退出), 否则注册等于空转
 *   C2 门禁类脚本若未注册, 文档不得声称它在生效
 *   C3 声称"阻断/拦截"的脚本必须真的有 exit(2) 路径
 *   C4 注册面与实现的工具矩阵必须一致(matcher 覆盖的工具, 代码要认)
 *
 * 用法: node engine/scripts/test-hooks/gate-registry-contract.cjs
 * 退出码: 0 全通过 / 1 有不一致
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const HOME = HARNESS_ROOT;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 收集 settings 里注册的全部脚本名(展开 local-runner --batch)。 */
function registeredScripts() {
  const names = new Set();
  for (const f of ['settings.json', 'settings.local.json']) {
    const cfg = readJson(path.join(HOME, f));
    if (!cfg || !cfg.hooks) continue;
    for (const matchers of Object.values(cfg.hooks)) {
      for (const m of matchers) {
        for (const h of (m.hooks || [])) {
          const cmd = String(h.command || '');
          for (const mm of cmd.matchAll(/([A-Za-z0-9_.\-\/\\]+\.(?:cjs|js|sh))/g)) {
            names.add(path.basename(mm[1]));
          }
          const batch = /--batch\s+"([^"]+)"/.exec(cmd);
          if (batch) for (const s of batch[1].split(',')) names.add(path.basename(s.trim()));
        }
      }
    }
  }
  return names;
}

/** 所有门禁类脚本。 */
function gateScripts() {
  const dirs = [
    path.join(HOME, 'engine/scripts/hooks'),
    path.join(HOME, 'engine/hooks/safety'),
  ];
  const out = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.(cjs|js)$/.test(f)) continue;
      if (!/(gate|guard|oracle)/i.test(f)) continue;
      out.push({ name: f, full: path.join(d, f) });
    }
  }
  return out;
}

/**
 * 脚本是否有可执行的 CLI 入口。
 *
 * 三种合法形态都要认, 少认一种就会把无辜脚本报成"空转":
 *   1. require.main === module 守卫
 *   2. 读 stdin (PreToolUse/PostToolUse 类需要载荷)
 *   3. 顶层直接调用 main()/run() —— Stop/SessionStart 类不需要 stdin, 常用这种
 */
function hasCliEntry(src) {
  return /require\.main\s*===\s*module/.test(src)
    || /process\.stdin/.test(src)
    || /readFileSync\(0/.test(src)
    || /^\s*(?:await\s+)?(?:main|run)\(\)\s*;?\s*$/m.test(src);
}

const REGISTERED = registeredScripts();
const GATES = gateScripts();

test('C1 已注册的门禁脚本都有 CLI 入口（注册不等于会执行）', () => {
  const dead = [];
  for (const g of GATES) {
    if (!REGISTERED.has(g.name)) continue;
    const src = fs.readFileSync(g.full, 'utf8');
    if (!hasCliEntry(src)) dead.push(g.name);
  }
  assert(dead.length === 0,
    `以下脚本已注册但没有 CLI 入口，注册后不会执行任何检查: ${dead.join(', ')}`);
});

test('C2 未注册的门禁，文档不得声称它在生效', () => {
  const docs = [
    'README.md', '快速入门.md',
    'docs/rules/README.md', 'docs/rules/03-gates.md',
    'docs/rules-archive/14-fix-in-place.md',
  ].map(f => path.join(HOME, f)).filter(f => fs.existsSync(f));

  const offenders = [];
  for (const g of GATES) {
    if (REGISTERED.has(g.name)) continue;
    const stem = g.name.replace(/\.(cjs|js)$/, '');
    for (const d of docs) {
      const txt = fs.readFileSync(d, 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.includes(stem)) continue;
        // 只有同一行同时出现"生效声称"才算问题；纯提及/说明未注册的不算
        if (/(已由\s*hook\s*执行|自动检测|阻断|拦截|强制执行)/.test(line)
          && !/(未注册|不生效|已移除|已废弃)/.test(line)) {
          offenders.push(`${path.basename(d)}: ${stem}`);
        }
      }
    }
  }
  assert(offenders.length === 0,
    `以下门禁未在 settings 注册，但文档声称它在生效: ${[...new Set(offenders)].join(' | ')}`);
});

test('C3 自称硬阻断的门禁必须真的有 exit(2) 路径', () => {
  const liars = [];
  for (const g of GATES) {
    const src = fs.readFileSync(g.full, 'utf8');
    const head = src.slice(0, 2000);
    const claimsBlock = /(exit\s*2\s*(硬)?(阻断|拦截)|硬阻断|硬拦截)/.test(head);
    const notBlocking = /(advisory|不阻断)/.test(head);
    if (claimsBlock && notBlocking) continue;      // 头部已说明降级
    if (!claimsBlock) continue;
    if (!/process\.exit\(2\)/.test(src)) liars.push(g.name);
  }
  assert(liars.length === 0,
    `以下脚本头部自称硬阻断，但代码里没有 exit(2): ${liars.join(', ')}`);
});

test('C4 写入类门禁的注册 matcher 与实现的工具矩阵一致', () => {
  // 注册在 Edit|Write|MultiEdit 上的脚本, 代码里不应只认 Write ——
  // 这正是 file-protection-guard(漏 MultiEdit)与 hdl-gate(漏 Edit)踩过的坑。
  const cfg = readJson(path.join(HOME, 'settings.json'));
  const mismatched = [];
  for (const m of (cfg?.hooks?.PreToolUse || [])) {
    const matcher = String(m.matcher || '');
    if (!/Edit/.test(matcher) || !/Write/.test(matcher)) continue;
    const scripts = new Set();
    for (const h of (m.hooks || [])) {
      const cmd = String(h.command || '');
      const batch = /--batch\s+"([^"]+)"/.exec(cmd);
      if (batch) for (const s of batch[1].split(',')) scripts.add(path.basename(s.trim()));
      else for (const mm of cmd.matchAll(/([A-Za-z0-9_.\-\/\\]+\.(?:cjs|js))/g)) scripts.add(path.basename(mm[1]));
    }
    for (const name of scripts) {
      const g = GATES.find(x => x.name === name);
      if (!g) continue;
      const src = fs.readFileSync(g.full, 'utf8');
      // 代码里出现了对 Write 的判定, 却完全没提 Edit → 大概率漏覆盖
      const mentionsWrite = /['"]Write['"]|['"]write['"]/.test(src);
      const mentionsEdit = /Edit|edit/.test(src);
      if (mentionsWrite && !mentionsEdit) mismatched.push(`${name} (注册于 ${matcher})`);
    }
  }
  assert(mismatched.length === 0,
    `以下门禁注册在含 Edit 的 matcher 上，但实现只认 Write: ${mismatched.join(', ')}`);
});

// ── 运行 ─────────────────────────────────────────────────────────────────────
console.log('门禁注册表契约检查\n');
let pass = 0; let fail = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ${t.name.padEnd(56)} PASS`);
    pass++;
  } catch (e) {
    console.log(`  ${t.name.padEnd(56)} FAIL`);
    console.log(`    ${e.message}`);
    fail++;
  }
}
console.log(`\nSummary: ${pass}/${tests.length} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
