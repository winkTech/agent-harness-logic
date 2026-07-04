#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  CORE_PROJECT_DIRS,
  modulePaths,
  writeDirectoryContract,
  validateProjectDirs,
  placementViolations,
} = require('../lib/project-directory-contract.cjs');

const HOME = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_RUN_ROOT = path.join(os.tmpdir(), 'claude-harness-agent-evals', 'hdl-project-directory');
const MODULE = 'tone_fsk_demod';
const EXPECTED_CLASSIFICATION = 'hdl_project_directory_plan';
const CODEX_NPX_EXEC_COMMAND = process.platform === 'win32'
  ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --skip-git-repo-check --ephemeral --color never"'
  : 'npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --skip-git-repo-check --ephemeral --color never';
const REQUIRED_CHECKLIST = [
  '行动: create canonical HDL project scaffold',
  '用户指令: "build the HDL project only under the canonical directory contract"',
  '匹配: ✅',
  '门禁: 🚦需求澄清[ ✅ ] 🧪验证质量[ ✅ ]',
].join('\n');

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

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
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

function runCommandLine(command, cwd, input, timeoutMs = 10 * 60 * 1000) {
  const argv = parseCommandLine(command);
  if (!argv.length) throw new Error('empty command');
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: false,
    env: { ...process.env, CLAUDE_VERIFY_GATE_STATE_FILE: path.join(cwd, 'var', 'verify-gate.json') },
  });
  return {
    commandArgv: argv,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function defaultCommandFor(agent) {
  if (agent === 'codex') return process.env.CODEX_EVAL_COMMAND || CODEX_NPX_EXEC_COMMAND;
  return process.env.CLAUDE_EVAL_COMMAND
    || 'claude -p --tools "" --output-format json --permission-mode bypassPermissions --no-session-persistence';
}

function extractResponseText(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.response === 'string') return parsed.response;
    if (typeof parsed.content === 'string') return parsed.content;
  } catch {
    // Not a single JSON wrapper.
  }
  let lastText = '';
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line);
      const parts = event?.message && Array.isArray(event.message.content) ? event.message.content : [];
      const text = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
      if (text) lastText = text;
      if (event.type === 'result' && typeof event.result === 'string') lastText = event.result;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        lastText = event.item.text;
      }
    } catch {
      // Ignore non-JSONL lines.
    }
  }
  return lastText || raw;
}

function stripFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseManagedJson(text) {
  const candidate = stripFence(text);
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('directory response did not contain parseable JSON');
  }
}

function checklist() {
  return REQUIRED_CHECKLIST;
}

function buildPrompt(previousFailure = null) {
  const paths = modulePaths(MODULE);
  return [
    '# HDL Project Directory Contract Eval',
    '',
    'You are in managed action mode. Do not run tools. Return exactly one JSON object.',
    'The harness will apply your mkdir/write plan and reject non-canonical paths.',
    '',
    'Mandatory checklist rule:',
    'Copy this exact four-line block into the top-level checklistText field and into every files[i].checklistText field.',
    'Do not translate it, summarize it, turn it into bullets, or replace the labels with synonyms.',
    'The validator requires these exact visible labels: 行动:, 用户指令:, 匹配:, 门禁:.',
    'Required checklist block:',
    REQUIRED_CHECKLIST,
    '',
    'User request:',
    '"Build a clean HDL project scaffold for a tone FSK demodulator. Follow the hdl-coding directory workflow exactly."',
    '',
    'Required directory contract:',
    ...CORE_PROJECT_DIRS.map((dir) => `- ${dir}/`),
    `- ${paths.rtlDir.replace(/\\/g, '/')}/`,
    `- ${paths.simDir.replace(/\\/g, '/')}/`,
    '',
    'Forbidden top-level project directories: rtl/, tb/, constraints/, build/, reports/, docs/, sim/, src/.',
    'Forbidden root artifacts: *.vcd, *.vvp, *.log, *.jou, *.dcp, *.rpt.',
    '',
    'Required files:',
    '- Makefile',
    '- .gitignore',
    '- README.md',
    `- ${paths.rtl.replace(/\\/g, '/')}`,
    `- ${paths.tb.replace(/\\/g, '/')}`,
    '- 06_doc/PROJECT_INIT_STATUS.md',
    '',
    'Return schema:',
    '{',
    '  "schemaVersion": 1,',
    `  "classification": "${EXPECTED_CLASSIFICATION}",`,
    '  "checklistText": "... exact four-line visible checklist ...",',
    '  "mkdirs": ["..."],',
    '  "files": [{"path": "...", "content": "...", "checklistText": "..."}],',
    '  "finalResponse": "..."',
    '}',
    '',
    'Every file path must be relative. RTL must not contain initial/#delay/wait/force/disable.',
    previousFailure ? [
      'Previous failure to fix:',
      JSON.stringify(previousFailure, null, 2),
      'If the failure says checklistText is missing required visible labels, the previous response used a paraphrase.',
      'Repair by copying the required checklist block exactly into every checklistText field.',
    ].join('\n') : '',
  ].filter(Boolean).join('\n');
}

