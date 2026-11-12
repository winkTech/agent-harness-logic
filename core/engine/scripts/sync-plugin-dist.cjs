#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/sync-plugin-dist.cjs — dist/plugin 组装器（Phase 4.1）
 *
 * 从真源组装 dist/plugin/（标准插件布局，Claude/Grok/Codex 三形态同名）：
 *
 *   dist/plugin/
 *     skills/              ← core 技能（skills/ 运行时镜像中 core 部分）+
 *                            packs/fpga/skills + packs/office/skills 合集
 *     agents/              ← packs/fpga/agents/{compound,domain}
 *     hooks/hooks.json     ← core/engine/hooks/plugin.hooks.json 复制
 *                            （命令已用 ${CLAUDE_PLUGIN_ROOT} 相对引用）
 *     core/                ← bundled 精简引擎（hooks/scripts/sqlite/schemas——
 *                            plugin.hooks.json 引用面的最小闭包）
 *     .mcp.json            ← 从根 .mcp.json 脱敏投影（绝对路径→占位）
 *     .claude-plugin/plugin.json  ← 三宿主同名 kebab-case 清单
 *     .grok-plugin/plugin.json
 *     .codex-plugin/plugin.json
 *
 * 双 marketplace（仓库根，source 指本仓 dist/plugin 子目录）：
 *   .claude-plugin/marketplace.json（git-subdir 形，条目带 40 位 sha）
 *   .grok-plugin/marketplace.json（plugin_subdir 形）
 *
 * 用法：sync-plugin-dist.cjs [--check]
 *   渲染 = 重建 dist/plugin + 两 marketplace；--check = 逐字节漂移比对 exit 1。
 *
 * 脱敏（Phase 4.2 前置）：plugin.json author 占位 __OWNER__；.mcp.json 不含
 * 本机路径；marketplace source 用仓库公开 URL（占位 __REPO_URL__，发布时替换）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const DIST = path.join(HARNESS_ROOT, 'dist', 'plugin');
const PLUGIN_NAME = 'logical-paradox';

// ── 拷贝工具（幂等重建：先清空目标子树）────────────────────────────────────

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** core 技能集 = skills/ 镜像中排除 pack 技能（pack 技能从 packs 源取）。 */
const PACK_SKILL_NAMES = new Set([
  'hdl-coding', 'project-init', 'python-hardware-debug', 'rtl-gen',
  'vivado-flow', 'workflows', 'xdc-constraint-gen',
  'doc-gen', 'markitdown-converter', 'pdf', 'presentation',
]);

function coreSkillNames() {
  return fs.readdirSync(path.join(HARNESS_ROOT, 'skills'))
    .filter((n) => !PACK_SKILL_NAMES.has(n) && fs.existsSync(
      path.join(HARNESS_ROOT, 'skills', n, 'SKILL.md'),
    ));
}

// ── 组装 ────────────────────────────────────────────────────────────────────

function buildDist() {
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  // skills/：core + fpga + office 合集
  for (const name of coreSkillNames()) {
    copyTree(path.join(HARNESS_ROOT, 'skills', name), path.join(DIST, 'skills', name));
  }
  for (const pack of ['fpga', 'office']) {
    const dir = path.join(HARNESS_ROOT, 'packs', pack, 'skills');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!fs.existsSync(path.join(dir, name, 'SKILL.md'))) continue;
      copyTree(path.join(dir, name), path.join(DIST, 'skills', name));
    }
  }

  // agents/：packs/fpga/agents 平铺
  const agentsSrc = path.join(HARNESS_ROOT, 'packs', 'fpga', 'agents');
  if (fs.existsSync(agentsSrc)) {
    copyTree(agentsSrc, path.join(DIST, 'agents', 'fpga'));
  }

  // hooks/hooks.json（plugin.hooks.json 已 ${CLAUDE_PLUGIN_ROOT} 形）
  copyFile(
    path.join(HARNESS_ROOT, 'core', 'engine', 'hooks', 'plugin.hooks.json'),
    path.join(DIST, 'hooks', 'hooks.json'),
  );

  // core/：精简引擎闭包（hooks 命令引用面）
  copyTree(path.join(HARNESS_ROOT, 'core', 'engine', 'hooks'), path.join(DIST, 'core', 'engine', 'hooks'));
  copyTree(path.join(HARNESS_ROOT, 'core', 'engine', 'scripts'), path.join(DIST, 'core', 'engine', 'scripts'));
  copyTree(path.join(HARNESS_ROOT, 'core', 'engine', 'sqlite'), path.join(DIST, 'core', 'engine', 'sqlite'));
  copyTree(path.join(HARNESS_ROOT, 'core', 'engine', 'schemas'), path.join(DIST, 'core', 'engine', 'schemas'));
  for (const extra of ['rules', 'io']) {
    const src = path.join(HARNESS_ROOT, 'core', 'engine', extra);
    if (fs.existsSync(src)) copyTree(src, path.join(DIST, 'core', 'engine', extra));
  }

  // .mcp.json（脱敏投影：只保留可分发服务器——npx 形与 plugin 相对形）
  const rootMcp = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, '.mcp.json'), 'utf8'));
  const mcpOut = { mcpServers: {} };
  for (const [name, cfg] of Object.entries(rootMcp.mcpServers || {})) {
    const cmd = String(cfg.command || '');
    if (cmd === 'npx' || cmd === 'node') {
      mcpOut.mcpServers[name] = cfg;
    }
    // 本机绝对路径 command（如 D:/tools/...）不分发
  }
  copyFromObject(mcpOut, path.join(DIST, '.mcp.json'));

  // 三宿主 plugin.json（同名 kebab-case）
  const baseManifest = {
    name: PLUGIN_NAME,
    displayName: PLUGIN_NAME,
    version: '0.2.0',
    description: 'Runtime-neutral agent harness: safety gates, verification loop, memory + Dream, session handoff.',
    author: { name: '__OWNER__' },
    repository: '__REPO_URL__',
    license: 'MIT',
    keywords: ['harness', 'hooks', 'memory', 'verification', 'fpga'],
  };
  copyFromObject(
    { ...baseManifest, hooks: './hooks/hooks.json', mcpServers: mcpOut.mcpServers },
    path.join(DIST, '.claude-plugin', 'plugin.json'),
  );
  copyFromObject(
    { ...baseManifest, hooks: './hooks/hooks.json' },
    path.join(DIST, '.grok-plugin', 'plugin.json'),
  );
  copyFromObject(
    { ...baseManifest, hooks: './hooks/hooks.json' },
    path.join(DIST, '.codex-plugin', 'plugin.json'),
  );
}

