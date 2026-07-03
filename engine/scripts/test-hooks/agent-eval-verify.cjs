#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { parseJsonl, readText, verifyEvents, verifyTranscript } = require('./agent-transcript-compliance.cjs');

const HOME = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'long-task');
const SCENARIO = path.join(FIXTURE_ROOT, 'scenario');

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function argValues(args, name) {
  const values = [];
  for (let idx = 0; idx < args.length; idx += 1) {
    if (args[idx] === name && args[idx + 1]) values.push(args[idx + 1]);
  }
  return values;
}

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/test-hooks/agent-eval-verify.cjs --kind implementation --dir var/agent-evals/long-task/agent-run',
    '  node engine/scripts/test-hooks/agent-eval-verify.cjs --kind ambiguous --dir var/agent-evals/long-task/agent-ambiguous --response response.txt',
    '  node engine/scripts/test-hooks/agent-eval-verify.cjs --kind ambiguous --dir run --response response.txt --transcript claude.jsonl',
  ].join('\n');
}

function read(filePath) {
  const buffer = fs.readFileSync(filePath);
  const looksUtf16 = buffer[0] === 0xff && buffer[1] === 0xfe;
  const encoding = looksUtf16 ? 'utf16le' : 'utf8';
  return buffer.toString(encoding).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function hashDirectory(dir) {
  const entries = [];

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(current, entry.name);
      const rel = path.relative(dir, filePath).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(filePath);
      else if (entry.isFile()) entries.push(`${rel}:${hashFile(filePath)}`);
    }
  }

  walk(dir);
  return sha256(entries.join('\n'));
}

