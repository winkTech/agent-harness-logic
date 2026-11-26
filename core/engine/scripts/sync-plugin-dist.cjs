#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/sync-plugin-dist.cjs — dist/plugin 组装器（Phase 4.1）
 *
 * 从真源组装 dist/plugin/（标准插件布局，Claude/Grok/Codex 三形态同名）：
 *
 *   dist/plugin/
 *     skills/              ← 从 core/skills 和 域包的 skills 目录 渲染的合集
 *     agents/              ← packs/fpga/agents/{compound,domain}
 *     hooks/hooks.json     ← Claude / Grok 插件 Hook
 *     hooks/codex.json     ← hosts/codex/registrations.json 渲染
 *     core/                ← bundled 精简引擎（hooks/scripts/sqlite/schemas——
 *                            plugin.hooks.json 引用面的最小闭包）
 *     .mcp.json            ← 从根 .mcp.json 脱敏投影（绝对路径→占位）
 *     .codex-mcp.json      ← Codex MCP（插件根工作目录）
 *     .claude-plugin/plugin.json  ← 三宿主同名 kebab-case 清单
 *     .grok-plugin/plugin.json
 *     .codex-plugin/plugin.json
 *
 * 双 marketplace 默认引用同仓 dist/plugin。发布时 Claude 使用 git-subdir
 * 定位带有完整插件产物的 Git 提交，Grok 使用同仓的 vendored 路径。
 *
 * 用法：sync-plugin-dist.cjs [--check]
 *       sync-plugin-dist.cjs [--check] --release --repo-url=<https-url> --owner=<name> --commit=<sha>
 * --check 在独立临时目录组装，发现漂移退出 1。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { resolveEnabledPacks } = require('./lib/pack-config.cjs');
const { collectSkillSources, deployTarget } = require('./sync-skills.cjs');
const { parseFrontmatter } = require('./rule-loader.cjs');

const DIST_REL = 'dist/plugin';
const DIST = path.join(HARNESS_ROOT, DIST_REL);
const AG_DIST_REL = 'dist/antigravity-plugin';
const AG_DIST = path.join(HARNESS_ROOT, AG_DIST_REL);
const PLUGIN_NAME = 'logical-paradox';
const PROJECT_NAME = 'Agent Harness Logic';
const DESCRIPTION = 'Runtime-neutral agent harness with safety gates, verification loop, memory and session handoff.';

// ── 拷贝工具（幂等重建：先清空目标子树）────────────────────────────────────

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyTree(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: file =>
    path.relative(src, file) !== 'workbuddy.hooks.json' && path.basename(file) !== '__pycache__' });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// ── 组装 ────────────────────────────────────────────────────────────────────

