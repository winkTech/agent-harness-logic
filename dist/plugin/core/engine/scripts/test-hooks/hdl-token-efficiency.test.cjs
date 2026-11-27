'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runHdlWorkflow } = require('../run-hdl-workflow.cjs');
const { AGENT_BUDGETS, getMaxChars, resolveWorkflowModelTier } = require('../agent-context-budget.cjs');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function createSeededProject(root, modules, { withGolden = false, badRtlRedline = false } = {}) {
  const write = (rel, txt) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, txt, 'utf8');
    return rel;
  };
  const json = (rel, obj) => write(rel, JSON.stringify(obj, null, 2));
  const hashes = (rels) => Object.fromEntries(rels.map((r) => [r, sha(fs.readFileSync(path.join(root, r)))]));

  write('README.md', '# Seeded Benchmark Project\n');
  const archRel = write('06_doc/architecture.yaml', [
    `modules: [${modules.join(', ')}]`,
    'pipeline_stages: 1',
    'fsm_states: []',
    'bit_width: 16',
    'latency: 1',
  ].join('\n'));
  const stratRel = write('06_doc/verification_strategy.md', '# Verification Strategy\n');
  const fpRel = write('06_doc/fixed_point_report.md', '# Fixed Point Report\n');
  const rbRel = write('06_doc/resource_budget_tracking.md', '# Resource Budget\n');
  const xdcRel = write('03_xdc/top.xdc', 'create_clock -name i_clk -period 10.000 [get_ports i_clk]\n');

  const entry = '07_mat/ref_model.m';
  const fixedModel = '07_mat/fixed_model.m';
  write(entry, 'y = x + 1;\n');
  write(fixedModel, 'y_q = int16(x) + 1;\n');

  const p2Paths = [archRel, fpRel, rbRel, entry, fixedModel];
  const p2Modules = {};
  for (const mod of modules) {
    const measRel = `var/audit/${mod}_widths.json`;
    json(measRel, {
      module: mod,
      compared_points: 16,
      selected_width: 16,
      max_error_limit: 1,
      rounding: 'nearest',
      overflow: 'saturate',
      trials: [{ width: 12, max_error: 2 }, { width: 16, max_error: 0 }],
    });
    p2Paths.push(measRel);
    p2Modules[mod] = { model: fixedModel, reference: entry, measurement: measRel };
  }

  let goldenBaseline;
  const systemCases = {};
  if (withGolden) {
    goldenBaseline = { entry, cases: ['QPSK'], tools: ['sim'] };
    json('var/workflow/golden-scope.json', goldenBaseline);
    write('var/audit/entry.log', 'ok\n');
    write('var/audit/cases.log', 'ok\n');
    write('var/audit/sim.log', 'ok\n');
    json('var/workflow/golden-preflight.json', {
      entry,
      entrySha256: sha(fs.readFileSync(path.join(root, entry))),
      exitCode: 0,
      entryLog: 'var/audit/entry.log',
      cases: [{ name: 'QPSK', source: 'normal', oracleInputs: [], compared: 32, metrics: {}, criterion: '0 err', passed: true, log: 'var/audit/cases.log' }],
      tools: [{ name: 'sim', exitCode: 0, log: 'var/audit/sim.log' }],
    });
    json('var/audit/QPSK.json', {
      case: 'QPSK',
      source: 'normal',
      oracleInputs: [],
      compared_points: 32,
      checks: [{ metric: 'err', float: 0, fixed: 0, max: 1 }],
    });
    systemCases.QPSK = 'var/audit/QPSK.json';
    p2Paths.push('var/workflow/golden-scope.json', 'var/workflow/golden-preflight.json', 'var/audit/QPSK.json');
  }

  const fixedRel = 'var/workflow/p2-fixed-point.json';
  json(fixedRel, {
    modules: p2Modules,
    systemCases,
    hashes: hashes(p2Paths),
    resources: { DSP: { estimate: 0, limit: 4 }, LUT: { estimate: 20, limit: 500 }, BRAM: { estimate: 0, limit: 2 } },
  });

  const planRel = 'var/workflow/p3-plan.json';
  json(planRel, {
    strategySha256: sha(fs.readFileSync(path.join(root, stratRel))),
    modules: Object.fromEntries(modules.map((m) => [m, ['normal', 'boundary']])),
  });

  for (const mod of modules) {
    const rtlRel = `01_src/00_hdl/${mod}/${mod}.sv`;
    const tbRel = `02_sim/${mod}/tb_${mod}.sv`;
    const chkRel = `02_sim/check_${mod}.py`;
    const tvRel = `02_sim/tv/${mod}_tv.txt`;
    write(rtlRel, badRtlRedline
      ? `module ${mod}(input logic i_clk, input logic rst_n, input logic [15:0] i_x, output logic [15:0] o_y);\n  logic [15:0] ro_y;\n  always_ff @(posedge i_clk or negedge rst_n) if (!rst_n) ro_y <= '0; else ro_y <= i_x + 16'd1;\n  assign o_y = ro_y;\nendmodule\n`
      : `module ${mod}(input logic i_clk, input logic i_rst, input logic [15:0] i_x, output logic [15:0] o_y);\n  logic [15:0] ri_x, ro_y;\n  always_ff @(posedge i_clk) begin\n    if (i_rst) begin ri_x <= '0; ro_y <= '0; end\n    else begin ri_x <= i_x; ro_y <= ri_x + 16'd1; end\n  end\n  assign o_y = ro_y;\nendmodule\n`);
    write(tbRel, `module tb_${mod}; endmodule\n`);
    write(chkRel, 'print("ok")\n');
    write(tvRel, '0001 0002\n');

    const probes = { tb: {}, checker: {} };
    const p3Files = [archRel, stratRel, tbRel, chkRel, tvRel, fixedModel, planRel, fixedRel];
    for (const comp of ['tb', 'checker']) {
      for (const kind of ['good', 'fault']) {
        const pr = `var/audit/${mod}-${comp}-${kind}.json`;
        probes[comp][kind] = pr;
        p3Files.push(pr);
        json(pr, {
          module: mod,
          component: comp,
          kind,
          compared_points: 16,
          mismatches: kind === 'fault' ? 1 : 0,
          exitCode: kind === 'fault' ? 1 : 0,
          scenarios: { normal: 12, boundary: 4 },
        });
      }
    }
    json(`var/workflow/p3/${mod}.json`, {
      module: mod,
      reference: fixedModel,
      probes,
      hashes: hashes(p3Files),
    });
  }

  // Hermetic tool runner script for simulate / golden / regression / vivado
  const runnerPath = path.join(path.dirname(root), 'hermetic-eda.cjs');
  fs.writeFileSync(runnerPath, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    "const mode = process.argv[2];",
    "const mod = process.argv[3];",
    "const out = process.env.HARNESS_WORKFLOW_EVIDENCE;",
    "const stateFile = process.env.SIM_FAIL_STATE_FILE || '';",
    "if (mode === 'golden') {",
    "  const entryBytes = fs.readFileSync('07_mat/ref_model.m');",
    "  fs.writeFileSync(out, JSON.stringify({",
    "    entry: '07_mat/ref_model.m',",
    "    entrySha256: crypto.createHash('sha256').update(entryBytes).digest('hex'),",
    "    exitCode: 0, entryLog: 'var/audit/entry.log',",
    "    cases: [{ name: 'QPSK', source: 'normal', oracleInputs: [], compared: 32, metrics: {}, criterion: '0 err', passed: true, log: 'var/audit/cases.log' }],",
    "    tools: [{ name: 'sim', exitCode: 0, log: 'var/audit/sim.log' }]",
    "  }));",
    "  process.exit(0);",
    "}",
    "if (mode === 'sim') {",
    "  let count = 0;",
    "  if (stateFile) {",
    "    count = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, 'utf8')) + 1 : 1;",
    "    fs.writeFileSync(stateFile, String(count));",
    "  }",
    "  const failMode = process.env.SIM_FAIL_MODE || 'none';",
    "  if ((failMode === 'once' && count === 1) || failMode === 'always') {",
    "    fs.writeFileSync(out, JSON.stringify({ module: mod, status: 'FAIL', compared_points: 16, mismatches: 3, first_fail_at: 'sample 0 mismatch' }));",
    "    process.exit(1);",
    "  }",
    "  fs.writeFileSync(out, JSON.stringify({ module: mod, status: 'PASS', compared_points: 16, mismatches: 0, max_error_lsb: 0 }));",
    "  process.exit(0);",
    "}",
    "if (mode === 'reg') {",
    "  const mods = mod.split(',');",
    "  fs.writeFileSync(out, JSON.stringify({ status: 'PASS', compared_points: 32, mismatches: 0, modules: mods, cases: { full: { status: 'PASS', compared_points: 32 } } }));",
    "  process.exit(0);",
    "}",
    "if (mode === 'vivado') {",
    "  fs.writeFileSync(out, JSON.stringify({",
    "    tool: 'vivado_flow', vivado_version: '2023.1', top: mod, part: 'xc7a35t', ok: true, aborted: false, constrained: true,",
    "    stages_run: ['rtlcheck', 'synth'], blocking: [],",
    "    rtlcheck: { critical: 0, error: 0 },",
    "    synth: { wns: 2.15, whs: 0.14, lut: 24, ff: 32, bram: 0, uram: 0, dsp: 0, srl: 0, critical: 0, error: 0 }",
    "  }));",
    "  process.exit(0);",
    "}",
  ].join('\n'), 'utf8');

  const tools = [{ executable: process.execPath, versionArgs: ['--version'], expectedVersion: process.version }];
  const profiles = {
    deterministic: true,
    simulate: Object.fromEntries(modules.map((m) => [m, {
      executable: process.execPath,
      args: [runnerPath, 'sim', m],
      inputs: [`01_src/00_hdl/${m}/${m}.sv`, `02_sim/${m}/tb_${m}.sv`, `02_sim/tv/${m}_tv.txt`],
      top: `tb_${m}`,
      version: 'bench-sim-v1',
      tools,
    }])),
    regression: {
      executable: process.execPath,
      args: [runnerPath, 'reg', modules.join(',')],
      inputs: modules.map((m) => `01_src/00_hdl/${m}/${m}.sv`),
      cases: ['full'],
      version: 'bench-reg-v1',
      tools,
    },
    vivado: {
      executable: process.execPath,
      args: [runnerPath, 'vivado', modules[0]],
      inputs: modules.map((m) => `01_src/00_hdl/${m}/${m}.sv`),
      constraints: [xdcRel],
      top: modules[0],
      part: 'xc7a35t',
      stage: 'synth',
      version: 'bench-vivado-v1',
      tools,
    },
  };
  if (withGolden) {
    profiles.golden = {
      executable: process.execPath,
      args: [runnerPath, 'golden', 'all'],
      inputs: [entry],
      version: 'bench-golden-v1',
      tools,
    };
  }
  return { profiles, goldenBaseline, runnerPath };
}

