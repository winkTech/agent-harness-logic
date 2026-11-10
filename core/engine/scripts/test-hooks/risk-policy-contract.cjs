'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const policyPath = path.join(HARNESS_ROOT, 'engine', 'scripts', 'lib', 'risk-policy.cjs');

function assertBasicClassification(policy) {
  const observed = policy.classifyRisk({ toolName: 'Read', readOnly: true });
  assert.equal(observed.minimumRiskLevel, 'R0');
  assert.equal(observed.effectiveRiskLevel, 'R0');

  const ordinary = policy.classifyRisk({
    toolName: 'Edit',
    mutating: true,
    existingFile: true,
    internalChange: true,
  });
  assert.equal(ordinary.minimumRiskLevel, 'R1');

  const strict = policy.classifyRisk({
    toolName: 'Write',
    mutating: true,
    newModule: true,
    interfaceChange: true,
  });
  assert.equal(strict.minimumRiskLevel, 'R2');

  const protectedAction = policy.classifyRisk({
    toolName: 'Bash',
    mutating: true,
    destructive: true,
    protectedTarget: true,
    releaseAction: true,
  });
  assert.equal(protectedAction.minimumRiskLevel, 'R3');
}

function assertMonotonicRisk(policy) {
  const attemptedDowngrade = policy.classifyRisk({
    toolName: 'Write',
    mutating: true,
    interfaceChange: true,
    agentRiskLevel: 'R0',
  });
  assert.equal(attemptedDowngrade.minimumRiskLevel, 'R2');
  assert.equal(attemptedDowngrade.effectiveRiskLevel, 'R2',
    'agent-selected risk must not lower the harness minimum');

  const voluntaryUpgrade = policy.classifyRisk({
    toolName: 'Edit',
    mutating: true,
    existingFile: true,
    internalChange: true,
    agentRiskLevel: 'R2',
  });
  assert.equal(voluntaryUpgrade.minimumRiskLevel, 'R1');
  assert.equal(voluntaryUpgrade.effectiveRiskLevel, 'R2',
    'agent-selected risk may upgrade the harness minimum');

  const uncertain = policy.classifyRisk({
    toolName: 'Edit',
    mutating: true,
    existingFile: true,
    graphStale: true,
  });
  assert.equal(uncertain.minimumRiskLevel, 'R2',
    'stale dependency evidence must raise risk by exactly one level');
  assert(uncertain.riskReasons.includes('stale-dependency-evidence'));
}

function assertPolicyModes(policy) {
  assert.equal(policy.riskPolicyMode({}), 'shadow');
  assert.equal(policy.riskPolicyMode({ CLAUDE_RISK_POLICY_MODE: 'off' }), 'off');
  assert.equal(policy.riskPolicyMode({ CLAUDE_RISK_POLICY_MODE: 'enforce' }), 'enforce');
  assert.equal(policy.riskPolicyMode({ CLAUDE_RISK_POLICY_MODE: 'invalid' }), 'shadow');

  const r0 = policy.applyRiskPolicy({ effectiveRiskLevel: 'R0', riskReasons: ['read-only'] }, {
    mode: 'shadow',
  });
  assert.equal(r0.decision, 'allow');
  assert.equal(r0.advisory, null, 'R0 must stay silent');

  const r2 = policy.applyRiskPolicy({
    minimumRiskLevel: 'R2',
    effectiveRiskLevel: 'R2',
    riskReasons: ['interface-change'],
  }, { mode: 'shadow' });
  assert.equal(r2.decision, 'warn');
  assert.equal(r2.blocking, false);
  assert(r2.advisory.message.length <= 320);

  const blocked = policy.applyRiskPolicy({
    minimumRiskLevel: 'R3',
    effectiveRiskLevel: 'R3',
    riskReasons: ['protected-target'],
  }, { mode: 'enforce', authorized: false });
  assert.equal(blocked.decision, 'block');
  assert.equal(blocked.diagnostics.length, 1, 'a block must present one primary reason');
  assert.match(blocked.remediation, /authorization|evidence/i);

  const authorized = policy.applyRiskPolicy({
    minimumRiskLevel: 'R3',
    effectiveRiskLevel: 'R3',
    riskReasons: ['protected-target'],
  }, { mode: 'enforce', authorized: true });
  assert.notEqual(authorized.decision, 'block');

  const disabled = policy.applyRiskPolicy({
    minimumRiskLevel: 'R3',
    effectiveRiskLevel: 'R3',
    riskReasons: ['protected-target'],
  }, { mode: 'off', authorized: false });
  assert.equal(disabled.decision, 'allow');
  assert.equal(disabled.advisory, null);
}

