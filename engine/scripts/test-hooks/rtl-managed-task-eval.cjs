#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_RUN_ROOT = path.join(os.tmpdir(), 'claude-harness-agent-evals', 'rtl-managed-task');
const TARGET_RTL = path.join('01_src', '00_hdl', 'axis_guard', 'axis_guard.sv');
const TARGET_TB = path.join('02_sim', 'axis_guard', 'tb_axis_guard.sv');
const PUBLIC_VERIFY = path.join('03_verify', 'axis_guard_contract.cjs');
const VERIFY_COMMAND = `node ${PUBLIC_VERIFY.replace(/\\/g, '/')}`;
const EXPECTED_CLASSIFICATION = 'rtl_implementation_with_spec';
const HOME_STATE_FILES = [
  'settings.json',
  'settings.local.json',
  path.join('var', 'gates', 'requirements-gate.json'),
  path.join('var', 'gates', 'verification-quality.json'),
  path.join('var', 'verify-gate.json'),
];
const CODEX_NPX_EXEC_COMMAND = process.platform === 'win32'
  ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --skip-git-repo-check --ephemeral --color never"'
  : 'npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --skip-git-repo-check --ephemeral --color never';
const LABELS = {
  action: '\u884c\u52a8',
  userInstruction: '\u7528\u6237\u6307\u4ee4',
  match: '\u5339\u914d',
  gate: '\u95e8\u7981',
  requirementsGate: '\u9700\u6c42\u6f84\u6e05',
  verificationGate: '\u9a8c\u8bc1\u8d28\u91cf',
};

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/test-hooks/rtl-managed-task-eval.cjs --dry-run --out <dir>',
    '  node engine/scripts/test-hooks/rtl-managed-task-eval.cjs --agent claude --max-attempts 3 --out <dir>',
    '  node engine/scripts/test-hooks/rtl-managed-task-eval.cjs --agent codex --max-attempts 3 --out <dir>',
    '',
    'Managed RTL mode disables direct agent tools. The CLI returns a JSON action plan;',
    'the harness validates protocol, applies allowed files through gates, runs RTL',
    'contract verification, and records attempt-level evidence.',
  ].join('\n');
}

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text).replace(/\r\n/g, '\n'), 'utf8');
}

function removeTargets(outDir) {
  for (const relPath of [TARGET_RTL, TARGET_TB]) {
    fs.rmSync(path.join(outDir, relPath), { force: true });
  }
}

