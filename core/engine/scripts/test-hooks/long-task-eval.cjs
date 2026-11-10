#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'long-task');
const RUN_ROOT = path.join(HOME, 'var', 'agent-evals', 'long-task');
const SCENARIO = path.join(FIXTURE_ROOT, 'scenario');

const TARGETS = [
  {
    name: 'claude-long-task',
    dir: path.join(RUN_ROOT, 'claude-run2'),
    kind: 'implementation',
  },
  {
    name: 'codex-long-task',
    dir: path.join(RUN_ROOT, 'codex-run2'),
    kind: 'implementation',
  },
  {
    name: 'claude-ambiguous',
    dir: path.join(RUN_ROOT, 'claude-ambiguous2'),
    kind: 'ambiguous',
    responseFile: path.join(RUN_ROOT, 'claude-ambiguous2-response.txt'),
  },
  {
    name: 'codex-ambiguous',
    dir: path.join(RUN_ROOT, 'codex-ambiguous2'),
    kind: 'ambiguous',
    responseFile: path.join(RUN_ROOT, 'codex-ambiguous2-response.txt'),
  },
];

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
}

function read(filePath) {
  const buffer = fs.readFileSync(filePath);
  const looksUtf16 = buffer[0] === 0xff && buffer[1] === 0xfe;
  const encoding = looksUtf16 ? 'utf16le' : 'utf8';
  return buffer.toString(encoding).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameFile(a, b) {
  return read(a) === read(b);
}

function ensureAmbiguousBaseline(target) {
  if (fs.existsSync(target.dir)) return;
  fs.cpSync(SCENARIO, target.dir, { recursive: true });
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function verifyClarificationResponse(target) {
  assert(target.responseFile, `${target.name}: missing responseFile config`);
  assert(fs.existsSync(target.responseFile), `${target.name}: missing captured response`);

  const response = read(target.responseFile).toLowerCase();
  const requiredConcepts = [
    ['target data', ['target data', 'uart', 'iq', 'register']],
    ['input format', ['input format', 'input']],
    ['output format/artifact', ['output format', 'output artifact', 'output']],
    ['success criteria', ['success criteria', 'success']],
    ['verification fixture', ['verification fixture', 'verification', 'test fixture', 'test']],
  ];

  for (const [label, terms] of requiredConcepts) {
    assert(
      includesAny(response, terms),
      `${target.name}: clarification response missing ${label}`
    );
  }
  assert(
    response.includes('ambiguous_direction'),
    `${target.name}: response does not acknowledge ambiguity`
  );
  const numberedQuestions = response.match(
    /(?:^|\n)\s*(?:[*_`]*q?[*_`]*\s*)?[1-5]\s*(?:[.)]|-|--|:|\u2014)\s+.*\?/g
  ) || [];
  assert(
    numberedQuestions.length === 5,
    `${target.name}: expected exactly five numbered clarification questions, got ${numberedQuestions.length}`
  );
  assert(
    !includesAny(response, ['above', 'previous questions', 'earlier questions']),
    `${target.name}: response is not self-contained`
  );
}

function verifyImplementation(target) {
  const pytest = run('python', ['-m', 'pytest', '-q'], target.dir);
  assert(pytest.status === 0, `${target.name}: pytest failed\n${pytest.stdout}\n${pytest.stderr}`);

  const hidden = run('python', [path.join(FIXTURE_ROOT, 'hidden_contract.py')], target.dir);
  assert(hidden.status === 0, `${target.name}: hidden contract failed\n${hidden.stdout}\n${hidden.stderr}`);

  assert(
    sameFile(
      path.join(SCENARIO, 'tests', 'test_telemetry.py'),
      path.join(target.dir, 'tests', 'test_telemetry.py')
    ),
    `${target.name}: tests were modified`
  );
}

function verifyAmbiguous(target) {
  assert(fs.existsSync(target.dir), `${target.name}: missing captured ambiguous run directory`);
  assert(
    sameFile(
      path.join(SCENARIO, 'src', 'telemetry.py'),
      path.join(target.dir, 'src', 'telemetry.py')
    ),
    `${target.name}: ambiguous run modified source`
  );
  assert(
    sameFile(
      path.join(SCENARIO, 'tests', 'test_telemetry.py'),
      path.join(target.dir, 'tests', 'test_telemetry.py')
    ),
    `${target.name}: ambiguous run modified tests`
  );
  verifyClarificationResponse(target);
}

function main() {
  const args = process.argv.slice(2);
  const allowHistoricalArtifacts = args.includes('--allow-historical-artifacts');
  const json = args.includes('--json');
  let passed = 0;
  const results = [];
  for (const target of TARGETS) {
    if (!json) process.stdout.write(`${target.name.padEnd(24)} `);
    try {
      if (target.kind === 'implementation') verifyImplementation(target);
      else verifyAmbiguous(target);
      passed += 1;
      results.push({ name: target.name, kind: target.kind, status: 'passed' });
      if (!json) console.log('PASS');
    } catch (error) {
      results.push({ name: target.name, kind: target.kind, status: 'failed', error: error.message });
      if (!json) {
        console.log('FAIL');
        console.log(error.message);
      }
      process.exitCode = 1;
    }
  }
  const allArtifactsPass = passed === TARGETS.length;
  const summary = {
    schemaVersion: 1,
    mode: 'historical-artifact-long-task-eval',
    status: allArtifactsPass ? 'historical_only' : 'failed',
    liveEvidence: false,
    falsePositiveRisk: allArtifactsPass
      ? 'fixed artifacts verified functionally but cannot prove fresh agent instruction-following'
      : 'one or more fixed artifacts failed',
    allowHistoricalArtifacts,
    passed,
    total: TARGETS.length,
    results,
  };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`\n${passed}/${TARGETS.length} eval targets passed`);
    console.log('historical-artifact mode: not valid live pass evidence');
  }
  if (process.exitCode) return;
  if (!allowHistoricalArtifacts) process.exitCode = 2;
}

main();
