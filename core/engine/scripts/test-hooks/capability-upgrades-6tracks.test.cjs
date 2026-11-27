#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');
const markers = require('../lib/verification-markers.cjs');
const ruleLoader = require('../rule-loader.cjs');
const dream = require('../dream-consolidate.cjs');
const prune = require('../harness-telemetry-prune.cjs');
const { openDb } = require('../../sqlite/index.cjs');
const events = require('../../sqlite/store-events.cjs');
const { recordTranscriptUsage } = require('../../sqlite/store-costs.cjs');
const autogen = require('../hdl-host-autogen.cjs');
const { runHdlWorkflow } = require('../run-hdl-workflow.cjs');
const redlineScanner = require(path.join(ROOT, 'packs/fpga/engine/hdl-redline-scanner.cjs'));
const rtlOracle = require('../hooks/rtl-semantic-oracle.cjs');
const { checkRedlines } = require('../hdl-evidence-gate.cjs');
const blindSeal = require('../blind-audit-seal.cjs');
const { validateWorkflowFile } = require('../lib/workflow-runtime.cjs');
const handoff = require('../handoff-protocol.cjs');
const unlock = require(path.join(ROOT, 'scripts/harness-unlock.cjs'));
const releasePin = require(path.join(ROOT, 'scripts/release-pin.cjs'));
const { reinstallVersion } = require(path.join(ROOT, 'hosts/codex/connect.cjs'));

test('Track 1: promoted rules match PreToolUse commands and file scopes, and VerificationGate accepts 0-failed suite summaries', () => {
  process.env.HARNESS_NO_PERSIST = '1';
  ruleLoader.invalidateRuleIndex();

  const cases = [
    [
      '90-promoted-hrc-0c527de6e9d797c7.md',
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node -e "const r=/foo\\/bar/; console.log(\\"x\\")"' } },
    ],
    [
      '90-promoted-hrc-17b80b214f7f4adb.md',
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git merge feature-branch into main' } },
    ],
    [
      '90-promoted-hrc-41608e7abd96afe9.md',
      { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'packs/fpga/engineering-assets/cbb/ldpc_codec/manifest.json' } },
    ],
    [
      '90-promoted-hrc-6a608b81ee27dd0b.md',
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node core/engine/scripts/test-hooks/run-all-tests.cjs' } },
    ],
    [
      '90-promoted-hrc-7b078b0123fa8e6f.md',
      { hook_event_name: 'UserPromptSubmit', prompt: 'test calling telemetry-spool.appendToSpool directly' },
    ],
    [
      '90-promoted-hrc-bf58b1ff89362118.md',
      { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'README.md' } },
    ],
  ];

  for (const [expectedRule, payload] of cases) {
    const out = ruleLoader.retrieveContext(payload, {
      loadInjected: () => new Set(),
      saveInjected: () => {},
    });
    assert.ok(out, `expected rule capsule for ${expectedRule}`);
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(expectedRule.replace(/\./g, '\\.')));
  }

  // VerificationGate marker check on suite output with "failure" / "fails" in passing test titles
  const suiteOut = [
    'Workflow contract regression tests',
    '  memory health fails closed on toolchain_failure and fatal worker probe PASS',
    '  postflight observer records failure attribution PASS',
    'Summary: 33/33 passed, 0 failed',
  ].join('\n');
  assert.equal(markers.failureMarker(suiteOut), null);
  assert.equal(markers.markerVerdict(suiteOut).status, 'passed');

  const failingSuiteOut = suiteOut.replace('33/33 passed, 0 failed', '32/33 passed, 1 failed');
  assert.equal(markers.markerVerdict(failingSuiteOut).status, 'failed');
});

test('Track 1: Dream skips unanalyzed tool_fail/transition telemetry counters while telemetry-prune parses epoch-ms and retires noise', (t) => {
  const handle = openDb({ path: ':memory:' });
  t.after(() => handle.close());
  const db = handle.db;

  for (let i = 0; i < 6; i += 1) {
    events.record({ sessionId: 's-noise', type: 'tool_fail', payload: { tool: 'Bash', error: `exit ${i}` } }, null, { db });
  }
  events.record({ sessionId: 's-noise', type: 'user_correct', payload: { message: 'Always verify functional behavior' } }, null, { db });

  const res = dream.runDream({ db, maxEvents: 20, logger: () => {} });
  assert.ok(res.patterns >= 2);
  const activeFacts = db.prepare("SELECT name, content FROM facts WHERE source = 'script:dream' AND status = 'active'").all();
  assert.equal(activeFacts.length, 1);
  assert.match(activeFacts[0].name, /user-correct/);

  // Seed legacy epoch-ms noise row and verify telemetry-prune ageDays + retireDreamNoiseFacts
  const hundredDaysAgoMs = Date.now() - 100 * 86_400_000;
  db.prepare(`
    INSERT INTO facts (id, namespace, name, content, source, confidence, status, hit_count, created_at, updated_at)
    VALUES ('legacy-noise-1', 'learnings', 'dream-2026-08-01-tool-fail-Bash--6', 'noise', 'script:dream', 0.3, 'active', 0, ?, ?)
  `).run(hundredDaysAgoMs, hundredDaysAgoMs);

  const reportBefore = prune.analyzeTelemetry(db, { days: 90 });
  const found = reportBefore.facts.pruneCandidates.find((c) => c.id === 'legacy-noise-1');
  assert.ok(found && found.ageDays >= 99, `expected numeric ageDays >= 99, got ${JSON.stringify(found)}`);

  const retired = prune.retireDreamNoiseFacts(db, { dryRun: false });
  assert.equal(retired.retired, 1);
  assert.equal(db.prepare("SELECT status FROM facts WHERE id = 'legacy-noise-1'").get().status, 'tombstone');
});