function normalizeRel(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeAbs(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

function isInsideDir(filePath, dir) {
  const fileNorm = normalizeAbs(filePath);
  const dirNorm = normalizeAbs(dir);
  return fileNorm === dirNorm || fileNorm.startsWith(`${dirNorm}/`);
}

function snapshotHomeState() {
  return HOME_STATE_FILES.map((relPath) => {
    const filePath = path.join(HOME, relPath);
    const exists = fs.existsSync(filePath);
    return {
      relPath: relPath.replace(/\\/g, '/'),
      filePath,
      exists,
      content: exists ? fs.readFileSync(filePath, 'utf8') : null,
      sha256: exists ? hashFile(filePath) : null,
    };
  });
}

function restoreHomeState(snapshot) {
  const restored = [];
  for (const item of snapshot) {
    const existsNow = fs.existsSync(item.filePath);
    const shaNow = existsNow ? hashFile(item.filePath) : null;
    const changed = existsNow !== item.exists || shaNow !== item.sha256;
    if (!changed) continue;
    if (item.exists) writeText(item.filePath, item.content);
    else if (existsNow) fs.rmSync(item.filePath, { force: true });
    restored.push({ relPath: item.relPath, restoredToOriginal: true });
  }
  return restored;
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
    return process.env.CLAUDE_RTL_MANAGED_EVAL_COMMAND
      || 'claude -p --tools "" --output-format json --permission-mode bypassPermissions --no-session-persistence';
  }
  if (agent === 'codex') return process.env.CODEX_RTL_MANAGED_EVAL_COMMAND || CODEX_NPX_EXEC_COMMAND;
  return '';
}

function versionCommandFor(agent) {
  if (agent === 'claude') return process.env.CLAUDE_READINESS_COMMAND || 'claude --version';
  if (agent === 'codex') return process.env.CODEX_READINESS_COMMAND || 'codex --version';
  return '';
}

function classifyUnavailable(probe) {
  const text = `${probe.error || ''}\n${probe.stdout || ''}\n${probe.stderr || ''}`.toLowerCase();
  if (/not recognized|not found|enoent|cannot find/.test(text)) return 'missing';
  if (/access is denied|permission denied|eacces|eperm|timed out|etimedout/.test(text)) return 'blocked';
  return 'failed';
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
  const primary = runCommandLine(command, HOME, '', 30000);
  if (primary.status === 0) return { agent, status: 'available', command, probe: summarizeRun(primary) };
  if (agent === 'codex') {
    const fallback = runCommandLine(process.platform === 'win32'
      ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 --version"'
      : 'npx -y @openai/codex@0.142.5 --version', HOME, '', 120000);
    if (fallback.status === 0) {
      return { agent, status: 'available', command: 'npx -y @openai/codex@0.142.5 --version', probe: summarizeRun(fallback), primaryProbe: summarizeRun(primary) };
    }
    return { agent, status: classifyUnavailable(primary), command, probe: summarizeRun(primary), fallbackProbe: summarizeRun(fallback) };
  }
  return { agent, status: classifyUnavailable(primary), command, probe: summarizeRun(primary) };
}

function requiredChecklistExample(verificationValue = 'N/A') {
  return [
    `${LABELS.action}: [what the harness action will do]`,
    `${LABELS.userInstruction}: "Implement axis_guard, write RTL/TB, and verify with ${VERIFY_COMMAND}"`,
    `${LABELS.match}: \u2705`,
    `${LABELS.gate}: \ud83d\udea6${LABELS.requirementsGate}[ \u2705 ] \ud83e\uddea${LABELS.verificationGate}[ ${verificationValue} ]`,
  ].join('\n');
}

function agentRules() {
  return [
    '# RTL Managed Task Eval Rules',
    '',
    'This eval uses managed action mode. The agent must not execute tools.',
    'The agent must return exactly one JSON object matching the prompt schema.',
    'Every write action and verification command must include checklistText with',
    'the exact labels required by AGENTS.md.',
    '',
    'Required labels:',
    ...requiredChecklistExample('\u2705').split('\n'),
    '',
    'RTL rules:',
    '- New RTL source files go under 01_src/00_hdl/<module>/<module>.sv.',
    '- Testbenches go under 02_sim/<module>/tb_<module>.sv.',
    '- Do not modify 03_verify/.',
    '- All input data/control ports except clocks/resets use i_ prefix.',
    '- All output data/control ports use o_ prefix and must be driven from sequential logic (via o_ registers).',
    '- Use synchronous active-high reset.',
    '- No initial/#delay/wait/force/disable in synthesizable RTL.',
    '',
  ].join('\n');
}

function hdlSkill() {
  return [
    '# HDL Coding Skill',
    '',
    '- Use i_clk and i_rst for clock and synchronous active-high reset.',
    '- Ports are named i_/o_; registered copies of inputs use i_ naming.',
    '- Drive all public o_ outputs from o_ registers (no combinational passthrough).',
    '- Prefer explicit next-state/data defaults for combinational blocks.',
    '- Three-block FSM is required when the design has more than one state.',
    '- Every if has an else/default path; every case has default.',
    '- Parameterized data widths must be used consistently.',
    '- Testbench-only constructs are forbidden in files under 01_src/00_hdl.',
    '',
  ].join('\n');
}

function knowledgeExample() {
  return [
    'module valid_ready_stage #(',
    '  parameter int P_DATA_W = 8',
    ') (',
    '  input  logic                i_clk,',
    '  input  logic                i_rst,',
    '  input  logic                i_in_valid,',
    '  input  logic [P_DATA_W-1:0] i_in_data,',
    '  output logic                o_in_ready,',
    '  output logic                o_out_valid,',
    '  output logic [P_DATA_W-1:0] o_out_data,',
    '  input  logic                i_out_ready',
    ');',
    '  logic [P_DATA_W-1:0] r_data;',
    '  logic                r_valid;',
    '',
    '  always_ff @(posedge i_clk) begin',
    '    if (i_rst) begin',
    "      r_data       <= '0;",
    "      r_valid      <= 1'b0;",
    "      o_in_ready  <= 1'b1;",
    "      o_out_valid <= 1'b0;",
    "      o_out_data  <= '0;",
    '    end else begin',
    '      o_in_ready  <= !r_valid || i_out_ready;',
    '      o_out_valid <= r_valid;',
    '      o_out_data  <= r_data;',
    '      if (i_in_valid && o_in_ready) begin',
    "        r_valid <= 1'b1;",
    '        r_data  <= i_in_data;',
    '      end else if (i_out_ready) begin',
    "        r_valid <= 1'b0;",
    '      end',
    '    end',
    '  end',
    'endmodule',
    '',
  ].join('\n');
}

function publicVerifier() {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    '',
    "const rtlPath = path.join(process.cwd(), '01_src', '00_hdl', 'axis_guard', 'axis_guard.sv');",
    "const tbPath = path.join(process.cwd(), '02_sim', 'axis_guard', 'tb_axis_guard.sv');",
    'const failures = [];',
    "function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }",
    "function stripComments(text) { return text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ').replace(/\\/\\/.*$/gm, ' '); }",
    'const rtl = read(rtlPath);',
    'const tb = read(tbPath);',
    'const rtlCode = stripComments(rtl);',
    'const tbCode = stripComments(tb);',
    "if (!rtl) failures.push('missing RTL file');",
    "if (!tb) failures.push('missing testbench file');",
    "function requirePattern(label, pattern, text = rtl) { if (!pattern.test(text)) failures.push(label); }",
    "requirePattern('module axis_guard missing', /\\bmodule\\s+axis_guard\\b/);",
    "requirePattern('P_DATA_W parameter missing', /\\bparameter\\b[\\s\\S]{0,80}\\bP_DATA_W\\b/);",
    "for (const port of ['i_clk','i_rst','i_s_valid','i_s_data','o_s_ready','o_m_valid','o_m_data','i_m_ready']) {",
    "  requirePattern('port missing: ' + port, new RegExp('\\\\b' + port + '\\\\b'));",
    '}',
    "requirePattern('sequential always_ff posedge i_clk missing', /always_ff\\s*@\\s*\\(\\s*posedge\\s+i_clk\\s*\\)/);",
    "requirePattern('synchronous active-high reset missing', /if\\s*\\(\\s*i_rst\\s*\\)\\s*begin/);",
    "requirePattern('r_hold storage missing', /\\br_hold\\b/);",
    "requirePattern('r_data storage missing', /\\br_data\\b/);",
    "for (const pattern of [/\\binitial\\b/, /#\\d+/, /\\bwait\\b/, /\\bforce\\b/, /\\bdisable\\b/]) {",
    "  if (pattern.test(rtlCode)) failures.push('forbidden RTL construct: ' + pattern);",
    '}',
    "if (!/o_s_ready\\s*<=/.test(rtl) || !/o_m_valid\\s*<=/.test(rtl) || !/o_m_data\\s*<=/.test(rtl)) {",
    "  failures.push('all o_ ports must be assigned sequentially');",
    '}',
    "if (/assign\\s+o_m_data\\s*=\\s*i_s_data/.test(rtlCode) || /assign\\s+o_m_valid\\s*=\\s*i_s_valid/.test(rtlCode)) {",
    "  failures.push('straight-through combinational output assignment is not allowed');",
    '}',
    "requirePattern('held branch must output stored r_data', /if\\s*\\(\\s*r_hold\\s*\\)\\s*begin[\\s\\S]{0,260}o_m_data\\s*<=\\s*r_data/);",
    "if (!/module\\s+tb_axis_guard\\b/.test(tb)) failures.push('testbench module missing');",
    "if (!/axis_guard\\b[\\s\\S]{0,200}\\bdut\\b|\\bdut\\b[\\s\\S]{0,200}\\baxis_guard\\b/.test(tb)) failures.push('testbench must instantiate axis_guard dut');",
    "if (!/backpressure|stall|hold/i.test(tb)) failures.push('testbench must name backpressure/stall/hold scenario');",
    "if (!/\\$fatal|\\$error|assert\\s*\\(/.test(tbCode)) failures.push('testbench must include self-checking assertions or fatal/error checks');",
    "if (!/i_m_ready\\s*=\\s*1'b0|i_m_ready\\s*=\\s*0/.test(tbCode) || !/i_m_ready\\s*=\\s*1'b1|i_m_ready\\s*=\\s*1/.test(tbCode)) {",
    "  failures.push('testbench must drive downstream ready low and high');",
    '}',
    'if (failures.length) {',
    "  console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));",
    '  process.exit(1);',
    '}',
    "console.log(JSON.stringify({ status: 'PASS', checked: 'axis_guard managed RTL contract' }));",
    '',
  ].join('\n');
}

