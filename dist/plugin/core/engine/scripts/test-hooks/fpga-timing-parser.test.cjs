'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');
const { parseTimingReport, buildTimingEvidence } = require(path.join(ROOT, 'packs/fpga/engine/fpga-timing-parser.cjs'));
const { runGates } = require(path.join(ROOT, 'packs/fpga/engineering-assets/tools/gate-runner.cjs'));

test('global Design Timing Summary setup violation fails even when first intra-clock row passes', () => {
  const rpt = [
    '| Design Timing Summary',
    '| ---------------------',
    '    WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints     WPWS(ns)     TPWS(ns)  TPWS Failing Endpoints  TPWS Total Endpoints',
    '    -------      -------  ---------------------  -------------------      -------      -------  ---------------------  -------------------     --------     --------  ----------------------  --------------------',
    '     -1.240      -18.600                     15                  120        0.110        0.000                      0                  120        2.500        0.000                       0                    60',
    'Timing constraints are not met.',
    '| Clock Summary',
    'Clock     Waveform(ns)    Period(ns)   Frequency(MHz)',
    'clk_fast  {0.000 2.000}   4.000        250.000',
    'clk_slow  {0.000 5.000}   10.000       100.000',
    '| Intra Clock Table',
    'Clock             WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints     WPWS(ns)     TPWS(ns)  TPWS Failing Endpoints  TPWS Total Endpoints',
    '-----             -------      -------  ---------------------  -------------------      -------      -------  ---------------------  -------------------     --------     --------  ----------------------  --------------------',
    'clk_fast            0.420        0.000                      0                   60        0.110        0.000                      0                   60        2.500        0.000                       0                    30',
    'clk_slow           -1.240      -18.600                     15                   60        0.135        0.000                      0                   60        4.500        0.000                       0                    30',
  ].join('\n');

  const ev = buildTimingEvidence(rpt, 'setup-fail.rpt');
  assert.equal(ev.status, 'failed');
  assert.equal(ev.failure?.code, 'negative_setup_slack');
  assert.equal(ev.timing.setup.wns, -1.24);
  assert.equal(ev.timing.setup.tns, -18.6);
  assert.equal(ev.timing.setup.failingEndpoints, 15);
  assert.equal(ev.timing.setup.met, false);
  assert.equal(ev.timing.clockSummary.length, 2);
});

test('global Design Timing Summary or Inter-Clock hold violation fails even when all intra-clock rows pass', () => {
  const rpt = [
    '| Design Timing Summary',
    '| ---------------------',
    '    WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints     WPWS(ns)     TPWS(ns)  TPWS Failing Endpoints  TPWS Total Endpoints',
    '    -------      -------  ---------------------  -------------------      -------      -------  ---------------------  -------------------     --------     --------  ----------------------  --------------------',
    '      1.850        0.000                      0                   80       -0.315       -4.200                     12                   80        3.000        0.000                       0                    40',
    'Timing constraints are not met.',
    '| Intra Clock Table',
    'Clock             WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints     WPWS(ns)     TPWS(ns)  TPWS Failing Endpoints  TPWS Total Endpoints',
    'clk_src             1.850        0.000                      0                   40        0.120        0.000                      0                   40        3.000        0.000                       0                    20',
    'clk_dst             2.400        0.000                      0                   30        0.145        0.000                      0                   30        3.000        0.000                       0                    20',
    '| Inter Clock Table',
    'From Clock    To Clock          WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints',
    'clk_src       clk_dst             2.100        0.000                      0                   10       -0.315       -4.200                     12                   10',
  ].join('\n');

  const ev = buildTimingEvidence(rpt, 'hold-fail.rpt');
  assert.equal(ev.status, 'failed');
  assert.equal(ev.failure?.code, 'negative_hold_slack');
  assert.equal(ev.timing.hold.whs, -0.315);
  assert.equal(ev.timing.hold.ths, -4.2);
  assert.equal(ev.timing.hold.failingEndpoints, 12);
  assert.equal(ev.timing.hold.met, false);
  assert.equal(ev.timing.interClockSummary?.length, 1);
});

test('pulse-width violations, NA columns, and truncated multi-clock snippets are handled fail-closed', () => {
  // 1. Pulse width violation with green setup & hold
  const pwFail = [
    '| Design Timing Summary',
    '    WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints     WPWS(ns)     TPWS(ns)  TPWS Failing Endpoints  TPWS Total Endpoints',
    '    -------      -------  ---------------------  -------------------      -------      -------  ---------------------  -------------------     --------     --------  ----------------------  --------------------',
    '      0.550        0.000                      0                   32        0.090        0.000                      0                   32       -0.220       -1.760                       8                    16',
  ].join('\n');
  const evPw = buildTimingEvidence(pwFail, 'pw-fail.rpt');
  assert.equal(evPw.status, 'failed');
  assert.equal(evPw.failure?.code, 'negative_pulse_width_slack');

  // 2. -delay_type max report where WHS/THS are NA passes when setup & PW are met
  const maxOnlyMet = [
    '| Design Timing Summary',
    '    WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints     WPWS(ns)     TPWS(ns)  TPWS Failing Endpoints  TPWS Total Endpoints',
    '    -------      -------  ---------------------  -------------------      -------      -------  ---------------------  -------------------     --------     --------  ----------------------  --------------------',
    '      0.850        0.000                      0                   50           NA           NA                      0                   50        1.200        0.000                       0                    25',
  ].join('\n');
  const evMax = buildTimingEvidence(maxOnlyMet, 'max-only.rpt');
  assert.equal(evMax.status, 'passed');
  assert.equal(evMax.timing.hold.met, null);

  // 3. Snippet without Design Timing Summary still aggregates worst across ALL rows (never row 0)
  const snippet = [
    '| Intra Clock Table',
    'Clock             WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints',
    'clk_0               1.200        0.000                      0                   20        0.150        0.000                      0                   20',
    'clk_1               0.900        0.000                      0                   20       -0.085       -0.340                      4                   20',
  ].join('\n');
  const evSnip = buildTimingEvidence(snippet, 'snippet.rpt');
  assert.equal(evSnip.status, 'failed');
  assert.equal(evSnip.failure?.code, 'negative_hold_slack');
  assert.equal(evSnip.timing.setup.wns, 0.9);
  assert.equal(evSnip.timing.hold.whs, -0.085);
});

