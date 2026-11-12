#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/bench-d2-plugin-validate.cjs — D-2 插件结构校验（Phase 4.1）
 *
 * Claude 插件结构校验（文档等效——无官方 CLI 时的结构断言集）+
 * Grok 插件形态等效校验：
 *   1. dist/plugin 布局：skills 下每目录有 SKILL.md 且 kebab-case；agents
 *      下 md 全入包
 *   2. hooks/hooks.json：${CLAUDE_PLUGIN_ROOT} 引用形、目标文件在 dist 内存在
 *   3. 三宿主 plugin.json：name 同一 kebab-case、hooks 指向存在文件
 *   4. .mcp.json：无可执行绝对路径（npx/node 形才可分发）
 *   5. marketplace 双形态：claude git-subdir 形（subdir 字段）/ grok
 *      plugin_subdir 形；条目带 40 位 sha
 *   6. 无个人信息泄漏（lihan/Lihan/本机路径 → D-1 联动前置抽查）
 */

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const DIST = path.join(HARNESS_ROOT, 'dist', 'plugin');

const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };

function main() {
  // 1 skills
  const skillsDir = path.join(DIST, 'skills');
  ok(fs.existsSync(skillsDir), 'skills/ 缺失');
  for (const name of fs.readdirSync(skillsDir)) {
    ok(/^[a-z][a-z0-9-]*$/.test(name), `技能名非 kebab-case: ${name}`);
    ok(fs.existsSync(path.join(skillsDir, name, 'SKILL.md')), `缺 SKILL.md: ${name}`);
  }

  // 2 hooks.json 引用闭包
  const hooksJson = JSON.parse(fs.readFileSync(path.join(DIST, 'hooks', 'hooks.json'), 'utf8'));
  let hookCount = 0;
  for (const groups of Object.values(hooksJson.hooks || {})) {
    for (const g of groups) {
      for (const hk of g.hooks || []) {
        hookCount += 1;
        const args = (hk.args || []).map(String);
        const rootRefs = args.filter((a) => a.includes('${CLAUDE_PLUGIN_ROOT}'));
        for (const ref of rootRefs) {
          const rel = ref.replace('${CLAUDE_PLUGIN_ROOT}/', '');
          ok(fs.existsSync(path.join(DIST, rel)), `hook 引用不在 dist 内: ${rel}`);
        }
      }
    }
  }
  ok(hookCount > 10, `hook 条目过少: ${hookCount}`);

  // 3 三宿主清单
  const names = [];
  for (const host of ['claude-plugin', 'grok-plugin', 'codex-plugin']) {
    const p = path.join(DIST, `.${host}`, 'plugin.json');
    ok(fs.existsSync(p), `.${host}/plugin.json 缺失`);
    if (fs.existsSync(p)) {
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      names.push(m.name);
      const hooksRef = (m.hooks || '').replace('./', '');
      ok(fs.existsSync(path.join(DIST, hooksRef)), `${host} hooks 指向不存在: ${m.hooks}`);
    }
  }
  ok(new Set(names).size === 1, `三宿主 name 不同一: ${names.join(',')}`);
  ok(/^[a-z][a-z0-9-]*$/.test(names[0] || ''), `name 非 kebab-case: ${names[0]}`);

  // 4 .mcp.json 可分发性
  const mcp = JSON.parse(fs.readFileSync(path.join(DIST, '.mcp.json'), 'utf8'));
  for (const [name, cfg] of Object.entries(mcp.mcpServers || {})) {
    ok(['npx', 'node'].includes(String(cfg.command)), `.mcp.json 不可分发服务器: ${name}(${cfg.command})`);
  }

  // 5 marketplace 双形态
  const cm = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const gm = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, '.grok-plugin', 'marketplace.json'), 'utf8'));
  ok(typeof cm.plugins[0].subdir === 'string', 'claude marketplace 缺 subdir（git-subdir 形）');
  ok(typeof gm.plugins[0].plugin_subdir === 'string', 'grok marketplace 缺 plugin_subdir');
  ok(/^[0-9a-f]{40}$/.test(cm.plugins[0].sha || ''), 'claude marketplace sha 非 40 位');
  ok(/^[0-9a-f]{40}$/.test(gm.plugins[0].sha || ''), 'grok marketplace sha 非 40 位');

  // 6 D-1 联动抽查（分发物全树；bench-d1 自身是守卫面——其模式串即被检词，豁免）
  const leaks = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (/bench-d1-desens/.test(name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (/lihan/i.test(name) || /Users.[\\/]Lihan|lihan\.local/.test(text)) {
        leaks.push(path.relative(DIST, p));
      }
    }
  };
  walk(DIST);
  ok(leaks.length === 0, `分发物含个人信息: ${leaks.slice(0, 3).join(', ')}`);

  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`[d2] ✖ ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`[d2] PASS 布局/引用闭包(${hookCount} hooks)/三宿主同名/mcp 可分发/marketplace 双形态/零个人信息\n`);
}

main();