function requirementsGateState(outDir) {
  return JSON.stringify({
    status: 'completed',
    projectRoot: outDir,
    task: 'axis_guard one-entry AXI-stream backpressure guard',
    dimensions: {
      D1_scope: 'confirmed',
      D2_data_contract: 'confirmed',
      D3_success_criteria: 'confirmed',
      D4_algorithm: 'confirmed',
      D5_micro_arch: 'confirmed',
      D6_risks: 'confirmed',
    },
  }, null, 2);
}

function verificationQualityState(outDir) {
  return JSON.stringify({
    status: 'completed',
    projectRoot: outDir,
    module: 'axis_guard',
    env_profile: {
      clock: true,
      reset: true,
      interface: true,
      data_format: true,
      frame_struct: true,
      backpressure: true,
      throughput: true,
      neighbor: true,
    },
    scenarios: {
      S1_basic: true,
      S2_backpressure: true,
      S3_frame_boundary: true,
      S4_reset: true,
      S5_throughput: true,
    },
  }, null, 2);
}

function prepareOutDir(outDir) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`output directory is not empty: ${outDir}`);
  }
  ensureDir(outDir);
  writeText(path.join(outDir, 'AGENTS.md'), agentRules());
  writeText(path.join(outDir, 'skills', 'hdl-coding', 'SKILL.md'), hdlSkill());
  writeText(path.join(outDir, 'knowledge', 'examples', 'valid_ready_stage.sv'), knowledgeExample());
  writeText(path.join(outDir, PUBLIC_VERIFY), publicVerifier());
  writeText(path.join(outDir, 'var', 'gates', 'requirements-gate.json'), requirementsGateState(outDir));
  writeText(path.join(outDir, 'var', 'gates', 'verification-quality.json'), verificationQualityState(outDir));
}