function buildDist(output, opts = {}) {
  const enabledPacks = resolveEnabledPacks({ root: HARNESS_ROOT, packs: opts.packs });
  const fpgaEnabled = enabledPacks.includes('fpga');
  const officeEnabled = enabledPacks.includes('office');

  const skills = collectSkillSources(HARNESS_ROOT, { packs: opts.packs }).filter(skill =>
    skill.sources.some(dir => fs.existsSync(path.join(dir, 'SKILL.md')))
  );
  if (!skills.length) throw new Error('找不到可分发的技能真源');
  deployTarget(path.join(output, 'skills'), skills, { quiet: true });

  // agents/：packs/fpga/agents 平铺（仅启用 fpga 域包时打包）
  const agentsSrc = path.join(HARNESS_ROOT, 'packs', 'fpga', 'agents');
  if (fpgaEnabled && fs.existsSync(agentsSrc)) {
    copyTree(agentsSrc, path.join(output, 'agents', 'fpga'));
    renderCodexAgents(agentsSrc, path.join(output, 'agents', 'codex'));
  }

  // hooks/hooks.json（plugin.hooks.json 已 ${CLAUDE_PLUGIN_ROOT} 形）
  copyFile(
    path.join(HARNESS_ROOT, 'core', 'engine', 'hooks', 'plugin.hooks.json'),
    path.join(output, 'hooks', 'hooks.json'),
  );
  copyFile(path.join(HARNESS_ROOT, 'hosts', 'codex', 'patch-hook.cjs'),
    path.join(output, 'hosts', 'codex', 'patch-hook.cjs'));
  const latencyRegistrations = path.join('hosts', 'claude-code', 'registrations.json');
  copyFile(path.join(HARNESS_ROOT, latencyRegistrations), path.join(output, latencyRegistrations));

  // core/：精简引擎闭包（hooks 命令引用面）
  const sourceEngine = path.join(HARNESS_ROOT, 'core', 'engine');
  const outputEngine = path.join(output, 'core', 'engine');
  for (const dir of ['hooks', 'scripts', 'sqlite', 'schemas', 'io', 'mcp', 'parsers']) {
    copyTree(path.join(sourceEngine, dir), path.join(outputEngine, dir));
  }
  copyFile(path.join(sourceEngine, 'config.cjs'), path.join(outputEngine, 'config.cjs'));
  const { workflowSourceFiles } = require('./lib/workflow-runtime.cjs');
  for (const file of workflowSourceFiles(HARNESS_ROOT)) {
    const relPosix = path.relative(HARNESS_ROOT, file).replace(/\\/g, '/');
    if (!fpgaEnabled && relPosix.startsWith('packs/fpga/')) continue;
    copyFile(file, path.join(output, path.relative(HARNESS_ROOT, file)));
    if (fpgaEnabled && path.basename(file) === 'hdl-coding-dag-workflow.js') {
      for (const parser of ['fpga-util-parser.cjs', 'fpga-timing-parser.cjs', 'hdl-redline-scanner.cjs']) {
        const relative = path.join('packs', 'fpga', 'engine', parser);
        copyFile(path.join(HARNESS_ROOT, relative), path.join(output, relative));
      }
    }
  }
  copyFromObject(codexPluginHooks(output), path.join(output, 'hooks', 'codex.json'));

  // 规则层 + 入口渲染产物（审计 P0-2）：harness-root 锚点判定 + rule-loader 都
  // 以 <root>/core/rules 与 <root>/CLAUDE.md|AGENTS.md 为引用面，缺了则
  // "有技能、无规则"——00-core/03-gates/05-harness 全部失效。
  copyTree(path.join(HARNESS_ROOT, 'core', 'rules'), path.join(output, 'core', 'rules'));
  if (fpgaEnabled) {
    for (const relative of ['packs/fpga/rules', 'packs/fpga/config']) {
      const source = path.join(HARNESS_ROOT, relative);
      if (fs.existsSync(source)) copyTree(source, path.join(output, relative));
    }
    const knowledge = 'packs/fpga/engineering-assets/knowledge';
    if (fs.existsSync(path.join(HARNESS_ROOT, knowledge))) {
      for (const file of git('ls-files', '-z', '--', knowledge).split('\0').filter(Boolean)) {
        // 局部 EDA 验证报告含开发机绝对路径，不属于检索正文。
        if (path.basename(file) === 'verification_report.json') continue;
        copyFile(path.join(HARNESS_ROOT, file), path.join(output, file));
      }
    }
    const assets = path.posix.dirname(knowledge);
    if (fs.existsSync(path.join(HARNESS_ROOT, assets, 'cbb'))) {
      for (const file of git('ls-files', '-z', '--', ':(glob)' + assets + '/cbb/*/manifest.json').split('\0').filter(Boolean)) {
        const manifest = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, file), 'utf8'));
        copyFile(path.join(HARNESS_ROOT, file), path.join(output, file));
        const id = path.posix.basename(path.posix.dirname(file));
        if (manifest.asset_uid !== id || !/^[\w-]+$/.test(id) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) {
          throw new Error('Invalid asset identity in ' + file);
        }
        const seal = path.posix.join(assets, 'evidence', id, manifest.version, 'SNAPSHOT.json');
        if (git('ls-files', '-z', '--', seal)) copyFile(path.join(HARNESS_ROOT, seal), path.join(output, seal));
      }
    }
  }
  for (const entry of ['CLAUDE.md', 'AGENTS.md']) {
    const src = path.join(HARNESS_ROOT, entry);
    if (fs.existsSync(src)) copyFile(src, path.join(output, entry));
  }

  // 引擎根锚点（审计 P0-1）：harness-root.cjs 靠"模块位置上溯找 package.json
  // （name=harness）"判定根——插件安装目录缺锚点时全部 hook 抛 Unable to
  // resolve Harness root。锚点与真源同版本号（单一事实源 = 根 .claude-plugin）。
  const sourceManifest = JSON.parse(fs.readFileSync(
    path.join(HARNESS_ROOT, '.claude-plugin', 'plugin.json'), 'utf8',
  ));
  copyFromObject(
    { name: 'harness', private: true, version: sourceManifest.version },
    path.join(output, 'package.json'),
  );

  // .mcp.json（脱敏投影：只保留可分发服务器——npx 形与 plugin 相对形，按启用域包裁剪）
  const rootMcp = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, '.mcp.json'), 'utf8'));
  const mcpOut = { mcpServers: {} };
  for (const [name, cfg] of Object.entries(rootMcp.mcpServers || {})) {
    if (!fpgaEnabled && name === 'matlab') continue;
    if (!officeEnabled && name === 'mcp-pdf') continue;
    const cmd = String(cfg.command || '');
    if (cmd === 'npx' || cmd === 'node') {
      // 审计 P0-3：node 相对路径依赖 cwd，插件模式下 MCP 启动 cwd 不可控——
      // 引擎内相对路径一律改 ${CLAUDE_PLUGIN_ROOT} 前缀（插件根解析契约）。
      const fixedArgs = (cfg.args || []).map((a) => (
        typeof a === 'string' && /^[a-zA-Z0-9_-]+[\\/]/.test(a) && !a.includes('${CLAUDE_PLUGIN_ROOT}')
          ? `\${CLAUDE_PLUGIN_ROOT}/${a.replace(/\\/g, '/')}`
          : a
      ));
      mcpOut.mcpServers[name] = { ...cfg, args: fixedArgs };
    }
    // 本机绝对路径 command（如 D:/tools/...）不分发
  }
  copyFromObject(mcpOut, path.join(output, '.mcp.json'));
  // Codex 的兼容清单支持 Hook，MCP 的相对 cwd 会从插件根解析。
  const pluginRootPrefix = '${CLAUDE_PLUGIN_ROOT}/';
  const codexServers = Object.fromEntries(Object.entries(mcpOut.mcpServers).map(([name, server]) => {
    const args = server.args.map((arg) => typeof arg === 'string' && arg.startsWith(pluginRootPrefix)
      ? './' + arg.slice(pluginRootPrefix.length) : arg);
    return [name, args.some((arg, i) => arg !== server.args[i]) ? { ...server, cwd: '.', args } : server];
  }));
  const codexMcp = './.codex-mcp.json';
  copyFromObject({ mcpServers: codexServers }, path.join(output, codexMcp));

  // 三宿主 plugin.json（同名 kebab-case）——版本单一事实源 = 根 .claude-plugin
  // （release-checklist「版本一致」条款；此前硬编码 0.2.0 与根 0.1.0 漂移，审计 P2-6）
  const keywords = ['harness', 'hooks', 'memory', 'verification', ...(fpgaEnabled ? ['fpga'] : [])];
  const baseManifest = {
    name: PLUGIN_NAME,
    displayName: PLUGIN_NAME,
    version: sourceManifest.version,
    description: DESCRIPTION,
    author: { name: PROJECT_NAME },
    license: 'MIT',
    keywords,
  };
  copyFromObject(
    { ...baseManifest, hooks: './hooks/hooks.json', mcpServers: mcpOut.mcpServers },
    path.join(output, '.claude-plugin', 'plugin.json'),
  );
  copyFromObject(
    { ...baseManifest, hooks: './hooks/hooks.json' },
    path.join(output, '.grok-plugin', 'plugin.json'),
  );
  copyFromObject(
    { ...baseManifest, hooks: './hooks/codex.json', mcpServers: codexMcp },
    path.join(output, '.codex-plugin', 'plugin.json'),
  );
  // Git checkout line endings vary by platform. Store portable text as LF and preserve binary blobs.
  for (const name of fs.readdirSync(output, { recursive: true })) {
    const file = path.join(output, name);
    if (!fs.statSync(file).isFile()) continue;
    const bytes = fs.readFileSync(file);
    if (!bytes.includes(0) && bytes.includes('\r\n') && require('node:buffer').isUtf8(bytes)) {
      fs.writeFileSync(file, bytes.toString('utf8').replace(/\r\n/g, '\n'));
    }
  }
  return skills.length;
}

