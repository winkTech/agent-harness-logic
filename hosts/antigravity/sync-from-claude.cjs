#!/usr/bin/env node
'use strict';

/**
 * Idempotent builder/syncer for the Antigravity `logical-paradox` plugin.
 *
 * Canonical source of truth lives in the Harness repository (`hosts/antigravity/`).
 * Supports two materialization modes:
 *   - Thin-link mode (Option A default): syncs runtime adapters + skills/rules/agents/manifests
 *     into the Antigravity plugin dir and writes `.source-root.json` pointing to HARNESS_ROOT.
 *   - Portable mode (--portable): emits a self-contained plugin bundle using `${PLUGIN_ROOT}`
 *     and `${PLUGIN_DATA}` with zero machine-specific absolute paths.
 *
 * Usage:
 *   node sync-from-claude.cjs [--target <dir>] [--portable]
 *   node sync-from-claude.cjs --check [--target <dir>] [--portable]
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveHarnessRoot } = require('./resolve-root.cjs');

const DEFAULT_TARGET = __dirname;
const RUNTIME_FILES = Object.freeze([
  'resolve-root.cjs',
  'bridge.cjs',
  'tool-policy.cjs',
  'transcript.cjs',
  'background.cjs',
  'git-integrity.cjs',
  'sync-from-claude.cjs',
  'README.md',
]);

const BUILTIN_AGENT_NAMES = new Set([
  'self', 'browser', 'research', 'image-generator', 'deepagent', 'review-agent',
]);

function posix(p) {
  return String(p).replace(/\\/g, '/');
}

function resolveRoot(overrideRoot) {
  const root = overrideRoot ? path.resolve(overrideRoot) : resolveHarnessRoot(__dirname).root;
  process.env.HARNESS_ROOT = root;
  return root;
}

function loadEngineHelpers(root) {
  const { collectSkillSources, checkTarget, deployTarget } = require(
    path.join(root, 'core/engine/scripts/sync-skills.cjs'),
  );
  const { parseFrontmatter } = require(
    path.join(root, 'core/engine/scripts/rule-loader.cjs'),
  );
  const { resolveEnabledPacks } = require(
    path.join(root, 'core/engine/scripts/lib/pack-config.cjs'),
  );
  return { collectSkillSources, checkTarget, deployTarget, parseFrontmatter, resolveEnabledPacks };
}

function enabledPacksFor(root, opts = {}) {
  const { resolveEnabledPacks } = loadEngineHelpers(root);
  return resolveEnabledPacks({ root, packs: opts.packs });
}

function buildPluginManifest(root = resolveRoot(), opts = {}) {
  const srcManifest = JSON.parse(
    fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  const enabledPacks = enabledPacksFor(root, opts);
  const fpgaEnabled = enabledPacks.includes('fpga');
  return {
    name: 'logical-paradox',
    displayName: 'Logical Paradox Harness',
    version: srcManifest.version || '0.1.0',
    description: srcManifest.description
      || 'Runtime-neutral agent harness: safety gates, verification loop, SQLite memory + Dream, session handoff, and optional domain packs.',
    author: srcManifest.author || { name: 'Agent Harness Logic' },
    repository: srcManifest.repository || 'https://github.com/winkTech/agent-harness-logic',
    suggestedPrompts: [
      '检查当前工作区的门禁与验证状态',
      '按 TDD 与验证门禁流程实现并验证新模块',
      fpgaEnabled ? '审查当前 RTL 或代码改动并运行针对性验证' : '审查当前代码改动并运行针对性验证',
    ],
  };
}

function buildMcpConfig(root = resolveRoot(), opts = {}) {
  const portable = Boolean(opts.portable);
  const enabledPacks = enabledPacksFor(root, opts);
  const fpgaEnabled = enabledPacks.includes('fpga');
  const officeEnabled = enabledPacks.includes('office');
  const customPacksEnv = opts.packs !== undefined && opts.packs !== null && String(opts.packs).trim() !== '' && String(opts.packs).trim().toLowerCase() !== 'all'
    ? (enabledPacks.length ? enabledPacks.join(',') : 'core')
    : null;
  const srcMcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  const mcpServers = {};
  const rootPosix = posix(root);

  for (const [rawName, cfg] of Object.entries(srcMcp.mcpServers || {})) {
    // Antigravity automatically namespaces plugin MCP servers as `<plugin_name>_<server_name>`.
    // Avoid double-prefixing so `mcp_<plugin>_<server>_<tool>` never exceeds the 64-char tool name limit.
    const serverName = rawName.replace(/^logical-paradox-/, '').replace(/^mcp-/, '');
    if (!fpgaEnabled && serverName === 'matlab') continue;
    if (!officeEnabled && serverName === 'pdf') continue;
    const cmd = String(cfg.command || '');
    const rawArgs = Array.isArray(cfg.args) ? cfg.args : [];

    if (cmd === 'node') {
      const resolvedArgs = [
        '--no-warnings',
        ...rawArgs.map((arg) => {
          if (typeof arg !== 'string') return arg;
          const cleaned = arg.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]/, '');
          if (portable) {
            return path.isAbsolute(cleaned) ? null : `\${PLUGIN_ROOT}/${posix(cleaned)}`;
          }
          return path.isAbsolute(cleaned) ? posix(cleaned) : `${rootPosix}/${posix(cleaned)}`;
        }),
      ];
      if (portable && resolvedArgs.some((a) => a === null)) continue;
      const baseEnv = cfg.env && Object.keys(cfg.env).length ? { ...cfg.env } : {};
      const packEnv = customPacksEnv ? { HARNESS_PACKS: customPacksEnv } : {};
      const portableEnv = portable
        ? {
            ...baseEnv,
            ...packEnv,
            HARNESS_ROOT: '${PLUGIN_ROOT}',
            HARNESS_PLUGIN_ROOT: '${PLUGIN_ROOT}',
            HARNESS_PLUGIN_DATA: '${PLUGIN_DATA}',
          }
        : { ...baseEnv, ...packEnv };
      mcpServers[serverName] = {
        command: 'node',
        args: resolvedArgs,
        cwd: portable ? '${PLUGIN_ROOT}' : rootPosix,
        ...(Object.keys(portableEnv).length ? { env: portableEnv } : {}),
      };
    } else if (cmd === 'npx' || !portable) {
      mcpServers[serverName] = {
        command: cmd,
        args: rawArgs,
        ...(cfg.env && Object.keys(cfg.env).length ? { env: cfg.env } : {}),
      };
    }
  }
  return { mcpServers };
}

function buildHooksConfig() {
  return {
    'logical-paradox': {
      SessionStart: [
        {
          type: 'command',
          command: 'node --no-warnings ./bridge.cjs SessionStart',
          timeout: 20,
        },
      ],
      PreInvocation: [
        {
          type: 'command',
          command: 'node --no-warnings ./bridge.cjs PreInvocation',
          timeout: 12,
        },
      ],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: 'node --no-warnings ./bridge.cjs PreToolUse',
              timeout: 20,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'run_command|edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content|invoke_subagent|run_workflow|Workflow|manage_task|call_mcp_tool|(mcp_.*_)?(evaluate_matlab_code|run_matlab_(test_)?file)',
          hooks: [
            {
              type: 'command',
              command: 'node --no-warnings ./bridge.cjs PostToolUse',
              timeout: 15,
            },
          ],
        },
      ],
      Stop: [
        {
          type: 'command',
          command: 'node --no-warnings ./bridge.cjs Stop',
          timeout: 30,
        },
      ],
    },
  };
}

function buildRulesContent(root = resolveRoot(), opts = {}) {
  const portable = Boolean(opts.portable);
  const fpgaEnabled = enabledPacksFor(root, opts).includes('fpga');
  const agentsMdPath = path.join(root, 'AGENTS.md');
  const templatePath = path.join(root, 'hosts', 'claude-code', 'AGENTS.md');
  const raw = fs.existsSync(agentsMdPath)
    ? fs.readFileSync(agentsMdPath, 'utf8')
    : fs.readFileSync(templatePath, 'utf8');

  const rootPosix = posix(root);
  let rewritten = raw.replace(/^#\s*Codex 项目指导\s*/m, '# Logical Paradox Harness 常驻行为契约\n\n');
  if (!fpgaEnabled) {
    rewritten = rewritten
      .split(/\r?\n/)
      .filter((line) => !line.includes('packs/fpga/rules/'))
      .join('\n');
  }
  if (!portable) {
    // Thin-link mode: resolve repo-relative rule paths so the agent in any workspace can read them directly.
    rewritten = rewritten.replace(/`((?:core|packs)\/[^`]+\.md)`/g, `\`${rootPosix}/$1\``);
  }

  if (Buffer.byteLength(rewritten, 'utf8') > 24 * 1024) {
    throw new Error('Generated rules/AGENTS.md exceeds Antigravity 24 KB per-file cap');
  }
  return rewritten.replace(/\r\n/g, '\n');
}

