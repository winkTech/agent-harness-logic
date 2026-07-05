#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_RUN_ROOT = path.join(os.tmpdir(), 'claude-harness-agent-evals', 'claude-patch-executor');
const TARGET_RTL = path.join('01_src', '00_hdl', 'spi_fifo', 'spi_fifo.sv');
const PUBLIC_VERIFY = path.join('03_verify', 'spi_fifo_contract.cjs');
const VERIFY_COMMAND = `node ${PUBLIC_VERIFY.replace(/\\/g, '/')}`;
const SENTINEL = 'REPAIR_PHASE_COMPLETE';

const {
  applyRepairSpec,
  comparePlanToSpec,
  evaluateOutputText,
  normalizeRel,
  readSpecFile,
  sha256,
  validateRepairSpec,
} = require('../lib/repair-contract.cjs');
const {
  commandEvidence,
  statusFromEvidence,
  writeEvidenceLedger,
} = require('../lib/evidence-ledger.cjs');

const CODEX_NPX_EXEC_COMMAND = process.platform === 'win32'
  ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --skip-git-repo-check --ephemeral --color never"'
  : 'npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --skip-git-repo-check --ephemeral --color never';

const OLD_BLOCK = [
  '  always_ff @(posedge i_clk) begin',
  '    if (i_rst) begin',
  "      ro_tx_valid <= 1'b0;",
  "      ro_tx_data  <= '0;",
  '    end else begin',
  '      ro_tx_valid <= i_pop && !i_fifo_empty;',
  '      if (i_pop && !i_fifo_empty) begin',
  '        ro_tx_data <= i_fifo_dout;',
  '      end else begin',
  "        ro_tx_data <= '0;",
  '      end',
  '    end',
  '  end',
].join('\n');