function cannedPlan() {
  const paths = modulePaths(MODULE);
  return {
    schemaVersion: 1,
    classification: EXPECTED_CLASSIFICATION,
    checklistText: checklist(),
    mkdirs: [...CORE_PROJECT_DIRS, paths.rtlDir, paths.simDir],
    files: [
      { path: 'Makefile', checklistText: checklist(), content: 'lint:\n\t@echo lint\ncompile:\n\t@echo compile\nsim:\n\t@echo sim\nclean:\n\trm -rf work *.vcd *.vvp *.log *.jou\n' },
      { path: '.gitignore', checklistText: checklist(), content: 'work/\n*.vcd\n*.vvp\n*.wlf\n*.log\n*.jou\n.Xil/\nxsim.dir/\n' },
      { path: 'README.md', checklistText: checklist(), content: '# tone_fsk_project\n\nCanonical HDL project scaffold.\n' },
      { path: '06_doc/PROJECT_INIT_STATUS.md', checklistText: checklist(), content: '# Project Init Status\n\n- status: initialized\n- layout: hdl-root-v1\n' },
      {
        path: paths.rtl.replace(/\\/g, '/'),
        checklistText: checklist(),
        content: `module ${MODULE} (\n  input  logic       i_clk,\n  input  logic       i_rst,\n  input  logic       ri_sample_valid,\n  output logic       ro_symbol_valid\n);\n  always_ff @(posedge i_clk) begin\n    if (i_rst) ro_symbol_valid <= 1'b0;\n    else ro_symbol_valid <= ri_sample_valid;\n  end\nendmodule\n`,
      },
      {
        path: paths.tb.replace(/\\/g, '/'),
        checklistText: checklist(),
        content: '`timescale 1ns/1ps\nmodule tb_tone_fsk_demod;\n  logic i_clk, i_rst, ri_sample_valid, ro_symbol_valid;\n  tone_fsk_demod u_dut(.*);\n  initial i_clk = 0;\n  always #5 i_clk = ~i_clk;\n  initial begin i_rst = 1; ri_sample_valid = 0; repeat (2) @(posedge i_clk); i_rst = 0; ri_sample_valid = 1; repeat (2) @(posedge i_clk); $finish; end\nendmodule\n',
      },
    ],
    finalResponse: 'Created canonical HDL project scaffold.',
  };
}

function hasChecklist(text) {
  const value = String(text || '');
  return value.includes('行动:')
    && value.includes('用户指令:')
    && value.includes('匹配:')
    && value.includes('门禁:')
    && value.includes('需求澄清')
    && value.includes('验证质量');
}

