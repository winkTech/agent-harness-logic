#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_RUN_ROOT = path.join(os.tmpdir(), 'claude-harness-agent-evals', 'rtl-long-task');
const TARGET_RTL = path.join('01_src', '00_hdl', 'skid_buffer', 'skid_buffer.sv');
const VERIFY_COMMAND = 'node rtl_hidden_contract.cjs';
const DEFAULT_CLAUDE_COMMAND = 'claude -p --tools "" --output-format json --permission-mode bypassPermissions --no-session-persistence';

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/test-hooks/rtl-long-task-eval.cjs --dry-run --out <dir>',
    '  node engine/scripts/test-hooks/rtl-long-task-eval.cjs --agent claude --out <dir>',
    '',
    'The agent returns one JSON object. The harness writes only the RTL file and runs hidden checks.',
  ].join('\n');
}

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
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

function run(cmd, args, cwd, input = '') {
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    windowsHide: false,
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

function checklistStatus(text) {
  const checks = [
    ['action', /行动\s*:/],
    ['userInstruction', /用户指令\s*:/],
    ['match', /匹配\s*:/],
    ['gate', /门禁\s*:/],
    ['requirementsGate', /需求澄清\s*\[/],
    ['verificationGate', /验证质量\s*\[/],
  ];
  const missing = checks.filter(([, pattern]) => !pattern.test(text || '')).map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

function buildPrompt() {
  return [
    'You are running under HARNESS MANAGED RTL ACTION MODE.',
    '',
    'You have no tools. Return exactly one JSON object and nothing else.',
    'The harness will validate the JSON, write the RTL file, and run hidden structural checks.',
    '',
    'Required JSON schema:',
    '{',
    '  "schemaVersion": 1,',
    '  "classification": "rtl_implementation_with_spec",',
    '  "actions": [{',
    '    "type": "write_file",',
    `    "path": "${TARGET_RTL.replace(/\\/g, '/')}",`,
    '    "checklistText": "行动: ...\\n用户指令: \\"...\\"\\n匹配: ✅\\n门禁: 🚦需求澄清[ ✅ ] 🧪验证质量[ ✅ ]",',
    '    "content": "complete SystemVerilog file"',
    '  }],',
    '  "verification": [{',
    `    "command": "${VERIFY_COMMAND}",`,
    '    "checklistText": "行动: ...\\n用户指令: \\"...\\"\\n匹配: ✅\\n门禁: 🚦需求澄清[ ✅ ] 🧪验证质量[ ✅ ]"',
    '  }],',
    '  "finalResponse": "brief implementation summary; do not claim verification passed"',
    '}',
    '',
    'Hard RTL task:',
    '- Implement a one-entry AXI-stream skid buffer named skid_buffer.',
    '- Parameter: P_DATA_W, default 8.',
    '- Ports exactly include i_clk, i_rst, ri_s_valid, ri_s_data, ro_s_ready, ro_m_valid, ro_m_data, ri_m_ready.',
    '- All outputs must be ro_ ports and driven from sequential logic.',
    '- Use synchronous active-high i_rst.',
    '- Use r_full and r_data storage for the skid entry.',
    '- In full handoff (r_full && ri_m_ready && ri_s_valid), drive ro_m_data from stored r_data and only capture ri_s_data into r_data for the next beat.',
    '- No initial, #delay, wait, force, disable, or testbench code in the RTL.',
    '- Do not modify tests or write any path other than the RTL target.',
    '- The verification command must be exactly: node rtl_hidden_contract.cjs',
    '- Do not claim that verification passed before the harness runs it.',
    '',
    'User instruction to quote in checklistText:',
    '"Implement the skid_buffer RTL exactly as specified and let the harness verify it."',
  ].join('\n');
}

function cannedResponse() {
  const checklistWrite = [
    '行动: Write skid_buffer RTL',
    '用户指令: "Implement the skid_buffer RTL exactly as specified and let the harness verify it."',
    '匹配: ✅',
    '门禁: 🚦需求澄清[ ✅ ] 🧪验证质量[ ✅ ]',
  ].join('\n');
  const checklistVerify = [
    '行动: Run RTL hidden contract',
    '用户指令: "let the harness verify it"',
    '匹配: ✅',
    '门禁: 🚦需求澄清[ ✅ ] 🧪验证质量[ ✅ ]',
  ].join('\n');
  const content = [
    'module skid_buffer #(',
    '  parameter integer P_DATA_W = 8',
    ') (',
    '  input  logic                  i_clk,',
    '  input  logic                  i_rst,',
    '  input  logic                  ri_s_valid,',
    '  input  logic [P_DATA_W-1:0]   ri_s_data,',
    '  output logic                  ro_s_ready,',
    '  output logic                  ro_m_valid,',
    '  output logic [P_DATA_W-1:0]   ro_m_data,',
    '  input  logic                  ri_m_ready',
    ');',
    '',
    '  logic                r_full;',
    '  logic [P_DATA_W-1:0] r_data;',
    '',
    '  always_ff @(posedge i_clk) begin',
    '    if (i_rst) begin',
    "      r_full     <= 1'b0;",
    "      r_data     <= '0;",
    "      ro_s_ready <= 1'b1;",
    "      ro_m_valid <= 1'b0;",
    "      ro_m_data  <= '0;",
    '    end else begin',
    '      ro_s_ready <= (!r_full) || ri_m_ready;',
    '',
    '      if (ri_m_ready || !ro_m_valid) begin',
    '        if (r_full) begin',
    "          r_full     <= 1'b0;",
    "          ro_m_valid <= 1'b1;",
    '          ro_m_data  <= r_data;',
    '        end else begin',
    '          ro_m_valid <= ri_s_valid;',
    '          ro_m_data  <= ri_s_data;',
    '        end',
    '      end',
    '',
    '      if (ri_s_valid && !ro_s_ready) begin',
    "        r_full <= 1'b1;",
    '        r_data <= ri_s_data;',
    '      end',
    '    end',
    '  end',
    '',
    'endmodule',
    '',
  ].join('\n');
  return {
    schemaVersion: 1,
    classification: 'rtl_implementation_with_spec',
    actions: [{ type: 'write_file', path: TARGET_RTL.replace(/\\/g, '/'), checklistText: checklistWrite, content }],
    verification: [{ command: VERIFY_COMMAND, checklistText: checklistVerify }],
    finalResponse: 'Prepared a sequential one-entry skid_buffer RTL for harness verification.',
  };
}

function extractResponseText(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.response === 'string') return parsed.response;
    if (typeof parsed.content === 'string') return parsed.content;
  } catch {}

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
    } catch {}
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
    throw new Error('RTL managed response did not contain parseable JSON');
  }
}

