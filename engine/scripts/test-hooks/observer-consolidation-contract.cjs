#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const observer = require(path.join(ROOT, 'engine', 'hooks', 'learning', 'postflight-observer.cjs'));

function payload(event) {
  return {
    hook_event_name: event,
    session_id: `observer-consolidation-${event}`,
    cwd: ROOT,
    tool_name: 'Read',
    tool_input: { file_path: path.join(ROOT, 'README.md') },
  };
}

function main() {
  const calls = [];
  const warnings = [];
  const deps = {
    ledgerRun(input) { calls.push(`ledger:${input.hook_event_name}`); },
    skillEvolve() { calls.push('skill-evolve'); },
    riskTelemetry(input) { calls.push(`risk:${input.hook_event_name}`); },
    warn(record) { warnings.push(record); },
  };

  const post = observer.handlePayload(payload('PostToolUse'), deps);
  assert.equal(post.ok, true);
  assert.deepEqual(calls, ['ledger:PostToolUse', 'risk:PostToolUse'],
    'PostToolUse must fold transparency into the observer process');

  calls.length = 0;
  const stop = observer.handlePayload(payload('Stop'), deps);
  assert.equal(stop.ok, true);
  assert.deepEqual(calls, ['ledger:Stop', 'skill-evolve'],
    'Stop must fold transparency and bounded skill evolution into the observer process');

  calls.length = 0;
  observer.handlePayload(payload('PostToolUseFailure'), deps);
  assert.deepEqual(calls, ['risk:PostToolUseFailure'],
    'failure risk telemetry must stay inside the registered observer process');

  calls.length = 0;
  observer.handlePayload(payload('Stop'), {
    ledgerRun() { calls.push('ledger'); throw new Error('ledger fixture failed'); },
    skillEvolve() { calls.push('skill-evolve'); },
    warn(record) { warnings.push(record); },
  });
  assert.deepEqual(calls, ['ledger', 'skill-evolve'],
    'one auxiliary failure must not suppress the other observer responsibility');
  assert.ok(warnings.some(record => record.kind === 'auxiliary-failure'
      && record.source === 'agent-transparency-ledger'),
  'auxiliary failures must be visible and fail-open');

  const health = require(path.join(ROOT, 'engine', 'scripts', 'memory-health-check.cjs'));
  const schedules = health.detectConsumerSchedules(ROOT, ['skill-evolve']);
  assert.equal(schedules['skill-evolve'], true,
    'memory health must recognize Skill-Evolve inside the active Stop observer');

  assert.equal(typeof observer.recordRiskTelemetry, 'function');
  const telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-telemetry-'));
  try {
    const ordinary = {
      hook_event_name: 'PostToolUse',
      session_id: 'risk-ordinary',
      cwd: ROOT,
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(ROOT, 'engine', 'hooks', 'learning', 'postflight-observer.cjs'),
        old_string: 'const value = 1;',
        new_string: 'const value = 2;',
      },
    };
    observer.recordRiskTelemetry(ordinary, {
      telemetryDir,
      now: '2026-08-20T06:00:00.000Z',
      env: {},
    });
    observer.recordRiskTelemetry(ordinary, {
      telemetryDir,
      now: '2026-08-20T06:01:00.000Z',
      env: {},
    });
    const dailyPath = path.join(telemetryDir, 'risk-daily.json');
    const daily = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
    assert.equal(Object.values(daily.days['2026-08-20']).reduce((sum, count) => sum + count, 0), 2,
      'routine successes must aggregate instead of writing one raw row each');

    observer.recordRiskTelemetry({
      ...ordinary,
      session_id: 'risk-upgrade',
      tool_input: {
        ...ordinary.tool_input,
        old_string: 'module.exports = { main };',
        new_string: 'module.exports = { main, evaluate };',
      },
    }, { telemetryDir, now: '2026-08-20T06:02:00.000Z', env: {} });
    observer.recordRiskTelemetry({
      ...ordinary,
      hook_event_name: 'PostToolUseFailure',
      session_id: 'risk-failure',
      failure_count: 2,
    }, { telemetryDir, now: '2026-08-20T06:03:00.000Z', env: {} });
    observer.recordRiskTelemetry(ordinary, {
      telemetryDir,
      now: '2026-08-20T06:04:00.000Z',
      env: {
        CLAUDE_GATES_DISABLED: '1',
        CLAUDE_GATES_DISABLE_TARGET: 'risk-policy.cjs',
      },
    });
    const rawPath = path.join(telemetryDir, 'risk-events.jsonl');
    const raw = fs.readFileSync(rawPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.deepEqual(raw.map(entry => entry.kind), ['upgrade', 'failure', 'bypass']);
    assert(raw.every(entry => !entry.sessionId && /^[a-f0-9]{64}$/.test(entry.sessionHash)));

    observer.recordRiskTelemetry(ordinary, {
      telemetryDir,
      now: '2026-12-01T00:00:00.000Z',
      env: {},
    });
    const retainedRaw = fs.existsSync(rawPath)
      ? fs.readFileSync(rawPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      : [];
    assert.equal(retainedRaw.length, 0, 'raw risk telemetry older than 14 days was retained');
    const retainedDaily = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
    assert.equal(retainedDaily.days['2026-08-20'], undefined,
      'daily success aggregate older than 90 days was retained');
  } finally {
    fs.rmSync(telemetryDir, { recursive: true, force: true });
  }

  process.stdout.write('OBSERVER_CONSOLIDATION_RESULT: PASS\n');
}

main();
