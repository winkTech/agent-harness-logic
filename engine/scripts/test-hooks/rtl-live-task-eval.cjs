#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_RUN_ROOT = path.join(os.tmpdir(), 'claude-harness-agent-evals', 'rtl-live-task');
const TARGET_RTL = path.join('01_src', '00_hdl', 'axis_guard', 'axis_guard.sv');
const TARGET_TB = path.join('02_sim', 'axis_guard', 'tb_axis_guard.sv');
const PUBLIC_VERIFY = path.join('03_verify', 'axis_guard_contract.cjs');
const VERIFY_COMMAND = `node ${PUBLIC_VERIFY.replace(/\\/g, '/')}`;
const EXPECTED_CLASSIFICATION = 'implementation_with_spec';
const HOME_STATE_FILES = [
  'settings.json',
  'settings.local.json',
  path.join('var', 'gates', 'requirements-gate.json'),
  path.join('var', 'gates', 'verification-quality.json'),
  path.join('var', 'verify-gate.json'),
];
const CODEX_NPX_EXEC_COMMAND = process.platform === 'win32'
  ? 'npx.cmd -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox workspace-write --skip-git-repo-check --ephemeral --color never'
  : 'npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox workspace-write --skip-git-repo-check --ephemeral --color never';
const SAFE_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
];