function normalizeTextLineEndings(dir) {
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    const bytes = fs.readFileSync(file);
    if (!bytes.includes(0) && bytes.includes('\r\n') && require('node:buffer').isUtf8(bytes)) {
      fs.writeFileSync(file, bytes.toString('utf8').replace(/\r\n/g, '\n'));
    }
  }
}

function buildAntigravityDist(stagedPlugin, output, opts = {}) {
  const agSyncPath = path.join(HARNESS_ROOT, 'hosts', 'antigravity', 'sync-from-claude.cjs');
  if (!fs.existsSync(agSyncPath)) return false;

  // Reuse already-staged portable engine/rules/packs/entry anchors from buildDist.
  for (const entry of ['core', 'packs', 'package.json', 'CLAUDE.md', 'AGENTS.md']) {
    const src = path.join(stagedPlugin, entry);
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) copyTree(src, path.join(output, entry));
    else copyFile(src, path.join(output, entry));
  }

  const { syncPlugin } = require(agSyncPath);
  syncPlugin({
    root: HARNESS_ROOT,
    target: output,
    portable: true,
    copyRuntime: true,
    packs: opts.packs,
  });
  normalizeTextLineEndings(output);
  return true;
}

function renderCodexAgents(source, output) {
  for (const group of ['compound', 'domain']) {
    for (const file of fs.readdirSync(path.join(source, group)).filter((name) => name.endsWith('.md'))) {
      const raw = fs.readFileSync(path.join(source, group, file), 'utf8');
      const { frontmatter: { name, description }, body } = parseFrontmatter(raw);
      if (!/^[a-z][a-z0-9-]*$/.test(name || '') || !description || !body) {
        throw new Error('Invalid Codex agent source: ' + file);
      }
      const skills = raw.split(/\r?\n---/)[0].match(/^skills:\s*\r?\n((?:[ \t]+- [^\r\n]+\r?\n)+)/m)?.[1]
        .trim().split(/\r?\n/).map((line) => line.replace(/^\s*-\s+/, '').split(/\s+#/)[0].trim());
      const preface = skills?.length ? '按任务使用已安装的技能：' + skills.join('、') + '。\n\n' : '';
      const instructions = ('继承父会话的工具与权限。查 Harness 引用时，以已安装插件的目录作为资源根。\n\n' + preface + body)
        .replace(/\r\n/g, '\n');
      const filePath = path.join(output, name + '.toml');
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(filePath, [
        '# Generated by logical-paradox from ' + group + '/' + file,
        'name = ' + JSON.stringify(name),
        'description = ' + JSON.stringify(description),
        'developer_instructions = ' + JSON.stringify(instructions),
        '',
      ].join('\n'));
    }
  }
}

function codexPluginHooks(output) {
  const registrations = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, 'hosts/codex/registrations.json'), 'utf8'));
  const hooks = Object.fromEntries(Object.entries(registrations.hooks).map(([event, groups]) => [event,
    groups.map(({ matcher, hooks: entries }) => ({
      matcher,
      hooks: entries.filter((entry) => !entry.standaloneOnly).map(({ command, ...fields }) => {
        const match = /^node "?\$\{HARNESS_ROOT\}\/((?:[\w-]+\/)*[\w.-]+\.cjs)"?(\s.*)?$/.exec(command);
        if (!match || !fs.existsSync(path.join(output, match[1]))) {
          throw new Error(`Invalid Codex plugin hook: ${command}`);
        }
        const [, script, args = ''] = match;
        return { ...fields,
          command: 'node "${PLUGIN_ROOT}/' + script + '"' + args,
          commandWindows: 'node "$env:PLUGIN_ROOT/' + script + '"' + args + '; exit $LASTEXITCODE',
        };
      }),
    })).filter((group) => group.hooks.length > 0),
  ]));
  return { hooks };
}

