#!/usr/bin/env node
'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = HARNESS_ROOT;
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
  // 注入面与真实 Workflow 运行时对齐: 缺 pipeline 曾让 hdl 工作流的深路径
  // 在本 eval 中根本不可执行 (ReferenceError), 假绿掩盖了 fs 桥缺失。
  return new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'workflow', source);
}

// pipeline(items, ...stages): 每个 item 独立走完所有 stage, stage 收
// (prevResult, originalItem, index) —— 与 Workflow 工具语义一致 (无层间屏障)。
async function pipelineImpl(items, ...stages) {
  return Promise.all(items.map(async (item, index) => {
    let prev = item;
    for (let s = 0; s < stages.length; s += 1) {
      prev = s === 0 ? await stages[s](item, item, index) : await stages[s](prev, item, index);
    }
    return prev;
  }));
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
          runner: 'argv',
          argv: ['node', 'engine/scripts/workflow-evidence-scan.cjs', '--json', '--root', '.', '--targets-json', '["src"]'],
          scanner: 'workflow-evidence-scan',
          schemaVersion: 2,
          exitCode: 0,
          status: opts.badSecurityEvidence ? 'clean' : 'clean',
          truncated: opts.badSecurityEvidence === true,
          manifestSha256: 'a'.repeat(64),
          filesScanned: 1,
          totalCandidates: 1,
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
      return {
        answer: 'Use the cited rule.',
        citations: opts.badRagCitation
          ? ['not-a-file-reference']
          : ['docs/rules/00-core.md:1'],
      };
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
      pipelineImpl,
      (name) => phases.push(name),
      (message) => logs.push(String(message)),
      workflow
    );
    return { ok: true, result, calls, phases, logs };
  } catch (error) {
    return { ok: false, error, calls, phases, logs };
  }
}

