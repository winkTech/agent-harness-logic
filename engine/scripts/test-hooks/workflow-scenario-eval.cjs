#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = path.join(os.homedir(), '.claude');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function workflowPath(name) {
  return path.join(HOME, 'workflows', `${name}.js`);
}

function compileWorkflow(name) {
  const filePath = workflowPath(name);
  const source = fs.readFileSync(filePath, 'utf8')
    .replace(/export\s+const\s+meta\s*=/, 'const meta =');
  return new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', 'workflow', source);
}

async function runWorkflow(name, args = {}, opts = {}) {
  const calls = [];
  const fn = compileWorkflow(name);
  const agent = async (prompt, agentOpts = {}) => {
    calls.push({ prompt: String(prompt), opts: agentOpts });
    const label = agentOpts.label || '';
    if (opts.agent) return opts.agent(prompt, agentOpts, calls);
    if (label === 'p1-correctness') {
      return {
        findings: opts.blockingReview ? [{
          pass: 'P1',
          severity: 'HIGH',
          category: '逻辑正确',
          file: 'src/app.py:10',
          title: 'hidden contract is violated',
          description: 'mock blocking issue',
          evidence: 'line 10 returns the wrong value',
          impact: 'tests fail',
        }] : [],
      };
    }
    if (label === 'p2-quality' || label.startsWith('p3-')) return { findings: [] };
    if (label === 'p1-context') {
      return {
        structure: 'src plus tests',
        components: ['src/app.py'],
        techStack: ['python'],
        dependencies: [],
        docCoverage: 'fair',
        size: 'small',
        keyFindings: ['mock context evidence'],
      };
    }
    if (label === 'p2-architecture') {
      return {
        patterns: ['layered'],
        quality: 'fair',
        coupling: 'low',
        cohesion: 'high',
        techDebt: {},
        risks: [],
        recommendations: [],
      };
    }
    if (label === 'p3-security') {
      return {
        strideFindings: [],
        owaspFindings: [],
        dependencyRisks: [],
        dataExposureRisks: [],
        overallRisk: 'low',
      };
    }
    if (label === 'p4-synthesis') {
      return { immediate: [], shortTerm: [], roadmap: [], overallHealth: 'good' };
    }
    if (label === 'p1-threat-model') {
      return {
        assets: [{ name: 'token', type: '密钥', sensitivity: '高' }],
        attackSurfaces: [{ entry: 'api', threats: ['tampering'], existingControls: [], gaps: [] }],
        overallRisk: 'medium',
        focusAreas: ['secrets'],
      };
    }
    if (label === 'p2-scan') {
      return {
        hardcodedSecrets: [],
        injectionRisks: [],
        dangerousCalls: [],
        configIssues: [],
        dependencyIssues: [],
        automatedEvidence: {
          command: 'node engine/scripts/workflow-evidence-scan.cjs --json --targets src',
          filesScanned: 1,
          issueCount: 0,
        },
        scanSummary: 'clean',
      };
    }
    if (label === 'p3-manual') {
      return {
        authIssues: [],
        permissionIssues: [],
        inputValidationIssues: [],
        dataProtectionIssues: [],
        overallAssessment: 'no confirmed issues',
      };
    }
    if (label === 'p4-fix-plan') {
      return { p0: [], p1: [], p2: [], verificationSteps: ['rerun scan'], summary: 'clean' };
    }
    if (label === 'rag-search') {
      return { answer: 'Use the cited rule.', citations: ['rules/00-core.md:1'] };
    }
    return {};
  };
  const parallel = async (tasks) => Promise.all(tasks.map((task) => task()));
  const phases = [];
  const logs = [];
  const workflow = async (delegatedName, delegatedArgs) => ({
    pass: true,
    delegatedName,
    delegatedArgs,
  });
  try {
    const result = await fn(
      args,
      agent,
      parallel,
      (name) => phases.push(name),
      (message) => logs.push(String(message)),
      workflow
    );
    return { ok: true, result, calls, phases, logs };
  } catch (error) {
    return { ok: false, error, calls, phases, logs };
  }
}

test('missing required inputs stop read/review/security/rag workflows before work', async () => {
  for (const name of [
    'architecture-review-workflow',
    'code-review-workflow',
    'rag-skill-workflow',
    'security-review-workflow',
  ]) {
    const run = await runWorkflow(name, {});
    assert(run.ok, `${name} threw instead of returning a clarification`);
    assert(run.result?.pass === false, `${name} did not return pass=false for missing inputs`);
    assert((run.calls || []).length === 0, `${name} called agent before required inputs were present`);
  }
});

test('code-review workflow fails the run when Pass 1 has a blocking finding', async () => {
  const run = await runWorkflow('code-review-workflow', { files: ['src/app.py'] }, { blockingReview: true });
  assert(run.ok, `code-review threw: ${run.error?.message}`);
  assert(run.result.pass === false, 'code-review returned pass=true despite HIGH finding');
  assert(run.result.pass1.passed === false, 'pass1.passed was not false');
  assert(run.result.blockingIssues.length === 1, 'blocking issue was not surfaced');
});

test('security workflow injects deterministic scan command into Phase 2', async () => {
  const run = await runWorkflow('security-review-workflow', { targets: ['src'], scope: 'full' });
  assert(run.ok, `security-review threw: ${run.error?.message}`);
  const scanCall = run.calls.find((call) => call.opts.label === 'p2-scan');
  assert(scanCall, 'p2-scan agent call missing');
  assert(scanCall.prompt.includes('workflow-evidence-scan.cjs'), 'deterministic scan command missing from p2 prompt');
  assert(run.result.automatedScan.automatedEvidence.filesScanned === 1, 'automated evidence was not returned');
});

test('rag workflow requires citations for a successful answer', async () => {
  const run = await runWorkflow('rag-skill-workflow', { query: 'reset rule' });
  assert(run.ok, `rag workflow threw: ${run.error?.message}`);
  assert(run.result.pass === true, 'rag workflow did not pass with cited stub result');
  assert(run.result.citations.length === 1, 'rag workflow did not expose citations');
});

test('hdl dag workflow blocks until the preflight checkpoint is confirmed', async () => {
  const run = await runWorkflow('hdl-coding-dag-workflow', { modules: ['demo'] });
  assert(!run.ok, 'hdl workflow should throw without preflight confirmation');
  assert(String(run.error.message).includes('WorkflowCheckpoint:preflight'), 'missing checkpoint error was not explicit');
});

test('hdl alias delegates to the dag workflow with original args', async () => {
  const run = await runWorkflow('hdl-coding-workflow', { modules: ['demo'], confirmed: true });
  assert(run.ok, `hdl alias threw: ${run.error?.message}`);
  assert(run.result.delegatedName === 'hdl-coding-dag-workflow', 'alias did not delegate to dag workflow');
  assert(run.result.delegatedArgs.modules[0] === 'demo', 'alias did not forward args');
});

async function main() {
  let passed = 0;
  let failed = 0;

  console.log('\nWorkflow scenario evals\n');
  for (const t of tests) {
    process.stdout.write(`  ${t.name.padEnd(82)} `);
    try {
      await t.fn();
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