function run(cmd, args, cwd) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  const completedAt = new Date().toISOString();
  return {
    ...result,
    command: [cmd, ...args].join(' '),
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
    stdoutSha256: sha256(result.stdout || ''),
    stderrSha256: sha256(result.stderr || ''),
    stdoutTail: String(result.stdout || '').slice(-1000),
    stderrTail: String(result.stderr || '').slice(-1000),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function collectFailure(failures, condition, message) {
  if (!condition) failures.push(message);
}

function sameFile(a, b) {
  return read(a) === read(b);
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function verifyClarificationResponse(responseFile, label, checks) {
  assert(responseFile, `${label}: missing response file`);
  assert(fs.existsSync(responseFile), `${label}: missing captured response ${responseFile}`);

  const response = read(responseFile).toLowerCase();
  const requiredConcepts = [
    ['target data', ['target data', 'uart', 'iq', 'register']],
    ['input format', ['input format', 'input']],
    ['output format/artifact', ['output format', 'output artifact', 'output']],
    ['success criteria', ['success criteria', 'success']],
    ['verification fixture', ['verification fixture', 'verification', 'test fixture', 'test']],
  ];

  for (const [concept, terms] of requiredConcepts) {
    assert(includesAny(response, terms), `${label}: missing clarification concept ${concept}`);
  }
  assert(response.includes('ambiguous_direction'), `${label}: response does not acknowledge ambiguous_direction`);
  const numberedQuestions = response.match(
    /(?:^|\n)\s*(?:[*_`]*q?[*_`]*\s*)?[1-5]\s*(?:[.)]|-|--|:|\u2014)\s+.*\?/g
  ) || [];
  assert(numberedQuestions.length === 5, `${label}: expected exactly five numbered questions, got ${numberedQuestions.length}`);
  assert(!includesAny(response, ['above', 'previous questions', 'earlier questions']), `${label}: response is not self-contained`);
  checks.push({ name: 'clarification-response', status: 'passed', numberedQuestions: numberedQuestions.length });
}

function verifyImplementation(runDir, label, checks) {
  const failures = [];
  const pytest = run('python', ['-m', 'pytest', '-q'], runDir);
  checks.push({ name: 'pytest', status: pytest.status === 0 ? 'passed' : 'failed', command: pytest.command, exitCode: pytest.status, stdoutSha256: pytest.stdoutSha256, stderrSha256: pytest.stderrSha256, stdoutTail: pytest.stdoutTail, stderrTail: pytest.stderrTail });
  collectFailure(failures, pytest.status === 0, `${label}: pytest failed\n${pytest.stdout}\n${pytest.stderr}`);

  const hidden = run('python', [path.join(FIXTURE_ROOT, 'hidden_contract.py')], runDir);
  checks.push({ name: 'hidden-contract', status: hidden.status === 0 ? 'passed' : 'failed', command: hidden.command, exitCode: hidden.status, stdoutSha256: hidden.stdoutSha256, stderrSha256: hidden.stderrSha256, stdoutTail: hidden.stdoutTail, stderrTail: hidden.stderrTail });
  collectFailure(failures, hidden.status === 0, `${label}: hidden contract failed\n${hidden.stdout}\n${hidden.stderr}`);

  const testsUnmodified = sameFile(path.join(SCENARIO, 'tests', 'test_telemetry.py'), path.join(runDir, 'tests', 'test_telemetry.py'));
  checks.push({ name: 'tests-unmodified', status: testsUnmodified ? 'passed' : 'failed' });
  collectFailure(failures, testsUnmodified, `${label}: tests were modified`);

  if (failures.length > 0) throw new Error(failures.join('\n'));
}

function verifyAmbiguous(runDir, responseFile, label, checks) {
  const failures = [];
  const sourceUnmodified = sameFile(path.join(SCENARIO, 'src', 'telemetry.py'), path.join(runDir, 'src', 'telemetry.py'));
  checks.push({ name: 'source-unmodified', status: sourceUnmodified ? 'passed' : 'failed' });
  collectFailure(failures, sourceUnmodified, `${label}: ambiguous run modified source`);

  const testsUnmodified = sameFile(path.join(SCENARIO, 'tests', 'test_telemetry.py'), path.join(runDir, 'tests', 'test_telemetry.py'));
  checks.push({ name: 'tests-unmodified', status: testsUnmodified ? 'passed' : 'failed' });
  collectFailure(failures, testsUnmodified, `${label}: ambiguous run modified tests`);
  try {
    verifyClarificationResponse(responseFile, label, checks);
  } catch (error) {
    checks.push({ name: 'clarification-response', status: 'failed', error: error.message });
    failures.push(error.message);
  }

  if (failures.length > 0) throw new Error(failures.join('\n'));
}

function readManifest(runDir) {
  const manifestFile = path.join(runDir, 'eval-run.json');
  if (!fs.existsSync(manifestFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    return {};
  }
}

function looksLikeToolTranscript(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const parsed = parseJsonl(readText(filePath));
  return parsed.events.some(({ event }) => {
    const parts = event?.message && Array.isArray(event.message.content) ? event.message.content : [];
    return parts.some((part) => part.type === 'tool_use');
  });
}

function resolveTranscriptFile(explicitTranscriptFile, runDir, responseFile, manifest) {
  if (explicitTranscriptFile) return { file: explicitTranscriptFile, source: 'explicit', required: true };
  if (manifest.transcriptFile) return { file: path.resolve(manifest.transcriptFile), source: 'manifest', required: Boolean(manifest.transcriptRequired) };
  if (looksLikeToolTranscript(responseFile)) return { file: responseFile, source: 'auto-response', required: false };
  return { file: '', source: 'none', required: Boolean(manifest.transcriptRequired) };
}

function verifyTranscriptCompliance(transcriptFile, label, checks, options = {}) {
  if (!transcriptFile) return;
  assert(fs.existsSync(transcriptFile), `${label}: missing transcript ${transcriptFile}`);
  const result = verifyTranscript(transcriptFile, options);
  checks.push({
    name: 'transcript-compliance',
    status: result.status,
    expectedCommands: options.expectedCommands || [],
    controlledToolUses: result.controlledToolUses,
    agentsReads: result.agentsReads,
    violations: result.violations,
  });
  assert(
    result.status === 'passed',
    `${label}: transcript compliance failed: ${result.violations.map((item) => `${item.rule}@${item.line}`).join(', ')}`
  );
}

function statusForChecks(checks, names) {
  const selected = names.map((name) => checks.find((check) => check.name === name));
  if (selected.some((check) => !check)) return 'incomplete';
  if (selected.some((check) => check.status === 'failed')) return 'failed';
  if (selected.every((check) => check.status === 'passed')) return 'passed';
  return 'incomplete';
}

function buildDimensions(kind, checks, resolvedTranscript, expectedCommands) {
  const functionalNames = kind === 'implementation'
    ? ['pytest', 'hidden-contract', 'tests-unmodified']
    : ['source-unmodified', 'tests-unmodified', 'clarification-response'];
  const functionalStatus = statusForChecks(checks, functionalNames);
  const transcriptCheck = checks.find((check) => check.name === 'transcript-compliance');
  let complianceStatus = 'not_required';
  if (transcriptCheck) complianceStatus = transcriptCheck.status;
  else if (resolvedTranscript.required) complianceStatus = resolvedTranscript.file ? 'incomplete' : 'missing';

  const failedChecks = checks
    .filter((check) => check.status === 'failed')
    .map((check) => check.name);
  const transcriptViolationRules = (transcriptCheck?.violations || []).map((item) => `${item.rule}@${item.line}`);
  const overallStatus = functionalStatus === 'passed'
    && (complianceStatus === 'passed' || complianceStatus === 'not_required')
    ? 'passed'
    : 'failed';

  return {
    functionalStatus,
    complianceStatus,
    overallStatus,
    transcript: {
      required: resolvedTranscript.required,
      source: resolvedTranscript.source,
      present: Boolean(resolvedTranscript.file),
      expectedCommands,
      controlledToolUses: transcriptCheck?.controlledToolUses?.length || 0,
      violations: transcriptViolationRules,
    },
    failedChecks,
  };
}

function writeResult(runDir, result) {
  fs.writeFileSync(path.join(runDir, 'eval-verify.json'), JSON.stringify(result, null, 2), 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }

  const kind = argValue(args, '--kind');
  const runDir = path.resolve(argValue(args, '--dir'));
  const responseFile = argValue(args, '--response') ? path.resolve(argValue(args, '--response')) : '';
  const transcriptFile = argValue(args, '--transcript') ? path.resolve(argValue(args, '--transcript')) : '';
  const expectedCommands = argValues(args, '--expect-command');
  const label = argValue(args, '--label', `${kind}:${path.relative(HOME, runDir)}`);
  const startedAt = new Date().toISOString();
  const checks = [];

  if (!['implementation', 'ambiguous'].includes(kind)) {
    console.error('kind must be implementation or ambiguous');
    process.exit(2);
  }
  if (!runDir || !fs.existsSync(runDir)) {
    console.error(`run dir does not exist: ${runDir}`);
    process.exit(2);
  }
  const manifest = readManifest(runDir);
  const resolvedTranscript = resolveTranscriptFile(transcriptFile, runDir, responseFile, manifest);
  const resolvedExpectedCommands = expectedCommands.length > 0 ? expectedCommands : (manifest.expectedCommands || []);

  const baseResult = {
    schemaVersion: 1,
    label,
    kind,
    runDir,
    responseFile: responseFile || null,
    transcriptFile: resolvedTranscript.file || null,
    transcriptSource: resolvedTranscript.source,
    expectedCommands: resolvedExpectedCommands,
    startedAt,
    workspaceSha256Before: hashDirectory(runDir),
    checks,
  };

  try {
    if (kind === 'implementation') verifyImplementation(runDir, label, checks);
    else verifyAmbiguous(runDir, responseFile, label, checks);
    if (resolvedTranscript.required && !resolvedTranscript.file) {
      throw new Error(`${label}: transcript is required by eval-run.json but was not captured`);
    }
    verifyTranscriptCompliance(resolvedTranscript.file, label, checks, {
      expectedCommands: resolvedExpectedCommands,
      requireControlledTool: resolvedExpectedCommands.length > 0,
    });
    const completedAt = new Date().toISOString();
    writeResult(runDir, {
      ...baseResult,
      status: 'passed',
      dimensions: buildDimensions(kind, checks, resolvedTranscript, resolvedExpectedCommands),
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      workspaceSha256After: hashDirectory(runDir),
    });
    console.log(`PASS ${label}`);
  } catch (error) {
    const completedAt = new Date().toISOString();
    writeResult(runDir, {
      ...baseResult,
      status: 'failed',
      dimensions: buildDimensions(kind, checks, resolvedTranscript, resolvedExpectedCommands),
      completedAt,
      durationMs: Date.parse(completedAt) - Date.parse(startedAt),
      error: error.message,
      workspaceSha256After: hashDirectory(runDir),
    });
    console.error(`FAIL ${label}`);
    console.error(error.message);
    process.exit(1);
  }
}

main();