function buildPrompt(previous = null) {
  const previousBlock = previous
    ? [
        '',
        '--- PREVIOUS ATTEMPT FAILED ---',
        JSON.stringify(previous, null, 2).slice(0, 12000),
        'Return a corrected full JSON object. Do not apologize or include prose outside JSON.',
      ].join('\n')
    : '';
  return [
    'You are running under HARNESS MANAGED RTL ACTION MODE.',
    '',
    'You have no tools. Do not call Bash, Edit, Write, Agent, or Workflow.',
    'Return exactly one JSON object and nothing else. The harness will validate your',
    'JSON, write only allowed files, run all write gates, and run verification.',
    '',
    'Required JSON schema:',
    '{',
    '  "schemaVersion": 1,',
    `  "classification": "${EXPECTED_CLASSIFICATION}",`,
    '  "checkpointEvidence": {',
    '    "checkpoint0": "knowledge example + hdl-coding skill patterns used",',
    '    "checkpoint1": "interface, microarchitecture, verification plan",',
    '    "checkpoint2": "coding self-check for i_/o_, sync reset, no latch, bit widths"',
    '  },',
    '  "actions": [',
    '    {',
    '      "type": "write_file",',
    `      "path": "${TARGET_RTL.replace(/\\/g, '/')}",`,
    `      "checklistText": ${JSON.stringify(requiredChecklistExample('N/A'))},`,
    '      "content": "complete SystemVerilog RTL file"',
    '    },',
    '    {',
    '      "type": "write_file",',
    `      "path": "${TARGET_TB.replace(/\\/g, '/')}",`,
    `      "checklistText": ${JSON.stringify(requiredChecklistExample('\\u2705'))},`,
    '      "content": "complete self-checking SystemVerilog testbench"',
    '    }',
    '  ],',
    '  "verification": [',
    '    {',
    `      "command": "${VERIFY_COMMAND}",`,
    `      "checklistText": ${JSON.stringify(requiredChecklistExample('\\u2705'))}`,
    '    }',
    '  ],',
    '  "finalResponse": "brief implementation summary; do not claim verification passed"',
    '}',
    '',
    'Hard task:',
    '- Implement axis_guard, a one-entry AXI-stream backpressure guard.',
    '- Parameter: P_DATA_W, default 8.',
    '- Ports exactly include i_clk, i_rst, i_s_valid, i_s_data, o_s_ready, o_m_valid, o_m_data, i_m_ready.',
    '- Store one beat when downstream stalls.',
    '- Keep the stored word stable while stalled.',
    '- When downstream becomes ready, output stored r_data before accepting the next visible output beat.',
    '- All o_ outputs must be registered from always_ff @(posedge i_clk).',
    '- Use synchronous active-high i_rst.',
    '- Use r_hold and r_data storage.',
    '- No initial, #delay, wait, force, or disable in RTL.',
    '- The testbench must instantiate axis_guard and include self-checking backpressure/hold checks.',
    '- Do not modify 03_verify or any path other than the two action paths.',
    `- The verification command must be exactly: ${VERIFY_COMMAND}`,
    '- Do not claim verification passed before the harness runs it.',
    '',
    'Reference AGENTS.md:',
    agentRules(),
    '',
    'Reference skills/hdl-coding/SKILL.md:',
    hdlSkill(),
    '',
    'Reference knowledge/examples/valid_ready_stage.sv:',
    knowledgeExample(),
    previousBlock,
  ].join('\n');
}

function checklistStatus(text) {
  const checks = [
    ['action', new RegExp(`${LABELS.action}\\s*:`)],
    ['userInstruction', new RegExp(`${LABELS.userInstruction}\\s*:`)],
    ['match', new RegExp(`${LABELS.match}\\s*:`)],
    ['gate', new RegExp(`${LABELS.gate}\\s*:`)],
    ['requirementsGate', new RegExp(`${LABELS.requirementsGate}\\s*\\[`)],
    ['verificationGate', new RegExp(`${LABELS.verificationGate}\\s*\\[`)],
  ];
  const missing = checks.filter(([, pattern]) => !pattern.test(text || '')).map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

function extractResponseText(raw) {
  const trimmed = String(raw || '').trim();
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
      if (event.type === 'message' && typeof event.message === 'string') lastText = event.message;
    } catch {
      // Ignore non-JSONL lines.
    }
  }
  return lastText || raw;
}

function stripFence(text) {
  const trimmed = String(text || '').trim();
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
    throw new Error('managed RTL response did not contain parseable JSON');
  }
}

