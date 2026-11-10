#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AGENTS = new Set(['claude', 'codex']);
const CODEX_NPX_VERSION_COMMAND = process.platform === 'win32'
  ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 --version"'
  : 'npx -y @openai/codex@0.142.5 --version';

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/test-hooks/agent-live-readiness.cjs',
    '  node engine/scripts/test-hooks/agent-live-readiness.cjs --agent claude --out readiness.json',
    '',
    'Reports whether external live-agent CLIs are available, blocked, missing, or failing.',
  ].join('\n');
}

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function tail(text) {
  return String(text || '').slice(-2000);
}

function run(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout || 15000,
    shell: options.shell || false,
    windowsHide: true,
  });
  const completedAt = new Date().toISOString();
  return {
    commandArgv: [command, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
  };
}

function parseCommandLine(command) {
  const parts = [];
  let current = '';
  let quote = '';
  let tokenStarted = false;
  for (const char of command) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (tokenStarted) parts.push(current);
      current = '';
      tokenStarted = false;
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (tokenStarted) parts.push(current);
  return parts;
}

function runCommandLine(command, options = {}) {
  const startedAt = new Date().toISOString();
  const parts = parseCommandLine(command);
  if (parts.length === 0) {
    const completedAt = new Date().toISOString();
    return {
      commandArgv: [],
      status: null,
      signal: null,
      error: 'empty command',
      stdoutTail: '',
      stderrTail: '',
      startedAt,
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    };
  }
  return run(parts[0], parts.slice(1), options);
}

function powershellJson(script) {
  const result = run('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 });
  if (result.status !== 0 || !result.stdoutTail.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdoutTail);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function commandEntries(agent) {
  if (process.platform === 'win32') {
    const where = run('where.exe', [agent], { timeout: 10000 });
    const whereEntries = where.stdoutTail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((entry) => ({ CommandType: 'Application', Source: entry, Definition: entry, Resolver: 'where.exe' }));
    const script = [
      `$cmds = Get-Command ${agent} -All -ErrorAction SilentlyContinue`,
      '$cmds | ForEach-Object {',
      '  [pscustomobject]@{',
      '    CommandType = $_.CommandType.ToString();',
      '    Source = [string]$_.Source;',
      '    Definition = [string]$_.Definition',
      '  }',
      '} | ConvertTo-Json -Depth 4 -Compress',
    ].join('; ');
    const psEntries = powershellJson(script).map((entry) => ({ ...entry, Resolver: 'Get-Command' }));
    const seen = new Set();
    return [...psEntries, ...whereEntries].filter((entry) => {
      const key = `${entry.Source || ''}|${entry.Definition || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const result = run('sh', ['-lc', `command -v ${agent} || true`], { timeout: 10000 });
  return result.stdoutTail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((entry) => ({ CommandType: 'Application', Source: entry, Definition: entry }));
}

function classify(agent, entries, probe) {
  const combined = `${probe.error || ''}\n${probe.stdoutTail || ''}\n${probe.stderrTail || ''}`.toLowerCase();
  if (probe.status === 0) return 'available';
  if (entries.length === 0 || /not recognized|not found|enoent|cannot find/.test(combined)) return 'missing';
  const hasWindowsAppsEntry = entries.some((entry) => /\\windowsapps\\/i.test(entry.Source || entry.Definition || ''));
  if (/access is denied|permission denied|eacces|eperm|拒绝访问|ܾ/.test(combined)) return 'blocked';
  if (process.platform === 'win32' && hasWindowsAppsEntry && probe.status !== 0) return 'blocked';
  if (probe.signal === 'SIGTERM' || /timed out|etimedout/.test(combined)) return 'blocked';
  return 'failed';
}

function versionProbe(agent) {
  const override = process.env[`${agent.toUpperCase()}_READINESS_COMMAND`];
  if (override) return runCommandLine(override, { timeout: 120000 });
  if (process.platform === 'win32') {
    return run('cmd.exe', ['/d', '/s', '/c', `${agent} --version`], { timeout: 15000 });
  }
  return run(agent, ['--version'], { timeout: 15000 });
}

function probeAgent(agent) {
  const entries = commandEntries(agent);
  const primaryProbe = versionProbe(agent);
  let probe = primaryProbe;
  let status = classify(agent, entries, primaryProbe);
  let fallbackProbe = null;
  if (agent === 'codex' && status === 'blocked' && !process.env.CODEX_READINESS_COMMAND) {
    fallbackProbe = runCommandLine(CODEX_NPX_VERSION_COMMAND, { timeout: 120000 });
    if (fallbackProbe.status === 0) {
      probe = fallbackProbe;
      status = 'available';
      entries.push({
        CommandType: 'Application',
        Source: CODEX_NPX_VERSION_COMMAND,
        Definition: CODEX_NPX_VERSION_COMMAND,
        Resolver: 'npm-fallback',
      });
    }
  }
  return {
    agent,
    status,
    commandEntries: entries,
    versionProbe: probe,
    primaryVersionProbe: fallbackProbe ? primaryProbe : undefined,
    fallbackVersionProbe: fallbackProbe || undefined,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }
  const requested = argValue(args, '--agent', 'all');
  const agents = requested === 'all' ? [...AGENTS] : [requested];
  for (const agent of agents) {
    if (!AGENTS.has(agent)) throw new Error(`unknown agent: ${agent}`);
  }
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    agents: agents.map(probeAgent),
  };
  const out = argValue(args, '--out', '');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  }
  console.log(JSON.stringify(result, null, 2));
  if (args.includes('--require-available')) {
    const unavailable = result.agents.filter((agent) => agent.status !== 'available');
    if (unavailable.length > 0) process.exit(1);
  }
}

if (require.main === module) main();
