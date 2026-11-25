#!/usr/bin/env node
'use strict';

/**
 * scripts/connect.cjs — Logical Paradox Harness 统一多宿主插件接入与体检 CLI
 *
 * 将五个宿主（claude-code / antigravity / codex / grok / workbuddy）的插件构建、
 * 按需域包裁剪（--packs core|core,office|fpga|all）、零漂移校验与环境体检收敛到单一入口。
 *
 * 用法：
 *   node scripts/connect.cjs --doctor [--json]
 *   node scripts/connect.cjs <host|all> [--packs core|core,office|all] [--mode plugin|user]
 *                            [--portable] [--refresh] [--no-seal] [--check] [--dry-run] [--json]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { discoverAvailablePacks, resolveEnabledPacks } = require(
  path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'pack-config.cjs'),
);

const HOST_ALIASES = Object.freeze({
  claude: 'claude-code',
  'claude-code': 'claude-code',
  antigravity: 'antigravity',
  ag: 'antigravity',
  codex: 'codex',
  grok: 'grok',
  workbuddy: 'workbuddy',
  all: 'all',
});

const ALL_HOSTS = Object.freeze(['claude-code', 'antigravity', 'codex', 'grok', 'workbuddy']);

function printHelp() {
  console.log(`Logical Paradox Harness — Unified Multi-Host Connect & Doctor CLI

Usage:
  npm run doctor
  npm run connect -- <host|all> [options]

Hosts:
  claude-code (claude)   Plugin-dir mode (default, zero settings.json mutation) or --mode user
  antigravity (ag)       Option A thin-link + OS read-only ACL (default) or --portable
  codex                  Codex plugin connect & hook trust setup
  grok                   Grok profile hook projection + smoke check
  workbuddy              WorkBuddy hook target render + zero-drift check
  all                    Connect or check all detected/supported hosts

Options:
  --packs <spec>         Domain pack profile: core | core,office | fpga | all (default: all)
  --mode <plugin|user>   Claude Code mode (default: plugin; user updates settings.json hooks only)
  --portable             Antigravity portable self-contained bundle (dist/antigravity-plugin)
  --refresh              Antigravity refresh + live MCP server reload
  --no-seal              Antigravity skip OS read-only ACL sealing
  --check                Read-only zero-drift check without writing files
  --doctor               Run environment, host, pack, ACL, and memory health diagnostics
  --dry-run              Print planned steps without executing writes
  --json                 Emit structured JSON summary
  -h, --help             Show this help message

Examples:
  npm run doctor
  npm run connect -- claude-code --packs core
  npm run connect -- antigravity --packs core,office --refresh
  npm run connect -- antigravity --portable --packs core
  npm run connect -- grok --check
`);
}

function parseCli(argv = process.argv.slice(2)) {
  const opts = {
    host: null,
    doctor: false,
    check: false,
    dryRun: false,
    json: false,
    help: false,
    portable: false,
    refresh: false,
    noSeal: false,
    mode: 'plugin',
    packs: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--doctor') opts.doctor = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--portable') opts.portable = true;
    else if (arg === '--refresh') opts.refresh = true;
    else if (arg === '--no-seal') opts.noSeal = true;
    else if (arg === '--mode') opts.mode = String(argv[++i] || 'plugin').trim().toLowerCase();
    else if (arg.startsWith('--mode=')) opts.mode = arg.slice('--mode='.length).trim().toLowerCase();
    else if (arg === '--packs') opts.packs = argv[++i];
    else if (arg.startsWith('--packs=')) opts.packs = arg.slice('--packs='.length);
    else if (arg === '--host') opts.host = argv[++i];
    else if (arg.startsWith('--host=')) opts.host = arg.slice('--host='.length);
    else if (!arg.startsWith('-') && !opts.host) opts.host = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (opts.mode !== 'plugin' && opts.mode !== 'user') {
    throw new Error(`Invalid --mode "${opts.mode}". Expected "plugin" or "user".`);
  }
  if (opts.host) {
    const normalized = HOST_ALIASES[String(opts.host).toLowerCase()];
    if (!normalized) {
      throw new Error(`Unknown host "${opts.host}". Expected one of: ${ALL_HOSTS.join(', ')}, all`);
    }
    opts.host = normalized;
  }
  return opts;
}

function probeCommand(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (r.error || r.status !== 0) return { available: false, version: null };
  return { available: true, version: String(r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] || 'ok' };
}

function parseNodeVersion(v = process.version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  if (!m) return { major: 0, minor: 0, patch: 0, supported: false };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const supported = major > 22 || (major === 22 && minor >= 5);
  return { major, minor, patch, supported };
}

function detectEnvironment(opts = {}) {
  const home = opts.home || os.homedir();
  const root = opts.root || ROOT;
  const nodeInfo = parseNodeVersion(opts.nodeVersion || process.version);
  const git = probeCommand('git');
  const python = probeCommand(process.platform === 'win32' ? 'python' : 'python3');
  const availablePacks = discoverAvailablePacks(root);
  const enabledPacks = resolveEnabledPacks({ root, packs: opts.packs });

  const agDir = path.join(home, '.gemini', 'config', 'plugins', 'logical-paradox');
  let agSealed = false;
  try {
    const acl = require(path.join(root, 'core', 'engine', 'scripts', 'lib', 'plugin-acl.cjs'));
    if (fs.existsSync(agDir)) agSealed = Boolean(acl.isSealed(agDir));
  } catch { /* optional */ }

  const hosts = {
    'claude-code': {
      detected: fs.existsSync(path.join(home, '.claude')),
      settingsExists: fs.existsSync(path.join(home, '.claude', 'settings.json')),
      distReady: fs.existsSync(path.join(root, 'dist', 'plugin', '.claude-plugin', 'plugin.json')),
    },
    antigravity: {
      detected: fs.existsSync(path.join(home, '.gemini')),
      installed: fs.existsSync(path.join(agDir, 'plugin.json')),
      sealed: agSealed,
      distReady: fs.existsSync(path.join(root, 'dist', 'antigravity-plugin', 'plugin.json')),
    },
    codex: {
      detected: fs.existsSync(path.join(home, '.codex')),
      hooksExists: fs.existsSync(path.join(home, '.codex', 'hooks.json')),
      distReady: fs.existsSync(path.join(root, 'dist', 'plugin', '.codex-plugin', 'plugin.json')),
    },
    grok: {
      detected: fs.existsSync(path.join(home, '.grok')),
      hooksExists: fs.existsSync(path.join(home, '.grok', 'hooks.json')),
      distReady: fs.existsSync(path.join(root, 'dist', 'plugin', '.grok-plugin', 'plugin.json')),
    },
    workbuddy: {
      detected: fs.existsSync(path.join(home, '.workbuddy')) || fs.existsSync(path.join(root, 'core', 'engine', 'hooks', 'workbuddy.hooks.json')),
      hooksExists: fs.existsSync(path.join(root, 'core', 'engine', 'hooks', 'workbuddy.hooks.json')),
    },
  };

  let memoryHealth = { available: false };
  try {
    const res = spawnSync(process.execPath, [path.join(root, 'core', 'engine', 'scripts', 'memory-health-check.cjs'), '--json'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    if (res.stdout) {
      const parsed = JSON.parse(res.stdout);
      memoryHealth = {
        available: true,
        status: parsed.status,
        score: parsed.score,
        issues: (parsed.issues || []).map((i) => i.code),
      };
    }
  } catch { /* fresh checkout without sqlite db */ }

  return {
    platform: process.platform,
    root,
    node: { raw: opts.nodeVersion || process.version, ...nodeInfo },
    git,
    python,
    availablePacks,
    enabledPacks,
    hosts,
    memoryHealth,
  };
}

function planActions(opts, root = ROOT) {
  const hosts = opts.host === 'all' ? [...ALL_HOSTS] : [opts.host];
  const packsArg = opts.packs ? [`--packs=${opts.packs}`] : [];
  const actions = [];

  for (const host of hosts) {
    if (host === 'claude-code') {
      if (opts.mode === 'plugin') {
        const distArgs = opts.check ? ['--check', ...packsArg] : [...packsArg];
        actions.push({
          host,
          label: opts.check ? 'Check dist/plugin zero drift' : 'Build portable dist/plugin for claude --plugin-dir',
          script: path.join(root, 'core', 'engine', 'scripts', 'sync-plugin-dist.cjs'),
          args: distArgs,
          nextStep: `claude --plugin-dir "${path.join(root, 'dist', 'plugin')}"`,
        });
      } else {
        actions.push({
          host,
          label: opts.check ? 'Check skill mirrors & entry rules' : 'Sync skills & entry rules',
          script: path.join(root, 'core', 'engine', 'scripts', 'sync-skills.cjs'),
          args: opts.check ? ['--check', ...packsArg] : [...packsArg],
        });
        actions.push({
          host,
          label: opts.check ? 'Check Claude Code settings.json hooks' : 'Render Claude Code hooks (preserving env/secrets)',
          script: path.join(root, 'core', 'engine', 'scripts', 'render-hook-settings.cjs'),
          args: opts.check ? ['--check'] : [],
        });
      }
    } else if (host === 'antigravity') {
      const agArgs = [];
      if (opts.check) agArgs.push('--check');
      if (opts.portable) agArgs.push('--portable');
      if (opts.refresh && !opts.check) agArgs.push('--refresh');
      if (opts.noSeal && !opts.check) agArgs.push('--no-seal');
      if (opts.packs) agArgs.push(`--packs=${opts.packs}`);
      actions.push({
        host,
        label: opts.check ? 'Check Antigravity plugin drift & ACL seal' : 'Connect Antigravity plugin',
        script: path.join(root, 'hosts', 'antigravity', 'connect.cjs'),
        args: agArgs,
      });
    } else if (host === 'codex') {
      actions.push({
        host,
        label: opts.check ? 'Check Codex plugin & hook trust' : 'Connect Codex plugin & open hook trust review if needed',
        script: path.join(root, 'hosts', 'codex', 'connect.cjs'),
        args: opts.check ? ['--check'] : [],
        env: opts.packs ? { HARNESS_PACKS: opts.packs } : undefined,
      });
    } else if (host === 'grok') {
      if (!opts.check) {
        actions.push({
          host,
          label: 'Sync skills for Grok (~/.agents/skills)',
          script: path.join(root, 'core', 'engine', 'scripts', 'sync-skills.cjs'),
          args: [...packsArg],
        });
      }
      actions.push({
        host,
        label: opts.check ? 'Check Grok hooks zero drift' : 'Render Grok profile hooks (~/.grok/hooks.json)',
        script: path.join(root, 'core', 'engine', 'scripts', 'render-grok-hooks.cjs'),
        args: opts.check ? ['--check'] : [],
      });
      actions.push({
        host,
        label: 'Run Grok static smoke checks (8/8)',
        script: path.join(root, 'hosts', 'grok', 'smoke.cjs'),
        args: [],
      });
    } else if (host === 'workbuddy') {
      actions.push({
        host,
        label: opts.check ? 'Check WorkBuddy hooks zero drift' : 'Render WorkBuddy hooks target',
        script: path.join(root, 'core', 'engine', 'scripts', 'render-hook-settings.cjs'),
        args: opts.check ? ['--check'] : [],
      });
    }
  }
  return actions;
}

function formatDoctorHuman(report) {
  const lines = [
    'Logical Paradox Harness — Environment & Host Doctor',
    `  Root:      ${report.root}`,
    `  Platform:  ${report.platform}`,
    `  Node.js:   ${report.node.raw} (${report.node.supported ? 'OK >=22.5' : 'UPGRADE REQUIRED: need >=22.5 for node:sqlite'})`,
    `  Git:       ${report.git.available ? report.git.version : 'MISSING'}`,
    `  Python:    ${report.python.available ? report.python.version : 'optional (not found)'}`,
    `  Packs:     available=[${report.availablePacks.join(', ')}] active=[${report.enabledPacks.length ? report.enabledPacks.join(', ') : 'core-only'}]`,
    '',
    'Hosts:',
    `  claude-code  detected=${report.hosts['claude-code'].detected}  dist=${report.hosts['claude-code'].distReady}  userSettings=${report.hosts['claude-code'].settingsExists}`,
    `  antigravity  detected=${report.hosts.antigravity.detected}  installed=${report.hosts.antigravity.installed}  sealed=${report.hosts.antigravity.sealed}  dist=${report.hosts.antigravity.distReady}`,
    `  codex        detected=${report.hosts.codex.detected}  hooks=${report.hosts.codex.hooksExists}  dist=${report.hosts.codex.distReady}`,
    `  grok         detected=${report.hosts.grok.detected}  hooks=${report.hosts.grok.hooksExists}  dist=${report.hosts.grok.distReady}`,
    `  workbuddy    detected=${report.hosts.workbuddy.detected}  hooks=${report.hosts.workbuddy.hooksExists}`,
    '',
    `Memory Health: ${report.memoryHealth.available ? `${report.memoryHealth.status} (${report.memoryHealth.score}/100, issues=${report.memoryHealth.issues.join(',') || 'none'})` : 'not initialized yet'}`,
    '',
    'Quick Start:',
    '  Universal software dev (no FPGA):  npm run connect -- claude-code --packs core',
    '  Universal + Office docs:           npm run connect -- antigravity --packs core,office',
    '  Full suite (Core + Office + FPGA): npm run connect -- <host> --packs all',
  ];
  return lines.join('\n');
}

function runDoctor(opts) {
  const report = detectEnvironment({ packs: opts.packs });
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatDoctorHuman(report));
  return report.node.supported && report.git.available ? 0 : 1;
}