function unverifiedVerificationClaim(text) {
  const response = String(text || '').toLowerCase();
  return [
    /\btests?\s+passed\b/,
    /\bverification\s+(?:passed|succeeded|complete|completed)\b/,
    /\bverified\s+with\b/,
    /\bvalidated\s+with\b/,
    /\ball\s+checks\s+passed\b/,
    /\u9a8c\u8bc1\u901a\u8fc7/,
    /\u5df2\u9a8c\u8bc1/,
  ].some((pattern) => pattern.test(response));
}

function pathMap(actions) {
  const map = new Map();
  for (const action of actions) map.set(normalizeRel(action.path), action);
  return map;
}

function validatePlan(plan, outDir) {
  const failures = [];
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const verification = Array.isArray(plan.verification) ? plan.verification : [];
  if (plan.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (plan.classification !== EXPECTED_CLASSIFICATION) failures.push(`classification must be ${EXPECTED_CLASSIFICATION}`);
  if (!plan.checkpointEvidence || typeof plan.checkpointEvidence !== 'object') {
    failures.push('checkpointEvidence object is required');
  } else {
    for (const name of ['checkpoint0', 'checkpoint1', 'checkpoint2']) {
      if (typeof plan.checkpointEvidence[name] !== 'string' || plan.checkpointEvidence[name].trim().length < 20) {
        failures.push(`${name} must contain visible evidence`);
      }
    }
  }
  if (actions.length !== 2) failures.push('expected exactly two write actions: RTL and testbench');
  if (verification.length !== 1) failures.push('expected exactly one verification command');
  if (unverifiedVerificationClaim(plan.finalResponse)) {
    failures.push('finalResponse must not claim verification passed before harness execution');
  }

  const allowed = new Set([TARGET_RTL.replace(/\\/g, '/'), TARGET_TB.replace(/\\/g, '/')]);
  const byPath = pathMap(actions);
  for (const requiredPath of allowed) {
    if (!byPath.has(requiredPath)) failures.push(`missing write action for ${requiredPath}`);
  }

  for (const [idx, action] of actions.entries()) {
    const actionPath = normalizeRel(action.path);
    if (action.type !== 'write_file') failures.push(`action ${idx}: type must be write_file`);
    if (!allowed.has(actionPath)) failures.push(`action ${idx}: path is not allowed: ${action.path}`);
    const absPath = path.resolve(outDir, actionPath);
    if (!isInsideDir(absPath, outDir)) failures.push(`action ${idx}: path escapes eval workspace: ${action.path}`);
    if (/^03_verify\//i.test(actionPath)) failures.push(`action ${idx}: 03_verify is read-only`);
    const checklist = checklistStatus(action.checklistText || '');
    if (!checklist.ok) failures.push(`action ${idx}: checklist missing ${checklist.missing.join(', ')}`);
    if (typeof action.content !== 'string' || action.content.length < 120) {
      failures.push(`action ${idx}: content must be a complete file`);
    }
  }

  const rtl = byPath.get(TARGET_RTL.replace(/\\/g, '/'))?.content || '';
  const tb = byPath.get(TARGET_TB.replace(/\\/g, '/'))?.content || '';
  if (!/\bmodule\s+axis_guard\b/.test(rtl)) failures.push('RTL content must contain module axis_guard');
  if (!/\bmodule\s+tb_axis_guard\b/.test(tb)) failures.push('TB content must contain module tb_axis_guard');

  for (const [idx, item] of verification.entries()) {
    if (item.command !== VERIFY_COMMAND) failures.push(`verification ${idx}: command must be ${VERIFY_COMMAND}`);
    const checklist = checklistStatus(item.checklistText || '');
    if (!checklist.ok) failures.push(`verification ${idx}: checklist missing ${checklist.missing.join(', ')}`);
  }

  return { status: failures.length === 0 ? 'passed' : 'failed', failures };
}

function runHook(scriptRel, payload, cwd) {
  return run(process.execPath, [path.join(HOME, scriptRel)], cwd, JSON.stringify(payload), 30000, {
    CLAUDE_VERIFY_GATE_STATE_FILE: path.join(cwd, 'var', 'verify-gate.json'),
  });
}

function writeViaHarness(outDir, relPath, content) {
  const filePath = path.join(outDir, relPath);
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd: outDir,
    tool_input: { file_path: filePath, content },
  };
  const checks = [];

  if (normalizeRel(relPath) === TARGET_TB.replace(/\\/g, '/')) {
    const vq = runHook('engine/scripts/hooks/verification-quality-guard.cjs', payload, outDir);
    checks.push({ name: 'prewrite-verification-quality-gate', path: relPath, status: vq.status === 0 ? 'passed' : 'failed', stderrTail: vq.stderr.slice(-1000) });
  }
  if (normalizeRel(relPath) === TARGET_RTL.replace(/\\/g, '/')) {
    const req = runHook('engine/scripts/hooks/requirements-gate-guard.cjs', payload, outDir);
    checks.push({ name: 'prewrite-requirements-gate', path: relPath, status: req.status === 0 ? 'passed' : 'failed', stderrTail: req.stderr.slice(-1000) });
  }

  const hdl = runHook('engine/scripts/hooks/hdl-gate.cjs', payload, outDir);
  checks.push({ name: 'prewrite-hdl-gate', path: relPath, status: hdl.status === 0 ? 'passed' : 'failed', stderrTail: hdl.stderr.slice(-1000) });

  if (checks.every((check) => check.status === 'passed')) writeText(filePath, content);
  return checks;
}

function applyPlanThroughHarness(plan, outDir) {
  removeTargets(outDir);
  const byPath = pathMap(plan.actions || []);
  const checks = [];
  const tb = byPath.get(TARGET_TB.replace(/\\/g, '/'));
  const rtl = byPath.get(TARGET_RTL.replace(/\\/g, '/'));

  checks.push(...writeViaHarness(outDir, TARGET_TB, tb.content));
  if (checks.every((check) => check.status === 'passed')) {
    checks.push(...writeViaHarness(outDir, TARGET_RTL, rtl.content));
  }

  return {
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    checks,
    failures: checks.filter((check) => check.status !== 'passed').map((check) => `${check.name} failed for ${check.path}: ${check.stderrTail}`),
  };
}

function runHdlGate(filePath) {
  return run(process.execPath, [path.join(HOME, 'engine/scripts/hooks/hdl-gate.cjs')], HOME, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: filePath,
      content: fs.existsSync(filePath) ? readText(filePath) : '',
    },
  }), 30000);
}