function assertAcceptanceCorpus(policy) {
  const highRiskCorpus = [
    { name: 'destructive', facts: { toolName: 'Bash', mutating: true, destructive: true } },
    { name: 'protected', facts: { toolName: 'Edit', mutating: true, protectedTarget: true } },
    { name: 'release', facts: { toolName: 'Bash', mutating: true, releaseAction: true } },
    { name: 'cross-project', facts: { toolName: 'Write', mutating: true, crossProject: true } },
  ];
  const highRiskResults = highRiskCorpus.map(({ name, facts }) => ({
    name,
    assessment: policy.classifyRisk(facts),
  }));
  assert.equal(
    highRiskResults.filter(entry => entry.assessment.effectiveRiskLevel === 'R3').length,
    highRiskCorpus.length,
    'high-risk corpus detection must be 100%',
  );
  for (const entry of highRiskResults) {
    const result = policy.applyRiskPolicy(entry.assessment, { mode: 'enforce', authorized: false });
    assert.equal(result.decision, 'block', `${entry.name} must block without exact authorization`);
    assert.match(result.remediation, /authorization|evidence/i,
      `${entry.name} block must include remediation`);
  }

  const ordinaryCorpus = [
    { toolName: 'Read', readOnly: true },
    { toolName: 'Edit', mutating: true, existingFile: true, internalChange: true },
    { toolName: 'Write', mutating: true, existingFile: true, internalChange: true },
    { toolName: 'Bash', readOnly: true },
  ];
  const ordinaryResults = ordinaryCorpus.map(facts => {
    const assessment = policy.classifyRisk(facts);
    return {
      assessment,
      outcome: policy.applyRiskPolicy(assessment, { mode: 'enforce', authorized: false }),
    };
  });
  assert.equal(ordinaryResults.filter(entry => entry.outcome.decision === 'block').length, 0,
    'review corpus must have zero false blocks for ordinary local work');
  assert(ordinaryResults.every(entry => !entry.assessment.requiredEvidence.includes('fresh-signoff-evidence')),
    'ordinary local work must not request full signoff evidence');
}

function assertVerificationEvidenceLevels(policy) {
  assert.equal(policy.verificationEvidenceLevel(
    'node engine/scripts/test-hooks/risk-policy-contract.cjs',
  ), 'R1');
  assert.equal(policy.verificationEvidenceLevel(
    'node engine/scripts/test-hooks/postflight-router-contract.cjs',
  ), 'R1');
  assert.equal(policy.verificationEvidenceLevel('pytest'), 'R2');
  assert.equal(policy.verificationEvidenceLevel('npm test'), 'R2');
  assert.equal(policy.verificationEvidenceLevel(
    'node engine/scripts/test-hooks/run-all-tests.cjs',
  ), 'R3');
  assert.equal(policy.verificationEvidenceLevel('vivado -mode batch -source post-route-signoff.tcl'), 'R3');
  assert.equal(policy.verificationEvidenceLevel('ruff check .'), 'R0',
    'lint alone must not become functional evidence');
}