const NEW_BLOCK = [
  '  logic                r_fwft_valid;',
  '  logic [P_DATA_W-1:0] r_fwft_data;',
  '',
  '  always_ff @(posedge i_clk) begin',
  '    if (i_rst) begin',
  "      r_fwft_valid <= 1'b0;",
  "      r_fwft_data  <= '0;",
  "      ro_tx_valid  <= 1'b0;",
  "      ro_tx_data   <= '0;",
  '    end else begin',
  '      if (!i_fifo_empty) begin',
  "        r_fwft_valid <= 1'b1;",
  '        r_fwft_data  <= i_fifo_dout;',
  '      end else if (i_pop) begin',
  "        r_fwft_valid <= 1'b0;",
  '      end',
  '',
  '      ro_tx_valid <= i_pop && r_fwft_valid;',
  '      if (i_pop && r_fwft_valid) begin',
  '        ro_tx_data <= r_fwft_data;',
  '      end',
  '    end',
  '  end',
].join('\n');

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/test-hooks/claude-patch-executor.cjs --dry-run --out <dir>',
    '  node engine/scripts/test-hooks/claude-patch-executor.cjs --agent claude --out <dir>',
    '  node engine/scripts/test-hooks/claude-patch-executor.cjs --agent codex --out <dir>',
    '',
    'The agent may only return a JSON patch plan. The harness applies exact old/new',
    'blocks, checks RTL content semantics, runs verifier commands, and records evidence.',
  ].join('\n');
}

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text).replace(/\r\n/g, '\n'), 'utf8');
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function parseCommandLine(command) {
  const parts = [];
  let current = '';
  let quote = '';
  let tokenStarted = false;
  for (const char of String(command || '')) {
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

function run(cmd, args, cwd, input = '', timeoutMs = 10 * 60 * 1000, env = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: false,
    env: { ...process.env, ...env },
  });
  const completedAt = new Date().toISOString();
  return {
    commandArgv: [cmd, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
  };
}

function runCommandLine(command, cwd, input = '', timeoutMs = 10 * 60 * 1000, env = {}) {
  const parts = parseCommandLine(command);
  if (parts.length === 0) throw new Error('empty command');
  return run(parts[0], parts.slice(1), cwd, input, timeoutMs, env);
}

function defaultCommandFor(agent) {
  if (agent === 'claude') {
    return process.env.CLAUDE_PATCH_EVAL_COMMAND
      || 'claude -p --tools "" --output-format json --permission-mode bypassPermissions --no-session-persistence';
  }
  if (agent === 'codex') return process.env.CODEX_PATCH_EVAL_COMMAND || CODEX_NPX_EXEC_COMMAND;
  return '';
}

function versionCommandFor(agent) {
  if (agent === 'claude') return process.env.CLAUDE_READINESS_COMMAND || 'claude --version';
  if (agent === 'codex') return process.env.CODEX_READINESS_COMMAND || 'codex --version';
  return '';
}

function summarizeRun(result) {
  return {
    commandArgv: result.commandArgv,
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdoutTail: result.stdout.slice(-2000),
    stderrTail: result.stderr.slice(-2000),
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
  };
}

function readinessProbe(agent) {
  const command = versionCommandFor(agent);
  if (!command) return { agent, status: 'dry-run' };
  const probe = runCommandLine(command, HOME, '', 30000);
  if (probe.status === 0) return { agent, status: 'available', command, probe: summarizeRun(probe) };
  if (agent === 'codex') {
    const fallbackCommand = process.platform === 'win32'
      ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 --version"'
      : 'npx -y @openai/codex@0.142.5 --version';
    const fallback = runCommandLine(fallbackCommand, HOME, '', 120000);
    if (fallback.status === 0) {
      return {
        agent,
        status: 'available',
        command: fallbackCommand,
        probe: summarizeRun(fallback),
        primaryProbe: summarizeRun(probe),
      };
    }
    const text = `${probe.error || ''}\n${probe.stdout || ''}\n${probe.stderr || ''}\n${fallback.error || ''}\n${fallback.stdout || ''}\n${fallback.stderr || ''}`.toLowerCase();
    const status = /not recognized|not found|enoent|cannot find/.test(text) ? 'missing' : 'failed';
    return {
      agent,
      status,
      command,
      probe: summarizeRun(probe),
      fallbackCommand,
      fallbackProbe: summarizeRun(fallback),
    };
  }
  const text = `${probe.error || ''}\n${probe.stdout || ''}\n${probe.stderr || ''}`.toLowerCase();
  const status = /not recognized|not found|enoent|cannot find/.test(text) ? 'missing' : 'failed';
  return { agent, status, command, probe: summarizeRun(probe) };
}

function baseRtl() {
  return [
    'module spi_fifo #(',
    '  parameter int P_DATA_W = 8',
    ') (',
    '  input  logic                i_clk,',
    '  input  logic                i_rst,',
    '  input  logic                i_pop,',
    '  input  logic                i_fifo_empty,',
    '  input  logic [P_DATA_W-1:0] i_fifo_dout,',
    '  output logic                ro_tx_valid,',
    '  output logic [P_DATA_W-1:0] ro_tx_data',
    ');',
    OLD_BLOCK,
    'endmodule',
    '',
  ].join('\n');
}

function publicVerifier() {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const rtlPath = path.join(process.cwd(), '01_src', '00_hdl', 'spi_fifo', 'spi_fifo.sv');",
    'const rtl = fs.existsSync(rtlPath) ? fs.readFileSync(rtlPath, "utf8") : "";',
    'const failures = [];',
    "function requirePattern(label, pattern) { if (!pattern.test(rtl)) failures.push(label); }",
    "if (!rtl) failures.push('missing rtl');",
    "requirePattern('FWFT valid register missing', /\\br_fwft_valid\\b/);",
    "requirePattern('FWFT data register missing', /\\br_fwft_data\\b/);",
    "requirePattern('output valid driven from FWFT register', /ro_tx_valid\\s*<=\\s*i_pop\\s*&&\\s*r_fwft_valid/);",
    "requirePattern('output data driven from FWFT data', /ro_tx_data\\s*<=\\s*r_fwft_data/);",
    "if (/else\\s+begin\\s*\\n\\s*ro_tx_data\\s*<=\\s*'0\\s*;\\s*\\n\\s*end/.test(rtl)) failures.push('forbidden zero fallback after non-empty read');",
    "if (/fallback_empty/i.test(rtl)) failures.push('forbidden fallback_empty workaround');",
    'if (failures.length) {',
    "  console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));",
    '  process.exit(1);',
    '}',
    "console.log(JSON.stringify({ status: 'PASS', checked: 'spi_fifo FWFT repair contract' }));",
    '',
  ].join('\n');
}