function validatePlan(plan) {
  const failures = [];
  if (!plan || typeof plan !== 'object') failures.push('plan is not an object');
  if (plan.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (plan.classification !== EXPECTED_CLASSIFICATION) failures.push(`classification must be ${EXPECTED_CLASSIFICATION}`);
  if (!hasChecklist(plan.checklistText)) failures.push('top-level checklistText is missing required visible labels');
  if (!Array.isArray(plan.mkdirs) || plan.mkdirs.length === 0) failures.push('mkdirs must be a non-empty array');
  if (!Array.isArray(plan.files) || plan.files.length === 0) failures.push('files must be a non-empty array');

  const paths = [];
  for (const rel of plan.mkdirs || []) paths.push(String(rel || ''));
  for (const file of plan.files || []) {
    paths.push(String(file?.path || ''));
    if (!hasChecklist(file?.checklistText)) failures.push(`file ${file?.path || '<missing>'} lacks checklistText`);
  }

  for (const rel of paths) {
    if (!rel || path.isAbsolute(rel) || rel.includes('..')) failures.push(`invalid relative path: ${rel}`);
    for (const violation of placementViolations(rel)) failures.push(violation);
  }

  return { status: failures.length ? 'failed' : 'passed', failures: [...new Set(failures)] };
}

function applyPlan(plan, outDir) {
  for (const dir of plan.mkdirs || []) ensureDir(path.join(outDir, dir));
  for (const file of plan.files || []) writeText(path.join(outDir, file.path), file.content || '');
  writeDirectoryContract(outDir, { projectName: 'tone_fsk_project', modules: [MODULE], createdAt: '2026-07-04T00:00:00.000Z' });
}

function verify(outDir) {
  const paths = modulePaths(MODULE);
  const checks = [];
  const contract = validateProjectDirs(outDir, { modules: [MODULE], requireRootFiles: true });
  checks.push({ name: 'project-directory-contract', status: contract.ok ? 'passed' : 'failed', detail: contract.failures.join('; ') });
  for (const rel of ['Makefile', '.gitignore', 'README.md', '06_doc/PROJECT_INIT_STATUS.md', paths.rtl, paths.tb]) {
    const exists = fs.existsSync(path.join(outDir, rel));
    checks.push({ name: `exists:${rel.replace(/\\/g, '/')}`, status: exists ? 'passed' : 'failed' });
  }
  const rtl = fs.existsSync(path.join(outDir, paths.rtl)) ? fs.readFileSync(path.join(outDir, paths.rtl), 'utf8') : '';
  checks.push({ name: 'rtl-module-name', status: new RegExp(`\\bmodule\\s+${MODULE}\\b`).test(rtl) ? 'passed' : 'failed' });
  checks.push({ name: 'rtl-no-testbench-constructs', status: /\b(initial|#\d+|wait|force|disable)\b/.test(rtl) ? 'failed' : 'passed' });
  return { status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed', checks };
}

function runAttempt({ dryRun, agent, command, outDir, attempt, previousFailure }) {
  const prompt = buildPrompt(previousFailure);
  writeText(path.join(outDir, `attempt-${attempt}-prompt.txt`), prompt);

  let rawOutput = '';
  let responseText = '';
  let plan = null;
  let parseError = '';
  let agentRun = null;
  if (dryRun) {
    plan = cannedPlan();
    responseText = JSON.stringify(plan, null, 2);
    rawOutput = responseText;
  } else {
    agentRun = runCommandLine(command, outDir, prompt);
    rawOutput = `${agentRun.stdout}${agentRun.stderr}`;
    responseText = extractResponseText(rawOutput);
    try {
      plan = parseManagedJson(responseText);
    } catch (error) {
      parseError = error.message;
    }
  }

  writeText(path.join(outDir, `attempt-${attempt}-agent-output.txt`), rawOutput);
  writeText(path.join(outDir, `attempt-${attempt}-response-text.txt`), responseText);
  if (plan) writeText(path.join(outDir, `attempt-${attempt}-response.json`), JSON.stringify(plan, null, 2));

  let protocol = { status: 'failed', failures: parseError ? [parseError] : ['missing plan'] };
  let functional = { status: 'not_run', checks: [] };
  if (plan) {
    protocol = validatePlan(plan);
    if (agentRun && agentRun.status !== 0) {
      protocol.status = 'failed';
      protocol.failures.push(`agent exited with status ${agentRun.status}`);
    }
    if (protocol.status === 'passed') {
      applyPlan(plan, outDir);
      functional = verify(outDir);
    }
  }

  const status = protocol.status === 'passed' && functional.status === 'passed' ? 'passed' : 'failed';
  return {
    attempt,
    status,
    agentExitCode: agentRun ? agentRun.status : null,
    promptSha256: sha256(prompt),
    responsePath: plan ? path.join(outDir, `attempt-${attempt}-response.json`) : null,
    dimensions: {
      protocolCompliance: protocol.status,
      directoryContract: functional.status,
      overallStatus: status,
    },
    complianceFailures: protocol.failures,
    functionalChecks: functional.checks,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const agent = argValue(args, '--agent', dryRun ? 'fixture' : 'claude');
  const command = argValue(args, '--command', defaultCommandFor(agent));
  const maxAttempts = Number.parseInt(argValue(args, '--max-attempts', dryRun ? '1' : '2'), 10);
  const outDir = path.resolve(argValue(args, '--out', path.join(DEFAULT_RUN_ROOT, `${agent}-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  const attempts = [];
  let previousFailure = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    const result = runAttempt({ dryRun, agent, command, outDir, attempt, previousFailure });
    attempts.push(result);
    if (result.status === 'passed') break;
    previousFailure = { complianceFailures: result.complianceFailures, functionalChecks: result.functionalChecks };
  }

  const finalAttempt = attempts[attempts.length - 1] || {};
  const status = finalAttempt.status === 'passed' ? 'passed' : 'failed';
  const manifest = {
    schemaVersion: 1,
    mode: 'hdl-project-directory',
    agent,
    requestedCommand: command,
    outDir,
    status,
    dimensions: finalAttempt.dimensions || {},
    attempts,
    finalFunctionalChecks: finalAttempt.functionalChecks || [],
  };
  writeText(path.join(outDir, 'hdl-project-directory-eval.json'), JSON.stringify(manifest, null, 2));
  console.log(`${status.toUpperCase()} hdl-project-directory ${agent}`);
  console.log(JSON.stringify(manifest.dimensions));
  if (status !== 'passed') process.exit(1);
}

main();
