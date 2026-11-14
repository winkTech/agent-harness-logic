#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULT_RUN_ROOT = path.join(os.tmpdir(), 'claude-harness-agent-evals', 'alignment-dialogue');
const CODEX_NPX_EXEC_COMMAND = process.platform === 'win32'
  ? 'cmd.exe /d /s /c "npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --ephemeral --skip-git-repo-check --color never"'
  : 'npx -y @openai/codex@0.142.5 exec --ignore-user-config --json --sandbox read-only --ephemeral --skip-git-repo-check --color never';

const USER_REQUEST = 'Build a Python hardware debug tool. I only know that it should look at data and be useful.';
const TARGET_ANSWER = 'The target data is CC1101 IQ captures.';
const FORMAT_ANSWER = [
  'The input format is .bin little-endian int16 interleaved I/Q at 2 Msps.',
  'The output artifact should be a PNG constellation and a CSV summary.',
  'Success criteria: detect the obvious FSK tone and flag clipping.',
  'Verification fixture: tests/fixtures/iq_fsk.bin should pass with no clipping.',
].join(' ');

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

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function defaultCommandFor(agent) {
  if (agent === 'codex') return process.env.CODEX_ALIGNMENT_EVAL_COMMAND || CODEX_NPX_EXEC_COMMAND;
  return process.env.CLAUDE_ALIGNMENT_EVAL_COMMAND
    || 'claude -p --tools "" --output-format json --permission-mode bypassPermissions --no-session-persistence';
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

function runCommandLine(command, cwd, input) {
  const argv = parseCommandLine(command);
  if (!argv.length) throw new Error('empty command');
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    windowsHide: false,
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
    throw new Error('alignment response did not contain parseable JSON');
  }
}

function buildPrompt(turn, history) {
  const transcript = history.map((entry) => `${entry.role}: ${entry.text}`).join('\n');
  return [
    'HARNESS ALIGNMENT DIALOGUE MODE.',
    'Return exactly one JSON object and nothing else. You have no tools.',
    '',
    'Goal: when the user input is sparse or ambiguous, align requirements one item at a time instead of inventing a direction.',
    'You must never include actions, writes, verification commands, implementation code, or claims that work is done in this eval.',
    '',
    'Required JSON schema:',
    '{',
    '  "schemaVersion": 1,',
    '  "classification": "needs_clarification | ready_for_implementation",',
    '  "known": {',
    '    "targetData": "... or null",',
    '    "inputFormat": "... or null",',
    '    "outputArtifact": "... or null",',
    '    "successCriteria": "... or null",',
    '    "verificationFixture": "... or null"',
    '  },',
    '  "missing": ["targetData", "inputFormat", "outputArtifact", "successCriteria", "verificationFixture"],',
    '  "nextQuestion": "one self-contained question about the current alignment field when classification is needs_clarification; otherwise empty string",',
    '  "actions": [],',
    '  "finalResponse": "brief user-facing response"',
    '}',
    '',
    'Alignment order is mandatory:',
    '1. First ask only about targetData.',
    '2. After targetData is known, ask only about inputFormat.',
    '3. Once all five fields are known, return ready_for_implementation and summarize the agreed requirement contract.',
    '',
    'Question rule: ask about exactly one alignment field per response. Do not ask a list. Examples inside the same field question are allowed.',
    '',
    `--- DIALOGUE TURN ${turn} ---`,
    transcript,
  ].join('\n');
}