test('CBB gate-runner G-C-01 fails when global Design Timing Summary WNS is negative despite primary clock row passing', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbb-gc01-global-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const eaDir = path.join(tmp, 'engineering-assets');
  const pkgDir = path.join(eaDir, 'cbb', 'dual_clk_mod');
  const pgDir = path.join(eaDir, 'var', 'gates', 'pg', 'dual_clk_mod');
  fs.mkdirSync(path.join(pkgDir, 'rtl'), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, 'constraints'), { recursive: true });
  fs.mkdirSync(path.join(eaDir, 'tools', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(eaDir, 'catalog'), { recursive: true });
  fs.mkdirSync(pgDir, { recursive: true });

  fs.writeFileSync(path.join(eaDir, 'tools', 'lib', 'default_nettype_none.vh'), '`default_nettype none\n');
  fs.writeFileSync(path.join(eaDir, 'tools', 'lib', 'default_nettype_wire.vh'), '`default_nettype wire\n');
  fs.writeFileSync(path.join(eaDir, 'catalog', 'protocol-baseline.json'), JSON.stringify({
    baseline: { standard: 'IEEE 802.11-2020', clause: '17', profile: '11a/g OFDM 20MHz' },
  }));
  const rtlContent = 'module dual_clk_mod(input logic i_clk, input logic i_rst, input logic i_d, output logic o_q); logic ro_q; always_ff @(posedge i_clk) if (i_rst) ro_q <= 1\'b0; else ro_q <= i_d; assign o_q = ro_q; endmodule\n';
  const xdcContent = 'create_clock -name i_clk -period 4.000 [get_ports i_clk]\n';
  fs.writeFileSync(path.join(pkgDir, 'rtl', 'dual_clk_mod.sv'), rtlContent);
  fs.writeFileSync(path.join(pkgDir, 'constraints', 'dual_clk_mod.xdc'), xdcContent);
  fs.writeFileSync(path.join(pgDir, 'timing-summary.rpt'), [
    '| Design Timing Summary',
    '    WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)  THS Failing Endpoints  THS Total Endpoints     WPWS(ns)     TPWS(ns)  TPWS Failing Endpoints  TPWS Total Endpoints',
    '    -------      -------  ---------------------  -------------------      -------      -------  ---------------------  -------------------     --------     --------  ----------------------  --------------------',
    '     -0.650       -3.900                      6                   40        0.120        0.000                      0                   40        1.500        0.000                       0                    20',
    '| Clock Summary',
    'i_clk     {0.000 2.000}        4.000           250.000',
    'i_clk_aux {0.000 2.000}        4.000           250.000',
    '| Intra Clock Table',
    'i_clk               0.520        0.000                      0                   20        0.120        0.000                      0                   20        1.500        0.000                       0                    10',
    'i_clk_aux          -0.650       -3.900                      6                   20        0.130        0.000                      0                   20        1.500        0.000                       0                    10',
  ].join('\n'));

  const manifest = {
    schema_version: '1.0',
    asset_uid: 'dual_clk_mod',
    name: 'dual_clk_mod',
    version: '1.0.0',
    owner: 'tester',
    kind: 'primitive',
    maturity: { level: 'certified' },
    protocol_anchor: { standard: 'none', baseline_relation: 'neutral' },
    ports: [
      { name: 'i_clk', direction: 'input', width: 1 },
      { name: 'i_rst', direction: 'input', width: 1 },
      { name: 'i_d', direction: 'input', width: 1 },
      { name: 'o_q', direction: 'output', width: 1 },
    ],
    clock: { name: 'i_clk', period_ns: 4 },
    reset: { name: 'i_rst', polarity: 'active_high', type: 'sync' },
    device: { part: 'xc7k325tffg900-2' },
    constraints: { target: { fmax: '250MHz', fmax_mhz: 250, lut: 50, ff: 50, bram: 0, dsp: 0 } },
    sources: [
      { path: 'rtl/dual_clk_mod.sv', role: 'rtl', sha256: require('node:crypto').createHash('sha256').update(rtlContent).digest('hex') },
      { path: 'constraints/dual_clk_mod.xdc', role: 'constraint', sha256: require('node:crypto').createHash('sha256').update(xdcContent).digest('hex') },
    ],
  };

  const gates = runGates(pkgDir, manifest, tmp);
  const gc01 = gates.find((g) => g.id === 'G-C-01');
  assert.ok(gc01);
  assert.equal(gc01.status, 'fail');
  assert.match(String(gc01.detail), /-0\.65/);
});
