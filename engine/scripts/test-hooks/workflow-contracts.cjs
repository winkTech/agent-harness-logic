#!/usr/bin/env node
'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = HARNESS_ROOT;
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

test('root shell scripts are thin compatibility wrappers for canonical engine scripts', () => {
  const rootModule = read('scripts/init-module.sh');
  const rootProject = read('scripts/init-project.sh');
  const engineModule = read('engine/scripts/init-module.sh');
  const engineProject = read('engine/scripts/init-project.sh');
  assert(rootModule.includes('exec "$ROOT_DIR/engine/scripts/init-module.sh" "$@"'), 'root init-module bypasses canonical engine shell script');
  assert(rootProject.includes('exec "$ROOT_DIR/engine/scripts/init-project.sh" "$@"'), 'root init-project bypasses canonical engine shell script');
  assert(!rootModule.includes('init-module.cjs'), 'root init-module contains implementation target details');
  assert(!rootProject.includes('harness-init.cjs'), 'root init-project duplicates implementation target details');
  assert(engineModule.includes('init-module.cjs'), 'canonical engine init-module implementation target missing');
  assert(engineProject.includes('harness-init.cjs'), 'canonical engine init-project implementation target missing');
});

test('root and platform workflow directories do not drift', () => {
  const rootDir = path.join(HOME, 'workflows');
  const platformDir = path.join(HOME, '.claude', 'workflows');
  const jsNames = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort();
  const rootNames = jsNames(rootDir);
  const platformNames = jsNames(platformDir);
  assert(JSON.stringify(rootNames) === JSON.stringify(platformNames),
    `workflow file sets differ: root=${rootNames.join(',')} platform=${platformNames.join(',')}`);
  for (const name of rootNames) {
    const rootBytes = fs.readFileSync(path.join(rootDir, name));
    const platformBytes = fs.readFileSync(path.join(platformDir, name));
    assert(rootBytes.equals(platformBytes), `workflow drift detected: ${name}`);
  }
});

test('HDL workflow never accepts arbitrary output merely containing PASS', () => {
  const content = read('workflows/hdl-coding-dag-workflow.js');
  assert(
    !/\.includes\(\s*['"]PASS['"]\s*\)/.test(content),
    'substring PASS acceptance remains in the HDL workflow'
  );
  // v3.6: 结构化证据判定移入确定性脚本 hdl-evidence-gate.cjs;
  // 工作流侧只接受 gate_executed/gate_ok + compared_points 的结构化返回。
  // 测试意图不变: 证据判定必须是结构化的, 不允许子串 PASS 匹配。
  assert(content.includes('hdl-evidence-gate.cjs'), 'deterministic evidence gate script reference missing');
  assert(/gate_executed\s*===\s*true/.test(content), 'structured gate_executed check missing');
  assert(/gate_ok\s*===\s*true/.test(content), 'structured gate_ok check missing');
  assert(/\(\s*\w+\?*\.?compared_points\s*\|\|\s*0\s*\)\s*>\s*0/.test(content), 'structured module evidence count gate missing');
  const gateScript = read('engine/scripts/hdl-evidence-gate.cjs');
  assert(gateScript.includes("data.status !== 'PASS'"), 'gate script structural status check missing');
  assert(gateScript.includes('points > 0'), 'gate script structural count check missing');

  const helperStart = content.indexOf('function _parseStrictJsonObject(raw)');
  const helperEnd = content.indexOf('function _checkpointConfirmed', helperStart);
  assert(helperStart >= 0 && helperEnd > helperStart, 'strict JSON parser helper missing');
  const parseStrictJsonObject = Function(
    `${content.slice(helperStart, helperEnd)}; return _parseStrictJsonObject;`
  )();
  assert(parseStrictJsonObject('simulation did NOT PASS') === null, 'arbitrary PASS text was parsed');
  assert(parseStrictJsonObject('prefix {"pass":true,"evidence_ok":true}') === null, 'embedded JSON was parsed');
  const verdict = parseStrictJsonObject('{"pass":true,"evidence_ok":true}');
  assert(verdict?.pass === true && verdict?.evidence_ok === true, 'complete structured verdict was rejected');
});

test('workflow trigger docs match actual workflow behavior', () => {
  const docs = read('docs/rules-archive/05-workflow-trigger.md');
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