function renderAgents(destDir, root = resolveRoot(), opts = {}) {
  const portable = Boolean(opts.portable);
  const fpgaEnabled = enabledPacksFor(root, opts).includes('fpga');
  const { parseFrontmatter } = loadEngineHelpers(root);
  const agentsSrc = path.join(root, 'packs', 'fpga', 'agents');
  fs.rmSync(destDir, { recursive: true, force: true });
  if (!fpgaEnabled || !fs.existsSync(agentsSrc)) return [];
  fs.mkdirSync(destDir, { recursive: true });

  const renderedNames = [];
  for (const group of ['compound', 'domain']) {
    const groupDir = path.join(agentsSrc, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const file of fs.readdirSync(groupDir).filter((f) => f.endsWith('.md')).sort()) {
      const raw = fs.readFileSync(path.join(groupDir, file), 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const baseName = String(frontmatter?.name || path.basename(file, '.md')).trim();
      const safeName = BUILTIN_AGENT_NAMES.has(baseName) ? `lp-${baseName}` : baseName;
      const desc = String(frontmatter?.description || `FPGA ${group} subagent ${safeName}`)
        .replace(/\r?\n/g, ' ')
        .trim();

      const skillsMatch = raw.split(/\r?\n---/)[0]?.match(/^skills:\s*\r?\n((?:[ \t]+- [^\r\n]+\r?\n)+)/m);
      const skills = skillsMatch
        ? skillsMatch[1].trim().split(/\r?\n/).map((l) => l.replace(/^\s*-\s+/, '').split(/\s+#/)[0].trim())
        : [];
      const skillHint = skills.length ? `优先结合已安装的技能：${skills.join('、')}。\n\n` : '';
      const rootHint = portable
        ? '查 Harness 引用时，以当前已安装插件目录作为资源根。\n\n'
        : `Harness 资源根目录位于 \`${posix(root)}\`。\n\n`;

      const out = [
        '---',
        `name: ${safeName}`,
        `description: ${JSON.stringify(desc)}`,
        'subagent: true',
        'mainAgent: false',
        'tools: [read_file, edit_file, write_file, run_command, manage_task, search_web]',
        '---',
        '',
        rootHint + skillHint + String(body || '').trim(),
        '',
      ].join('\n');

      fs.writeFileSync(path.join(destDir, `${safeName}.md`), out, 'utf8');
      renderedNames.push(safeName);
    }
  }
  return renderedNames;
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function installedSources(root = resolveRoot(), opts = {}) {
  const { collectSkillSources } = loadEngineHelpers(root);
  return collectSkillSources(root, { packs: opts.packs }).filter((s) =>
    s.sources.some((dir) => fs.existsSync(path.join(dir, 'SKILL.md'))),
  );
}

function isPortableTarget(destination) {
  return fs.existsSync(path.join(destination, 'core', 'engine', 'scripts', 'lib', 'harness-state.cjs'));
}

function checkAssets(destination = DEFAULT_TARGET, skills = null, opts = {}) {
  const root = resolveRoot(opts.root);
  const portable = opts.portable !== undefined ? Boolean(opts.portable) : isPortableTarget(destination);
  const list = skills || installedSources(root, { packs: opts.packs });
  const isSourceDir = !fs.existsSync(path.join(destination, 'plugin.json'))
    && !fs.existsSync(path.join(destination, 'skills'));
  if (isSourceDir) {
    // Running directly inside hosts/antigravity/ source tree (not an installed plugin dir).
    // If pointed at its own repo (smoke-test), treat source tree as clean; if pointed at an
    // external fixture repo (e.g., git-integrity drift test), report the fixture's missing skills.
    if (path.resolve(root) === path.resolve(destination, '..', '..')) {
      return { skip: false, drift: [] };
    }
    const missing = list.map((s) => `missing: ${s.name}`);
    missing.push('rules/AGENTS.md');
    return { skip: false, drift: missing };
  }
  const { checkTarget } = loadEngineHelpers(root);
  const check = checkTarget('antigravity', path.join(destination, 'skills'), list);
  const drift = [...check.drift];
  const rules = path.join(destination, 'rules', 'AGENTS.md');
  const expectedRules = buildRulesContent(root, { portable, packs: opts.packs });
  if (!fs.existsSync(rules) || fs.readFileSync(rules, 'utf8').replace(/\r\n/g, '\n') !== expectedRules) {
    drift.push('rules/AGENTS.md');
  }
  return { skip: check.skip || !list.length, drift };
}

function syncPlugin(opts = {}) {
  const root = resolveRoot(opts.root);
  const targetDir = path.resolve(opts.target || DEFAULT_TARGET);
  const portable = Boolean(opts.portable);
  const copyRuntime = Boolean(opts.copyRuntime);
  const packs = opts.packs;
  const enabledPacks = enabledPacksFor(root, { packs });
  const skills = installedSources(root, { packs });
  const { deployTarget } = loadEngineHelpers(root);

  fs.mkdirSync(targetDir, { recursive: true });

  if (copyRuntime) {
    const adapterSrc = path.join(root, 'hosts', 'antigravity');
    if (path.resolve(adapterSrc) !== targetDir && fs.existsSync(adapterSrc)) {
      for (const file of RUNTIME_FILES) {
        const src = path.join(adapterSrc, file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDir, file));
      }
    }
  }

  writeJson(path.join(targetDir, 'plugin.json'), buildPluginManifest(root, { packs }));
  writeJson(path.join(targetDir, 'mcp_config.json'), buildMcpConfig(root, { portable, packs }));
  writeJson(path.join(targetDir, 'hooks.json'), buildHooksConfig());

  const pointerPath = path.join(targetDir, '.source-root.json');
  if (portable) {
    fs.rmSync(pointerPath, { force: true });
  } else {
    writeJson(pointerPath, { mode: 'thin-link', sourceRoot: posix(root) });
  }

  const rulesFile = path.join(targetDir, 'rules', 'AGENTS.md');
  fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
  fs.writeFileSync(rulesFile, buildRulesContent(root, { portable, packs }), 'utf8');

  const skillsDir = path.join(targetDir, 'skills');
  fs.rmSync(skillsDir, { recursive: true, force: true });
  deployTarget(skillsDir, skills, { quiet: true });
  const agents = renderAgents(path.join(targetDir, 'agents'), root, { portable, packs });

  return {
    pluginDir: targetDir,
    sourceRoot: root,
    mode: portable ? 'portable' : 'thin-link',
    packs: enabledPacks,
    skillsDeployed: skills.length,
    agentsDeployed: agents.length,
    mcpServers: Object.keys(buildMcpConfig(root, { portable, packs }).mcpServers),
    hooksEvents: Object.keys(buildHooksConfig()['logical-paradox']),
  };
}

function parseCli(argv) {
  const out = { check: false, portable: false, copyRuntime: false, target: DEFAULT_TARGET, packs: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--portable') out.portable = true;
    else if (a === '--copy-runtime') out.copyRuntime = true;
    else if (a === '--target') out.target = path.resolve(argv[++i] || DEFAULT_TARGET);
    else if (a === '--packs') out.packs = argv[++i];
    else if (a.startsWith('--packs=')) out.packs = a.slice('--packs='.length);
  }
  return out;
}

function main() {
  const opts = parseCli(process.argv.slice(2));
  const root = resolveRoot();
  const skills = installedSources(root, { packs: opts.packs });

  if (opts.check) {
    const skillCheck = checkAssets(opts.target, skills, { root, portable: opts.portable ? true : undefined, packs: opts.packs });
    if (skillCheck.skip || skillCheck.drift.length > 0) {
      console.error(`[sync-from-claude] skills drift: ${skillCheck.skip ? 'uninitialized' : skillCheck.drift.join('; ')}`);
      process.exit(1);
    }
    console.log(`[sync-from-claude] OK: zero drift (${skills.length} skills verified)`);
    return;
  }

  const summary = syncPlugin({
    root,
    target: opts.target,
    portable: opts.portable,
    copyRuntime: opts.copyRuntime,
    packs: opts.packs,
  });
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = {
  RUNTIME_FILES,
  buildPluginManifest,
  buildMcpConfig,
  buildHooksConfig,
  buildRulesContent,
  renderAgents,
  installedSources,
  checkAssets,
  syncPlugin,
};

if (require.main === module) {
  const { workerData, parentPort } = require('node:worker_threads');
  if (parentPort && workerData === 'check-assets') parentPort.postMessage(checkAssets());
  else main();
}