function cannedPlan(turn) {
  if (turn === 1) {
    return {
      schemaVersion: 1,
      classification: 'needs_clarification',
      known: { targetData: null, inputFormat: null, outputArtifact: null, successCriteria: null, verificationFixture: null },
      missing: ['targetData', 'inputFormat', 'outputArtifact', 'successCriteria', 'verificationFixture'],
      nextQuestion: '1. What target data should the hardware debug tool analyze: UART logs, IQ captures, register dumps, or something else?',
      actions: [],
      finalResponse: 'needs_clarification\n1. What target data should the hardware debug tool analyze: UART logs, IQ captures, register dumps, or something else?',
    };
  }
  if (turn === 2) {
    return {
      schemaVersion: 1,
      classification: 'needs_clarification',
      known: { targetData: 'CC1101 IQ captures', inputFormat: null, outputArtifact: null, successCriteria: null, verificationFixture: null },
      missing: ['inputFormat', 'outputArtifact', 'successCriteria', 'verificationFixture'],
      nextQuestion: '2. What exact input format should the CC1101 IQ capture parser accept, including file type, sample width, byte order, and sample rate?',
      actions: [],
      finalResponse: 'needs_clarification\n2. What exact input format should the CC1101 IQ capture parser accept, including file type, sample width, byte order, and sample rate?',
    };
  }
  return {
    schemaVersion: 1,
    classification: 'ready_for_implementation',
    known: {
      targetData: 'CC1101 IQ captures',
      inputFormat: '.bin little-endian int16 interleaved I/Q at 2 Msps',
      outputArtifact: 'PNG constellation and CSV summary',
      successCriteria: 'detect obvious FSK tone and flag clipping',
      verificationFixture: 'tests/fixtures/iq_fsk.bin should pass with no clipping',
    },
    missing: [],
    nextQuestion: '',
    actions: [],
    finalResponse: 'ready_for_implementation: agreed contract is CC1101 IQ capture input, .bin little-endian int16 interleaved I/Q at 2 Msps, PNG constellation plus CSV summary, success by FSK tone detection and clipping flag, verified with tests/fixtures/iq_fsk.bin.',
  };
}

function textIncludesAny(text, terms) {
  const value = String(text || '').toLowerCase();
  return terms.some((term) => value.includes(term));
}

function hasQuestion(text) {
  return /[?？]/.test(String(text || ''));
}

function looksLikeQuestionList(text) {
  const value = String(text || '');
  const numberedQuestions = value.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:[1-5])[.)\-:]\s+.*[?？]/g) || [];
  return numberedQuestions.length > 1
    || /\b(?:second|third|fourth|fifth)\s+question\b/i.test(value)
    || /(?:\?|？).+(?:\?|？).+(?:\?|？)/s.test(value);
}