function copyFromObject(obj, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/** dist 树内容 sha（40 位——marketplace 条目引用）。 */
function distSha() {
  const hash = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) walk(p);
      else {
        hash.update(name);
        hash.update(fs.readFileSync(p));
      }
    }
  };
  walk(DIST);
  return hash.digest('hex');
}

// ── 双 marketplace ─────────────────────────────────────────────────────────

function buildMarketplaces() {
  const sha = distSha();
  const claude = {
    name: 'agent-harness-logic',
    owner: { name: '__OWNER__' },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: '__REPO_URL__',
        subdir: 'dist/plugin',
        description: base64desc(),
        sha,
      },
    ],
  };
  copyFromObject(claude, path.join(HARNESS_ROOT, '.claude-plugin', 'marketplace.json'));
  const grok = {
    name: 'agent-harness-logic',
    plugins: [
      {
        name: PLUGIN_NAME,
        source: '__REPO_URL__',
        plugin_subdir: 'dist/plugin',
        sha,
      },
    ],
  };
  copyFromObject(grok, path.join(HARNESS_ROOT, '.grok-plugin', 'marketplace.json'));
  return sha;
}

function base64desc() {
  return Buffer.from('Runtime-neutral agent harness with safety gates, verification loop, memory + Dream. Multi-host: claude-code / grok / codex / workbuddy.').toString('base64');
}

// ── check ──────────────────────────────────────────────────────────────────

/** 逐字节比对：把当前 dist 快照到临时目录，重建，比对两树。 */
function check() {
  const tmp = path.join(HARNESS_ROOT, 'var', 'tmp', 'dist-check');
  rmrf(tmp);
  if (fs.existsSync(DIST)) copyTree(DIST, tmp);
  buildDist();
  const shaNew = distSha();
  const diffs = [];
  const walk = (a, b, rel) => {
    const aEntries = fs.existsSync(a) ? fs.readdirSync(a).sort() : [];
    const bEntries = fs.existsSync(b) ? fs.readdirSync(b).sort() : [];
    for (const n of new Set([...aEntries, ...bEntries])) {
      const relPath = rel ? `${rel}/${n}` : n;
      const inA = aEntries.includes(n);
      const inB = bEntries.includes(n);
      if (!inA || !inB) { diffs.push(relPath); continue; }
      const pa = path.join(a, n); const pb = path.join(b, n);
      const sa = fs.statSync(pa); const sb = fs.statSync(pb);
      if (sa.isDirectory() !== sb.isDirectory()) { diffs.push(relPath); continue; }
      if (sa.isDirectory()) walk(pa, pb, relPath);
      else if (fs.readFileSync(pa).equals(fs.readFileSync(pb)) === false) diffs.push(relPath);
    }
  };
  walk(tmp, DIST, '');
  rmrf(tmp);
  if (diffs.length > 0) {
    process.stderr.write(`[sync-plugin-dist] ✖ dist/plugin 漂移 ${diffs.length} 处: ${diffs.slice(0, 5).join(', ')}${diffs.length > 5 ? ' ...' : ''}\n`);
    process.exit(1);
  }
  // marketplace sha 复核
  const claudeM = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  if (claudeM.plugins[0].sha !== shaNew) {
    process.stderr.write('[sync-plugin-dist] ✖ marketplace sha 过期（重跑渲染）\n');
    process.exit(1);
  }
  process.stdout.write('[sync-plugin-dist] ✓ 零漂移\n');
}

function main() {
  if (process.argv.includes('--check')) { check(); return; }
  buildDist();
  const sha = buildMarketplaces();
  const skillCount = fs.readdirSync(path.join(DIST, 'skills')).length;
  process.stdout.write(`[sync-plugin-dist] 已组装 dist/plugin（skills ${skillCount} · agents fpga · core 引擎 · 三宿主清单）sha=${sha.slice(0, 12)}\n`);
  process.stdout.write('[sync-plugin-dist] 双 marketplace 已渲染（__REPO_URL__ 占位——发布时替换）\n');
}

main();