test('Track 2: hdl-host-autogen discovers project layout and binds working simulation into runHdlWorkflow --auto-host', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autogen-hdl-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const proj = path.join(tmp, 'proj');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(proj, '06_doc'), { recursive: true });
  fs.mkdirSync(path.join(proj, '01_src/00_hdl/adder'), { recursive: true });
  fs.mkdirSync(path.join(proj, '02_sim/adder'), { recursive: true });
  fs.mkdirSync(path.join(proj, '03_xdc'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# Adder\n');
  fs.writeFileSync(path.join(proj, '06_doc/architecture.yaml'), 'modules: [adder]\npipeline_stages: 1\nfsm_states: []\nbit_width: 8\nlatency: 1\n');
  fs.writeFileSync(path.join(proj, '06_doc/verification_strategy.md'), '# Strategy\n');
  fs.writeFileSync(path.join(proj, '01_src/00_hdl/adder/adder.sv'), [
    'module adder(input logic i_clk, input logic i_rst, input logic [7:0] i_a, output logic [7:0] o_y);',
    '  always_ff @(posedge i_clk) if (i_rst) o_y <= 8\'d0; else o_y <= i_a + 8\'d1;',
    'endmodule',
  ].join('\n'));
  fs.writeFileSync(path.join(proj, '02_sim/adder/tb_adder.sv'), 'module tb_adder; initial begin $display("compared_points=8 0 mismatches RESULT: PASS"); $finish; end endmodule\n');
  fs.writeFileSync(path.join(proj, '02_sim/check_adder.py'), 'print("ok")\n');
  fs.mkdirSync(path.join(proj, '02_sim/tv'), { recursive: true });
  fs.writeFileSync(path.join(proj, '02_sim/tv/adder_tv.txt'), '01 02\n');
  fs.writeFileSync(path.join(proj, '03_xdc/clocks.xdc'), 'create_clock -period 5.0 [get_ports i_clk]\n');

  // Hermetic mock iverilog + vvp scripts so CI without EDA binaries still exercises --exec-sim
  const fakeBin = path.join(tmp, 'fake-eda.cjs');
  fs.writeFileSync(fakeBin, [
    "const fs = require('node:fs');",
    "if (process.argv.includes('-V')) { console.log('Icarus Verilog version 12.0'); process.exit(0); }",
    "const outIdx = process.argv.indexOf('-o');",
    "if (outIdx >= 0) { fs.writeFileSync(process.argv[outIdx + 1], 'compiled'); process.exit(0); }",
    "console.log('8 vectors checked, 0 mismatches, RESULT: PASS');",
  ].join('\n'));

  const built = autogen.buildAutoHostConfig({
    projectRoot: proj,
    part: 'xc7a35t',
    toolchain: {
      iverilog: { executable: process.execPath, vvp: process.execPath, version: '12.0' },
      vivado: null,
    },
  });
  // Patch fakeBin into args after node executable for hermetic execution
  built.profiles.simulate.adder.tools = [{ executable: process.execPath, versionArgs: [fakeBin, '-V'], expectedVersion: 'Icarus Verilog' }];
  built.profiles.simulate.adder.iverilogFake = true;

  assert.deepEqual(built.summary.modules, ['adder']);
  assert.deepEqual(built.summary.boundSimulateModules, ['adder']);
  assert.ok(built.agentReceipts['rtl-code-adder']);

  const run = await runHdlWorkflow({
    args: { modules: ['adder'] },
    projectRoot: proj,
    stateDir,
    runId: 'autogen-smoke',
    autoHost: true,
    agent: () => assert.fail('preflight stops before agent'),
  });
  assert.equal(run.status, 'checkpoint');
  assert.equal(run.checkpoint, 'preflight');
  const journal = fs.readFileSync(run.eventPath, 'utf8');
  assert.match(journal, /"type":"auto-host"/);
});