function validatePlan(plan, turn) {
  const failures = [];
  if (!plan || typeof plan !== 'object') failures.push('plan is not an object');
  if (plan.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (!Array.isArray(plan.actions) || plan.actions.length !== 0) failures.push('actions must be an empty array');
  if (String(plan.finalResponse || '').match(/\b(created|implemented|wrote|tests passed|verification passed)\b/i)) {
    failures.push('finalResponse must not claim work was implemented or verified');
  }

  if (turn === 1 || turn === 2) {
    if (plan.classification !== 'needs_clarification') failures.push('classification must be needs_clarification');
    if (!hasQuestion(plan.nextQuestion)) failures.push('nextQuestion must contain a question');
    if (looksLikeQuestionList(plan.nextQuestion)) failures.push('nextQuestion must not contain a list of questions');
    if (looksLikeQuestionList(plan.finalResponse)) failures.push('finalResponse must not contain a list of questions');
  }

  if (turn === 1) {
    const q = `${plan.nextQuestion || ''} ${plan.finalResponse || ''}`;
    if (!textIncludesAny(q, ['target data', 'data source', 'what data', 'uart', 'iq', 'register'])) {
      failures.push('turn 1 must ask only about target data/source');
    }
    if (textIncludesAny(q, ['input format', 'output', 'success criteria', 'verification fixture'])) {
      failures.push('turn 1 must not ask later alignment questions');
    }
  }

  if (turn === 2) {
    const q = `${plan.nextQuestion || ''} ${plan.finalResponse || ''}`;
    if (!textIncludesAny(`${plan.known?.targetData || ''} ${q}`, ['iq'])) failures.push('turn 2 must retain known targetData');
    if (!textIncludesAny(q, ['input format', 'file type', 'sample width', 'byte order', 'sample rate', 'bin', 'format'])) {
      failures.push('turn 2 must ask only about input format');
    }
    if (textIncludesAny(q, ['output artifact', 'success criteria', 'verification fixture'])) {
      failures.push('turn 2 must not ask later alignment questions');
    }
  }

  if (turn === 3) {
    if (plan.classification !== 'ready_for_implementation') failures.push('classification must be ready_for_implementation');
    if (String(plan.nextQuestion || '').trim()) failures.push('ready turn must not ask another question');
    if (Array.isArray(plan.missing) && plan.missing.length !== 0) failures.push('ready turn must have no missing fields');
    const known = plan.known || {};
    const combined = `${JSON.stringify(known)} ${plan.finalResponse || ''}`.toLowerCase();
    for (const [field, terms] of [
      ['targetData', ['cc1101', 'iq']],
      ['inputFormat', ['little-endian', 'int16', '2 msps', '2msps']],
      ['outputArtifact', ['png', 'csv']],
      ['successCriteria', ['fsk', 'clipping']],
      ['verificationFixture', ['tests/fixtures/iq_fsk.bin', 'iq_fsk.bin']],
    ]) {
      if (!known[field] || !textIncludesAny(combined, terms)) failures.push(`ready turn missing agreed ${field}`);
    }
  }

  return { status: failures.length ? 'failed' : 'passed', failures: [...new Set(failures)] };
}

function runTurn({ dryRun, command, outDir, turn, history }) {
  const prompt = buildPrompt(turn, history);
  writeText(path.join(outDir, `turn-${turn}-prompt.txt`), prompt);

  let rawOutput = '';
  let responseText = '';
  let plan = null;
  let parseError = '';
  let agentRun = null;

  if (dryRun) {
    plan = cannedPlan(turn);
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

  writeText(path.join(outDir, `turn-${turn}-agent-output.txt`), rawOutput);
  writeText(path.join(outDir, `turn-${turn}-response-text.txt`), responseText);
  if (plan) writeText(path.join(outDir, `turn-${turn}-response.json`), JSON.stringify(plan, null, 2));

  const protocol = plan ? validatePlan(plan, turn) : { status: 'failed', failures: [parseError || 'missing plan'] };
  if (agentRun && agentRun.status !== 0) {
    protocol.status = 'failed';
    protocol.failures.push(`agent exited with status ${agentRun.status}`);
  }

  return {
    turn,
    status: protocol.status,
    agentExitCode: agentRun ? agentRun.status : null,
    promptSha256: sha256(prompt),
    responsePath: plan ? path.join(outDir, `turn-${turn}-response.json`) : null,
    failures: protocol.failures,
    plan,
  };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const agent = argValue(args, '--agent', dryRun ? 'fixture' : 'claude');
  const command = argValue(args, '--command', defaultCommandFor(agent));
  const outDir = path.resolve(argValue(args, '--out', path.join(DEFAULT_RUN_ROOT, `${agent}-${new Date().toISOString().replace(/[:.]/g, '-')}`)));

  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  const turns = [];
  const history = [{ role: 'user', text: USER_REQUEST }];

  for (let turn = 1; turn <= 3; turn += 1) {
    const result = runTurn({ dryRun, command, outDir, turn, history });
    turns.push({
      turn: result.turn,
      status: result.status,
      agentExitCode: result.agentExitCode,
      promptSha256: result.promptSha256,
      responsePath: result.responsePath,
      failures: result.failures,
    });
    if (result.status !== 'passed') break;
    if (turn === 1) {
      history.push({ role: 'assistant', text: result.plan.nextQuestion });
      history.push({ role: 'user', text: TARGET_ANSWER });
    } else if (turn === 2) {
      history.push({ role: 'assistant', text: result.plan.nextQuestion });
      history.push({ role: 'user', text: FORMAT_ANSWER });
    }
  }

  const status = turns.length === 3 && turns.every((turn) => turn.status === 'passed') ? 'passed' : 'failed';
  const manifest = {
    schemaVersion: 1,
    mode: 'alignment-dialogue',
    agent,
    requestedCommand: command,
    outDir,
    status,
    dimensions: {
      sequentialClarification: status,
      noPrematureAction: turns.every((turn) => turn.status === 'passed') ? 'passed' : 'failed',
      overallStatus: status,
    },
    turns,
  };
  writeText(path.join(outDir, 'alignment-dialogue-eval.json'), JSON.stringify(manifest, null, 2));
  console.log(`${status.toUpperCase()} alignment-dialogue ${agent}`);
  console.log(JSON.stringify(manifest.dimensions));
  if (status !== 'passed') process.exit(1);
}

main();