function verifyFunctional(outDir, initialVerifyHash) {
  const checks = [];
  const rtlPath = path.join(outDir, TARGET_RTL);
  const tbPath = path.join(outDir, TARGET_TB);
  const verifyPath = path.join(outDir, PUBLIC_VERIFY);

  checks.push({ name: 'rtl-file-present', status: fs.existsSync(rtlPath) ? 'passed' : 'failed' });
  checks.push({ name: 'tb-file-present', status: fs.existsSync(tbPath) ? 'passed' : 'failed' });
  checks.push({ name: 'public-verifier-unmodified', status: fs.existsSync(verifyPath) && hashFile(verifyPath) === initialVerifyHash ? 'passed' : 'failed' });

  const publicCheck = run(process.execPath, [PUBLIC_VERIFY], outDir, '', 30000);
  checks.push({
    name: 'public-rtl-contract',
    command: VERIFY_COMMAND,
    status: publicCheck.status === 0 ? 'passed' : 'failed',
    stdoutTail: publicCheck.stdout.slice(-1000),
    stderrTail: publicCheck.stderr.slice(-1000),
  });

  const rtlGate = runHdlGate(rtlPath);
  checks.push({ name: 'hdl-gate-rtl', status: rtlGate.status === 0 ? 'passed' : 'failed', stderrTail: rtlGate.stderr.slice(-1000) });
  const tbGate = runHdlGate(tbPath);
  checks.push({ name: 'hdl-gate-tb', status: tbGate.status === 0 ? 'passed' : 'failed', stderrTail: tbGate.stderr.slice(-1000) });

  return {
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    checks,
  };
}

function compliantRtl() {
  return [
    'module axis_guard #(',
    '  parameter int P_DATA_W = 8',
    ') (',
    '  input  logic                  i_clk,',
    '  input  logic                  i_rst,',
    '  input  logic                  i_s_valid,',
    '  input  logic [P_DATA_W-1:0]   i_s_data,',
    '  output logic                  o_s_ready,',
    '  output logic                  o_m_valid,',
    '  output logic [P_DATA_W-1:0]   o_m_data,',
    '  input  logic                  i_m_ready',
    ');',
    '',
    '  logic                r_hold;',
    '  logic [P_DATA_W-1:0] r_data;',
    '',
    '  always_ff @(posedge i_clk) begin',
    '    if (i_rst) begin',
    "      r_hold     <= 1'b0;",
    "      r_data     <= '0;",
    "      o_s_ready <= 1'b1;",
    "      o_m_valid <= 1'b0;",
    "      o_m_data  <= '0;",
    '    end else begin',
    '      o_s_ready <= (!r_hold) || i_m_ready;',
    '      if (r_hold) begin',
    "        o_m_valid <= 1'b1;",
    '        o_m_data  <= r_data;',
    '        if (i_m_ready) begin',
    '          r_hold <= i_s_valid;',
    '          if (i_s_valid) begin',
    '            r_data <= i_s_data;',
    '          end',
    '        end',
    '      end else begin',
    '        o_m_valid <= i_s_valid;',
    '        o_m_data  <= i_s_data;',
    '        if (i_s_valid && !i_m_ready) begin',
    "          r_hold <= 1'b1;",
    '          r_data <= i_s_data;',
    '        end',
    '      end',
    '    end',
    '  end',
    '',
    'endmodule',
    '',
  ].join('\n');
}

