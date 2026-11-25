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
  return path.join(HOME, name.startsWith('hdl-coding') ? 'packs/fpga/workflows' : 'core/workflows', `${name}.js`);
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
          argv: ['node', 'core/engine/scripts/workflow-evidence-scan.cjs', '--json', '--root', '.', '--targets-json', '["src"]'],
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
    if (label === 'rag-search' || label === 'rag-verify') {
      return {
        status: 'references', answer: 'Use the cited rule.',
        citations: opts.badRagCitation
          ? ['not-a-file-reference']
          : [{ file: 'docs/rules/00-core.md', line: 1, quote: label === 'rag-verify' && opts.changedSource ? 'Updated rule' : 'Use the cited rule.' }],
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
    if (label === 'rtl-ready') {
      const mode = prompt.includes('--lite') ? 'lite' : 'full';
      return { executed: true, ok: true, failures: [], gateJson: JSON.stringify({ gate: 'hdl-evidence-gate', ok: true, mode, fixedPointReceiptSha256: 'a'.repeat(64), withBaseline: prompt.includes('--with-baseline'), rtlReady: ['demo'] }) };
    }
    if (label === 'p2-evidence') return { executed: true, ok: true, failures: [], gateJson: JSON.stringify({ gate: 'hdl-evidence-gate', ok: true, mode: 'full', fixedPointReceiptSha256: 'a'.repeat(64), withBaseline: prompt.includes('--with-baseline'), fixedPoint: ['demo'] }) };
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

test('rag workflow rejects changed evidence at an otherwise valid location', async () => {
  const run = await runWorkflow('rag-skill-workflow', { query: 'reset rule' }, { changedSource: true });
  assert(run.ok && !run.result.pass, 'changed source was accepted');
});

test('hdl dag workflow blocks until the preflight checkpoint is confirmed', async () => {
  const run = await runWorkflow('hdl-coding-dag-workflow', { modules: ['demo'] });
  assert(!run.ok, 'hdl workflow should throw without preflight confirmation');
  assert(String(run.error.message).includes('WorkflowCheckpoint:preflight'), 'missing checkpoint error was not explicit');
});

test('hdl dag waits for each design approval before dispatching the next phase', async () => {
  const checkpoints = {};
  for (const [gate, forbidden] of [['layout-review', 'p1a-system-design'], ['system-review', 'p1b-algo-arch']]) {
    const step = await runWorkflow('hdl-coding-dag-workflow', { modules: ['demo'], confirmed: true, checkpoints }, { agent: hdlDeepStubAgent() });
    assert(!step.ok && step.error.message.includes('WorkflowCheckpoint:' + gate), 'missing checkpoint: ' + gate);
    assert(!step.calls.some(call => call.opts.label === forbidden || call.opts.label === 'p1b-logic-arch'), 'premature dispatch at ' + gate);
    checkpoints[gate] = { confirmed: true };
  }
  const run = await runWorkflow('hdl-coding-dag-workflow', { modules: ['demo'], confirmed: true, checkpoints }, {
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

test('existing Golden and RTL dispatch enforce on-disk evidence in lite and unattended runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-preflight-'));
  const write = (file, value) => {
    const dst = path.join(root, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, value);
  };
  const gate = (...flags) => {
    const { stdout, status } = require('node:child_process').spawnSync(process.execPath,
      [path.join(HOME, 'core/engine/scripts/hdl-evidence-gate.cjs'), '--project-root', root, ...flags],
      { encoding: 'utf8', env: { ...process.env, HARNESS_NO_PERSIST: '1' } });
    const json = JSON.parse(stdout.slice(0, stdout.lastIndexOf('RESULT:')));
    assert((status === 0) === json.ok, 'CLI exit code disagrees with report');
    return { executed: true, ok: json.ok, failures: json.failures, gateJson: JSON.stringify(json) };
  };
  const entry = 'model/main.m';
  const row = name => ({ name, source: 'normal', oracleInputs: [], compared: 24, metrics: { measuredSnrDb: 20 },
    criterion: 'matches 24 reference symbols', passed: true, log: 'audit/cases.log' });
  const baseline = { entry, cases: ['QPSK', '16QAM'], tools: ['sim'], limits: [{ case: '16QAM', metric: 'measuredSnrDb', min: 19.9, max: 20.1 }] };
  const receipt = { entry, entrySha256: require('node:crypto').createHash('sha256').update('model').digest('hex'),
    exitCode: 0, entryLog: 'audit/entry.log', cases: baseline.cases.map(row), tools: [{ name: 'sim', exitCode: 0, log: 'audit/sim.log' }] };
  const save = data => write('var/workflow/golden-preflight.json', JSON.stringify(data));
  const run = (lite = true, options = {}, beforeReady) => runWorkflow('hdl-coding-dag-workflow',
    { modules: ['demo'], lite, resourceLimits: lite ? {} : { DSP: 1 }, confirmAllCheckpoints: true, projectRoot: root, goldenBaseline: baseline, ...options },
    { agent: hdlDeepStubAgent({ 'golden-preflight-evidence': () => gate('--golden'),
      'p2-evidence': prompt => gate('--fixed-point', '--with-baseline', ...(prompt.includes('--hard-limit DSP=1 ') ? ['--hard-limit', 'DSP=1'] : []), '--modules', 'demo'),
      'rtl-ready': prompt => {
        beforeReady?.();
        return gate('--rtl-ready', lite ? '--lite' : '--with-baseline', ...(prompt.includes('--hard-limit DSP=1 ') ? ['--hard-limit', 'DSP=1'] : []), '--modules', 'demo');
      } }) });
  try {
    write(entry, 'model');
    write('var/workflow/golden-scope.json', JSON.stringify(baseline));
    for (const name of ['entry', 'cases', 'sim']) write('audit/' + name + '.log', name + ' run fixture');
    for (const change of [
      { exitCode: 1 }, { cases: [row('QPSK')] }, { cases: [row('QPSK'), { ...row('16QAM'), source: 'diagnostic' }] },
      { cases: [row('QPSK'), { ...row('16QAM'), compared: 0 }] }, { tools: [] }, { entryLog: 'audit/missing' },
      { entrySha256: 'old' }, { entryLog: entry },
      { cases: [row('QPSK'), { ...row('16QAM'), oracleInputs: ['tx.SIGNAL.MCS'] }] },
      { cases: [row('QPSK'), { ...row('16QAM'), oracleInputs: undefined }] },
      { cases: [row('QPSK'), { ...row('16QAM'), metrics: { configuredSnrDb: 20, measuredSnrDb: 12 } }] },
      { cases: [row('QPSK'), { ...row('16QAM'), metrics: { configuredSnrDb: 20 } }] },
    ]) {
      save({ ...receipt, ...change });
      const result = await run();
      assert(!result.ok && result.error.message.includes('Golden preflight blocked'), 'unqualified Golden was accepted: ' + JSON.stringify(change));
      assert(!result.calls.some(c => c.opts.label === 'p0-infra'), 'dispatched beyond preflight');
    }
    save(receipt);
    write('var/workflow/golden-scope.json', JSON.stringify({ ...baseline, limits: [] }));
    const weakened = await run();
    assert(!weakened.ok && weakened.error.message.includes('unchecked measurement'), 'caller limits lost during handoff');
    write('var/workflow/golden-scope.json', JSON.stringify(baseline));
    const files = ['06_doc/architecture.yaml', '06_doc/verification_strategy.md', '02_sim/demo/tb_demo.sv',
      '02_sim/check_demo.py', '02_sim/tv/demo_tv.txt'];
    for (const file of files) write(file, 'fixture');
    const early = await run(false);
    assert(!early.ok && early.error.message.includes('P2') && !early.calls.some(c => ['p3-vectors', 'rtl-code-demo'].includes(c.opts.label)),
      'full workflow dispatched final vectors or RTL without P2');
    for (const file of files) {
      write(file, '');
      const result = await run();
      assert(!result.ok && result.error.message.includes(file), 'missing prerequisite not identified: ' + file);
      assert(!result.calls.some(c => c.opts.label.startsWith('rtl-code-')), 'dispatched RTL without ' + file);
      write(file, 'fixture');
    }
    const json = (file, object) => write(file, JSON.stringify(object));
    const digest = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    const hashes = paths => Object.fromEntries(paths.map(f => [f, digest(f)]));
    const model = 'model/fixed.m', measurement = 'audit/widths.json', fixed = 'var/workflow/p2-fixed-point.json';
    const p2Paths = [files[0], '06_doc/fixed_point_report.md', '06_doc/resource_budget_tracking.md', entry, model, measurement];
    for (const file of p2Paths.slice(1, 3).concat(model)) write(file, file);
    const widths = { module: 'demo', compared_points: 8, selected_width: 10, max_error_limit: 1, rounding: 'nearest', overflow: 'saturate',
      trials: [{ width: 8, max_error: 2 }, { width: 10, max_error: 1 }] };
    const systemCases = {};
    p2Paths.push('var/workflow/golden-scope.json', 'var/workflow/golden-preflight.json');
    for (const name of baseline.cases) {
      const file = 'audit/' + name + '.json';
      systemCases[name] = file;
      const checks = [{ metric: 'error', float: 0, fixed: 0.5, max: 1 }];
      if (name === '16QAM') checks.push({ metric: 'measuredSnrDb', float: 20, fixed: 20, min: 19.9, max: 20.1 });
      json(file, { case: name, source: 'normal', oracleInputs: [], compared_points: 24, checks });
      p2Paths.push(file);
    }
    const sealP2 = () => json(fixed, { modules: { demo: { model, reference: entry, measurement } }, systemCases, hashes: hashes(p2Paths),
      resources: Object.fromEntries(['DSP', 'LUT', 'BRAM'].map(k => [k, { estimate: 0, limit: 1 }])) });
    json(measurement, widths); sealP2();
    const plan = 'var/workflow/p3-plan.json', p3 = 'var/workflow/p3/demo.json';
    json(plan, { strategySha256: digest(files[1]), modules: { demo: ['normal', 'boundary'] } });
    const probes = { tb: {}, checker: {} };
    const p3Paths = [...files, model, plan];
    for (const component of Object.keys(probes)) for (const kind of ['good', 'fault']) {
      const file = 'audit/' + component + '-' + kind + '.json';
      probes[component][kind] = file;
      p3Paths.push(file);
      json(file, { module: 'demo', component, kind, compared_points: 8, mismatches: +(kind === 'fault'), exitCode: +(kind === 'fault'),
        scenarios: { normal: 7, boundary: 1 } });
    }
    const sealP3 = (full = true) => json(p3, { module: 'demo', reference: model, probes, hashes: hashes(full ? [...p3Paths, fixed] : p3Paths) });
    sealP3();
    for (const lite of [false, true]) {
      const result = await run(lite);
      assert(result.ok && result.calls.some(c => c.opts.label === 'rtl-code-demo'), 'qualified scenario did not dispatch RTL: ' + result.error?.message);
      const labels = result.calls.map(c => c.opts.label);
      if (!lite) assert(labels.indexOf('p2-evidence') < labels.indexOf('p3-vectors'), 'vectors preceded P2 qualification');
      assert(labels.indexOf('p3-selftest') < labels.indexOf('rtl-ready') && labels.indexOf('rtl-ready') < labels.indexOf('rtl-code-demo'), 'P4 ran early');
      const prep = await run(lite, { stopAfter: 'p3' });
      assert(prep.ok && prep.result.completedThrough === 'p3' && prep.result.rtlReady === true && prep.result.evidence === 'validated-on-disk' && !prep.result.verifier
        && prep.calls.some(c => c.opts.label === 'rtl-ready') && !prep.calls.some(c => c.opts.label.startsWith('rtl-code-')),
        'P2/P3-only scope must end after readiness and before any RTL dispatch');
    }
    assert(!gate('--rtl-ready', '--modules', 'demo,missing').ok, 'partial module scope passed');
    const changedDuringP3 = await run(false, {}, () => {
      fs.appendFileSync(path.join(root, fixed), '\n'); sealP3();
    });
    assert(!changedDuringP3.ok && changedDuringP3.error.message.includes('P2 changed')
      && !changedDuringP3.calls.some(c => c.opts.label.startsWith('rtl-code-')), 'a new P2 generation slipped into P4');
    sealP2(); sealP3();
    const expectBlocked = async (reason, lite = false) => {
      const result = await run(lite);
      assert(!result.ok && !result.calls.some(c => c.opts.label === 'rtl-code-demo') && result.error.message.includes(reason), 'failed to block: ' + reason);
    };
    const measuredPath = systemCases['16QAM'];
    const measured = JSON.parse(fs.readFileSync(path.join(root, measuredPath), 'utf8'));
    const signal = measured.checks[1];
    for (const change of [
      { checks: [measured.checks[0]] },
      { checks: [{ ...signal, fixed: 12, min: 0 }] },
      { checks: [{ ...signal, float: 12 }] },
      { source: 'diagnostic' },
      { oracleInputs: ['tx.SIGNAL'] },
    ]) {
      json(measuredPath, { ...measured, ...change }); sealP2();
      await expectBlocked('P2');
    }
    json(measuredPath, measured); sealP2(); sealP3();
    // The OFDM fixture uses a thin per-module TB and checker over shared implementations.
    write(files[2], '`include "scoreboard.svh"\n');
    write(files[3], 'from shared_runner import main\n');
    const sharedTb = '02_sim/scoreboard.svh', sharedChecker = '02_sim/shared_runner.py';
    write(sharedTb, '// scoreboard'); write(sharedChecker, 'def main(): return 0\n');
    sealP3(); await expectBlocked('missing artifact digest');
    p3Paths.push(sharedTb); sealP3(); await expectBlocked('missing artifact digest');
    p3Paths.push(sharedChecker); sealP3();
    assert((await run(false, { stopAfter: 'p3' })).ok, 'qualified shared test support was rejected');
    write(sharedTb, '// replaced scoreboard'); await expectBlocked('artifact changed');
    write(sharedTb, '// scoreboard');
    const contract = '06_doc/interface_contract.md';
    write(contract, 'payload requires memory read; first_sample comes from frame metadata');
    const scenarioPlan = JSON.parse(fs.readFileSync(path.join(root, plan), 'utf8'));
    sealP3(); await expectBlocked('interface contract');
    json(plan, { ...scenarioPlan, interfaceContractSha256: digest(contract) });
    p3Paths.push(contract); sealP3(); await expectBlocked('interface review');
    const reviewed = JSON.parse(fs.readFileSync(path.join(root, p3), 'utf8'));
    json(p3, { ...reviewed, openInterfaceIssues: ['payload handle has no read port'] });
    await expectBlocked('payload handle has no read port');
    json(p3, { ...reviewed, openInterfaceIssues: [] });
    assert((await run(false, { stopAfter: 'p3' })).ok, 'reviewed interface was rejected');
    const approval = { 'design-review': { confirmed: true, interfaceContractSha256: digest(contract) } };
    assert((await run(false, { stopAfter: 'p3', checkpoints: approval })).ok, 'accepted interface digest was rejected');
    const oldApproval = await run(false, { checkpoints: { 'design-review': { confirmed: true, interfaceContractSha256: 'obsolete' } } });
    assert(!oldApproval.ok && oldApproval.error.message.includes('design-review interface digest')
      && !oldApproval.calls.some(c => c.opts.label.startsWith('rtl-code-')), 're-sealed inputs bypassed an older design approval');
    write(contract, 'different ports'); await expectBlocked('interface_contract.md');
    fs.unlinkSync(path.join(root, contract)); p3Paths.pop();
    json(plan, scenarioPlan); sealP3();
    write(model, 'different implementation');
    await expectBlocked('artifact changed');
    write(model, fs.readFileSync(path.join(root, entry), 'utf8')); sealP2();
    await expectBlocked('model and independent reference are identical');
    write(model, model);
    sealP2();
    write(files[4], 'new vectors');
    await expectBlocked('artifact changed');
    write(files[4], 'fixture');
    const fault = probes.tb.fault, original = fs.readFileSync(path.join(root, fault), 'utf8');
    json(fault, { ...JSON.parse(original), compared_points: 0, mismatches: 0 });
    sealP3(); await expectBlocked('unproven P3 comparison', true);
    write(fault, original);
    const good = probes.checker.good, goodRun = JSON.parse(fs.readFileSync(path.join(root, good), 'utf8'));
    json(good, { ...goodRun, scenarios: { normal: 8 } }); sealP3(); await expectBlocked('unexercised planned scenario');
    json(good, goodRun); sealP3();
    json(measurement, { ...widths, selected_width: 8 }); sealP2(); await expectBlocked('out-of-budget');
    json(measurement, widths); sealP2();
    delete systemCases['16QAM']; sealP2(); await expectBlocked('unmeasured P2 baseline case');
    systemCases['16QAM'] = 'audit/16QAM.json'; sealP2();
    const over = JSON.parse(fs.readFileSync(path.join(root, fixed), 'utf8'));
    over.resources.DSP = { estimate: 2, limit: 10, acceptedRisk: files[0] };
    json(fixed, over); await expectBlocked('hard limit exceeded: DSP');
    fs.unlinkSync(path.join(root, fixed)); sealP3(false);
    assert((await run(true)).ok, 'explicit Lite should support independent Golden without P2');
    await expectBlocked('P2');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