function assertContentAddressedEvidence(policy) {
  const first = policy.buildEvidenceKey({
    projectRoot: 'C:/repo',
    fileHashes: [
      { path: 'src/b.cjs', sha256: 'b'.repeat(64) },
      { path: 'src/a.cjs', sha256: 'a'.repeat(64) },
    ],
    testHashes: [{ path: 'tests/contract.cjs', sha256: 'c'.repeat(64) }],
    goldenHashes: [{ path: 'golden/model.json', sha256: 'd'.repeat(64) }],
    command: 'node   tests/contract.cjs',
    toolVersions: { node: 'v24.0.0' },
    riskLevel: 'R2',
  });
  const reordered = policy.buildEvidenceKey({
    projectRoot: 'C:\\repo\\',
    fileHashes: [
      { path: 'src/a.cjs', sha256: 'a'.repeat(64) },
      { path: 'src/b.cjs', sha256: 'b'.repeat(64) },
    ],
    testHashes: [{ path: 'tests/contract.cjs', sha256: 'c'.repeat(64) }],
    goldenHashes: [{ path: 'golden/model.json', sha256: 'd'.repeat(64) }],
    command: 'node tests/contract.cjs',
    toolVersions: { node: 'v24.0.0' },
    riskLevel: 'R2',
  });
  assert.equal(first.evidenceKey, reordered.evidenceKey,
    'evidence key must ignore input ordering and insignificant command whitespace');
  assert.equal(first.contentHash, reordered.contentHash);

  const changed = policy.buildEvidenceKey({
    ...first.inputs,
    fileHashes: [{ path: 'src/a.cjs', sha256: 'e'.repeat(64) }],
  });
  assert.notEqual(changed.evidenceKey, first.evidenceKey,
    'changed source content must invalidate cached evidence');

  const cacheEntry = {
    status: 'pass',
    evidenceKey: first.evidenceKey,
    riskLevel: 'R2',
    expiresAt: '2026-08-21T00:00:00.000Z',
  };
  assert.equal(policy.canReuseEvidence(cacheEntry, {
    evidenceKey: first.evidenceKey,
    riskLevel: 'R2',
    now: '2026-08-20T12:00:00.000Z',
  }), true);
  assert.equal(policy.canReuseEvidence(cacheEntry, {
    evidenceKey: first.evidenceKey,
    riskLevel: 'R3',
    now: '2026-08-20T12:00:00.000Z',
  }), false, 'R3 signoff evidence must always be fresh');
}