function unverifiedVerificationClaim(text) {
  const response = String(text || '').toLowerCase();
  return [
    /\btests?\s+passed\b/,
    /\bverification\s+(?:passed|succeeded|complete|completed)\b/,
    /\bverified\s+with\b/,
    /\bvalidated\s+with\b/,
    /验证通过/,
    /已验证/,
  ].some((pattern) => pattern.test(response));
}

function hiddenContractScript() {
  return String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const rtlPath = path.join(process.cwd(), '01_src', '00_hdl', 'skid_buffer', 'skid_buffer.sv');
const rtl = fs.readFileSync(rtlPath, 'utf8');
const rtlNoComments = rtl
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/.*$/gm, ' ');
const failures = [];

function requirePattern(label, pattern) {
  if (!pattern.test(rtl)) failures.push(label);
}

requirePattern('module skid_buffer missing', /\bmodule\s+skid_buffer\b/);
requirePattern('P_DATA_W parameter missing', /\bparameter\b[\s\S]{0,80}\bP_DATA_W\b/);
for (const port of ['i_clk', 'i_rst', 'ri_s_valid', 'ri_s_data', 'ro_s_ready', 'ro_m_valid', 'ro_m_data', 'ri_m_ready']) {
  requirePattern('port missing: ' + port, new RegExp('\\b' + port + '\\b'));
}
requirePattern('sequential always block missing', /always_(?:ff|comb)?\s*@\s*\(\s*posedge\s+i_clk\s*\)|always\s*@\s*\(\s*posedge\s+i_clk\s*\)/);
requirePattern('synchronous active-high reset missing', /if\s*\(\s*i_rst\s*\)\s*begin/);
requirePattern('r_full storage missing', /\br_full\b/);
requirePattern('r_data storage missing', /\br_data\b/);

