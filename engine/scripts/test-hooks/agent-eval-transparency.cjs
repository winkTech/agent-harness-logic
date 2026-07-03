#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..', '..');
const RUNNER = path.join(HOME, 'engine/scripts/test-hooks/agent-eval-runner.cjs');
const VERIFIER = path.join(HOME, 'engine/scripts/test-hooks/agent-eval-verify.cjs');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(args, opts = {}) {
  return spawnSync('node', args, {
    cwd: HOME,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    ...opts,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function goodAmbiguousResponse() {
  return [
    'ambiguous_direction',
    '',
    '1. Target data: Should the tool analyze UART logs, IQ captures, register dumps, or a specific combination?',
    '',
    '2. Input format: What exact input format should it accept, such as text logs, CSV, JSON, binary captures, or NumPy arrays?',
    '',
    '3. Output artifact: What should it produce, such as a terminal summary, JSON report, plots, or annotated log?',
    '',
    '4. Success criteria: What concrete behavior should count as success for the first useful version?',
    '',
    '5. Verification fixture: What sample input and expected output should verify the tool?',
  ].join('\n');
}

function assistant(parts) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: parts,
    },
  });
}

function toolUse(name, input = {}) {
  return { type: 'tool_use', name, input };
}

function goodTranscript() {
  const checklist = [
    '\u884c\u52a8: verify ambiguous task',
    '\u7528\u6237\u6307\u4ee4: "run the requested verifier"',
    '\u5339\u914d: ok',
    '\u95e8\u7981: \u9700\u6c42\u6f84\u6e05[ ok ] \u9a8c\u8bc1\u8d28\u91cf[ N/A ]',
  ].join('\n');
  return [
    assistant([{ type: 'text', text: checklist }]),
    assistant([toolUse('Bash', { command: 'node engine/scripts/test-hooks/workflow-contracts.cjs' })]),
  ].join('\n');
}

function badTranscript() {
  return assistant([toolUse('Bash', { command: 'node engine/scripts/test-hooks/workflow-contracts.cjs' })]);
}

test('agent-eval-runner refuses non-empty output directories by default', () => {
  const root = tmpDir('agent-eval-stale-');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'stale.txt'), 'old result', 'utf8');

  const result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--out', outDir,
  ]);

  assert(result.status === 2, `expected stale output dir rejection, exit=${result.status}`);
  assert((result.stderr || '').includes('output directory is not empty'), 'missing stale directory error');
  assert(!fs.existsSync(path.join(outDir, 'eval-run.json')), 'runner wrote a manifest into a stale rejected directory');
});

test('agent-eval-runner writes transparent dry-run manifest with hashes', () => {
  const outDir = path.join(tmpDir('agent-eval-fresh-'), 'out');
  const result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--out', outDir,
  ]);
  assert(result.status === 0, `dry-run failed: ${result.stderr}`);

  const manifest = readJson(path.join(outDir, 'eval-run.json'));
  assert(manifest.schemaVersion === 2, 'manifest schema version was not upgraded');
  assert(manifest.promptScaffold === 'visible-tool-checklist-v1', 'manifest lacks prompt scaffold version');
  assert(manifest.outDirFresh === true && manifest.outDirReused === false, 'fresh/reuse flags incorrect');
  for (const key of ['promptSha256', 'rawPromptSha256', 'scenarioSha256', 'initialWorkspaceSha256', 'finalWorkspaceSha256']) {
    assert(/^[a-f0-9]{64}$/.test(manifest[key] || ''), `${key} is missing or not a sha256`);
  }
});

test('agent-eval-runner sends visible checklist scaffold to live command stdin', () => {
  const outDir = path.join(tmpDir('agent-eval-scaffold-'), 'out');
  const result = runNode([
    RUNNER,
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--command', 'node -e "process.stdin.pipe(process.stdout)"',
    '--out', outDir,
  ]);
  assert(result.status === 0, `live echo command failed: ${result.stderr}`);

  const manifest = readJson(path.join(outDir, 'eval-run.json'));
  const transcript = fs.readFileSync(manifest.transcriptFile, 'utf8');
  assert(transcript.includes('HARNESS INSTRUCTION-COMPLIANCE SCAFFOLD'), 'live stdin did not include scaffold header');
  assert(transcript.includes('\u884c\u52a8: [what you are about to do]'), 'live stdin did not include action label');
  assert(transcript.includes('\u7528\u6237\u6307\u4ee4: "[the exact sentence'), 'live stdin did not include user instruction label');
});