function compliantTb() {
  return [
    'module tb_axis_guard;',
    '  localparam int P_DATA_W = 8;',
    '  logic i_clk;',
    '  logic i_rst;',
    '  logic i_s_valid;',
    '  logic [P_DATA_W-1:0] i_s_data;',
    '  logic o_s_ready;',
    '  logic o_m_valid;',
    '  logic [P_DATA_W-1:0] o_m_data;',
    '  logic i_m_ready;',
    '',
    '  axis_guard #(.P_DATA_W(P_DATA_W)) dut (.*);',
    '',
    '  initial begin',
    "    i_clk = 1'b0;",
    '    forever #5 i_clk = ~i_clk;',
    '  end',
    '',
    '  task automatic expect_output(input logic [P_DATA_W-1:0] expected);',
    '    begin',
    '      if (!o_m_valid || o_m_data !== expected) begin',
    '        $error("expected held output");',
    '        $fatal;',
    '      end',
    '    end',
    '  endtask',
    '',
    '  initial begin',
    "    i_rst = 1'b1;",
    "    i_s_valid = 1'b0;",
    "    i_s_data = '0;",
    "    i_m_ready = 1'b0;",
    '    repeat (2) @(posedge i_clk);',
    "    i_rst = 1'b0;",
    '    @(posedge i_clk);',
    '',
    '    // backpressure stall: first word must be held stable',
    "    i_s_valid = 1'b1;",
    "    i_s_data = 8'h3c;",
    "    i_m_ready = 1'b0;",
    '    @(posedge i_clk);',
    "    i_s_valid = 1'b0;",
    "    i_s_data = 8'h91;",
    '    repeat (2) @(posedge i_clk);',
    '    expect_output(8\'h3c);',
    '',
    '    // release hold and observe the stored value',
    "    i_m_ready = 1'b1;",
    '    @(posedge i_clk);',
    '    expect_output(8\'h3c);',
    '    $finish;',
    '  end',
    'endmodule',
    '',
  ].join('\n');
}

function cannedPlan() {
  return {
    schemaVersion: 1,
    classification: EXPECTED_CLASSIFICATION,
    checkpointEvidence: {
      checkpoint0: 'Used valid_ready_stage.sv and hdl-coding rules for valid/ready naming and reset style.',
      checkpoint1: 'Interface is AXI-stream valid/ready; microarchitecture uses r_hold/r_data one-entry storage; verification covers backpressure hold.',
      checkpoint2: 'Checked i_/o_ ports, synchronous reset, sequential o_ assignments, no latch paths, and P_DATA_W widths.',
    },
    actions: [
      {
        type: 'write_file',
        path: TARGET_RTL.replace(/\\/g, '/'),
        checklistText: requiredChecklistExample('N/A'),
        content: compliantRtl(),
      },
      {
        type: 'write_file',
        path: TARGET_TB.replace(/\\/g, '/'),
        checklistText: requiredChecklistExample('\u2705'),
        content: compliantTb(),
      },
    ],
    verification: [{ command: VERIFY_COMMAND, checklistText: requiredChecklistExample('\u2705') }],
    finalResponse: 'Prepared axis_guard RTL and self-checking backpressure testbench for harness verification.',
  };
}

function failureDigest({ parseError, compliance, applyResult, functional, agentRun }) {
  const digest = {};
  if (parseError) digest.parseError = parseError;
  if (agentRun && agentRun.status !== 0) digest.agentExit = summarizeRun(agentRun);
  if (compliance?.failures?.length) digest.complianceFailures = compliance.failures;
  if (applyResult?.failures?.length) digest.applyFailures = applyResult.failures;
  if (functional?.checks?.length) {
    digest.functionalFailures = functional.checks
      .filter((check) => check.status !== 'passed')
      .map((check) => ({
        name: check.name,
        status: check.status,
        stdoutTail: check.stdoutTail,
        stderrTail: check.stderrTail,
      }));
  }
  return digest;
}

function writeBlockedManifest(outDir, payload) {
  const completedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1,
    mode: 'rtl-managed-task',
    ...payload,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(payload.startedAt),
    status: 'blocked',
    dimensions: {
      readiness: 'blocked',
      protocolCompliance: 'not_run',
      gateCompliance: 'not_run',
      stateIsolation: 'not_run',
      functionalStatus: 'not_run',
      overallStatus: 'blocked',
    },
    attempts: [],
  };
  writeText(path.join(outDir, 'rtl-managed-task-eval.json'), JSON.stringify(result, null, 2));
  console.log(`BLOCKED rtl-managed-task ${payload.agent}`);
  console.log(JSON.stringify(result.dimensions));
  process.exit(2);
}

