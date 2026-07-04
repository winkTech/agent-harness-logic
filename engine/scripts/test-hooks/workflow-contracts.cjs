#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = path.join(os.homedir(), '.claude');
const { validateWorkflowSet } = require(path.join(HOME, 'engine/scripts/lib/workflow-runtime.cjs'));

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relPath) {
  return fs.readFileSync(path.join(HOME, relPath), 'utf8');
}

test('all workflow files satisfy the strict runtime contract', () => {
  const result = validateWorkflowSet(path.join(HOME, 'workflows'));
  assert(result.ok, result.errors.join('\n'));
});

test('strict workflow contract rejects empty checkpoint and evidence arrays', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-contract-bad-'));
  const bad = path.join(tmp, 'code-review-workflow.js');
  fs.writeFileSync(bad, [
    'export const meta = {',
    "  name: 'code-review-workflow',",
    '  contract: {',
    '    version: 1,',
    '    strict: true,',
    '    inputs: ["target"],',
    '    checkpoints: [],',
    '    evidence: [],',
    '    completionCriteria: ["done"],',
    '  },',
    '};',
    "phase('noop');",
    'const workflowPassed = false;',
    'const blockingIssues = [];',
    'return { pass: workflowPassed, blockingIssues };',
    '',
  ].join('\n'), 'utf8');

  const result = validateWorkflowSet(tmp);
  assert(!result.ok, 'malformed strict workflow unexpectedly passed');
  assert(
    result.errors.some((error) => error.includes('contract.checkpoints')) &&
      result.errors.some((error) => error.includes('contract.evidence')),
    `missing structured contract errors: ${result.errors.join('|')}`
  );
});

test('workflow evidence scanner produces concrete file-line findings', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-'));
  const fixture = path.join(tmp, 'app.js');
  fs.writeFileSync(fixture, [
    'const api_key = "sk_test_123456789";',
    'eval(userInput);',
    'const query = "SELECT * FROM users WHERE id=" + id;',
  ].join('\n'), 'utf8');

  const script = path.join(HOME, 'engine/scripts/workflow-evidence-scan.cjs');
  const result = spawnSync('node', [script, '--json', '--targets', fixture], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert(result.status === 0, `scanner exit=${result.status}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert(parsed.filesScanned === 1, 'scanner did not scan the fixture file');
  assert(parsed.findings.hardcodedSecrets.length === 1, 'secret finding missing');
  assert(parsed.findings.dangerousCalls.length === 1, 'dangerous call finding missing');
  assert(parsed.findings.injectionRisks.length === 1, 'injection finding missing');
  for (const bucket of Object.values(parsed.findings)) {
    for (const finding of bucket) {
      assert(finding.file && finding.line > 0 && finding.evidence, 'finding is missing file/line/evidence');
    }
  }
});

test('code review workflow fails when blocking findings exist', () => {
  const content = read('workflows/code-review-workflow.js');
  assert(!/return\s*\{\s*pass\s*:\s*true\b/s.test(content), 'unconditional pass:true remains');
  assert(content.includes('workflowPassed'), 'workflowPassed gate missing');
  assert(content.includes('blockingIssues'), 'blockingIssues gate missing');
});

test('workflow trigger docs match actual workflow behavior', () => {
  const docs = read('rules/archive/05-workflow-trigger.md');
  assert(!docs.includes('Writer→Reviewer→Arbiter'), 'stale code-review route description remains');
  assert(docs.includes('Pass 1 正确性'), 'code-review route does not mention actual Pass 1 flow');
  assert(docs.includes('workflow-evidence-scan.cjs'), 'security route does not mention deterministic evidence scan');
});

function main() {
  let passed = 0;
  let failed = 0;

  console.log('\nWorkflow contract regression tests\n');
  for (const t of tests) {
    process.stdout.write(`  ${t.name.padEnd(78)} `);
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