test('Track 3: maintainer lease enforces TTL/integrity, Codex refresh survives EBUSY, and release-pin builds pipeline', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'track3-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const leasePath = path.join(tmp, '.logical-paradox', 'maintainer-unlock.json');
  const issued = unlock.issueLease({ leasePath, workspace: ROOT, ttl: '15m', reason: 'unit test unlock', now: 1_000_000 });
  assert.equal(issued.active, true);
  assert.equal(unlock.inspectLease({ leasePath, now: 1_000_000 + 60_000 }).active, true);
  assert.equal(unlock.inspectLease({ leasePath, now: 1_000_000 + 20 * 60_000 }).reason, 'expired');

  // Tamper check
  const raw = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  raw.expiresAt = new Date(1_000_000 + 90 * 60_000).toISOString();
  fs.writeFileSync(leasePath, JSON.stringify(raw));
  assert.equal(unlock.inspectLease({ leasePath, now: 1_000_000 + 60_000 }).reason, 'integrity-mismatch');
  unlock.revokeLease({ leasePath });
  assert.equal(unlock.inspectLease({ leasePath }).reason, 'missing');

  // Codex EBUSY in-place fallback
  const codexHome = path.join(tmp, 'codex');
  const cache = path.join(codexHome, 'plugins/cache/agent-harness-logic/logical-paradox/0.1.7');
  const pkg = path.join(tmp, 'pkg');
  for (const dir of [cache, pkg]) {
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'logical-paradox', version: '0.1.7' }));
  }
  fs.writeFileSync(path.join(cache, 'old.txt'), 'stale');
  fs.writeFileSync(path.join(pkg, 'new.txt'), 'fresh-0.1.7');

  const origRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from) === path.resolve(cache)) {
      throw Object.assign(new Error('EBUSY: directory locked'), { code: 'EBUSY' });
    }
    return origRename(from, to);
  });
  reinstallVersion({ cache, codexHome, version: '0.1.7', pkg, install: () => assert.fail('install should be skipped on EBUSY fallback') });
  assert.equal(fs.readFileSync(path.join(cache, 'new.txt'), 'utf8'), 'fresh-0.1.7');
  assert.equal(fs.existsSync(path.join(cache, 'old.txt')), false);

  // release-pin dry-run
  const dry = releasePin.runPipeline({ dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.steps.length, 12);
});

test('Track 4: blind-audit-seal detects post-seal expectation tampering and blind-audit-workflow satisfies strict contract', (t) => {
  const wfCheck = validateWorkflowFile(path.join(ROOT, 'core/workflows/blind-audit-workflow.js'));
  assert.equal(wfCheck.errors.length, 0, wfCheck.errors.join('; '));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-seal-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const expFile = path.join(tmp, '01-blind-expectations.md');
  const sealFile = path.join(tmp, 'seal.json');
  const probesFile = path.join(tmp, 'probes.json');
  fs.writeFileSync(expFile, '# Blind Expectations\n- Q1 bad input rejected\n- Q2 stale rejected\n- Q3 recovery\n- Q4 good accepted\n');
  const sealed = blindSeal.sealExpectations({ expectationPath: expFile, sealOutPath: sealFile, projectRoot: ROOT });
  assert.match(sealed.expectationSha256, /^[a-f0-9]{64}$/);

  fs.writeFileSync(probesFile, JSON.stringify({
    quadrants: {
      bad_input_rejected: { executed: true, pass: true },
      stale_artifact_rejected: { executed: true, pass: true },
      interrupted_job_recovered: { executed: true, pass: true },
      valid_input_accepted: { executed: true, pass: true },
    },
  }));
  assert.equal(blindSeal.verifyAuditSeal({ sealPath: sealFile, probesPath: probesFile }).ok, true);

  fs.appendFileSync(expFile, '\nEdited after seeing test results!\n');
  const tampered = blindSeal.verifyAuditSeal({ sealPath: sealFile, probesPath: probesFile });
  assert.equal(tampered.ok, false);
  assert.match(tampered.failures.join('; '), /modified after blind seal/);
});