function repairSpec() {
  return {
    schemaVersion: 1,
    id: 'spi-fifo-fwft-repair',
    objective: 'Replace the TX FIFO registered-read bug with a FWFT-style data capture repair.',
    allowedFiles: [normalizeRel(TARGET_RTL)],
    readonlyFiles: [normalizeRel(PUBLIC_VERIFY)],
    outputSentinel: SENTINEL,
    forbiddenClaims: [
      'RESULT:\\s*PASS',
      'synthesis\\s+passed',
      'simulation\\s+passed'
    ],
    patches: [
      {
        file: normalizeRel(TARGET_RTL),
        description: 'Exact replacement of the broken TX data path block.',
        oldBlock: OLD_BLOCK,
        newBlock: NEW_BLOCK,
      },
    ],
    requiredRegex: [
      { file: normalizeRel(TARGET_RTL), pattern: '\\br_fwft_valid\\b', description: 'FWFT valid register exists' },
      { file: normalizeRel(TARGET_RTL), pattern: '\\br_fwft_data\\b', description: 'FWFT data register exists' },
      { file: normalizeRel(TARGET_RTL), pattern: 'ro_tx_valid\\s*<=\\s*i_pop\\s*&&\\s*r_fwft_valid', description: 'valid is driven by FWFT register' },
      { file: normalizeRel(TARGET_RTL), pattern: 'ro_tx_data\\s*<=\\s*r_fwft_data', description: 'data is driven by FWFT register' }
    ],
    forbiddenRegex: [
      { file: normalizeRel(TARGET_RTL), pattern: "else\\s+begin\\s*\\n\\s*ro_tx_data\\s*<=\\s*'0\\s*;\\s*\\n\\s*end", description: 'zero fallback after non-empty path' },
      { file: normalizeRel(TARGET_RTL), pattern: 'fallback_empty', flags: 'i', description: 'named fallback workaround' }
    ],
    expectedCommands: [VERIFY_COMMAND],
    expectedLogEvidence: [
      {
        command: VERIFY_COMMAND,
        mustContain: ['"status":"PASS"', 'spi_fifo FWFT repair contract'],
        mustNotContain: ['"status":"FAIL"'],
        classifyToolchainFailure: true
      }
    ]
  };
}

function prepareProject(outDir) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`output directory is not empty: ${outDir}`);
  }
  ensureDir(outDir);
  const projectRoot = path.join(outDir, 'project');
  writeText(path.join(projectRoot, 'AGENTS.md'), '# Patch executor fixture\n');
  writeText(path.join(projectRoot, TARGET_RTL), baseRtl());
  writeText(path.join(projectRoot, PUBLIC_VERIFY), publicVerifier());
  writeText(path.join(projectRoot, 'var', 'repair', 'repair-spec.json'), JSON.stringify(repairSpec(), null, 2));
  return projectRoot;
}

function buildPrompt(projectRoot, spec) {
  const rtl = readText(path.join(projectRoot, TARGET_RTL));
  return [
    'You are Claude Code running in HARNESS NARROW PATCH EXECUTOR MODE.',
    '',
    'You must not use Bash, Edit, Write, Agent, Workflow, or any other tool.',
    'Return exactly one JSON object and no prose.',
    'The harness, not you, will apply the patch and run verification.',
    `Your final user-facing output field must equal exactly: ${SENTINEL}`,
    'Do not claim verified, passed, synthesis passed, or simulation passed.',
    '',
    'Required JSON schema:',
    '{',
    '  "schemaVersion": 1,',
    `  "output": "${SENTINEL}",`,
    '  "patches": [',
    '    { "file": "relative path", "oldBlock": "exact old block", "newBlock": "exact new block" }',
    '  ]',
    '}',
    '',
    'RepairSpec to echo exactly:',
    JSON.stringify({
      id: spec.id,
      objective: spec.objective,
      allowedFiles: spec.allowedFiles,
      patches: spec.patches,
    }, null, 2),
    '',
    'Current RTL file:',
    '```systemverilog',
    rtl,
    '```',
    '',
    'Return the JSON object now.',
  ].join('\n');
}