test('agent-eval-runner marks stream-json live runs as transcript-required', () => {
  const outDir = path.join(tmpDir('agent-eval-stream-'), 'out');
  const result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--command', 'claude -p --verbose --output-format stream-json',
    '--out', outDir,
  ]);
  assert(result.status === 0, `dry-run failed: ${result.stderr}`);

  const manifest = readJson(path.join(outDir, 'eval-run.json'));
  assert(manifest.transcriptRequired === true, 'stream-json command did not require transcript compliance');
  assert(/claude-ambiguous-transcript\.jsonl$/.test(manifest.transcriptFile || ''), 'manifest lacks transcript file path');
});

test('agent-eval-runner records expected commands in manifest', () => {
  const outDir = path.join(tmpDir('agent-eval-expected-command-'), 'out');
  const result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--command', 'claude -p --verbose --output-format stream-json',
    '--expect-command', 'node expected.cjs',
    '--out', outDir,
  ]);
  assert(result.status === 0, `dry-run failed: ${result.stderr}`);

  const manifest = readJson(path.join(outDir, 'eval-run.json'));
  assert((manifest.expectedCommands || []).includes('node expected.cjs'), 'manifest did not record expected command');
});

test('agent-eval-runner requires transcript for live commands by default', () => {
  const outDir = path.join(tmpDir('agent-eval-live-plain-'), 'out');
  const result = runNode([
    RUNNER,
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--command', 'node -e "console.log(\'plain live output\')"',
    '--out', outDir,
  ]);
  assert(result.status === 0, `live command failed: ${result.stderr}`);

  const manifest = readJson(path.join(outDir, 'eval-run.json'));
  assert(manifest.transcriptRequired === true, 'live command did not require transcript by default');
  assert(fs.existsSync(manifest.transcriptFile), 'live command did not capture raw output as transcript file');
});

test('agent-eval-verify writes failed manifest for invalid ambiguous response', () => {
  const outDir = path.join(tmpDir('agent-eval-bad-'), 'out');
  let result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--out', outDir,
  ]);
  assert(result.status === 0, `prepare failed: ${result.stderr}`);

  const responseFile = path.join(outDir, 'claude-ambiguous-response.txt');
  fs.writeFileSync(responseFile, 'ambiguous_direction\n\n1. Target data: UART?\n', 'utf8');

  result = runNode([
    VERIFIER,
    '--kind', 'ambiguous',
    '--dir', outDir,
    '--response', responseFile,
    '--label', 'bad-ambiguous',
  ]);

  assert(result.status === 1, `bad ambiguous response unexpectedly passed, exit=${result.status}`);
  const verify = readJson(path.join(outDir, 'eval-verify.json'));
  assert(verify.status === 'failed', 'failed verifier manifest did not record failed status');
  assert(
    /missing clarification concept|expected exactly five/.test(verify.error || ''),
    'failed verifier manifest lacks the concrete failure reason'
  );
});

test('agent-eval-verify writes passed manifest with check details', () => {
  const outDir = path.join(tmpDir('agent-eval-good-'), 'out');
  let result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--out', outDir,
  ]);
  assert(result.status === 0, `prepare failed: ${result.stderr}`);

  const responseFile = path.join(outDir, 'claude-ambiguous-response.txt');
  fs.writeFileSync(responseFile, goodAmbiguousResponse(), 'utf8');
  const transcriptFile = path.join(outDir, 'claude-transcript.jsonl');
  fs.writeFileSync(transcriptFile, goodTranscript(), 'utf8');

  result = runNode([
    VERIFIER,
    '--kind', 'ambiguous',
    '--dir', outDir,
    '--response', responseFile,
    '--transcript', transcriptFile,
    '--label', 'good-ambiguous',
  ]);

  assert(result.status === 0, `good ambiguous response failed: ${result.stderr}`);
  const verify = readJson(path.join(outDir, 'eval-verify.json'));
  assert(verify.status === 'passed', 'passed verifier manifest did not record passed status');
  const checkNames = new Set((verify.checks || []).map((check) => check.name));
  for (const required of ['source-unmodified', 'tests-unmodified', 'clarification-response', 'transcript-compliance']) {
    assert(checkNames.has(required), `missing verifier check detail: ${required}`);
  }
});