test('Track 5: FPGA redline scanner catches NBA LHS function subscript, gated clock, and async reset without $clog2 false positives', (t) => {
  const badRtl = [
    'module bad_lut(input logic i_clk, input logic i_en, input logic rst_n, input logic [7:0] i_din, output logic [7:0] ro_dout);',
    '  logic [7:0] r_mem [0:15];',
    '  logic [3:0] r_cnt;',
    '  function automatic [3:0] f_addr(input logic [3:0] x); return x + 4\'d1; endfunction',
    '  always_ff @(posedge (i_clk & i_en) or negedge rst_n) begin',
    '    if (!rst_n) ro_dout <= 8\'d0;',
    '    else begin',
    '      r_cnt <= r_cnt + 4\'d1;',
    '      r_mem[f_addr(r_cnt)] <= i_din;',
    '      ro_dout <= r_mem[0];',
    '    end',
    '  end',
    'endmodule',
  ].join('\n');

  const badReport = redlineScanner.scanContent(badRtl, '01_src/00_hdl/bad_lut/bad_lut.sv');
  assert.equal(badReport.ok, false);
  const rules = badReport.findings.map((f) => f.rule);
  assert.ok(rules.includes('nba-lhs-function-index'), `missing nba-lhs-function-index in ${rules}`);
  assert.ok(rules.includes('gated-clock-expression'), `missing gated-clock-expression in ${rules}`);
  assert.ok(rules.includes('async-or-active-low-reset'), `missing async-or-active-low-reset in ${rules}`);

  // PreToolUse rtl-semantic-oracle blocks NBA LHS function index immediately
  const oracleVerdict = rtlOracle.evaluate({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd: ROOT,
    tool_input: { file_path: '01_src/00_hdl/bad_lut/bad_lut.sv', content: badRtl },
  });
  assert.equal(oracleVerdict.decision, 'block');

  // Compliant RTL with wire-indexed memory and $clog2 slice passes with zero errors
  const goodRtl = [
    'module good_lut #(parameter int DEPTH = 16) (input logic i_clk, input logic i_rst, input logic [7:0] i_din, output logic [7:0] ro_dout);',
    '  logic [7:0] r_mem [0:DEPTH-1];',
    '  logic [$clog2(DEPTH)-1:0] r_cnt, w_waddr;',
    '  assign w_waddr = r_cnt + 1\'b1;',
    '  always_ff @(posedge i_clk) begin',
    '    if (i_rst) begin r_cnt <= \'0; ro_dout <= \'0; end',
    '    else begin',
    '      r_cnt[$clog2(DEPTH)-1:0] <= w_waddr;',
    '      r_mem[w_waddr] <= i_din;',
    '      ro_dout <= r_mem[r_cnt];',
    '    end',
    '  end',
    'endmodule',
  ].join('\n');
  assert.equal(redlineScanner.scanContent(goodRtl, '01_src/00_hdl/good_lut/good_lut.sv').ok, true);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-redlines-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, '01_src/00_hdl/good_lut'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '01_src/00_hdl/good_lut/good_lut.sv'), goodRtl);
  assert.equal(checkRedlines(tmp, ['good_lut']).ok, true);
});

test('Track 6: store-costs parses Codex cumulative & OpenAI response transcripts, and handoff-protocol round-trips cross-host state', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'track6-'));
  const handle = openDb({ path: path.join(tmp, 'costs.db') });
  t.after(() => {
    try { handle.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const codexLog = path.join(tmp, 'codex-rollout.jsonl');
  fs.writeFileSync(codexLog, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', model: 'gpt-5-codex', info: { total_token_usage: { input_tokens: 10000, cached_input_tokens: 4000, output_tokens: 800 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', model: 'gpt-5-codex', info: { total_token_usage: { input_tokens: 18000, cached_input_tokens: 10000, output_tokens: 1500 } } } }),
  ].join('\n') + '\n');

  const r = recordTranscriptUsage({ sessionId: 'codex-s1', transcriptPath: codexLog }, { db: handle.db });
  assert.equal(r.recorded, 1);
  const row = handle.db.prepare("SELECT tokens_in, tokens_out, cache_read_tokens FROM cost_ledger WHERE session_id = 'codex-s1' AND phase = 'usage'").get();
  // Latest cumulative snapshot: 18000 total input - 10000 cached = 8000 uncached, 10000 cache_read, 1500 out
  assert.deepEqual({ ...row }, { tokens_in: 8000, tokens_out: 1500, cache_read_tokens: 10000 });

  const projDir = path.join(tmp, 'fpga-proj');
  const hDir = path.join(tmp, 'handoff-store');
  fs.mkdirSync(projDir, { recursive: true });
  handoff.writeHandoff({
    projectRoot: projDir,
    fromHost: 'codex',
    sessionId: 'codex-s1',
    runId: 'wifi-01',
    signoffId: 'wifi-accept-01',
    checkpoint: 'evidence-review',
    summary: 'P4 RTL verified on 35 modules',
    nextSteps: ['Confirm evidence-review', 'Run P6b Vivado synth'],
  }, { handoffDir: hDir });

  const restored = handoff.readHandoffForCwd(projDir, { handoffDir: hDir });
  assert.equal(restored.fromHost, 'codex');
  assert.equal(restored.workflow.runId, 'wifi-01');
  assert.match(handoff.formatHandoffCapsule(restored), /\[cross-host:codex\].*wifi-01.*cp=evidence-review/);
});
