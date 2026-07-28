#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SESSION_BOOTSTRAP = path.join(ROOT, 'engine', 'scripts', 'hooks', 'session-bootstrap.cjs');
const STOP_SUMMARY = path.join(ROOT, 'engine', 'scripts', 'hooks', 'stop-summary.cjs');
const SESSION_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'];

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('SessionStart parses once and routes five lifecycle sources in-process', () => {
  const { runSessionBootstrap, SUPPORTED_SOURCES } = require(SESSION_BOOTSTRAP);
  assert.deepEqual([...SUPPORTED_SOURCES], SESSION_SOURCES);

  for (const source of SESSION_SOURCES) {
    let parseCount = 0;
    const calls = [];
    const stdout = [];
    const stderr = [];
    const payload = { hook_event_name: 'SessionStart', source, session_id: `session-${source}` };
    const components = {
      stateResume(received) {
        assert.equal(received.source, source);
        calls.push('state-resume');
        return { exitCode: 0, context: `state:${source}` };
      },
      contextResumeInject(received) {
        assert.equal(received.source, source);
        calls.push('context-resume');
        return { exitCode: 0, context: `context:${source}` };
      },
      dreamStartup(received) {
        assert.equal(received.source, source);
        calls.push('dream-startup-inject');
        return { exitCode: 0, context: `dream:${source}` };
      },
      isolationCheck(received, io) {
        assert.equal(received.source, source);
        calls.push('isolation-check');
        io.stderr(`isolation:${source}`);
        return { exitCode: 0 };
      },
    };

    const result = runSessionBootstrap(JSON.stringify(payload), {
      parse(raw) {
        parseCount += 1;
        return JSON.parse(raw);
      },
      components,
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    });

    assert.equal(parseCount, 1, `${source} must parse stdin exactly once`);
    assert.deepEqual(calls, source === 'startup'
      ? ['state-resume', 'context-resume', 'dream-startup-inject', 'isolation-check']
      : ['state-resume', 'context-resume', 'dream-startup-inject']);
    assert.equal(stdout.length, 1, `${source} must emit exactly one Hook JSON object`);
    const hookOutput = JSON.parse(stdout[0]);
    assert.equal(hookOutput.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(hookOutput.hookSpecificOutput.additionalContext,
      `state:${source}\n\ncontext:${source}\n\ndream:${source}`);
    assert.deepEqual(stderr, source === 'startup' ? [`isolation:${source}`] : []);
    assert.equal(result.exitCode, 0);
  }
});

test('SessionStart router is require-safe and excludes synchronous heavy maintenance', () => {
  const source = readSource(SESSION_BOOTSTRAP);
  assert.doesNotMatch(source, /spawn(?:Sync)?|execFile(?:Sync)?|child_process/);
  assert.doesNotMatch(source, /memory-knowledge-maintenance|memory-health|kb-stats|eda-detect|lint-auto-gate/);
  assert.equal((source.match(/readFileSync\(0/g) || []).length, 1);

  const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SESSION_BOOTSTRAP)})`], {
    encoding: 'utf8',
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, '');
  assert.equal(probe.stderr, '');
});

test('Stop parses once, preserves output order, and propagates watchdog failure', () => {
  const { runStopSummary } = require(STOP_SUMMARY);
  let parseCount = 0;
  const calls = [];
  const stdout = [];
  const stderr = [];
  const payload = { hook_event_name: 'Stop', source: 'stop', session_id: 'stop-session' };

  const result = runStopSummary(JSON.stringify(payload), {
    parse(raw) {
      parseCount += 1;
      return JSON.parse(raw);
    },
    components: {
      contextPressure(received, io) {
        assert.equal(received, payloadRef.value);
        calls.push('context-pressure-warn');
        io.stderr('pressure-warning');
        return { exitCode: 0 };
      },
      progressWatchdog(received, io) {
        assert.equal(received, payloadRef.value);
        calls.push('progress-watchdog');
        io.stdout('watchdog-context');
        io.stderr('watchdog-blocked');
        return { exitCode: 2 };
      },
    },
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
    onParsed(parsed) {
      payloadRef.value = parsed;
    },
  });

  assert.equal(parseCount, 1);
  assert.deepEqual(calls, ['context-pressure-warn', 'progress-watchdog']);
  assert.deepEqual(stdout, ['watchdog-context']);
  assert.deepEqual(stderr, ['pressure-warning', 'watchdog-blocked']);
  assert.equal(result.exitCode, 2);
});

const payloadRef = { value: null };

test('Stop router is require-safe, same-process, and never runs lint', () => {
  const source = readSource(STOP_SUMMARY);
  assert.doesNotMatch(source, /spawn(?:Sync)?|execFile(?:Sync)?|child_process/);
  assert.doesNotMatch(source, /lint-auto-gate|eslint|ruff|vlog|git\s+diff/);
  assert.equal((source.match(/readFileSync\(0/g) || []).length, 1);

  const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(STOP_SUMMARY)})`], {
    encoding: 'utf8',
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, '');
  assert.equal(probe.stderr, '');
});