// ── hdl DAG 深路径测试的 stub agent ─────────────────────────────────────────
// 覆盖 v3.6 的证据门禁/仿真/终验/verifier 全部结构化契约。
function hdlDeepStubAgent(overrides = {}) {
  return (prompt, agentOpts) => {
    const label = agentOpts.label || '';
    if (overrides[label]) return overrides[label](prompt, agentOpts);
    for (const key of Object.keys(overrides)) {
      if (key.endsWith('*') && label.startsWith(key.slice(0, -1))) return overrides[key](prompt, agentOpts);
    }
    if (label === 'p1b-arch-evidence') {
      return { executed: true, ok: true, failures: [], gateJson: '{"gate":"hdl-evidence-gate","ok":true,"arch":{"exists":true}}' };
    }
    if (label === 'p45-evidence') {
      return {
        executed: true, ok: true, failures: [],
        gateJson: '{"gate":"hdl-evidence-gate","ok":true,"modules":[{"module":"demo","pass":true,"compared_points":2048,"max_error_lsb":0}]}',
      };
    }
    if (label.startsWith('sim-run-') || label.startsWith('sim-recheck-') || label.startsWith('sim-final-')) {
      return { gate_executed: true, gate_ok: true, compared_points: 2048, log_tail: 'sim ok' };
    }
    if (label.startsWith('final-verify-')) {
      return '{"module":"demo","pass":true,"evidence_ok":true,"checks":["naming"],"issues":[]}';
    }
    if (label === 'p45-adversarial') return '[]';
    if (label === 'p5-synthesis') return '{"overall":"pass","issues":[],"root_cause":"","fix_suggestion":""}';
    if (label === 'verifier') return '{"pass":true,"reason":"all phases produced evidence"}';
    return 'stub-output';
  };
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

test('security workflow binds Phase 2 to a deterministic argv scan manifest', async () => {
  const run = await runWorkflow('security-review-workflow', { targets: ['src'], scope: 'full' });
  assert(run.ok, `security-review threw: ${run.error?.message}`);
  const scanCall = run.calls.find((call) => call.opts.label === 'p2-scan');
  assert(scanCall, 'p2-scan agent call missing');
  assert(scanCall.prompt.includes('"runner":"argv"'), 'structured runner request missing from p2 prompt');
  assert(scanCall.prompt.includes('"--targets-json","[\\"src\\"]"'), 'JSON target argv missing from p2 prompt');
  assert(run.result.automatedScan.automatedEvidence.filesScanned === 1, 'automated evidence was not returned');
  assert(run.result.pass === true, 'valid bound scan evidence did not pass the workflow');
  assert(run.result.scanEvidenceValid === true, 'valid scan evidence was not marked bound');
});

test('security workflow rejects a truncated manifest even when it claims clean', async () => {
  const run = await runWorkflow('security-review-workflow', { targets: ['src'], scope: 'full' }, { badSecurityEvidence: true });
  assert(run.ok, `security-review threw: ${run.error?.message}`);
  assert(run.result.pass === false, 'truncated scan evidence produced pass=true');
  assert(run.result.scanEvidenceValid === false, 'truncated scan evidence was accepted');
  assert((run.result.blockingIssues || []).some((item) => /truncated/.test(item)),
    `missing truncation blocker: ${JSON.stringify(run.result.blockingIssues)}`);
});

test('rag workflow requires citations for a successful answer', async () => {
  const run = await runWorkflow('rag-skill-workflow', { query: 'reset rule' });
  assert(run.ok, `rag workflow threw: ${run.error?.message}`);
  assert(run.result.pass === true, 'rag workflow did not pass with cited stub result');
  assert(run.result.citations.length === 1, 'rag workflow did not expose citations');
});

test('rag workflow rejects non-file citations instead of counting arbitrary strings', async () => {
  const run = await runWorkflow(
    'rag-skill-workflow',
    { query: 'reset rule' },
    { badRagCitation: true }
  );
  assert(run.ok, `rag workflow threw: ${run.error?.message}`);
  assert(run.result.pass === false, 'rag workflow accepted an invalid citation string');
  assert(run.result.invalidCitations.includes('not-a-file-reference'),
    'rag workflow did not expose the rejected citation');
});

test('hdl dag workflow blocks until the preflight checkpoint is confirmed', async () => {
  const run = await runWorkflow('hdl-coding-dag-workflow', { modules: ['demo'] });
  assert(!run.ok, 'hdl workflow should throw without preflight confirmation');
  assert(String(run.error.message).includes('WorkflowCheckpoint:preflight'), 'missing checkpoint error was not explicit');
});

test('hdl dag workflow pauses at design-review checkpoint after preflight confirmed', async () => {
  const run = await runWorkflow('hdl-coding-dag-workflow', { modules: ['demo'], confirmed: true }, {
    agent: hdlDeepStubAgent(),
  });
  assert(!run.ok, 'workflow should pause (throw) at design-review checkpoint');
  assert(String(run.error.message).includes('WorkflowCheckpoint:design-review'),
    `expected design-review checkpoint error, got: ${run.error.message.slice(0, 200)}`);
  assert(String(run.error.message).includes('resumeFromRunId'),
    'checkpoint error must carry resume instructions');
  const labels = run.calls.map((c) => c.opts.label || '');
  assert(labels.includes('p1b-arch-evidence'), 'P1b must route arch check through the evidence gate agent');
});

test('hdl dag workflow deep run completes with deterministic evidence gates', async () => {
  const run = await runWorkflow('hdl-coding-dag-workflow', { modules: ['demo'], confirmAllCheckpoints: true }, {
    agent: hdlDeepStubAgent(),
  });
  assert(run.ok, `deep run threw: ${run.error?.message?.slice(0, 300)}`);
  assert(run.result?.verifier?.pass === true, 'verifier did not report pass=true');
  const labels = run.calls.map((c) => c.opts.label || '');
  assert(labels.includes('p45-evidence'), 'Phase 4.5 must invoke the evidence gate agent');
  const gateCall = run.calls.find((c) => c.opts.label === 'p45-evidence');
  assert(gateCall.prompt.includes('hdl-evidence-gate.cjs'), 'evidence gate prompt must reference the deterministic script');
  const simCall = run.calls.find((c) => (c.opts.label || '').startsWith('sim-run-'));
  assert(simCall && simCall.opts.schema, 'sim agents must use structured-output schema');
  assert(simCall.opts.agentType === 'logic-engineer', 'sim agents must be wired to logic-engineer');
  const advCall = run.calls.find((c) => c.opts.label === 'p45-adversarial');
  assert(!advCall, 'standard module must not trigger adversarial review');
});

test('hdl dag executor terminates on node failure instead of looping', async () => {
  const run = await runWorkflow('hdl-coding-dag-workflow', { modules: ['demo'], confirmAllCheckpoints: true }, {
    agent: hdlDeepStubAgent({
      'p0-infra': () => { throw new Error('infra tooling unavailable'); },
    }),
  });
  assert(!run.ok, 'workflow should fail when a DAG node fails');
  assert(String(run.error.message).includes('p0_infra'), `failure must name the failed node, got: ${run.error.message.slice(0, 200)}`);
  assert(run.calls.length <= 3, `failed node must not be re-run in a loop (agent calls=${run.calls.length})`);
});

test('code-review adversarial verify demotes refuted findings', async () => {
  const run = await runWorkflow('code-review-workflow', { files: ['src/app.py'] }, {
    blockingReview: true,
    agent: (prompt, agentOpts) => {
      const label = agentOpts.label || '';
      if (label === 'p1-correctness') {
        return {
          findings: [{
            pass: 'P1', severity: 'HIGH', category: '逻辑正确', file: 'src/app.py:10',
            title: 'suspected wrong return', description: 'mock', evidence: 'line 10', impact: 'tests fail',
          }],
        };
      }
      if (label.startsWith('verify-finding-')) return { refuted: true, reason: 'the return value is correct for the documented contract' };
      if (label === 'p2-quality' || label.startsWith('p3-')) return { findings: [] };
      return {};
    },
  });
  assert(run.ok, `code-review threw: ${run.error?.message}`);
  assert(run.result.pass === true, 'refuted finding should no longer block the run');
  assert(run.result.blockingIssues.length === 0, 'refuted finding still listed as blocking');
  assert(run.result.pass1.findings[0].verdict === 'REFUTED', 'finding was not marked REFUTED');
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