function assertStickyRiskState(policy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-state-'));
  const stateFile = path.join(root, 'verify-gate.json');
  const previousStateFile = process.env.CLAUDE_VERIFY_GATE_STATE_FILE;
  process.env.CLAUDE_VERIFY_GATE_STATE_FILE = stateFile;
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture\n', 'utf8');
  fs.writeFileSync(stateFile, JSON.stringify({ version: 3, pending: {} }), 'utf8');
  const verificationStatePath = path.join(
    HARNESS_ROOT, 'engine', 'scripts', 'lib', 'verification-state.cjs',
  );
  delete require.cache[require.resolve(verificationStatePath)];
  const state = require(verificationStatePath);
  try {
    assert.equal(state.readVerificationState().version, 4,
      'v3 verification state must migrate to v4');

    state.markRisk({
      cwd: root,
      filePath: path.join(root, 'src', 'ordinary.cjs'),
      sessionId: 'risk-session',
      assessment: {
        minimumRiskLevel: 'R1',
        effectiveRiskLevel: 'R1',
        riskReasons: ['state-changing-action'],
        requiredEvidence: ['targeted-test'],
      },
      now: '2026-08-20T01:00:00.000Z',
      ttlMs: 60_000,
    });
    state.markRisk({
      cwd: root,
      filePath: path.join(root, 'src', 'interface.cjs'),
      sessionId: 'risk-session',
      assessment: {
        minimumRiskLevel: 'R2',
        effectiveRiskLevel: 'R2',
        riskReasons: ['interface-change'],
        requiredEvidence: ['affected-regression'],
      },
      now: '2026-08-20T01:00:10.000Z',
      ttlMs: 60_000,
    });
    state.markRisk({
      cwd: root,
      filePath: path.join(root, 'src', 'ordinary.cjs'),
      sessionId: 'risk-session',
      assessment: {
        minimumRiskLevel: 'R1',
        effectiveRiskLevel: 'R1',
        riskReasons: ['state-changing-action'],
        requiredEvidence: ['targeted-test'],
      },
      now: '2026-08-20T01:00:20.000Z',
      ttlMs: 60_000,
    });

    const payload = { cwd: root, session_id: 'risk-session' };
    let active = state.riskForPayload(state.readVerificationState({
      now: '2026-08-20T01:00:30.000Z',
    }), payload, { now: '2026-08-20T01:00:30.000Z' });
    assert.equal(active.length, 1);
    assert.equal(active[0].effectiveRiskLevel, 'R2',
      'task risk must not fall after a later low-risk action');
    assert.equal(active[0].targets.length, 2);

    state.markRiskVerificationStatusForCwd(root, {
      sessionId: 'risk-session',
      status: 'unavailable',
      reason: 'required toolchain is unavailable',
      now: '2026-08-20T01:00:32.000Z',
    });
    active = state.riskForPayload(state.readVerificationState({
      now: '2026-08-20T01:00:33.000Z',
    }), payload, { now: '2026-08-20T01:00:33.000Z' });
    assert.equal(active[0].verificationStatus, 'unavailable');
    assert.match(active[0].verificationReason, /toolchain/);

    let cleared = state.markRiskVerifiedForCwd(root, {
      sessionId: 'risk-session',
      evidenceRiskLevel: 'R1',
      now: '2026-08-20T01:00:35.000Z',
    });
    assert.equal(cleared.cleared.length, 0,
      'R1 evidence must not clear sticky R2 risk');
    cleared = state.markRiskVerifiedForCwd(root, {
      sessionId: 'risk-session',
      evidenceRiskLevel: 'R2',
      now: '2026-08-20T01:00:40.000Z',
    });
    assert.equal(cleared.cleared.length, 1);

    state.markRisk({
      cwd: root,
      filePath: path.join(root, 'src', 'expires.cjs'),
      sessionId: 'expiring-session',
      assessment: {
        minimumRiskLevel: 'R1',
        effectiveRiskLevel: 'R1',
        riskReasons: ['state-changing-action'],
      },
      now: '2026-08-20T01:00:41.000Z',
      ttlMs: 1_000,
    });
    const expiringPayload = { cwd: root, session_id: 'expiring-session' };
    active = state.riskForPayload(state.readVerificationState({
      now: '2026-08-20T01:00:43.000Z',
    }), expiringPayload, { now: '2026-08-20T01:00:43.000Z' });
    assert.equal(active.length, 0, 'expired risk state must be ignored');

    const descriptor = policy.buildEvidenceKey({
      projectRoot: root,
      fileHashes: [{ path: 'src/interface.cjs', sha256: 'a'.repeat(64) }],
      testHashes: [{ path: 'tests/risk.cjs', sha256: 'b'.repeat(64) }],
      goldenHashes: [],
      command: 'node tests/risk.cjs',
      toolVersions: { node: process.version },
      riskLevel: 'R2',
    });
    state.recordRiskEvidence({
      ...descriptor,
      projectRoot: root,
      riskLevel: 'R2',
      command: 'node tests/risk.cjs',
      now: '2026-08-20T02:00:00.000Z',
      ttlMs: 60_000,
    });
    const cacheState = state.readVerificationState({ now: '2026-08-20T02:00:30.000Z' });
    assert(state.findReusableRiskEvidence(cacheState, {
      projectRoot: root,
      riskLevel: 'R2',
      evidenceKey: descriptor.evidenceKey,
      now: '2026-08-20T02:00:30.000Z',
    }));
    assert.equal(state.findReusableRiskEvidence(cacheState, {
      projectRoot: root,
      riskLevel: 'R3',
      evidenceKey: descriptor.evidenceKey,
      now: '2026-08-20T02:00:30.000Z',
    }), null, 'v4 cache must never satisfy R3');

    const inserted = [];
    for (let index = 0; index < 4; index += 1) {
      const bounded = policy.buildEvidenceKey({
        projectRoot: root,
        fileHashes: [{ path: `src/cache-${index}.cjs`, sha256: String(index).repeat(64) }],
        testHashes: [],
        goldenHashes: [],
        command: `node tests/cache-${index}.cjs`,
        toolVersions: { node: process.version },
        riskLevel: 'R1',
      });
      inserted.push(bounded.evidenceKey);
      state.recordRiskEvidence({
        ...bounded,
        projectRoot: root,
        riskLevel: 'R1',
        command: `node tests/cache-${index}.cjs`,
        now: `2026-08-20T02:0${index + 1}:00.000Z`,
        ttlMs: 10 * 60_000,
        maxEntries: 3,
      });
    }
    const boundedState = state.readVerificationState({ now: '2026-08-20T02:04:30.000Z' });
    assert.equal(Object.keys(boundedState.evidenceCache).length, 3,
      'content-addressed evidence cache must be bounded');
    assert.equal(boundedState.evidenceCache[inserted[0]], undefined,
      'bounded cache must evict the oldest evidence first');
  } finally {
    if (previousStateFile === undefined) delete process.env.CLAUDE_VERIFY_GATE_STATE_FILE;
    else process.env.CLAUDE_VERIFY_GATE_STATE_FILE = previousStateFile;
    delete require.cache[require.resolve(verificationStatePath)];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  const policy = require(policyPath);
  assertBasicClassification(policy);
  assertMonotonicRisk(policy);
  assertPolicyModes(policy);
  assertAcceptanceCorpus(policy);
  assertVerificationEvidenceLevels(policy);
  assertContentAddressedEvidence(policy);
  assertStickyRiskState(policy);
  process.stdout.write('RISK_POLICY_RESULT: PASS\n');
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