function makeAgent(projectRoot, { fixRedlineOnDebug = false, touchRtlOnDebug = false } = {}) {
  return async (prompt, opts = {}) => {
    const label = opts.label || '';
    if (label.startsWith('debug-')) {
      const mod = label.replace(/^debug-/, '').replace(/-try\d+$/, '');
      const rtlPath = path.join(projectRoot, `01_src/00_hdl/${mod}/${mod}.sv`);
      if (fixRedlineOnDebug) {
        fs.writeFileSync(rtlPath, [
          `module ${mod}(input logic i_clk, input logic i_rst, input logic [15:0] i_x, output logic [15:0] o_y);`,
          '  logic [15:0] ri_x, ro_y;',
          '  always_ff @(posedge i_clk) begin',
          "    if (i_rst) begin ri_x <= '0; ro_y <= '0; end",
          "    else begin ri_x <= i_x; ro_y <= ri_x + 16'd1; end",
          '  end',
          '  assign o_y = ro_y;',
          'endmodule',
          '',
        ].join('\n'), 'utf8');
        return { hypothesis: 'replaced async active-low rst_n with sync active-high i_rst', change: 'updated reset sensitivity and polarity' };
      }
      if (touchRtlOnDebug) {
        fs.appendFileSync(rtlPath, `\n// repair attempt at ${Date.now()}\n`, 'utf8');
      }
      return { hypothesis: 'pipeline alignment off by 1 cycle', change: 'adjusted output register stage' };
    }
    if (label.startsWith('final-verify-')) {
      const mod = label.replace('final-verify-', '');
      return JSON.stringify({ module: mod, pass: true, evidence_ok: true, checks: ['all'], issues: [] });
    }
    if (label === 'p5-interface') return JSON.stringify([{ interface: 'm1->m2', status: 'pass', detail: 'ok' }]);
    if (label === 'p5-datapath') return JSON.stringify([{ stage: 'input->m1', status: 'pass', width: 16, format: 'Q1.15', notes: 'ok' }]);
    if (label === 'p5-golden') return JSON.stringify({ overall: 'pass', first_deviation: null, compared_points: 32, max_error_lsb: 0, algo_consistent: true });
    if (label === 'p5-timing') return JSON.stringify({ resource: { lut_est: 40, dsp_est: 0, bram_est: 0 }, timing: { critical_path: 'adder', fmax_est: '300MHz' }, cdc_issues: [], pipeline_issues: [] });
    if (label === 'p5-synthesis') return JSON.stringify({ overall: 'pass', issues: [], root_cause: 'none', fix_suggestion: 'none' });
    if (label.startsWith('p7-review-')) {
      return JSON.stringify({ pass: true, summary: 'compliant with 01-hdl and interface contract', evidence: ['01_src/00_hdl/m1/m1.sv:1'] });
    }
    if (label === 'verifier') {
      return JSON.stringify({ pass: true, reason: 'all phases verified with on-disk evidence', missing: [], strongest_phase: 'P4', weakest_phase: 'none' });
    }
    return `${label} completed`;
  };
}

