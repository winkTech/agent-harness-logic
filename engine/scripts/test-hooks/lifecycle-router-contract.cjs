#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SESSION_BOOTSTRAP = path.join(ROOT, 'engine', 'scripts', 'hooks', 'session-bootstrap.cjs');
const STOP_SUMMARY = path.join(ROOT, 'engine', 'scripts', 'hooks', 'stop-summary.cjs');
const REGISTRATIONS = path.join(ROOT, 'engine', 'hooks', 'registrations.json');
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
      loopController(received) {
        assert.equal(received, payloadRef.value);
        calls.push('loop-controller');
        return { exitCode: 0, decision: 'allow' };
      },
      deliveryRisk(received) {
        assert.equal(received, payloadRef.value);
        calls.push('delivery-risk');
        return { exitCode: 0, decision: 'allow' };
      },
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
  assert.deepEqual(calls, [
    'loop-controller', 'delivery-risk', 'context-pressure-warn', 'progress-watchdog',
  ]);
  assert.deepEqual(stdout, ['watchdog-context']);
  assert.deepEqual(stderr, ['pressure-warning', 'watchdog-blocked']);
  assert.equal(result.exitCode, 2);
});

test('Stop short-circuits summaries when an active loop requests continuation', () => {
  const { runStopSummary } = require(STOP_SUMMARY);
  const calls = [];
  const stdout = [];
  const result = runStopSummary(JSON.stringify({ hook_event_name: 'Stop' }), {
    components: {
      loopController(_payload, io) {
        calls.push('loop-controller');
        io.stdout(JSON.stringify({ decision: 'block', reason: 'continue fixture loop' }));
        return { exitCode: 0, decision: 'block', stopRouting: true };
      },
      contextPressure() {
        calls.push('context-pressure-warn');
        return { exitCode: 0 };
      },
      progressWatchdog() {
        calls.push('progress-watchdog');
        return { exitCode: 0 };
      },
    },
    stdout: line => stdout.push(line),
  });
  assert.deepEqual(calls, ['loop-controller']);
  assert.equal(stdout.length, 1, 'a blocked Stop must emit exactly one protocol object');
  assert.equal(JSON.parse(stdout[0]).decision, 'block');
  assert.equal(result.exitCode, 0, 'Stop continuation uses decision:block, not process failure');
});

