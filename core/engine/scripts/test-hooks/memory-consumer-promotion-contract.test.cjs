#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CANDIDATES = path.join(ROOT, 'engine', 'scripts', 'harness-rule-candidates.cjs');
const RULE_LOADER = path.join(ROOT, 'engine', 'scripts', 'rule-loader.cjs');
const PREFLIGHT = path.join(ROOT, 'engine', 'scripts', 'hooks', 'preflight-router.cjs');
const {
  behaviorContractHash,
  commandEvidence,
  evidenceEntrySha256,
} = require(path.join(ROOT, 'engine', 'scripts', 'lib', 'evidence-ledger.cjs'));

function makeHarnessFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'engine', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture\n', 'utf8');
  return root;
}

function evidence(label = 'fixture', fixture) {
  if (!fixture) {
    return [{
      kind: 'real_payload_test',
      result: 'PASS',
      red: { status: 'RED', exitCode: 2, command: `node ${label}.cjs` },
      green: { status: 'GREEN', exitCode: 0, command: `node ${label}.cjs` },
    }];
  }
  const evidenceDir = path.join(fixture, 'var', 'evidence');
  const scriptPath = path.join(evidenceDir, `${label}.cjs`);
  const evidenceLedger = path.join(evidenceDir, `${label}.json`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const command = `${process.execPath} ${scriptPath}`;
  const runCase = (source, accepted, startedAt, completedAt) => {
    fs.writeFileSync(scriptPath, source, 'utf8');
    const run = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    const entry = commandEvidence(command, {
      status: run.status,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    }, { startedAt, completedAt });
    entry.verification = {
      accepted,
      reason: accepted ? 'real fixture command passed' : 'real fixture command failed',
      gate: 'verification-gate',
    };
    entry.recordedAt = completedAt;
    return entry;
  };
  const redEntry = runCase(
    "process.stderr.write('RED: expected failure\\n'); process.exit(2);\n",
    false,
    '2026-07-28T00:00:00.000Z',
    '2026-07-28T00:00:01.000Z',
  );
  const greenEntry = runCase(
    "process.stdout.write('PASS: expected behavior\\n');\n",
    true,
    '2026-07-28T00:00:02.000Z',
    '2026-07-28T00:00:03.000Z',
  );
  fs.writeFileSync(evidenceLedger, `${JSON.stringify({
    schemaVersion: 1,
    entries: [redEntry, greenEntry],
  }, null, 2)}\n`, 'utf8');
  return [{
    kind: 'real_payload_test',
    result: 'PASS',
    contractHash: behaviorContractHash(command),
    red: {
      status: 'RED',
      exitCode: 2,
      command,
      ledger: evidenceLedger,
      entrySha256: evidenceEntrySha256(redEntry),
    },
    green: {
      status: 'GREEN',
      exitCode: 0,
      command,
      ledger: evidenceLedger,
      entrySha256: evidenceEntrySha256(greenEntry),
    },
  }];
}

function lifecycle(input, fixture) {
  const candidates = require(CANDIDATES);
  const ledgerPath = path.join(fixture, 'var', 'maintenance', 'harness-rule-candidates.json');
  const rulesPath = path.join(fixture, 'docs', 'rules');
  const staged = candidates.stageCandidate(input, { ledgerPath, stagedBy: 'contract-test' });
  candidates.verifyCandidate(staged.id, {
    ledgerPath,
    verifiedBy: 'contract-test',
    evidence: evidence(staged.id, fixture),
  });
  candidates.approveCandidate(staged.id, {
    ledgerPath,
    approvedBy: 'user-fixture',
    explicit: true,
  });
  const promoted = candidates.promoteCandidate(staged.id, {
    ledgerPath,
    rulesPath,
    promotedBy: 'contract-test',
  });
  return { candidates, ledgerPath, promoted, rulesPath };
}

test('consumer registry is structural and heartbeat distinguishes skipped, failed, and never-ran', () => {
  const health = require(path.join(ROOT, 'engine', 'scripts', 'memory-health-check.cjs'));
  const { openDb } = require(path.join(ROOT, 'engine', 'sqlite', 'index.cjs'));
  const events = require(path.join(ROOT, 'engine', 'sqlite', 'store-events.cjs'));
  const startup = require(path.join(ROOT, 'engine', 'scripts', 'dream-startup-inject.cjs'));
  const wDb = openDb({ path: ':memory:' });
  for (let index = 0; index < 3; index += 1) {
    events.record({ sessionId: 'consumer-runtime', type: 'tool_fail', payload: {} }, null, { db: wDb.db });
  }

  assert.equal(health.detectConsumerSchedules(ROOT, ['dream']).dream, true);
  let report = health.buildHealthReport({
    db: wDb.db,
    home: ROOT,
    now: Date.parse('2026-07-28T00:00:00.000Z'),
  });
  assert.ok(report.issues.some((item) => item.code === 'event_consumer_never_ran'));

  startup.runStartup({
    db: wDb.db,
    minEvents: 5,
    runId: 'dream-skipped',
    now: '2026-07-28T00:01:00.000Z',
  });
  assert.equal(events.getConsumerRun('dream', { db: wDb.db }).status, 'skipped');
  report = health.buildHealthReport({
    db: wDb.db,
    home: ROOT,
    now: Date.parse('2026-07-28T00:02:00.000Z'),
  });
  assert.ok(!report.issues.some((item) => item.code === 'pending_event_backlog'
    && item.evidence.consumers.some((consumer) => consumer.consumer === 'dream')));

  for (let index = 0; index < 2; index += 1) {
    events.record({ sessionId: 'consumer-runtime', type: 'tool_fail', payload: {} }, null, { db: wDb.db });
  }
  const failed = startup.runStartup({
    db: wDb.db,
    minEvents: 5,
    runId: 'dream-failed',
    now: '2026-07-28T00:03:00.000Z',
    runDream() { throw new Error('fixture dream failed'); },
  });
  assert.match(failed.dreamError, /fixture dream failed/);
  assert.equal(events.getConsumerRun('dream', { db: wDb.db }).status, 'failed');
  report = health.buildHealthReport({
    db: wDb.db,
    home: ROOT,
    now: Date.parse('2026-07-28T00:04:00.000Z'),
  });
  assert.ok(report.issues.some((item) => item.code === 'event_consumer_failing'));
  wDb.close();
});

test('registered event-stream consumers cannot disappear when their watermark row is missing', () => {
  const health = require(path.join(ROOT, 'engine', 'scripts', 'memory-health-check.cjs'));
  const { openDb } = require(path.join(ROOT, 'engine', 'sqlite', 'index.cjs'));
  const wDb = openDb({ path: ':memory:' });
  wDb.db.prepare("DELETE FROM runtime_consumer_watermarks WHERE consumer = 'dream'").run();
  const report = health.buildHealthReport({
    db: wDb.db,
    home: ROOT,
    now: Date.parse('2026-07-28T00:00:00.000Z'),
  });
  const dream = report.metrics.events.consumers.find((item) => item.consumer === 'dream');
  assert.equal(dream?.watermarkPresent, false);
  assert.ok(report.issues.some((item) => item.code === 'event_consumer_watermark_missing'
    && item.evidence.consumers.some((consumer) => consumer.consumer === 'dream')));
  wDb.close();
});

test('verified facts cannot report healthy without complete scope, trigger, evidence, and validity metadata', () => {
  const health = require(path.join(ROOT, 'engine', 'scripts', 'memory-health-check.cjs'));
  const { openDb } = require(path.join(ROOT, 'engine', 'sqlite', 'index.cjs'));
  const { writeMemory } = require(path.join(ROOT, 'engine', 'sqlite', 'store-memory.cjs'));
  const wDb = openDb({ path: ':memory:' });
  const incomplete = writeMemory({
    namespace: 'errors',
    name: 'incomplete-verified',
    content: 'Verified behavior without an applicability contract.',
    source: 'contract-test',
    confidence: 0.9,
    verificationState: 'verified',
  }, { db: wDb.db });
  writeMemory({
    namespace: 'learnings',
    name: 'complete-global',
    content: 'A harness-global fact does not require a project id.',
    source: 'contract-test',
    confidence: 0.9,
    scopeKind: 'global_harness',
    triggerKind: 'harness_health',
    verificationState: 'verified',
    evidenceRef: 'test:global-harness-contract',
    validUntil: Date.parse('2026-08-28T00:00:00.000Z'),
  }, { db: wDb.db });

  let report = health.buildHealthReport({
    db: wDb.db,
    home: ROOT,
    now: Date.parse('2026-07-28T00:00:00.000Z'),
  });
  const red = report.issues.find((item) => item.code === 'verified_fact_metadata_incomplete');
  assert.ok(red, `incomplete verified fact false-greened: ${JSON.stringify(report.metrics.facts)}`);
  assert.notEqual(report.status, 'healthy');
  assert.equal(red.evidence.incomplete, 1);
  assert.deepEqual(red.evidence.records[0].missing.sort(), [
    'evidence_ref', 'project_id', 'scope_kind', 'trigger_kind', 'valid_until',
  ]);

  wDb.db.prepare(`
    UPDATE facts
    SET project_id = ?, scope_kind = 'path', path_scope = ?, trigger_kind = ?,
        evidence_ref = ?, valid_until = ?
    WHERE id = ?
  `).run('project-fixture', 'engine/**', 'file_edit', 'test:focused-regression',
    Date.parse('2026-08-28T00:00:00.000Z'), incomplete.id);
  report = health.buildHealthReport({
    db: wDb.db,
    home: ROOT,
    now: Date.parse('2026-07-28T00:00:00.000Z'),
  });
  assert.equal(report.metrics.facts.verifiedIncomplete, 0);
  assert.ok(!report.issues.some((item) => item.code === 'verified_fact_metadata_incomplete'));
  wDb.close();
});

test('memory health exposes attribution progress and overdue candidate review', () => {
  const health = require(path.join(ROOT, 'engine', 'scripts', 'memory-health-check.cjs'));
  const candidates = require(CANDIDATES);
  const attribution = require(path.join(ROOT, 'engine', 'sqlite', 'store-memory-attribution.cjs'));
  const { openDb } = require(path.join(ROOT, 'engine', 'sqlite', 'index.cjs'));
  const fixture = makeHarnessFixture('memory-health-attribution-');
  const ledgerPath = path.join(fixture, 'var', 'maintenance', 'harness-rule-candidates.json');
  candidates.stageCandidate({
    title: 'Review stale memory contract',
    source: 'contract-test',
    rootCause: 'A durable candidate remained unreviewed.',
    verifiedFix: 'Report candidate age in the primary health output.',
    prevention: 'Warn when an unverified candidate is older than thirty days.',
    triggerConditions: ['memory health candidate aging'],
  }, {
    ledgerPath,
    stagedBy: 'contract-test',
    now: '2026-06-01T00:00:00.000Z',
  });
  const wDb = openDb({ path: ':memory:' });
  const retrievalId = attribution.createRetrievalId();
  attribution.recordExposure({
    sessionId: 'health-attribution-session',
    projectId: 'project-health',
    memoryId: 'memory-health',
    retrievalId,
    correlationId: retrievalId,
    triggerKind: 'user-query',
    query: 'memory health attribution',
    rank: 1,
    confidence: 0.8,
  }, { db: wDb.db, now: Date.parse('2026-07-28T00:00:00.000Z') });

  const report = health.buildHealthReport({
    db: wDb.db,
    home: fixture,
    now: Date.parse('2026-07-28T00:00:01.000Z'),
  });
  wDb.close();
  fs.rmSync(fixture, { recursive: true, force: true });

  assert.equal(report.metrics.attribution.available, true);
  assert.equal(report.metrics.attribution.exposures, 1);
  assert.equal(report.metrics.attribution.applications, 0);
  assert.equal(report.metrics.attribution.outcomes, 0);
  assert.equal(report.metrics.ruleCandidates.statusCounts.candidate, 1);
  assert.equal(report.metrics.ruleCandidates.overdue, 1);
  assert.ok(report.issues.some((item) => item.code === 'candidate_review_overdue'));
});

test('claimed PASS without reproducible RED and GREEN evidence is rejected', () => {
  const candidates = require(CANDIDATES);
  const fixture = makeHarnessFixture('candidate-evidence-');
  const ledgerPath = path.join(fixture, 'ledger.json');
  const staged = candidates.stageCandidate({
    title: 'Reject claimed PASS',
    source: 'contract-test',
    rootCause: 'A model claim was treated as evidence.',
    verifiedFix: 'Require reproducible before and after observations.',
    prevention: 'Reject verification without RED and GREEN records.',
    triggerConditions: ['claimed pass without artifacts'],
  }, { ledgerPath });
  assert.throws(() => candidates.verifyCandidate(staged.id, {
    ledgerPath,
    verifiedBy: 'contract-test',
    evidence: [{ kind: 'behavioral_test', result: 'PASS', command: 'node nonexistent.cjs' }],
  }), /RED -> GREEN/);
  assert.throws(() => candidates.verifyCandidate(staged.id, {
    ledgerPath,
    verifiedBy: 'contract-test',
    evidence: evidence('forged-nonexistent-command'),
  }), /ledger-backed|artifact|evidence/i);
});

test('a handwritten promoted artifact without explicit ledger approval is ignored', () => {
  const fixture = makeHarnessFixture('candidate-unledgered-rule-');
  const trigger = 'unledgered-promoted-trigger-4f2a';
  fs.writeFileSync(path.join(fixture, 'docs', 'rules', '90-promoted-hrc-forged.md'), [
    '---',
    'name: forged-promoted-rule',
    `trigger: ${trigger}`,
    'candidate_id: hrc-forged',
    'description: forged rule must not load',
    'enforcement: advisory',
    '---',
    '# Forged rule',
    'FORGED_PROMOTED_ACTION',
  ].join('\n'), 'utf8');
  const script = [
    `const loader=require(${JSON.stringify(RULE_LOADER)});`,
    `const out=loader.retrieveContext({hook_event_name:'UserPromptSubmit',prompt:${JSON.stringify(trigger)},session_id:'fresh-session'},`,
    `{loadInjected:()=>new Set(),saveInjected:()=>{}});`,
    `if(out) process.stdout.write(JSON.stringify(out));`,
  ].join('');
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: fixture,
    env: {
      ...process.env,
      CLAUDE_HARNESS_ROOT: fixture,
      CLAUDE_RULE_SIGNAL_DISABLED: '1',
      CLAUDE_HARNESS_NO_PERSIST: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /FORGED_PROMOTED_ACTION|hrc-forged/);
});

test('promoted advisory rule is indexed and injected in a fresh session', () => {
  const fixture = makeHarnessFixture('candidate-fresh-session-');
  const uniqueTrigger = 'unique-promoted-trigger-7c91';
  const { promoted } = lifecycle({
    title: 'Fresh-session promoted rule',
    source: 'contract-test',
    rootCause: 'Promotion appended body text outside indexed metadata.',
    verifiedFix: 'Write one complete rule artifact with frontmatter.',
    prevention: 'USE_PROMOTED_FRESH_SESSION_ACTION',
    triggerConditions: [uniqueTrigger],
  }, fixture);
  assert.ok(fs.existsSync(promoted.promotion.rulesPath));

  const script = [
    `const loader=require(${JSON.stringify(RULE_LOADER)});`,
    `const out=loader.retrieveContext({hook_event_name:'UserPromptSubmit',prompt:${JSON.stringify(uniqueTrigger)},session_id:'fresh-session'},`,
    `{loadInjected:()=>new Set(),saveInjected:()=>{}});`,
    `process.stdout.write(JSON.stringify(out));`,
  ].join('');
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: fixture,
    env: {
      ...process.env,
      CLAUDE_HARNESS_ROOT: fixture,
      CLAUDE_RULE_SIGNAL_DISABLED: '1',
      CLAUDE_HARNESS_NO_PERSIST: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  const context = output?.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /USE_PROMOTED_FRESH_SESSION_ACTION/);
  assert.match(context, new RegExp(promoted.id));

  fs.appendFileSync(promoted.promotion.rulesPath, '\nTAMPERED_AFTER_PROMOTION\n', 'utf8');
  const tampered = spawnSync(process.execPath, ['-e', script], {
    cwd: fixture,
    env: {
      ...process.env,
      CLAUDE_HARNESS_ROOT: fixture,
      CLAUDE_RULE_SIGNAL_DISABLED: '1',
      CLAUDE_HARNESS_NO_PERSIST: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(tampered.status, 0, tampered.stderr);
  assert.doesNotMatch(tampered.stdout, /USE_PROMOTED_FRESH_SESSION_ACTION/,
    'tampered promoted artifact remained active in a fresh session');
  const health = require(path.join(ROOT, 'engine', 'scripts', 'memory-health-check.cjs'));
  const integrity = health.inspectPromotedRuleIntegrity(fixture);
  assert.equal(integrity.invalid, 1, `health did not report tampered promotion: ${JSON.stringify(integrity)}`);
});

test('explicitly approved promoted hard rule blocks its payload and permits a near neighbor', () => {
  const fixture = makeHarnessFixture('candidate-hard-gate-');
  const dbPath = path.join(fixture, 'memory-attribution.db');
  const { promoted } = lifecycle({
    title: 'Block a reviewed unsafe fixture path',
    source: 'contract-test',
    rootCause: 'The durable rule was advisory only.',
    verifiedFix: 'Route an allowlisted predicate through PreToolUse.',
    prevention: 'BLOCK_PROMOTED_SENTINEL_PATH',
    triggerConditions: ['blocked-sentinel-path'],
    enforcement: {
      mode: 'block',
      tools: ['Read'],
      field: 'file_path',
      operator: 'contains',
      value: 'blocked-sentinel-path',
    },
  }, fixture);

  const env = {
    ...process.env,
    CLAUDE_HARNESS_ROOT: fixture,
    CLAUDE_SQLITE_PATH: dbPath,
    CLAUDE_HARNESS_NO_PERSIST: '0',
    CLAUDE_HARNESS_VERIFY_READONLY: '0',
    CLAUDE_TRANSPARENCY_LEDGER_DISABLED: '1',
  };
  const invoke = (filePath) => spawnSync(process.execPath, [PREFLIGHT], {
    cwd: fixture,
    env,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: filePath },
      cwd: fixture,
      session_id: 'promoted-hard-gate-contract',
      tool_use_id: 'promoted-hard-gate-call',
    }),
    encoding: 'utf8',
  });
  const blocked = invoke(path.join(fixture, 'blocked-sentinel-path.txt'));
  assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
  assert.match(blocked.stderr, new RegExp(promoted.id));
  const duplicateBlocked = invoke(path.join(fixture, 'blocked-sentinel-path.txt'));
  assert.equal(duplicateBlocked.status, 2, duplicateBlocked.stderr || duplicateBlocked.stdout);

  const allowed = invoke(path.join(fixture, 'allowed-neighbor.txt'));
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);

  const { openDb } = require(path.join(ROOT, 'engine/sqlite/index.cjs'));
  const { memoryProjectId } = require(path.join(ROOT, 'engine/scripts/lib/project-scope.cjs'));
  const wDb = openDb({ path: dbPath });
  const exposures = wDb.db.prepare('SELECT * FROM memory_retrieval_exposures').all();
  const applications = wDb.db.prepare('SELECT * FROM memory_applications').all();
  const outcomes = Number(wDb.db.prepare('SELECT COUNT(*) AS count FROM memory_outcomes').get().count);
  wDb.close();
  assert.equal(exposures.length, 1, 'repeated promoted block did not write one idempotent exposure');
  assert.equal(applications.length, 1, 'promoted hard gate did not write one strong application');
  assert.equal(outcomes, 0, 'promoted hard gate fabricated a verification outcome');
  const exposure = exposures[0];
  const application = applications[0];
  assert.equal(exposure.memory_id, promoted.id);
  assert.equal(exposure.session_id, 'promoted-hard-gate-contract');
  assert.equal(exposure.project_id, memoryProjectId(fixture));
  assert.equal(exposure.trigger_kind, 'rule-trigger');
  assert.equal(exposure.status, 'unverified');
  assert.equal(exposure.correlation_id, 'promoted-hard-gate-call');
  assert.ok(exposure.retrieval_id);
  assert.equal(application.memory_id, promoted.id);
  assert.equal(application.retrieval_id, exposure.retrieval_id);
  assert.equal(application.correlation_id, exposure.correlation_id);
  assert.equal(application.event_name, 'PreToolUse');
  assert.equal(application.tool_name, 'Read');
  assert.equal(application.evidence_kind, 'rule-enforced');
  assert.equal(application.evidence_strength, 'strong');
  assert.equal(application.causal_claim, 'unproven');
  assert.match(application.action_sha256, /^[a-f0-9]{64}$/);

  fs.appendFileSync(promoted.promotion.rulesPath, '\nTAMPERED_AFTER_PROMOTION\n', 'utf8');
  const tampered = invoke(path.join(fixture, 'blocked-sentinel-path.txt'));
  assert.equal(tampered.status, 0,
    `tampered promoted hard gate remained active: ${tampered.stderr || tampered.stdout}`);
});
