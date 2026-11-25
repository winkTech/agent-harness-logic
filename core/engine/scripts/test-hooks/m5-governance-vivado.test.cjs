#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../../sqlite/index.cjs');
const { analyzeTelemetry } = require('../harness-telemetry-prune.cjs');
const { checkVivadoSummary } = require('../hdl-evidence-gate.cjs');
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