test('agent-eval-verify fails live transcript without visible tool checklist', () => {
  const outDir = path.join(tmpDir('agent-eval-bad-transcript-'), 'out');
  let result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--out', outDir,
  ]);
  assert(result.status === 0, `prepare failed: ${result.stderr}`);

  const responseFile = path.join(outDir, 'claude-ambiguous-response.txt');
  fs.writeFileSync(responseFile, goodAmbiguousResponse(), 'utf8');
  const transcriptFile = path.join(outDir, 'claude-transcript.jsonl');
  fs.writeFileSync(transcriptFile, badTranscript(), 'utf8');

  result = runNode([
    VERIFIER,
    '--kind', 'ambiguous',
    '--dir', outDir,
    '--response', responseFile,
    '--transcript', transcriptFile,
    '--label', 'bad-transcript',
  ]);

  assert(result.status === 1, `bad transcript unexpectedly passed, exit=${result.status}`);
  const verify = readJson(path.join(outDir, 'eval-verify.json'));
  assert(verify.status === 'failed', 'failed transcript manifest did not record failed status');
  assert(verify.dimensions?.functionalStatus === 'passed', 'functional dimension should pass for bad transcript fixture');
  assert(verify.dimensions?.complianceStatus === 'failed', 'compliance dimension should fail for bad transcript fixture');
  assert(
    (verify.dimensions?.transcript?.violations || []).some((item) => item.startsWith('visible-pre-tool-checklist@')),
    'dimensions summary lacks visible checklist violation'
  );
  const transcriptCheck = (verify.checks || []).find((check) => check.name === 'transcript-compliance');
  assert(transcriptCheck?.status === 'failed', 'transcript compliance check did not fail explicitly');
  assert(
    (transcriptCheck.violations || []).some((violation) => violation.rule === 'visible-pre-tool-checklist'),
    'failed transcript manifest lacks the visible checklist violation'
  );
});

test('agent-eval-verify auto-checks manifest transcript without --transcript', () => {
  const outDir = path.join(tmpDir('agent-eval-auto-transcript-'), 'out');
  let result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--command', 'claude -p --verbose --output-format stream-json',
    '--out', outDir,
  ]);
  assert(result.status === 0, `prepare failed: ${result.stderr}`);

  const manifest = readJson(path.join(outDir, 'eval-run.json'));
  fs.writeFileSync(manifest.responseFile, goodAmbiguousResponse(), 'utf8');
  fs.writeFileSync(manifest.transcriptFile, badTranscript(), 'utf8');

  result = runNode([
    VERIFIER,
    '--kind', 'ambiguous',
    '--dir', outDir,
    '--response', manifest.responseFile,
    '--label', 'auto-bad-transcript',
  ]);

  assert(result.status === 1, `auto transcript bad run unexpectedly passed, exit=${result.status}`);
  const verify = readJson(path.join(outDir, 'eval-verify.json'));
  assert(verify.transcriptSource === 'manifest', `expected manifest transcript source, got ${verify.transcriptSource}`);
  const transcriptCheck = (verify.checks || []).find((check) => check.name === 'transcript-compliance');
  assert(transcriptCheck?.status === 'failed', 'auto transcript compliance check did not fail explicitly');
});

test('agent-eval-verify fails when expected command is missing from transcript', () => {
  const outDir = path.join(tmpDir('agent-eval-missing-command-'), 'out');
  let result = runNode([
    RUNNER,
    '--dry-run',
    '--agent', 'claude',
    '--kind', 'ambiguous',
    '--command', 'claude -p --verbose --output-format stream-json',
    '--expect-command', 'node expected.cjs',
    '--out', outDir,
  ]);
  assert(result.status === 0, `prepare failed: ${result.stderr}`);

  const manifest = readJson(path.join(outDir, 'eval-run.json'));
  fs.writeFileSync(manifest.responseFile, goodAmbiguousResponse(), 'utf8');
  fs.writeFileSync(manifest.transcriptFile, goodTranscript(), 'utf8');

  result = runNode([
    VERIFIER,
    '--kind', 'ambiguous',
    '--dir', outDir,
    '--response', manifest.responseFile,
    '--label', 'missing-expected-command',
  ]);

  assert(result.status === 1, `missing expected command unexpectedly passed, exit=${result.status}`);
  const verify = readJson(path.join(outDir, 'eval-verify.json'));
  const transcriptCheck = (verify.checks || []).find((check) => check.name === 'transcript-compliance');
  assert(
    (transcriptCheck?.violations || []).some((violation) => violation.rule === 'expected-command-missing'),
    'failed verifier manifest lacks expected-command-missing violation'
  );
});

function main() {
  let passed = 0;
  let failed = 0;

  console.log('\nAgent eval transparency tests\n');
  for (const t of tests) {
    process.stdout.write(`  ${t.name.padEnd(82)} `);
    try {
      t.fn();
      passed += 1;
      console.log('PASS');
    } catch (error) {
      failed += 1;
      console.log('FAIL');
      console.log(`    ${error.message}`);
    }
  }

  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