test('Stop delivery risk is shadow-first, enforceable, and permits explicit unverified handoff', () => {
  const { runDeliveryRisk } = require(STOP_SUMMARY);
  assert.equal(typeof runDeliveryRisk, 'function');
  const payload = { hook_event_name: 'Stop', cwd: ROOT, session_id: 'risk-stop-session' };
  const active = [{
    minimumRiskLevel: 'R2',
    effectiveRiskLevel: 'R2',
    riskReasons: ['interface-change'],
    requiredEvidence: ['affected-regression'],
    targets: [path.join(ROOT, 'engine', 'scripts', 'hooks', 'postflight-router.cjs')],
  }];

  let stdout = [];
  let stderr = [];
  let result = runDeliveryRisk(payload, {
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
  }, {
    env: { CLAUDE_RISK_POLICY_MODE: 'shadow' },
    riskEntries: active,
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.status, 'shadow');
  assert.equal(stdout.length, 0);
  assert.equal(stderr.length, 1);

  stdout = [];
  stderr = [];
  result = runDeliveryRisk(payload, {
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
  }, {
    env: { CLAUDE_RISK_POLICY_MODE: 'enforce' },
    riskEntries: active,
  });
  assert.equal(result.decision, 'block');
  assert.equal(result.stopRouting, true);
  assert.equal(stdout.length, 1, 'blocked delivery must emit one protocol object');
  const blocked = JSON.parse(stdout[0]);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /affected-regression|evidence/i);

  stdout = [];
  stderr = [];
  result = runDeliveryRisk(payload, {
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
  }, {
    env: { CLAUDE_RISK_POLICY_MODE: 'enforce' },
    riskEntries: [{
      ...active[0],
      verificationStatus: 'unavailable',
      verificationReason: 'required toolchain is unavailable',
    }],
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.status, 'unverified');
  assert.equal(stdout.length, 1);
  const limited = JSON.parse(stdout[0]);
  assert.match(limited.hookSpecificOutput.additionalContext, /unverified/i);
  assert.doesNotMatch(limited.hookSpecificOutput.additionalContext, /completed|verified-pass/i);
});

test('Stop reuses exact R1/R2 cache entries but never R3 signoff evidence', () => {
  const { runDeliveryRisk } = require(STOP_SUMMARY);
  const payload = { hook_event_name: 'Stop', cwd: ROOT, session_id: 'risk-cache-session' };
  const base = {
    projectRoot: ROOT,
    sessionId: 'risk-cache-session',
    minimumRiskLevel: 'R2',
    effectiveRiskLevel: 'R2',
    riskReasons: ['interface-change'],
    requiredEvidence: ['affected-regression'],
    targets: [path.join(ROOT, 'engine', 'scripts', 'hooks', 'postflight-router.cjs')],
  };
  let lookups = 0;
  let result = runDeliveryRisk(payload, { stdout() {}, stderr() {} }, {
    env: { CLAUDE_RISK_POLICY_MODE: 'enforce' },
    riskEntries: [base],
    findCacheEvidence() {
      lookups += 1;
      return { riskLevel: 'R2', status: 'pass' };
    },
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.status, 'cached-evidence');
  assert.equal(lookups, 1);

  const stdout = [];
  result = runDeliveryRisk(payload, {
    stdout: line => stdout.push(line),
    stderr() {},
  }, {
    env: { CLAUDE_RISK_POLICY_MODE: 'enforce' },
    riskEntries: [{ ...base, minimumRiskLevel: 'R3', effectiveRiskLevel: 'R3' }],
    findCacheEvidence() {
      lookups += 1;
      return { riskLevel: 'R3', status: 'pass' };
    },
  });
  assert.equal(result.decision, 'block');
  assert.equal(stdout.length, 1);
  assert.equal(lookups, 1, 'R3 must not even query reusable evidence');
});

test('Stop cache matches equivalent project-root paths', () => {
  const { findCachedEvidence } = require(STOP_SUMMARY);
  const policy = require(path.join(ROOT, 'engine', 'scripts', 'lib', 'risk-policy.cjs'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-cache-root-'));
  try {
    const source = path.join(root, 'source.cjs');
    fs.writeFileSync(source, 'module.exports = 1;\n', 'utf8');
    const descriptor = policy.buildEvidenceKey({
      projectRoot: `${root}${path.sep}`,
      fileHashes: [{
        path: 'source.cjs',
        sha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
      }],
      testHashes: [],
      goldenHashes: [],
      command: 'node source.cjs',
      toolVersions: { node: process.version },
      riskLevel: 'R2',
    });
    const candidate = {
      ...descriptor,
      status: 'pass',
      projectRoot: `${root}${path.sep}`,
      riskLevel: 'R2',
      command: 'node source.cjs',
      verifiedAt: '2026-08-20T00:00:00.000Z',
      expiresAt: '2026-08-21T00:00:00.000Z',
    };
    const hit = findCachedEvidence({
      projectRoot: root,
      effectiveRiskLevel: 'R2',
    }, { evidenceCache: { [candidate.evidenceKey]: candidate } }, {
      findReusableRiskEvidence() { return candidate; },
    }, policy, { now: '2026-08-20T12:00:00.000Z' });
    assert.equal(hit, candidate,
      'equivalent project roots must not cause a content-addressed cache miss');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Stop passes unresolved delivery risk into watchdog scope selection', () => {
  const { runStopSummary } = require(STOP_SUMMARY);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-watchdog-risk-'));
  const stateFile = path.join(root, 'watchdog.json');
  try {
    const result = runStopSummary(JSON.stringify({
      hook_event_name: 'Stop',
      cwd: root,
      session_id: 'stop-risk-scope',
    }), {
      env: { CLAUDE_RISK_POLICY_MODE: 'shadow' },
      riskEntries: [{
        projectRoot: root,
        sessionId: 'stop-risk-scope',
        minimumRiskLevel: 'R2',
        effectiveRiskLevel: 'R2',
        requiredEvidence: ['affected-regression'],
        verificationStatus: 'pending',
        targets: [path.join(root, 'shared-core.cjs')],
      }],
      evaluateLoop: () => ({ decision: 'allow' }),
      watchdogOptions: {
        stateFile,
        archiveDir: path.join(root, 'archive'),
      },
      stdout() {},
      stderr() {},
    });
    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(stateFile), true,
      'an unresolved R2 delivery must keep Stop inside watchdog scope');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Stop registration launches one synchronous router process', () => {
  const registrations = JSON.parse(fs.readFileSync(REGISTRATIONS, 'utf8'));
  const commands = (registrations.hooks?.Stop || [])
    .flatMap((group) => group.hooks || []);
  const synchronous = commands.filter((hook) => hook.async !== true);
  assert.equal(synchronous.length, 1, 'Stop must launch exactly one synchronous process');
  assert.match(synchronous[0].command || '', /stop-summary\.cjs/);
  assert.doesNotMatch(JSON.stringify(commands), /loop-controller\.cjs/,
    'loop controller must run inside stop-summary instead of a second Node process');
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
