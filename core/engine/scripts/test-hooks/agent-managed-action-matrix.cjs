#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_OUT_ROOT = path.join(os.tmpdir(), 'claude-harness-agent-evals', 'managed-action-matrix');
const DEFAULT_AGENTS = ['claude', 'codex'];
const DEFAULT_KINDS = ['implementation', 'ambiguous'];
const CODEX_NPX_EXEC_COMMAND = process.platform === 'win32'
  ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --ephemeral --skip-git-repo-check --color never"'
  : 'npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --ephemeral --skip-git-repo-check --color never';

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/test-hooks/agent-managed-action-matrix.cjs --out <dir>',
    '  node engine/scripts/test-hooks/agent-managed-action-matrix.cjs --live --report --agents claude,codex --kinds implementation,ambiguous --out <dir>',
    '',
    'Without --live, this records readiness and produces not_run/blocked rows.',
    'With --live, available agents are evaluated through agent-managed-action-eval.cjs and unavailable agents become blocked rows.',
  ].join('\n');
}

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function splitList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function run(cmd, args, opts = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || HOME,
    encoding: 'utf8',
    timeout: opts.timeout || 10 * 60 * 1000,
    windowsHide: true,
  });
  const completedAt = new Date().toISOString();
  return {
    commandArgv: [cmd, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdoutTail: String(result.stdout || '').slice(-(opts.tailBytes || 2000)),
    stderrTail: String(result.stderr || '').slice(-(opts.tailBytes || 2000)),
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readinessFor(agent) {
  const script = path.join(__dirname, 'agent-live-readiness.cjs');
  const probe = run(process.execPath, [script, '--agent', agent], { timeout: 120000, tailBytes: 50000 });
  let manifest = null;
  try {
    manifest = JSON.parse(probe.stdoutTail);
  } catch {
    // Retain the raw probe as evidence below.
  }
  return {
    runner: probe,
    agent: manifest?.agents?.[0] || null,
  };
}

function commandFor(agent) {
  if (agent === 'claude') {
    return process.env.CLAUDE_MANAGED_EVAL_COMMAND
      || 'claude -p --tools "" --output-format json --permission-mode bypassPermissions --no-session-persistence';
  }
  if (agent === 'codex') {
    return process.env.CODEX_MANAGED_EVAL_COMMAND
      || CODEX_NPX_EXEC_COMMAND;
  }
  return process.env.AGENT_MANAGED_EVAL_COMMAND || '';
}

function summarize(runs) {
  const counts = { passed: 0, blocked: 0, failed: 0, notRun: 0, total: runs.length };
  for (const row of runs) {
    if (row.status === 'passed') counts.passed += 1;
    else if (row.status === 'blocked') counts.blocked += 1;
    else if (row.status === 'not_run') counts.notRun += 1;
    else counts.failed += 1;
  }
  const overallStatus = counts.failed > 0
    ? 'failed'
    : counts.blocked > 0
      ? 'blocked'
      : counts.notRun > 0
        ? 'not_run'
        : 'passed';
  return { ...counts, overallStatus };
}

function runManagedEval({ agent, kind, live, outRoot, readiness }) {
  const readinessStatus = readiness?.agent?.status || 'unknown';
  const rowDir = path.join(outRoot, `${agent}-${kind}`);
  fs.mkdirSync(rowDir, { recursive: true });

  if (!live) {
    const status = readinessStatus === 'available' ? 'not_run' : readinessStatus === 'blocked' ? 'blocked' : 'not_run';
    return {
      agent,
      kind,
      status,
      readinessStatus,
      outDir: rowDir,
      manifestPath: null,
      dimensions: {
        protocolCompliance: 'not_run',
        functionalStatus: 'not_run',
        overallStatus: status,
      },
    };
  }

  const script = path.join(__dirname, 'agent-managed-action-eval.cjs');
  const command = commandFor(agent);
  const result = run(process.execPath, [
    script,
    '--agent', agent,
    '--kind', kind,
    '--check-readiness',
    '--command', command,
    '--out', rowDir,
  ], { timeout: 15 * 60 * 1000 });
  const manifestPath = path.join(rowDir, 'managed-eval.json');
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = readJson(manifestPath);
    } catch {
      manifest = null;
    }
  }
  const status = manifest?.status || (result.status === 0 ? 'passed' : 'failed');
  return {
    agent,
    kind,
    status,
    readinessStatus,
    outDir: rowDir,
    manifestPath: fs.existsSync(manifestPath) ? manifestPath : null,
    exitCode: result.status,
    commandArgv: result.commandArgv,
    dimensions: manifest?.dimensions || {
      protocolCompliance: status === 'passed' ? 'passed' : 'unknown',
      functionalStatus: status === 'passed' ? 'passed' : 'unknown',
      overallStatus: status,
    },
    evalRunner: result,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }
  const live = args.includes('--live');
  const report = args.includes('--report');
  const requireAllPassed = args.includes('--require-all-passed');
  const agents = splitList(argValue(args, '--agents', ''), DEFAULT_AGENTS);
  const kinds = splitList(argValue(args, '--kinds', ''), DEFAULT_KINDS);
  const outRoot = path.resolve(argValue(args, '--out', path.join(DEFAULT_OUT_ROOT, new Date().toISOString().replace(/[:.]/g, '-'))));
  fs.mkdirSync(outRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const readiness = Object.fromEntries(agents.map((agent) => [agent, readinessFor(agent)]));
  const runs = [];
  for (const agent of agents) {
    for (const kind of kinds) {
      if (report) {
        const readinessStatus = readiness[agent]?.agent?.status || 'unknown';
        process.stderr.write(`[managed-action] start agent=${agent} kind=${kind} readiness=${readinessStatus}\n`);
      }
      const row = runManagedEval({ agent, kind, live, outRoot, readiness: readiness[agent] });
      runs.push(row);
      if (report) {
        const dimensions = row.dimensions || {};
        process.stderr.write([
          '[managed-action] done',
          `agent=${agent}`,
          `kind=${kind}`,
          `status=${row.status}`,
          `protocol=${dimensions.protocolCompliance || 'unknown'}`,
          `functional=${dimensions.functionalStatus || 'unknown'}`,
          `overall=${dimensions.overallStatus || row.status}`,
        ].join(' ') + '\n');
      }
    }
  }
  const completedAt = new Date().toISOString();
  const summary = summarize(runs);
  const manifest = {
    schemaVersion: 1,
    mode: 'managed-action-matrix',
    live,
    outRoot,
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    agents,
    kinds,
    readiness,
    runs,
    summary,
  };
  const manifestPath = path.join(outRoot, 'managed-action-matrix.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify({ manifestPath, summary }, null, 2));
  if (report) {
    const reportScript = path.join(__dirname, 'agent-managed-action-report.cjs');
    const reportResult = run(process.execPath, [reportScript, manifestPath], { timeout: 30000 });
    if (reportResult.stdoutTail) process.stdout.write(`\n${reportResult.stdoutTail.trim()}\n`);
    if (reportResult.status !== 0) {
      process.stderr.write(reportResult.stderrTail || 'failed to render managed-action report');
      process.exit(1);
    }
  }
  if (summary.failed > 0) process.exit(1);
  if (requireAllPassed && summary.overallStatus !== 'passed') process.exit(2);
}

if (require.main === module) main();