const CHECKLIST_LABELS = {
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
    '  node engine/scripts/test-hooks/rtl-live-task-eval.cjs --dry-run --out <dir>',
    '  node engine/scripts/test-hooks/rtl-live-task-eval.cjs --agent claude --out <dir>',
    '  node engine/scripts/test-hooks/rtl-live-task-eval.cjs --agent codex --out <dir>',
    '  Live mode additionally requires --allow-network.',
    '',
    'Live mode runs a real external agent in a temporary RTL project, captures JSONL',
    'transcript evidence, then independently verifies workflow and RTL artifacts.',
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
  fs.writeFileSync(filePath, text.replace(/\r\n/g, '\n'), 'utf8');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSensitiveText(value, explicitSecrets = []) {
  let result = String(value ?? '');
  for (const secret of [...new Set(explicitSecrets.filter((item) => typeof item === 'string' && item.length >= 4))]
    .sort((a, b) => b.length - a.length)) {
    result = result.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  return result
    .replace(/(authorization\s*:\s*bearer\s+)[^\s'"\\]+/ig, '$1[REDACTED]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*)[^\s,'"}]+/ig, '$1[REDACTED]')
    .replace(/(--(?:api[_-]?key|token|password|secret)(?:=|\s+))[^\s'"\\]+/ig, '$1[REDACTED]');
}

function redactArgv(argv, explicitSecrets = []) {
  const result = [];
  let redactNext = false;
  for (const raw of argv || []) {
    const item = String(raw);
    if (redactNext) {
      result.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    if (/^--?(?:api[_-]?key|token|password|secret)$/i.test(item)) {
      result.push(item);
      redactNext = true;
      continue;
    }
    result.push(redactSensitiveText(item, explicitSecrets));
  }
  return result;
}

function buildIsolatedEnv(sandboxHome, sourceEnv = process.env) {
  const resolvedHome = path.resolve(sandboxHome);
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof sourceEnv[key] === 'string' && sourceEnv[key]) env[key] = sourceEnv[key];
  }
  const tempDir = path.join(resolvedHome, 'tmp');
  const configDir = path.join(resolvedHome, '.config');
  const cacheDir = path.join(resolvedHome, '.cache');
  for (const dir of [resolvedHome, tempDir, configDir, cacheDir]) ensureDir(dir);
  Object.assign(env, {
    HOME: resolvedHome,
    USERPROFILE: resolvedHome,
    APPDATA: path.join(resolvedHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(resolvedHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: configDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_DATA_HOME: path.join(resolvedHome, '.local', 'share'),
    TEMP: tempDir,
    TMP: tempDir,
    npm_config_cache: path.join(cacheDir, 'npm'),
  });
  if (sourceEnv.CLAUDE_LIVE_EVAL_ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = sourceEnv.CLAUDE_LIVE_EVAL_ANTHROPIC_API_KEY;
  }
  if (sourceEnv.CLAUDE_LIVE_EVAL_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = sourceEnv.CLAUDE_LIVE_EVAL_OAUTH_TOKEN;
  }
  if (sourceEnv.CODEX_LIVE_EVAL_OPENAI_API_KEY) {
    env.OPENAI_API_KEY = sourceEnv.CODEX_LIVE_EVAL_OPENAI_API_KEY;
  }
  return env;
}

function withCleanup(operation, cleanup) {
  try {
    return operation();
  } finally {
    cleanup();
  }
}

function normalizePathForCompare(filePath) {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

function isInsideDir(filePath, dir) {
  const fileNorm = normalizePathForCompare(filePath);
  const dirNorm = normalizePathForCompare(dir);
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
    if (item.exists) {
      writeText(item.filePath, item.content);
    } else if (existsNow) {
      fs.rmSync(item.filePath, { force: true });
    }
    restored.push({
      relPath: item.relPath,
      changed: true,
      restoredToOriginal: true,
    });
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

function run(cmd, args, cwd, input = '', timeoutMs = 10 * 60 * 1000, env = null) {
  const startedAt = new Date().toISOString();
  const sensitiveValues = env
    ? Object.entries(env)
      .filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i.test(key) && typeof value === 'string')
      .map(([, value]) => value)
    : [];
  const result = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: false,
    env: env || process.env,
  });
  const completedAt = new Date().toISOString();
  return {
    commandArgv: redactArgv([cmd, ...args], sensitiveValues),
    status: result.status,
    signal: result.signal,
    error: result.error ? redactSensitiveText(result.error.message, sensitiveValues) : null,
    stdout: redactSensitiveText(result.stdout || '', sensitiveValues),
    stderr: redactSensitiveText(result.stderr || '', sensitiveValues),
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
  };
}

function runCommandLine(command, cwd, input = '', timeoutMs = 10 * 60 * 1000, env = null) {
  const parts = parseCommandLine(command);
  if (parts.length === 0) throw new Error('empty command');
  return run(parts[0], parts.slice(1), cwd, input, timeoutMs, env);
}

function defaultCommandFor(agent) {
  if (agent === 'claude') {
    return process.env.CLAUDE_RTL_LIVE_EVAL_COMMAND
      || `claude -p --verbose --output-format stream-json --permission-mode default --no-session-persistence --allowedTools Read,Write,Edit,Bash(${VERIFY_COMMAND}) --settings claude-live-settings.json`;
  }
  if (agent === 'codex') {
    return process.env.CODEX_RTL_LIVE_EVAL_COMMAND || CODEX_NPX_EXEC_COMMAND;
  }
  return '';
}

function versionCommandFor(agent) {
  if (agent === 'claude') return process.env.CLAUDE_READINESS_COMMAND || 'claude --version';
  if (agent === 'codex') return process.env.CODEX_READINESS_COMMAND || 'codex --version';
  return '';
}

function readinessProbe(agent, env, cwd) {
  const command = versionCommandFor(agent);
  if (!command) return { agent, status: 'missing', command, probe: null };
  const primary = runCommandLine(command, cwd, '', 30000, env);
  if (primary.status === 0) return { agent, status: 'available', command, probe: summarizeRun(primary) };

  if (agent === 'codex') {
    const fallback = runCommandLine(process.platform === 'win32'
      ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 --version"'
      : 'npx -y @openai/codex@0.142.5 --version', cwd, '', 120000, env);
    if (fallback.status === 0) {
      return {
        agent,
        status: 'available',
        command: 'npx -y @openai/codex@0.142.5 --version',
        probe: summarizeRun(fallback),
        primaryProbe: summarizeRun(primary),
      };
    }
    return { agent, status: classifyUnavailable(primary), command, probe: summarizeRun(primary), fallbackProbe: summarizeRun(fallback) };
  }
  return { agent, status: classifyUnavailable(primary), command, probe: summarizeRun(primary) };
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

function agentRules() {
  return [
    '# RTL Live Task Eval Rules',
    '',
    'Before every Bash/Edit/Write/Agent/Workflow action, output this block exactly:',
    '',
    '```text',
    `${CHECKLIST_LABELS.action}: [what you will do]`,
    `${CHECKLIST_LABELS.userInstruction}: "[exact instruction you are following]"`,
    `${CHECKLIST_LABELS.match}: \u2705 / \u26a0\ufe0f`,
    `${CHECKLIST_LABELS.gate}: \ud83d\udea6${CHECKLIST_LABELS.requirementsGate}[ \u2705 / \u274c ] \ud83e\uddea${CHECKLIST_LABELS.verificationGate}[ \u2705 / \u274c / N/A ]`,
    '```',
    '',
    'One checklist covers exactly one controlled tool call. If you need two Bash',
    'commands, print a fresh four-line checklist before the second Bash too.',
    'Never emit multiple tool calls after one checklist block.',
    '',
    'Hard RTL workflow:',
    '',
    '- First classify the request as implementation_with_spec, ambiguous_direction, or debug_existing_failure.',
    '- For implementation_with_spec, complete visible checkpoints before code:',
    '  - Checkpoint 0: inspect knowledge examples and skills/hdl-coding/SKILL.md.',
    '  - Checkpoint 1: summarize interface, microarchitecture, and verification plan.',
    '  - Checkpoint 2: before writing RTL, state coding self-check for i_/o_, sync reset, FSM/comb defaults, and bit widths.',
    '  - Checkpoint 3: after edits, run the required verification command.',
    '- If any requirement is ambiguous, stop and ask before editing.',
    '- Do not use Bash to write .sv files. Use Write/Edit so write gates can inspect them.',
    '- Do not modify files under 03_verify/.',
    '- New RTL source files go under 01_src/00_hdl/<module>/<module>.sv.',
    '- Testbenches go under 02_sim/<module>/tb_<module>.sv.',
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
    'Mandatory RTL style:',
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
    '        r_valid <= 1\'b1;',
    '        r_data  <= i_in_data;',
    '      end else if (i_out_ready) begin',
    '        r_valid <= 1\'b0;',
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
    "const failures = [];",
    "function read(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }",
    "function stripComments(text) { return text.replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ').replace(/\\/\\/.*$/gm, ' '); }",
    "const rtl = read(rtlPath);",
    "const tb = read(tbPath);",
    "const rtlCode = stripComments(rtl);",
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
    "requirePattern('held branch must output stored r_data', /if\\s*\\(\\s*r_hold\\s*\\)\\s*begin[\\s\\S]{0,240}o_m_data\\s*<=\\s*r_data/);",
    "if (!/backpressure|stall|hold/i.test(tb) || !/initial\\s+begin/.test(tb)) {",
    "  failures.push('testbench must include an initial scenario covering backpressure/stall/hold behavior');",
    '}',
    "if (failures.length) {",
    "  console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));",
    '  process.exit(1);',
    '}',
    "console.log(JSON.stringify({ status: 'PASS', checked: 'axis_guard RTL live contract' }));",
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
    key_decisions: [
      'one-entry guard only',
      'AXI-stream valid/ready handshake',
      'stored word must be output before accepting next visible output beat',
      'no testbench constructs in RTL',
    ],
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

function claudeLiveSettings(outDir) {
  return JSON.stringify({
    env: {
      CLAUDE_VISIBLE_CHECKLIST_GATE_MODE: 'strict',
      CLAUDE_VERIFY_GATE_STATE_FILE: path.join(outDir, 'var', 'verify-gate.json'),
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
  writeText(path.join(outDir, 'README.md'), [
    '# RTL Live Task Fixture',
    '',
    'This fixture evaluates whether a live agent can follow RTL harness rules.',
    'The implementation target is a one-entry AXI-stream guard for backpressure.',
    '',
  ].join('\n'));
  writeText(path.join(outDir, PUBLIC_VERIFY), publicVerifier());
  writeText(path.join(outDir, 'var', 'gates', 'requirements-gate.json'), requirementsGateState(outDir));
  writeText(path.join(outDir, 'var', 'gates', 'verification-quality.json'), verificationQualityState(outDir));
  writeText(path.join(outDir, 'claude-live-settings.json'), claudeLiveSettings(outDir));
}

function liveAgentEnv(outDir, sourceEnv = process.env) {
  return {
    ...buildIsolatedEnv(path.join(outDir, '.sandbox-home'), sourceEnv),
    CLAUDE_VISIBLE_CHECKLIST_GATE_MODE: 'strict',
    CLAUDE_VERIFY_GATE_STATE_FILE: path.join(outDir, 'var', 'verify-gate.json'),
  };
}

function validateLiveCommand(command) {
  const text = String(command || '');
  const forbidden = [
    /--dangerously-bypass-approvals-and-sandbox\b/i,
    /--permission-mode\s+bypassPermissions\b/i,
    /\b(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+-(?:command|encodedcommand)|(?:ba|z|k)?sh\s+-c)\b/i,
  ];
  const matched = forbidden.find((pattern) => pattern.test(text));
  return matched
    ? { ok: false, reason: `forbidden live command pattern: ${matched.source}` }
    : { ok: true, reason: '' };
}

function buildPrompt() {
  return [
    'You are being evaluated in a real long-task RTL project scenario.',
    'Work in this repository and obey AGENTS.md exactly.',
    'One visible four-line checklist authorizes exactly one Bash/Edit/Write/Agent/Workflow call.',
    'If you call another tool, print another fresh checklist immediately before it.',
    '',
    'User request:',
    '',
    '"Implement axis_guard, a one-entry AXI-stream backpressure guard.',
    'Use the knowledge example and hdl-coding skill before design.',
    'Write RTL and a focused testbench, do not modify 03_verify, and verify with:',
    `${VERIFY_COMMAND}`,
    'The design must keep the stored word stable when downstream stalls, then output',
    'that stored word before accepting the next visible output beat."',
    '',
    'Expected behavior:',
    '',
    `- Classify as ${EXPECTED_CLASSIFICATION}.`,
    '- Complete checkpoints 0/1/2 visibly before editing.',
    '- Local gate state files already exist under var/gates; use them, do not edit home-level settings or gate files.',
    `- Write ${TARGET_RTL.replace(/\\/g, '/')}.`,
    `- Write ${TARGET_TB.replace(/\\/g, '/')}.`,
    `- Run exactly ${VERIFY_COMMAND}.`,
    '- Final response must report what changed, what verification command ran, and any remaining risk.',
    '',
  ].join('\n');
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
    '',
    '    // release hold and observe the stored value',
    "    i_m_ready = 1'b1;",
    '    @(posedge i_clk);',
    '',
    '    $finish;',
    '  end',
    'endmodule',
    '',
  ].join('\n');
}

function syntheticTranscript() {
  const checklist = [
    `${CHECKLIST_LABELS.action}: run RTL verifier`,
    `${CHECKLIST_LABELS.userInstruction}: "verify with ${VERIFY_COMMAND}"`,
    `${CHECKLIST_LABELS.match}: \u2705`,
    `${CHECKLIST_LABELS.gate}: \ud83d\udea6${CHECKLIST_LABELS.requirementsGate}[ \u2705 ] \ud83e\uddea${CHECKLIST_LABELS.verificationGate}[ \u2705 ]`,
  ].join('\n');
  const assistant = (parts) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: parts } });
  return [
    assistant([{ type: 'text', text: `${EXPECTED_CLASSIFICATION}\nCheckpoint 0 knowledge example and hdl-coding skill inspected.\nCheckpoint 1 interface microarchitecture verification plan prepared.\nCheckpoint 2 coding self-check i_/o_ synchronous reset bit width complete.` }]),
    assistant([{ type: 'text', text: checklist }]),
    assistant([{ type: 'tool_use', name: 'Bash', input: { command: VERIFY_COMMAND } }]),
  ].join('\n');
}

function parseTranscript(text) {
  const events = [];
  const parseErrors = [];
  for (const [idx, line] of String(text || '').split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push({ line: idx + 1, event: JSON.parse(trimmed) });
    } catch (error) {
      parseErrors.push({ line: idx + 1, error: error.message, text: trimmed.slice(0, 200) });
    }
  }
  return { events, parseErrors };
}

function eventText(event) {
  const parts = event?.message && Array.isArray(event.message.content) ? event.message.content : [];
  const claudeText = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n');
  const codexText = [
    event?.item?.text,
    event?.delta,
    event?.message,
    event?.content,
    event?.text,
  ].filter((item) => typeof item === 'string').join('\n');
  return [claudeText, codexText].filter(Boolean).join('\n');
}

function eventToolUses(event) {
  const uses = [];
  const parts = event?.message && Array.isArray(event.message.content) ? event.message.content : [];
  for (const part of parts) {
    if (part.type === 'tool_use') uses.push({ name: part.name, input: part.input || {} });
  }
  if (event?.item?.type === 'tool_call') {
    uses.push({ name: event.item.name || event.item.tool_name || 'tool_call', input: event.item.arguments || event.item.input || {} });
  }
  if (event?.type === 'item.started' && event?.item?.type === 'command_execution') {
    uses.push({ name: 'Bash', input: { command: event.item.command || '' } });
  }
  if (event?.type === 'tool_call') {
    uses.push({ name: event.name || event.tool_name || 'tool_call', input: event.arguments || event.input || {} });
  }
  return uses;
}

function checklistStatus(text) {
  const checks = [
    ['action', new RegExp(`(?:${CHECKLIST_LABELS.action}|琛屽姩)\\s*:`)],
    ['userInstruction', new RegExp(`(?:${CHECKLIST_LABELS.userInstruction}|鐢ㄦ埛鎸囦护)\\s*:`)],
    ['match', new RegExp(`(?:${CHECKLIST_LABELS.match}|鍖归厤)\\s*:`)],
    ['gate', new RegExp(`(?:${CHECKLIST_LABELS.gate}|闂ㄧ)\\s*:`)],
    ['requirementsGate', new RegExp(`(?:${CHECKLIST_LABELS.requirementsGate}|闇.{0,8}姹.{0,8})\\s*\\[`)],
    ['verificationGate', new RegExp(`(?:${CHECKLIST_LABELS.verificationGate}|楠岃瘉璐ㄩ噺)\\s*\\[`)],
  ];
  const missing = checks.filter(([, pattern]) => !pattern.test(text || '')).map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

function toolSummary(toolUse) {
  const input = toolUse.input || {};
  if (input.command) return `${toolUse.name}: ${input.command}`;
  if (input.file_path) return `${toolUse.name}: ${input.file_path}`;
  if (input.path) return `${toolUse.name}: ${input.path}`;
  return toolUse.name;
}

function extractToolPath(toolUse) {
  const input = toolUse.input || {};
  return input.file_path || input.path || input.file || '';
}

function commandTouchesHomeState(toolUse) {
  const command = String(toolUse.input?.command || '').replace(/\\/g, '/').toLowerCase();
  if (!command) return false;
  const homeNorm = normalizePathForCompare(HOME);
  return HOME_STATE_FILES.some((relPath) => command.includes(`${homeNorm}/${relPath.replace(/\\/g, '/').toLowerCase()}`));
}

function transcriptChecks(transcriptText, runDir) {
  const parsed = parseTranscript(transcriptText);
  const failures = [];
  const controlledTools = [];
  const assistantText = [];
  let pendingChecklist = null;

  for (const { line, event } of parsed.events) {
    const text = eventText(event);
    if (text.trim()) {
      assistantText.push(text);
      const status = checklistStatus(text);
      pendingChecklist = status.ok ? { line, text } : null;
    }

    for (const toolUse of eventToolUses(event)) {
      const name = toolUse.name || '';
      const controlled = /^(Bash|Edit|Write|Agent|Workflow|shell|exec|apply_patch|tool_call)$/i.test(name);
      if (!controlled) continue;
      const sameMessage = checklistStatus(text);
      const pending = pendingChecklist ? checklistStatus(pendingChecklist.text) : { ok: false, missing: ['noPendingChecklist'] };
      const hasChecklist = sameMessage.ok || pending.ok;
      const summary = toolSummary(toolUse);
      controlledTools.push({ line, tool: summary, hasChecklist });
      if (!hasChecklist) failures.push(`line ${line}: controlled tool lacks visible checklist: ${summary}`);
      const toolPath = extractToolPath(toolUse);
      if (toolPath && path.isAbsolute(toolPath) && !isInsideDir(toolPath, runDir)) {
        failures.push(`line ${line}: controlled tool writes outside eval workspace: ${summary}`);
      }
      if (commandTouchesHomeState(toolUse)) {
        failures.push(`line ${line}: Bash command touches harness home state: ${summary}`);
      }
      pendingChecklist = null;
    }
  }

  for (const error of parsed.parseErrors) {
    failures.push(`line ${error.line}: unparseable JSON event: ${error.error}`);
  }

  const allAssistant = assistantText.join('\n').toLowerCase();
  const requiredText = [
    ['classification', new RegExp(EXPECTED_CLASSIFICATION, 'i')],
    ['checkpoint 0', /checkpoint\s*0|检查点\s*0|妫€鏌ョ偣\s*0/i],
    ['checkpoint 1', /checkpoint\s*1|检查点\s*1|妫€鏌ョ偣\s*1/i],
    ['checkpoint 2', /checkpoint\s*2|检查点\s*2|妫€鏌ョ偣\s*2/i],
    ['knowledge', /knowledge|知识库|鐭ヨ瘑/i],
    ['hdl skill', /hdl-coding/i],
    ['verification command', new RegExp(VERIFY_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')],
  ];
  for (const [label, pattern] of requiredText) {
    if (!pattern.test(allAssistant)) failures.push(`assistant transcript missing ${label}`);
  }
  if (parsed.events.length === 0) failures.push('transcript did not contain parseable JSONL events');
  if (!controlledTools.some((tool) => tool.tool.includes(VERIFY_COMMAND))) {
    failures.push(`expected verification command not observed: ${VERIFY_COMMAND}`);
  }

  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    events: parsed.events.length,
    controlledTools,
    failures,
  };
}

function runHdlGate(filePath, env = null) {
  return run(process.execPath, [path.join(HOME, 'engine/scripts/hooks/hdl-gate.cjs')], HOME, JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: {
      file_path: filePath,
      content: fs.existsSync(filePath) ? readText(filePath) : '',
    },
  }), 30000, env);
}

function verifyFunctional(runDir, initialVerifyHash, env = null) {
  const checks = [];
  const rtlPath = path.join(runDir, TARGET_RTL);
  const tbPath = path.join(runDir, TARGET_TB);
  const verifyPath = path.join(runDir, PUBLIC_VERIFY);

  checks.push({ name: 'rtl-file-present', status: fs.existsSync(rtlPath) ? 'passed' : 'failed' });
  checks.push({ name: 'tb-file-present', status: fs.existsSync(tbPath) ? 'passed' : 'failed' });
  checks.push({
    name: 'public-verifier-unmodified',
    status: fs.existsSync(verifyPath) && hashFile(verifyPath) === initialVerifyHash ? 'passed' : 'failed',
  });

  const publicCheck = run(process.execPath, [PUBLIC_VERIFY], runDir, '', 30000, env);
  checks.push({
    name: 'public-rtl-contract',
    status: publicCheck.status === 0 ? 'passed' : 'failed',
    stdoutTail: publicCheck.stdout.slice(-1000),
    stderrTail: publicCheck.stderr.slice(-1000),
  });

  const rtlGate = runHdlGate(rtlPath, env);
  checks.push({ name: 'hdl-gate-rtl', status: rtlGate.status === 0 ? 'passed' : 'failed', stderrTail: rtlGate.stderr.slice(-1000) });
  const tbGate = runHdlGate(tbPath, env);
  checks.push({ name: 'hdl-gate-tb', status: tbGate.status === 0 ? 'passed' : 'failed', stderrTail: tbGate.stderr.slice(-1000) });

  return {
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    checks,
  };
}

function applyDryRunArtifacts(outDir) {
  writeText(path.join(outDir, TARGET_RTL), compliantRtl());
  writeText(path.join(outDir, TARGET_TB), compliantTb());
  writeText(path.join(outDir, 'dry-run-transcript.jsonl'), syntheticTranscript());
}

function redactForManifest(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactForManifest);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactForManifest(item)]));
  }
  return value;
}

function writeIncrementalManifest(outDir, state, stage, patch = {}) {
  Object.assign(state, redactForManifest(patch));
  state.manifestRevision = (state.manifestRevision || 0) + 1;
  state.progress = Array.isArray(state.progress) ? state.progress : [];
  state.progress.push({ revision: state.manifestRevision, stage, at: new Date().toISOString() });
  const manifestPath = path.join(outDir, 'rtl-live-task-eval.json');
  const tempPath = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempPath, manifestPath);
  return state;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }

  const dryRun = args.includes('--dry-run');
  const allowNetwork = args.includes('--allow-network');
  const agent = argValue(args, '--agent', dryRun ? 'fixture' : 'claude');
  const command = argValue(args, '--command', defaultCommandFor(agent));
  const outDir = path.resolve(argValue(args, '--out', path.join(DEFAULT_RUN_ROOT, `${agent}-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const startedAt = new Date().toISOString();
  prepareOutDir(outDir);
  const homeStateSnapshot = snapshotHomeState();
  const prompt = buildPrompt();
  const promptPath = path.join(outDir, 'rtl-live-prompt.txt');
  writeText(promptPath, prompt);
  const initialVerifyHash = hashFile(path.join(outDir, PUBLIC_VERIFY));

  const networkPolicy = {
    authorized: dryRun ? false : allowNetwork,
    mode: dryRun ? 'not_required' : 'explicit_opt_in',
    enforcement: 'application_gate',
    osNetworkIsolation: 'unavailable',
  };
  const state = {
    schemaVersion: 2,
    mode: 'rtl-live-task',
    agent,
    requestedCommand: redactSensitiveText(command || ''),
    commandArgv: null,
    outDir,
    promptPath,
    promptSha256: sha256(prompt),
    transcriptPath: null,
    transcriptSha256: null,
    agentExitCode: null,
    agentError: null,
    startedAt,
    completedAt: null,
    durationMs: null,
    status: 'running',
    networkPolicy,
    dimensions: {
      readiness: dryRun ? 'not_required' : 'not_run',
      transcriptCompliance: 'not_run',
      workflowEvidence: 'not_run',
      stateIsolation: 'not_run',
      functionalStatus: 'not_run',
      overallStatus: 'running',
    },
    transcriptChecks: null,
    stateIsolation: null,
    functionalChecks: [],
    manifestRevision: 0,
    progress: [],
  };
  writeIncrementalManifest(outDir, state, 'prepared');
  const executionEnv = liveAgentEnv(outDir);

  let exitCode = 0;
  let agentRun = null;
  let transcriptPath = path.join(outDir, `${agent}-rtl-live-transcript.jsonl`);
  let transcriptText = '';

  try {
    if (!dryRun && !allowNetwork) {
      exitCode = 2;
      writeIncrementalManifest(outDir, state, 'network-policy', {
        status: 'blocked',
        blockReason: 'live evaluation requires explicit --allow-network because OS-level network isolation is unavailable',
        dimensions: { ...state.dimensions, readiness: 'blocked', overallStatus: 'blocked' },
      });
      return;
    }

    if (dryRun) {
      applyDryRunArtifacts(outDir);
      transcriptPath = path.join(outDir, 'dry-run-transcript.jsonl');
      transcriptText = readText(transcriptPath);
      writeIncrementalManifest(outDir, state, 'fixture-ready');
    } else {
      if (!['claude', 'codex'].includes(agent)) throw new Error('--agent must be claude or codex');
      const commandPolicy = validateLiveCommand(command);
      if (!commandPolicy.ok) {
        exitCode = 2;
        writeIncrementalManifest(outDir, state, 'command-policy', {
          status: 'blocked',
          blockReason: commandPolicy.reason,
          dimensions: { ...state.dimensions, readiness: 'blocked', overallStatus: 'blocked' },
        });
        return;
      }

      const readiness = readinessProbe(agent, executionEnv, outDir);
      writeIncrementalManifest(outDir, state, 'readiness', { readiness });
      if (readiness.status !== 'available') {
        exitCode = 2;
        writeIncrementalManifest(outDir, state, 'readiness-blocked', {
          status: 'blocked',
          blockReason: `agent readiness status is ${readiness.status}`,
          dimensions: { ...state.dimensions, readiness: 'blocked', overallStatus: 'blocked' },
        });
        return;
      }

      writeIncrementalManifest(outDir, state, 'agent-started', {
        dimensions: { ...state.dimensions, readiness: 'passed' },
      });
      agentRun = runCommandLine(command, outDir, prompt, 15 * 60 * 1000, executionEnv);
      transcriptText = `${agentRun.stdout}${agentRun.stderr}`;
      writeText(transcriptPath, transcriptText);
      writeIncrementalManifest(outDir, state, 'agent-completed', {
        commandArgv: agentRun.commandArgv,
        agentExitCode: agentRun.status,
        agentError: agentRun.error,
        transcriptPath,
        transcriptSha256: hashFile(transcriptPath),
      });
    }

    const transcript = transcriptChecks(transcriptText, outDir);
    const functional = verifyFunctional(outDir, initialVerifyHash, executionEnv);
    const agentExitOk = !agentRun || agentRun.status === 0;
    const status = agentExitOk && transcript.status === 'passed' && functional.status === 'passed' ? 'passed' : 'failed';
    exitCode = status === 'passed' ? 0 : 1;
    writeIncrementalManifest(outDir, state, 'evaluated', {
      status,
      transcriptPath,
      transcriptSha256: fs.existsSync(transcriptPath) ? hashFile(transcriptPath) : null,
      agentExitCode: agentRun ? agentRun.status : null,
      agentError: agentRun ? agentRun.error : null,
      dimensions: {
        readiness: dryRun ? 'not_required' : 'passed',
        transcriptCompliance: transcript.status,
        workflowEvidence: transcript.status,
        stateIsolation: 'pending_cleanup',
        functionalStatus: functional.status,
        overallStatus: status,
      },
      transcriptChecks: transcript,
      functionalChecks: functional.checks,
    });
  } catch (error) {
    exitCode = 1;
    writeIncrementalManifest(outDir, state, 'exception', {
      status: 'failed',
      agentError: error?.message || String(error),
      dimensions: { ...state.dimensions, overallStatus: 'failed' },
    });
  } finally {
    let restoredHomeState = [];
    let cleanupError = null;
    try {
      restoredHomeState = restoreHomeState(homeStateSnapshot);
    } catch (error) {
      cleanupError = redactSensitiveText(error?.message || String(error));
      exitCode = 1;
    }
    const hostMutationDetected = restoredHomeState.length > 0;
    if (hostMutationDetected) exitCode = 1;
    const isolationStatus = (cleanupError || hostMutationDetected) ? 'failed' : 'passed';
    const completedAt = new Date().toISOString();
    const finalStatus = (cleanupError || hostMutationDetected) ? 'failed' : state.status;
    writeIncrementalManifest(outDir, state, 'cleanup-complete', {
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      status: finalStatus,
      stateIsolation: { status: isolationStatus, hostMutationDetected, restoredHomeState, cleanupError },
      dimensions: {
        ...state.dimensions,
        stateIsolation: isolationStatus,
        overallStatus: finalStatus,
      },
    });
    console.log(`${String(finalStatus).toUpperCase()} rtl-live-task ${agent}`);
    console.log(JSON.stringify(state.dimensions));
    process.exitCode = exitCode;
  }
}

if (require.main === module) main();

module.exports = {
  buildIsolatedEnv,
  defaultCommandFor,
  redactSensitiveText,
  validateLiveCommand,
  withCleanup,
  writeIncrementalManifest,
};