function copyFromObject(obj, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function filesIn(dir, rel = '', files = new Map()) {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) filesIn(dir, name, files);
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(path.join(dir, name));
      const oid = crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      files.set(name, oid);
    } else throw new Error('Unsupported plugin entry: ' + name);
  }
  return files;
}

function differences(expected, actual) {
  return [...new Set([...expected.keys(), ...actual.keys()])].filter(k => expected.get(k) !== actual.get(k));
}

function git(...args) {
  return execFileSync('git', ['-c', 'safe.directory=' + HARNESS_ROOT.replace(/\\/g, '/'), ...args],
    { cwd: HARNESS_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function releaseSource(options, files) {
  const { commit, 'repo-url': url, owner } = options;
  if (!owner?.trim() || !/^https:\/\//.test(url || '') || !/^[a-f0-9]{40}$/.test(commit || '')) {
    throw new Error('--release requires --owner, --repo-url=https://... and --commit=<full Git SHA>');
  }
  if (git('cat-file', '-t', commit).trim() !== 'commit') throw new Error('Expected a Git commit');
  const tree = git('ls-tree', '-rz', commit + ':' + DIST_REL);
  const committed = new Map(tree.split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    if (!['100644','100755'].includes(mode) || type !== 'blob') throw new Error('Invalid plugin entry ' + entry);
    return [entry.slice(tab + 1), oid];
  }));
  const drift = differences(files, committed);
  if (drift.length) throw new Error('Commit differs from generated plugin: ' + drift.slice(0, 8).join(', '));
  return { source: 'git-subdir', url, path: DIST_REL, sha: commit };
}

function main() {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, release: { type: 'boolean' }, local: { type: 'boolean' },
    packs: { type: 'string' }, 'repo-url': { type: 'string' }, owner: { type: 'string' }, commit: { type: 'string' } } });
  const tempParent = values.check ? os.tmpdir() : path.dirname(DIST);
  fs.mkdirSync(tempParent, { recursive: true });
  const work = fs.mkdtempSync(path.join(tempParent, 'plugin-build-'));
  const staged = path.join(work, 'plugin');
  const stagedAg = path.join(work, 'antigravity-plugin');
  const backup = path.join(work, 'previous');
  const backupAg = path.join(work, 'previous-ag');
  try {
    buildDist(staged, { packs: values.packs });
    const hasAgDist = buildAntigravityDist(staged, stagedAg, { packs: values.packs });
    const files = filesIn(staged);
    const agFiles = hasAgDist ? filesIn(stagedAg) : null;
    if (values.release && values.local) throw new Error('Choose either --release or --local');
    const existingPath = path.join(HARNESS_ROOT, '.claude-plugin/marketplace.json');
    const existing = fs.existsSync(existingPath) ? JSON.parse(fs.readFileSync(existingPath, 'utf8')) : null;
    const pin = existing?.plugins?.find(p => p.name === PLUGIN_NAME)?.source;
    const release = values.release ? values : !values.local && pin?.source === 'git-subdir'
      ? { commit: pin.sha, 'repo-url': pin.url, owner: existing.owner?.name } : null;
    const source = release ? releaseSource(release, files) : './' + DIST_REL;
    const base = { name: 'agent-harness-logic', owner: { name: release?.owner || PROJECT_NAME } };
    const catalogs = {
      [require(path.join(HARNESS_ROOT, 'hosts/codex/connect.cjs')).catalogPath]: { name: base.name, interface: { displayName: PROJECT_NAME },
        plugins: [{ name: PLUGIN_NAME, source: { source: 'local', path: './' + DIST_REL },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] },
      '.claude-plugin/marketplace.json': { ...base, plugins: [{ name: PLUGIN_NAME, source, description: DESCRIPTION }] },
      '.grok-plugin/marketplace.json': { ...base, plugins: [{ name: PLUGIN_NAME, source: { type: 'local', path: './' + DIST_REL } }] },
    };
    if (values.check) {
      const drift = differences(files, fs.existsSync(DIST) ? filesIn(DIST) : new Map());
      if (hasAgDist) {
        for (const item of differences(agFiles, fs.existsSync(AG_DIST) ? filesIn(AG_DIST) : new Map())) {
          drift.push(`${AG_DIST_REL}/${item}`);
        }
      }
      for (const [name, catalog] of Object.entries(catalogs)) {
        const target = path.join(HARNESS_ROOT, name);
        if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== JSON.stringify(catalog, null, 2) + '\n') drift.push(name);
      }
      if (drift.length) throw new Error('Distribution drift: ' + drift.slice(0, 10).join(', '));
    } else {
      if (!fs.existsSync(DIST) || differences(files, filesIn(DIST)).length) {
        if (fs.existsSync(DIST)) fs.renameSync(DIST, backup);
        try { fs.renameSync(staged, DIST); }
        catch (error) {
          if (fs.existsSync(backup)) fs.renameSync(backup, DIST);
          throw error;
        }
      }
      if (hasAgDist && (!fs.existsSync(AG_DIST) || differences(agFiles, filesIn(AG_DIST)).length)) {
        if (fs.existsSync(AG_DIST)) fs.renameSync(AG_DIST, backupAg);
        try { fs.renameSync(stagedAg, AG_DIST); }
        catch (error) {
          if (fs.existsSync(backupAg)) fs.renameSync(backupAg, AG_DIST);
          throw error;
        }
      }
      for (const [name, catalog] of Object.entries(catalogs)) copyFromObject(catalog, path.join(HARNESS_ROOT, name));
    }
    console.log('[sync-plugin-dist] ' + (values.check ? '零漂移' : '插件与目录已生成'));
  } finally {
    if ((fs.existsSync(DIST) || !fs.existsSync(backup)) && (fs.existsSync(AG_DIST) || !fs.existsSync(backupAg))) rmrf(work);
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error('[sync-plugin-dist] ' + error.message); process.exitCode = 1; }
}
module.exports = { filesIn, differences };