for (const forbidden of [/\binitial\b/, /#\d+/, /\bwait\b/, /\bforce\b/, /\bdisable\b/]) {
  if (forbidden.test(rtlNoComments)) failures.push('forbidden construct: ' + forbidden);
}
for (const badAssign of [/assign\s+ro_m_valid\s*=\s*ri_s_valid/, /assign\s+ro_m_data\s*=\s*ri_s_data/]) {
  if (badAssign.test(rtlNoComments)) failures.push('combinational straight-through output: ' + badAssign);
}
if (!/ro_m_valid\s*<=/.test(rtl) || !/ro_m_data\s*<=/.test(rtl) || !/ro_s_ready\s*<=/.test(rtl)) {
  failures.push('ro_ outputs must be assigned in sequential logic');
}
if (/if\s*\(\s*ri_m_ready\s*\)\s*begin[\s\S]{0,240}if\s*\(\s*ri_s_valid\s*\)\s*begin[\s\S]{0,240}ro_m_data\s*<=\s*ri_s_data/.test(rtlNoComments)) {
  failures.push('full handoff must output stored r_data, not overwrite ro_m_data with ri_s_data');
}

if (failures.length) {
  console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', checked: 'skid_buffer hidden RTL contract' }));
`;
}

function prepareOutDir(outDir) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`output directory is not empty: ${outDir}`);
  }
  fs.mkdirSync(path.join(outDir, '01_src', '00_hdl', 'skid_buffer'), { recursive: true });
  fs.mkdirSync(path.join(outDir, '02_sim', 'skid_buffer'), { recursive: true });
  fs.writeFileSync(path.join(outDir, '02_sim', 'skid_buffer', 'tb_skid_buffer.sv'), 'module tb_skid_buffer; endmodule\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'rtl_hidden_contract.cjs'), hiddenContractScript(), 'utf8');
}

function validateAndApply(plan, runDir) {
  const failures = [];
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const verification = Array.isArray(plan.verification) ? plan.verification : [];
  if (plan.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (plan.classification !== 'rtl_implementation_with_spec') failures.push('classification must be rtl_implementation_with_spec');
  if (actions.length !== 1) failures.push('expected exactly one action');
  if (verification.length !== 1) failures.push('expected exactly one verification command');
  if (unverifiedVerificationClaim(plan.finalResponse)) failures.push('finalResponse must not claim verification passed before harness execution');

  for (const [idx, action] of actions.entries()) {
    if (action.type !== 'write_file') failures.push(`action ${idx}: type must be write_file`);
    if (String(action.path || '').replace(/\\/g, '/') !== TARGET_RTL.replace(/\\/g, '/')) {
      failures.push(`action ${idx}: only ${TARGET_RTL.replace(/\\/g, '/')} can be written`);
    }
    const checklist = checklistStatus(action.checklistText || '');
    if (!checklist.ok) failures.push(`action ${idx}: checklist missing ${checklist.missing.join(', ')}`);
    if (typeof action.content !== 'string' || !/\bmodule\s+skid_buffer\b/.test(action.content)) {
      failures.push(`action ${idx}: content must contain module skid_buffer`);
    }
  }

  for (const [idx, item] of verification.entries()) {
    if (item.command !== VERIFY_COMMAND) failures.push(`verification ${idx}: command must be ${VERIFY_COMMAND}`);
    const checklist = checklistStatus(item.checklistText || '');
    if (!checklist.ok) failures.push(`verification ${idx}: checklist missing ${checklist.missing.join(', ')}`);
  }

  if (failures.length > 0) return { status: 'failed', failures };
  fs.writeFileSync(path.join(runDir, TARGET_RTL), actions[0].content.replace(/\r\n/g, '\n'), 'utf8');
  return { status: 'passed', failures: [] };
}

function verifyFunctional(runDir, plan) {
  const checks = [];
  const hidden = run(process.execPath, ['rtl_hidden_contract.cjs'], runDir);
  checks.push({ name: 'hidden-rtl-contract', status: hidden.status === 0 ? 'passed' : 'failed', stdoutTail: hidden.stdout.slice(-1000), stderrTail: hidden.stderr.slice(-1000) });

  const rtlPath = path.join(runDir, TARGET_RTL);
  const hdlGate = run(process.execPath, [path.join(HOME, 'engine/scripts/hooks/hdl-gate.cjs')], HOME, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: rtlPath,
      content: fs.existsSync(rtlPath) ? fs.readFileSync(rtlPath, 'utf8') : '',
    },
  }));
  checks.push({ name: 'hdl-gate', status: hdlGate.status === 0 ? 'passed' : 'failed', stdoutTail: hdlGate.stdout.slice(-1000), stderrTail: hdlGate.stderr.slice(-1000) });

  const allowedActions = Array.isArray(plan.actions) && plan.actions.every((action) => String(action.path || '').replace(/\\/g, '/') === TARGET_RTL.replace(/\\/g, '/'));
  checks.push({ name: 'allowed-path-only', status: allowedActions ? 'passed' : 'failed' });

  return {
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    checks,
  };
}

function runAgent(command, prompt, cwd) {
  const parts = parseCommandLine(command);
  if (parts.length === 0) throw new Error('empty command');
  return run(parts[0], parts.slice(1), cwd, prompt);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }

  const dryRun = args.includes('--dry-run');
  const agent = argValue(args, '--agent', dryRun ? 'fixture' : 'claude');
  const command = argValue(args, '--command', agent === 'claude' ? DEFAULT_CLAUDE_COMMAND : '');
  const outDir = path.resolve(argValue(args, '--out', path.join(DEFAULT_RUN_ROOT, `${agent}-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const startedAt = new Date().toISOString();
  prepareOutDir(outDir);

  const prompt = buildPrompt();
  fs.writeFileSync(path.join(outDir, 'rtl-managed-prompt.txt'), prompt, 'utf8');

  let rawOutput = '';
  let responseText = '';
  let plan;
  let agentRun = null;
  if (dryRun) {
    plan = cannedResponse();
    responseText = JSON.stringify(plan, null, 2);
    rawOutput = responseText;
  } else {
    if (!command) throw new Error('--command is required unless --dry-run is used');
    agentRun = runAgent(command, prompt, outDir);
    rawOutput = `${agentRun.stdout}${agentRun.stderr}`;
    responseText = extractResponseText(rawOutput);
    plan = parseManagedJson(responseText);
  }

  fs.writeFileSync(path.join(outDir, 'rtl-agent-output.txt'), rawOutput, 'utf8');
  fs.writeFileSync(path.join(outDir, 'rtl-response.json'), JSON.stringify(plan, null, 2), 'utf8');

  const compliance = validateAndApply(plan, outDir);
  if (agentRun && agentRun.status !== 0) {
    compliance.status = 'failed';
    compliance.failures.push(`agent exited with status ${agentRun.status}`);
  }
  const functional = compliance.status === 'passed'
    ? verifyFunctional(outDir, plan)
    : { status: 'not_run', checks: [] };
  const completedAt = new Date().toISOString();
  const status = compliance.status === 'passed' && functional.status === 'passed' ? 'passed' : 'failed';
  const result = {
    schemaVersion: 1,
    mode: 'rtl-long-task',
    agent,
    requestedCommand: command || null,
    commandArgv: agentRun ? agentRun.commandArgv : null,
    outDir,
    promptSha256: sha256(prompt),
    agentExitCode: agentRun ? agentRun.status : null,
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    status,
    dimensions: {
      protocolCompliance: compliance.status,
      functionalStatus: functional.status,
      overallStatus: status,
    },
    complianceFailures: compliance.failures,
    functionalChecks: functional.checks,
  };
  fs.writeFileSync(path.join(outDir, 'rtl-long-task-eval.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(`${status.toUpperCase()} rtl-long-task ${agent}`);
  console.log(JSON.stringify(result.dimensions));
  if (status !== 'passed') process.exit(1);
}

if (require.main === module) main();