function dryRunPlan(spec) {
  return {
    schemaVersion: 1,
    output: SENTINEL,
    patches: spec.patches.map((patch) => ({
      file: patch.file,
      oldBlock: patch.oldBlock,
      newBlock: patch.newBlock,
    })),
  };
}

function extractAgentText(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.message === 'string') return parsed.message;
    if (parsed.output && typeof parsed.output === 'string' && Array.isArray(parsed.patches)) return trimmed;
    if (Array.isArray(parsed) || typeof parsed === 'object') return trimmed;
  } catch (_error) {
    // Try JSONL below.
  }

  let lastText = '';
  for (const line of trimmed.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result' && typeof event.result === 'string') lastText = event.result;
      if (typeof event.result === 'string') lastText = event.result;
      if (typeof event.message === 'string') lastText = event.message;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        lastText = event.item.text;
      }
      if (event.type === 'agent_message' && typeof event.text === 'string') {
        lastText = event.text;
      }
    } catch (_error) {
      // ignore non-json lines
    }
  }
  return lastText || trimmed;
}

function parsePlan(agentText) {
  const candidate = String(agentText || '').trim();
  try {
    return JSON.parse(candidate);
  } catch (_error) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw _error;
  }
}

function runVerifier(projectRoot, ledgerPath) {
  const runResult = runCommandLine(VERIFY_COMMAND, projectRoot, '', 30000);
  const evidence = commandEvidence(VERIFY_COMMAND, runResult);
  writeEvidenceLedger(ledgerPath, evidence);
  return { runResult, evidence };
}