function executeActions(actions, opts) {
  const results = [];
  for (const action of actions) {
    if (opts.dryRun) {
      results.push({ host: action.host, label: action.label, script: path.relative(ROOT, action.script).replace(/\\/g, '/'), args: action.args, dryRun: true, ok: true });
      continue;
    }
    const env = { ...process.env, HARNESS_ROOT: ROOT, ...(action.env || {}) };
    const r = spawnSync(process.execPath, [action.script, ...action.args], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      stdio: opts.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: opts.json,
      timeout: 180000,
    });
    const ok = !r.error && r.status === 0;
    results.push({
      host: action.host,
      label: action.label,
      ok,
      exitCode: r.status,
      ...(opts.json ? { stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() } : {}),
      ...(action.nextStep ? { nextStep: action.nextStep } : {}),
    });
    if (!ok) {
      if (opts.json) console.log(JSON.stringify({ ok: false, results }, null, 2));
      return r.status || 1;
    }
    if (!opts.json && action.nextStep) {
      console.log(`\n[connect] Next step (${action.host}):\n  ${action.nextStep}\n`);
    }
  }
  if (opts.json) console.log(JSON.stringify({ ok: true, results }, null, 2));
  else if (opts.dryRun) {
    for (const r of results) console.log(`[dry-run] (${r.host}) node ${r.script} ${r.args.join(' ')}  # ${r.label}`);
  }
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const opts = parseCli(argv);
  if (opts.help || (!opts.doctor && !opts.host)) {
    printHelp();
    return 0;
  }
  // Fail fast if --packs names an unknown pack.
  if (opts.packs !== undefined) resolveEnabledPacks({ root: ROOT, packs: opts.packs });

  if (opts.doctor) return runDoctor(opts);

  const nodeInfo = parseNodeVersion();
  if (!nodeInfo.supported) {
    console.error(`[connect] Node.js >= 22.5 is required (found ${process.version}).`);
    return 1;
  }
  const actions = planActions(opts, ROOT);
  return executeActions(actions, opts);
}

module.exports = {
  ALL_HOSTS,
  parseCli,
  parseNodeVersion,
  detectEnvironment,
  planActions,
  runDoctor,
  main,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[connect] ${error.message}`);
    process.exitCode = 1;
  }
}