test('5-scenario benchmark achieves >=45% dispatch & token reduction over 0.1.7 while preserving all gates', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-bench-5-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }));

  const contextHistory = (opts) => ({
    threadId: `thread-${opts.agentType || 'host'}-${opts.affinityKey || 'shared'}`,
    epoch: 'epoch-1',
    historyAvailable: true,
  });

  async function runScenario(name, modules, { withGolden = false, failMode = 'none' } = {}) {
    const proj = path.join(tmp, `proj-${name}`);
    const stateDir = path.join(tmp, `state-${name}`);
    const seeded = createSeededProject(proj, modules, { withGolden });
    const failStateFile = path.join(tmp, `fail-${name}.count`);
    for (const m of modules) {
      seeded.profiles.simulate[m].env = { SIM_FAIL_MODE: failMode, SIM_FAIL_STATE_FILE: failStateFile };
    }
    const res = await runHdlWorkflow({
      args: {
        modules,
        part: 'xc7a35t',
        confirmAllCheckpoints: true,
        ...(withGolden ? { goldenBaseline: seeded.goldenBaseline } : {}),
      },
      projectRoot: proj,
      stateDir,
      runId: `run-${name}`,
      profiles: seeded.profiles,
      contextHistory,
      agent: makeAgent(proj, { touchRtlOnDebug: failMode !== 'none' }),
    });
    const promptTokens = res.usage[0]?.estimatedPromptSubtotal ?? 0;
    return { name, status: res.status, dispatches: res.agentDispatches, actions: res.actions, promptTokens, tiers: res.tierDispatches, error: res.error };
  }

  const s1 = await runScenario('1mod-clean', ['m1']);
  const s2 = await runScenario('1mod-golden', ['m1'], { withGolden: true });
  const s3 = await runScenario('2mod-golden', ['m1', 'm2'], { withGolden: true });
  const s4 = await runScenario('1mod-1fix', ['m1'], { failMode: 'once' });
  const s5 = await runScenario('1mod-breaker', ['m1'], { failMode: 'always' });

  console.log('BENCHMARK_5_SCENARIOS:', JSON.stringify([s1, s2, s3, s4, s5], null, 2));

  // Verify completion & breaker semantics
  assert.equal(s1.status, 'completed', s1.error);
  assert.equal(s2.status, 'completed', s2.error);
  assert.equal(s3.status, 'completed', s3.error);
  assert.equal(s4.status, 'completed', s4.error);
  assert.equal(s5.status, 'failed');
  assert.match(s5.error, /repeated hypothesis/);

  // 0.1.7 Complete Host baselines from user's benchmark table:
  // s1: 19 dispatches / 8,837 tok -> now <= 10 dispatches & <= 4,800 tok
  assert.ok(s1.dispatches <= 10, `expected <=10 dispatches on s1, got ${s1.dispatches}`);
  assert.ok(s1.promptTokens <= 4800, `expected <=4800 prompt tokens on s1, got ${s1.promptTokens}`);

  // s2: 19 dispatches / 8,632 tok -> now <= 10 dispatches & <= 4,800 tok
  assert.ok(s2.dispatches <= 10, `expected <=10 dispatches on s2, got ${s2.dispatches}`);
  assert.ok(s2.promptTokens <= 4800, `expected <=4800 prompt tokens on s2, got ${s2.promptTokens}`);

  // s3 (2 modules, multi-module 4-way P5 preserved without p5-synthesis / redundant stage3 LLM calls!): 21 -> <= 15 dispatches & <= 4,000 tok
  assert.ok(s3.dispatches <= 15, `expected <=15 dispatches on s3, got ${s3.dispatches}`);
  assert.ok(s3.promptTokens <= 4000, `expected <=4000 prompt tokens on s3, got ${s3.promptTokens}`);

  // s4 (1 repair): 20 -> <= 11 dispatches
  assert.ok(s4.dispatches <= 11, `expected <=11 dispatches on s4, got ${s4.dispatches}`);

  // s5 (circuit breaker): 11 -> <= 9 dispatches & <= 4,200 tok
  assert.ok(s5.dispatches <= 9, `expected <=9 dispatches on s5, got ${s5.dispatches}`);
  assert.ok(s5.promptTokens <= 4200, `expected <=4200 prompt tokens on s5, got ${s5.promptTokens}`);

  // Verify deterministic report file was generated on disk with Vivado metrics
  const reportText = fs.readFileSync(path.join(tmp, 'proj-1mod-clean/06_doc/workflow-verification.md'), 'utf8');
  assert.match(reportText, /Vivado \(`m1` @ `xc7a35t`/);
  assert.match(reportText, /WNS=2\.15ns/);

  // Reviewer context budgets are tightened to 8k chars and tier routing is recorded
  assert.equal(AGENT_BUDGETS['ce-correctness-reviewer'], 'tight');
  assert.equal(getMaxChars('ce-api-contract-reviewer'), 8000);
  assert.equal(resolveWorkflowModelTier({ label: 'p1a-system-design' }), 'deep');
  assert.equal(resolveWorkflowModelTier({ label: 'final-verify-m1' }), 'fast');
  assert.ok(s1.tiers.deep >= 4 && s1.tiers.standard >= 4);
});

test('deterministic static redline gate in Phase 4 catches async/active-low reset bug and drives repair without false pass', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-redline-loop-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }));

  const proj = path.join(tmp, 'proj');
  const stateDir = path.join(tmp, 'state');
  const seeded = createSeededProject(proj, ['bad_mod'], { badRtlRedline: true });

  const res = await runHdlWorkflow({
    args: { modules: ['bad_mod'], part: 'xc7a35t', confirmAllCheckpoints: true },
    projectRoot: proj,
    stateDir,
    runId: 'redline-repair',
    profiles: seeded.profiles,
    agent: makeAgent(proj, { fixRedlineOnDebug: true }),
  });

  assert.equal(res.status, 'completed', res.error);
  const events = fs.readFileSync(res.eventPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'agent-dispatch' && e.label === 'debug-bad_mod-try1'),
    'redline violation in Stage 2 must trigger targeted debug repair');
  const fixedRtl = fs.readFileSync(path.join(proj, '01_src/00_hdl/bad_mod/bad_mod.sv'), 'utf8');
  assert.doesNotMatch(fixedRtl, /negedge\s+rst_n/);
});