function checkExpectedLogEvidence(spec, ledger) {
  const failures = [];
  for (const expectation of spec.expectedLogEvidence || []) {
    const entry = ledger.entries.find((item) => item.command === expectation.command);
    if (!entry) {
      failures.push(`missing expected evidence: ${expectation.command}`);
      continue;
    }
    const text = `${entry.stdoutTail}\n${entry.stderrTail}`;
    for (const needle of expectation.mustContain || []) {
      if (!text.includes(needle)) failures.push(`missing log evidence ${JSON.stringify(needle)} for ${expectation.command}`);
    }
    for (const needle of expectation.mustNotContain || []) {
      if (text.includes(needle)) failures.push(`forbidden log evidence ${JSON.stringify(needle)} for ${expectation.command}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

function runEval(opts) {
  const outDir = opts.outDir;
  const projectRoot = prepareProject(outDir);
  const specPath = path.join(projectRoot, 'var', 'repair', 'repair-spec.json');
  const spec = readSpecFile(specPath);
  const ledgerPath = path.join(outDir, 'evidence-ledger.json');
  const checks = [];

  const validation = validateRepairSpec(spec, { projectRoot });
  checks.push({ name: 'repair-spec-validation', status: validation.ok ? 'passed' : 'failed', detail: validation.failures.join('|') });

  let agentRun = null;
  let agentText = '';
  let plan = null;
  let protocol = { ok: false, failures: [] };
  let apply = { ok: false, failures: ['not run'], applied: [] };
  let contentGate = { ok: false, failures: ['not run'], checks: [] };
  let verifier = null;
  let ledger = { entries: [] };
  let evidenceStatus = { status: 'failed', failures: ['not run'] };
  let logEvidence = { ok: false, failures: ['not run'] };

  try {
    if (opts.dryRun) {
      plan = dryRunPlan(spec);
      agentText = JSON.stringify(plan);
    } else {
      const command = opts.command || defaultCommandFor(opts.agent);
      agentRun = runCommandLine(command, projectRoot, buildPrompt(projectRoot, spec), opts.timeoutMs);
      agentText = extractAgentText(agentRun.stdout || agentRun.stderr);
      if (agentRun.status !== 0) {
        throw new Error(`agent command failed exit=${agentRun.status}: ${agentRun.stderr || agentRun.stdout}`);
      }
      plan = parsePlan(agentText);
    }

    protocol = comparePlanToSpec(plan, spec);
    checks.push({ name: 'agent-protocol-and-exact-patch', status: protocol.ok ? 'passed' : 'failed', detail: protocol.failures.join('|') });
    if (protocol.ok) {
      apply = applyRepairSpec({ ...spec, patches: plan.patches }, { projectRoot });
      checks.push({ name: 'exact-replacement-apply', status: apply.ok ? 'passed' : 'failed', detail: apply.failures.join('|') });
    }

    if (apply.ok) {
      const gateScript = path.join(HOME, 'engine/scripts/hooks/repair-content-gate.cjs');
      const gateRun = run(process.execPath, [gateScript, '--check', '--spec', specPath, '--project-root', projectRoot], projectRoot, '', 30000);
      contentGate = {
        ok: gateRun.status === 0,
        failures: gateRun.status === 0 ? [] : [gateRun.stderr || gateRun.stdout],
        checks: [],
      };
      checks.push({ name: 'repair-content-gate', status: contentGate.ok ? 'passed' : 'failed', detail: contentGate.failures.join('|') });
    }

    if (contentGate.ok) {
      verifier = runVerifier(projectRoot, ledgerPath);
      ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      evidenceStatus = statusFromEvidence(ledger.entries, spec.expectedCommands);
      logEvidence = checkExpectedLogEvidence(spec, ledger);
      checks.push({ name: 'public-log-evidence', status: logEvidence.ok ? 'passed' : 'failed', detail: logEvidence.failures.join('|') });
      checks.push({ name: 'evidence-ledger-status', status: evidenceStatus.status, detail: evidenceStatus.failures.join('|') });
    }
  } catch (error) {
    checks.push({ name: 'executor-exception', status: 'failed', detail: error.stack || error.message });
  }

  const dimensions = {
    protocolCompliance: protocol.ok ? 'passed' : 'failed',
    patchApplied: apply.ok ? 'passed' : 'failed',
    contentGate: contentGate.ok ? 'passed' : 'failed',
    toolchainHealth: verifier?.evidence?.classification?.status || 'not_run',
    evidenceLedger: evidenceStatus.status,
    logEvidence: logEvidence.ok ? 'passed' : 'failed',
  };
  const status = Object.values(dimensions).every((value) => value === 'passed') ? 'passed' : 'failed';
  const result = {
    schemaVersion: 1,
    mode: 'claude-patch-executor',
    agent: opts.dryRun ? 'dry-run' : opts.agent,
    status,
    projectRoot,
    specPath,
    evidenceLedger: ledgerPath,
    dimensions,
    checks,
    applied: apply.applied,
    agentOutputSha256: sha256(agentText),
    agentRun: agentRun ? summarizeRun(agentRun) : null,
  };
  writeText(path.join(outDir, 'claude-patch-executor.json'), JSON.stringify(result, null, 2));
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const agent = argValue(args, '--agent', dryRun ? 'dry-run' : 'claude');
  if (!dryRun && !['claude', 'codex'].includes(agent)) {
    console.error(`unsupported agent: ${agent}`);
    process.exit(1);
  }

  const outDir = path.resolve(argValue(args, '--out', path.join(DEFAULT_RUN_ROOT, `${Date.now()}`)));
  const command = argValue(args, '--command', '');
  const readiness = dryRun ? { agent: 'dry-run', status: 'available' } : readinessProbe(agent);
  if (!dryRun && readiness.status !== 'available') {
    ensureDir(outDir);
    const blocked = {
      schemaVersion: 1,
      mode: 'claude-patch-executor',
      agent,
      status: 'blocked',
      readiness,
    };
    writeText(path.join(outDir, 'claude-patch-executor.json'), JSON.stringify(blocked, null, 2));
    console.log(`BLOCKED claude-patch-executor ${agent}`);
    console.log(JSON.stringify(blocked, null, 2));
    process.exit(2);
  }

  try {
    const result = runEval({
      dryRun,
      agent,
      outDir,
      command,
      timeoutMs: Number(argValue(args, '--timeout-ms', '600000')),
    });
    console.log(`${result.status.toUpperCase()} claude-patch-executor ${result.agent}`);
    console.log(JSON.stringify(result.dimensions));
    process.exit(result.status === 'passed' ? 0 : 1);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  NEW_BLOCK,
  OLD_BLOCK,
  SENTINEL,
  dryRunPlan,
  extractAgentText,
  parsePlan,
  publicVerifier,
  repairSpec,
  runEval,
};
