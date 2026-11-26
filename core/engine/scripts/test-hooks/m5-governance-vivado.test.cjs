#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../../sqlite/index.cjs');
const { analyzeTelemetry } = require('../harness-telemetry-prune.cjs');
const { checkModule, checkVivadoSummary } = require('../hdl-evidence-gate.cjs');
const { recordTranscriptUsage } = require('../../sqlite/store-costs.cjs');

test('telemetry-prune identifies zero-hit tentative facts and zero-load rules strictly read-only', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
  const dbPath = path.join(tmp, 'test.db');
  const handle = openDb({ path: dbPath });
  const db = handle.db;
  t.after(() => {
    try { handle.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const oldDate = new Date(Date.now() - 120 * 86_400_000).toISOString();
  db.prepare(`
    INSERT INTO facts (id, namespace, name, content, source, confidence, status, hit_count, created_at, updated_at)
    VALUES ('f-stale', 'feedback', 'old-tentative', 'body', 'script:dream', 0.4, 'active', 0, ?, ?)
  `).run(oldDate, oldDate);

  const report = analyzeTelemetry(db, { days: 90 });
  assert.equal(report.facts.totalActive, 1);
  assert.equal(report.facts.zeroHitTentative, 1);
  assert.equal(report.facts.pruneCandidates.length, 1);
  assert.equal(report.facts.pruneCandidates[0].id, 'f-stale');

  // Strictly read-only: fact must remain untouched in DB.
  const stillThere = db.prepare("SELECT status FROM facts WHERE id = 'f-stale'").get();
  assert.equal(stillThere.status, 'active');
});

test('hdl-evidence-gate --vivado-summary validates WNS, WHS, inferred latches, and CDC critical violations', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vivado-gate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const passFile = path.join(tmp, 'pass.json');
  fs.writeFileSync(passFile, JSON.stringify({
    status: 'PASS',
    timing: { wns_ns: 0.42, whs_ns: 0.08 },
    methodology: { inferred_latches: 0 },
    cdc: { critical_violations: 0 },
  }));
  const ok = checkVivadoSummary(tmp, 'pass.json');
  assert.equal(ok.pass, true);
  assert.equal(ok.failures.length, 0);

  const failFile = path.join(tmp, 'fail.json');
  fs.writeFileSync(failFile, JSON.stringify({
    status: 'PASS',
    timing: { wns_ns: -0.15, whs_ns: -0.02 },
    methodology: { inferred_latches: 3 },
    cdc: { critical_violations: 2 },
  }));
  const bad = checkVivadoSummary(tmp, 'fail.json');
  assert.equal(bad.pass, false);
  assert.equal(bad.failures.length, 4);
  assert.match(bad.failures.join('\n'), /WNS -0\.15/);
  assert.match(bad.failures.join('\n'), /WHS -0\.02/);
  assert.match(bad.failures.join('\n'), /inferred latches 3/);
  assert.match(bad.failures.join('\n'), /CDC critical violations 2/);

  // Real vivado_flow.tcl / p6b stage-nested schema (synth & route)
  const realSynthFile = path.join(tmp, 'flow_synth.json');
  fs.writeFileSync(realSynthFile, JSON.stringify({
    tool: 'vivado_flow',
    vivado_version: '2023.1.1',
    top: 'mac_pipe',
    part: 'xc7a35tcpg236-1',
    constrained: true,
    aborted: false,
    ok: true,
    stages_run: ['rtlcheck', 'synth'],
    rtlcheck: { critical: 0, error: 0, waived: [] },
    synth: { lut: 4, ff: 5, bram: 0, uram: 0, dsp: 1, srl: 0, wns: 0.559, whs: 0.262, critical: 0, error: 0, cdc_critical: 0 },
    blocking: [],
  }));
  const realOk = checkVivadoSummary(tmp, 'flow_synth.json');
  assert.equal(realOk.pass, true, realOk.failures.join('; '));
  assert.equal(realOk.metrics.stage, 'synth');
  assert.equal(realOk.metrics.wns, 0.559);
  assert.equal(realOk.metrics.whs, 0.262);

  const realFailFile = path.join(tmp, 'flow_route_fail.json');
  fs.writeFileSync(realFailFile, JSON.stringify({
    tool: 'vivado_flow',
    vivado_version: '2023.1.1',
    top: 'mac_pipe',
    part: 'xc7a35tcpg236-1',
    constrained: true,
    aborted: false,
    ok: false,
    stages_run: ['rtlcheck', 'synth', 'opt', 'place', 'route'],
    rtlcheck: { critical: 0, error: 0 },
    synth: { wns: 0.2, whs: 0.1, critical: 0, error: 0 },
    place: { wns: 0.05, whs: 0.02, error: 1 },
    route: { wns: -0.08, whs: 0.01, critical: 1, error: 0, cdc_critical: 1 },
    blocking: ['route WNS < 0'],
  }));
  const realBad = checkVivadoSummary(tmp, 'flow_route_fail.json');
  assert.equal(realBad.pass, false);
  assert.match(realBad.failures.join('\n'), /ok=false/);
  assert.match(realBad.failures.join('\n'), /stage errors=1/);
  assert.match(realBad.failures.join('\n'), /stage critical warnings=1/);
  assert.match(realBad.failures.join('\n'), /blocking items/);
  assert.match(realBad.failures.join('\n'), /WNS -0\.08/);
  assert.match(realBad.failures.join('\n'), /CDC critical violations 1/);
});

test('hdl-evidence-gate checkModule rejects post-simulation edits to RTL or transitive includes', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-freshness-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const hdlDir = path.join(tmp, '01_src', '00_hdl', 'alu');
  const resDir = path.join(tmp, '02_sim', 'check_results');
  fs.mkdirSync(hdlDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });

  const defsPath = path.join(hdlDir, 'alu_defs.svh');
  const rtlPath = path.join(hdlDir, 'alu.sv');
  const resPath = path.join(resDir, 'alu.json');
  fs.writeFileSync(defsPath, '`define ALU_W 16\n');
  fs.writeFileSync(rtlPath, '`include "alu_defs.svh"\nmodule alu; endmodule\n');
  fs.writeFileSync(resPath, JSON.stringify({ module: 'alu', status: 'PASS', compared_points: 64, mismatches: 0 }));

  assert.equal(checkModule(tmp, 'alu').pass, true);

  // Editing transitive header after check_results invalidates module evidence
  const future = (Date.now() + 5000) / 1000;
  fs.writeFileSync(defsPath, '`define ALU_W 8\n');
  fs.utimesSync(defsPath, future, future);
  const stale = checkModule(tmp, 'alu');
  assert.equal(stale.pass, false);
  assert.match(stale.reason, /stale evidence.*alu_defs\.svh/);
});

test('store-costs parses Antigravity PLANNER_RESPONSE transcript token usage idempotently', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ag-'));
  const dbPath = path.join(tmp, 'test.db');
  const handle = openDb({ path: dbPath });
  const db = handle.db;
  t.after(() => {
    try { handle.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 10000, cache_read_tokens: 2000, output_tokens: 500 }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 5000, cache_read_tokens: 1000, output_tokens: 300 }),
  ].join('\n') + '\n');

  const r1 = recordTranscriptUsage({ sessionId: 'ag-s1', transcriptPath: transcript, model: 'gemini-4' }, { db });
  assert.equal(r1.recorded, 1);
  // Idempotent upsert on repeated call.
  const r2 = recordTranscriptUsage({ sessionId: 'ag-s1', transcriptPath: transcript, model: 'gemini-4' }, { db });
  assert.equal(r2.recorded, 1);
  const row = db.prepare("SELECT tokens_in, tokens_out, cache_read_tokens FROM cost_ledger WHERE session_id = 'ag-s1' AND phase = 'usage'").get();
  assert.deepEqual({ ...row }, { tokens_in: 15000, tokens_out: 800, cache_read_tokens: 3000 });
});