function runAttempt({ agent, command, outDir, attempt, dryRun, previous }) {
  const prompt = buildPrompt(previous);
  const promptPath = path.join(outDir, `attempt-${attempt}-prompt.txt`);
  writeText(promptPath, prompt);

  let rawOutput = '';
  let responseText = '';
  let plan = null;
  let parseError = null;
  let agentRun = null;

  if (dryRun) {
    plan = cannedPlan();
    responseText = JSON.stringify(plan, null, 2);
    rawOutput = responseText;
  } else {
    agentRun = runCommandLine(command, outDir, prompt, 10 * 60 * 1000, {
      CLAUDE_VERIFY_GATE_STATE_FILE: path.join(outDir, 'var', 'verify-gate.json'),
    });
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

  let compliance = { status: 'failed', failures: parseError ? [parseError] : ['missing plan'] };
  let applyResult = { status: 'not_run', checks: [], failures: [] };
  let functional = { status: 'not_run', checks: [] };
  if (plan) {
    compliance = validatePlan(plan, outDir);
    if (agentRun && agentRun.status !== 0) {
      compliance.status = 'failed';
      compliance.failures.push(`agent exited with status ${agentRun.status}`);
    }
    if (compliance.status === 'passed') {
      applyResult = applyPlanThroughHarness(plan, outDir);
      if (applyResult.status === 'passed') {
        functional = verifyFunctional(outDir, hashFile(path.join(outDir, PUBLIC_VERIFY)));
      }
    }
  }

  const status = compliance.status === 'passed' && applyResult.status === 'passed' && functional.status === 'passed'
    ? 'passed'
    : 'failed';
  return {
    attempt,
    status,
    promptPath,
    agentExitCode: agentRun ? agentRun.status : null,
    agentError: agentRun ? agentRun.error : null,
    rawOutputPath: path.join(outDir, `attempt-${attempt}-agent-output.txt`),
    responsePath: plan ? path.join(outDir, `attempt-${attempt}-response.json`) : null,
    dimensions: {
      protocolCompliance: compliance.status,
      gateCompliance: applyResult.status,
      functionalStatus: functional.status,
      overallStatus: status,
    },
    complianceFailures: compliance.failures,
    gateChecks: applyResult.checks,
    functionalChecks: functional.checks,
    failureDigest: failureDigest({ parseError, compliance, applyResult, functional, agentRun }),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }

  const dryRun = args.includes('--dry-run');
  const agent = argValue(args, '--agent', dryRun ? 'fixture' : 'claude');
  const command = argValue(args, '--command', defaultCommandFor(agent));
  const maxAttempts = Number.parseInt(argValue(args, '--max-attempts', dryRun ? '1' : '2'), 10);
  const outDir = path.resolve(argValue(args, '--out', path.join(DEFAULT_RUN_ROOT, `${agent}-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const startedAt = new Date().toISOString();

  prepareOutDir(outDir);
  const homeStateSnapshot = snapshotHomeState();

  if (!dryRun) {
    if (!['claude', 'codex'].includes(agent)) throw new Error('--agent must be claude or codex');
    const readiness = readinessProbe(agent);
    if (readiness.status !== 'available') {
      writeBlockedManifest(outDir, {
        agent,
        requestedCommand: command,
        commandArgv: null,
        outDir,
        startedAt,
        readiness,
        blockReason: `agent readiness status is ${readiness.status}`,
      });
    }
  }

  const attempts = [];
  let previous = null;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    const result = runAttempt({ agent, command, outDir, attempt, dryRun, previous });
    attempts.push(result);
    if (result.status === 'passed') break;
    previous = result.failureDigest;
  }

  const restoredHomeState = restoreHomeState(homeStateSnapshot);
  const stateIsolation = {
    status: restoredHomeState.length === 0 ? 'passed' : 'failed',
    restoredHomeState,
  };
  const finalAttempt = attempts[attempts.length - 1] || null;
  const status = finalAttempt?.status === 'passed' && stateIsolation.status === 'passed' ? 'passed' : 'failed';
  const completedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1,
    mode: 'rtl-managed-task',
    agent,
    requestedCommand: command || null,
    outDir,
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    maxAttempts,
    status,
    dimensions: {
      readiness: dryRun ? 'not_required' : 'passed',
      protocolCompliance: finalAttempt?.dimensions?.protocolCompliance || 'not_run',
      gateCompliance: finalAttempt?.dimensions?.gateCompliance || 'not_run',
      stateIsolation: stateIsolation.status,
      functionalStatus: finalAttempt?.dimensions?.functionalStatus || 'not_run',
      overallStatus: status,
    },
    stateIsolation,
    attempts,
    finalFunctionalChecks: finalAttempt?.functionalChecks || [],
  };
  writeText(path.join(outDir, 'rtl-managed-task-eval.json'), JSON.stringify(result, null, 2));
  console.log(`${status.toUpperCase()} rtl-managed-task ${agent}`);
  console.log(JSON.stringify(result.dimensions));
  if (status !== 'passed') process.exit(1);
}

if (require.main === module) main();
