#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
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
    warn(record) { warnings.push(record); },
  };

  const post = observer.handlePayload(payload('PostToolUse'), deps);
  assert.equal(post.ok, true);
  assert.deepEqual(calls, ['ledger:PostToolUse'],
    'PostToolUse must fold transparency into the observer process');

  calls.length = 0;
  const stop = observer.handlePayload(payload('Stop'), deps);
  assert.equal(stop.ok, true);
  assert.deepEqual(calls, ['ledger:Stop', 'skill-evolve'],
    'Stop must fold transparency and bounded skill evolution into the observer process');

  calls.length = 0;
  observer.handlePayload(payload('PostToolUseFailure'), deps);
  assert.deepEqual(calls, [], 'failure events must not invent previously unregistered auxiliary work');

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

  process.stdout.write('OBSERVER_CONSOLIDATION_RESULT: PASS\n');
}

main();
