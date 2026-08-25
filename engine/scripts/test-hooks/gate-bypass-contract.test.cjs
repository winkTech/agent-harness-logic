#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const BYPASS_MODULE = path.join(ROOT, 'engine', 'scripts', 'lib', 'gate-bypass.cjs');
const GUARDS = [
  path.join(ROOT, 'engine', 'hooks', 'safety', 'fix-in-place-guard.cjs'),
  path.join(ROOT, 'engine', 'scripts', 'hooks', 'verification-quality-guard.cjs'),
  path.join(ROOT, 'engine', 'scripts', 'hooks', 'verification-gate.cjs'),
  path.join(ROOT, 'engine', 'scripts', 'hooks', 'requirements-gate-guard.cjs'),
  path.join(ROOT, 'engine', 'scripts', 'hooks', 'project-directory-guard.cjs'),
  path.join(ROOT, 'engine', 'scripts', 'hooks', 'hdl-gate.cjs'),
  path.join(ROOT, 'engine', 'scripts', 'hooks', 'file-protection-guard.cjs'),
];

function makeAudit(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bypass-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'audit.jsonl');
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_GATES_DISABLE')) delete env[key];
  }
  return { ...env, ...overrides };
}

test('bare CLAUDE_GATES_DISABLED=true is requested but never authorized', (t) => {
  const { evaluateGateBypass } = require(BYPASS_MODULE);
  const auditPath = makeAudit(t);
  const result = evaluateGateBypass({
    gateId: 'file-protection-guard.cjs',
    sessionId: 'session-a',
    now: Date.parse('2026-07-28T12:00:00.000Z'),
    auditPath,
    env: { CLAUDE_GATES_DISABLED: 'true' },
  });

  assert.equal(result.requested, true);
  assert.equal(result.allowed, false);
  assert(result.errors.length > 0, 'missing authorization fields were accepted');
  assert.equal(fs.readFileSync(auditPath, 'utf8').trim().length > 0, true,
    'rejected bypass attempt was not audited');
});

test('complete short-lived bypass is exact-target/session bound and audited without raw identity', (t) => {
  const { evaluateGateBypass } = require(BYPASS_MODULE);
  const auditPath = makeAudit(t);
  const reason = 'approved recovery for a corrupt gate state';
  const actor = 'operator-lihan';
  const sessionId = 'session-bound-123';
  const issuedAt = Date.parse('2026-07-28T12:00:00.000Z');
  const result = evaluateGateBypass({
    gateId: 'file-protection-guard.cjs',
    sessionId,
    now: issuedAt + 30_000,
    auditPath,
    env: {
      CLAUDE_GATES_DISABLED: '1',
      CLAUDE_GATES_DISABLE_REASON: reason,
      CLAUDE_GATES_DISABLE_ACTOR: actor,
      CLAUDE_GATES_DISABLE_TARGET: 'file-protection-guard.cjs',
      CLAUDE_GATES_DISABLE_SESSION: sessionId,
      CLAUDE_GATES_DISABLE_ISSUED_AT: String(issuedAt),
      CLAUDE_GATES_DISABLE_TTL_MS: '60000',
    },
  });

  assert.equal(result.requested, true);
  assert.equal(result.allowed, true, result.errors.join(', '));
  const rawAudit = fs.readFileSync(auditPath, 'utf8');
  assert(!rawAudit.includes(reason), 'audit leaked the raw authorization reason');
  assert(!rawAudit.includes(actor), 'audit leaked the raw actor identity');
  assert(!rawAudit.includes(sessionId), 'audit leaked the raw session identifier');
  const audit = JSON.parse(rawAudit.trim());
  assert.equal(audit.decision, 'allowed');
  assert.match(audit.reasonHash, /^[a-f0-9]{64}$/);
  assert.match(audit.actorHash, /^[a-f0-9]{64}$/);
  assert.match(audit.sessionHash, /^[a-f0-9]{64}$/);
});

test('risk downgrade is exact-action bound, expiring, and consumed once', (t) => {
  const { evaluateGateBypass } = require(BYPASS_MODULE);
  const auditPath = makeAudit(t);
  const sessionId = 'risk-action-session';
  const issuedAt = Date.parse('2026-08-20T04:00:00.000Z');
  const actionHash = 'a'.repeat(64);
  const nonce = 'risk-once-20260820-0001';
  const env = {
    CLAUDE_GATES_DISABLED: '1',
    CLAUDE_GATES_DISABLE_REASON: 'approved one-shot risk downgrade for this exact action',
    CLAUDE_GATES_DISABLE_ACTOR: 'operator-lihan',
    CLAUDE_GATES_DISABLE_TARGET: 'risk-policy.cjs',
    CLAUDE_GATES_DISABLE_SESSION: sessionId,
    CLAUDE_GATES_DISABLE_ISSUED_AT: String(issuedAt),
    CLAUDE_GATES_DISABLE_TTL_MS: '60000',
    CLAUDE_GATES_DISABLE_ACTION_SHA256: actionHash,
    CLAUDE_GATES_DISABLE_NONCE: nonce,
  };
  const options = {
    gateId: 'risk-policy.cjs',
    sessionId,
    now: issuedAt + 1_000,
    auditPath,
    env,
    actionHash,
    requireActionBinding: true,
    oneShot: true,
  };

  const first = evaluateGateBypass(options);
  assert.equal(first.allowed, true, first.errors.join(', '));
  const second = evaluateGateBypass({ ...options, now: issuedAt + 2_000 });
  assert.equal(second.allowed, false, 'one-shot authorization was reusable');
  assert(second.errors.includes('authorization_consumed'));
  const mismatch = evaluateGateBypass({
    ...options,
    now: issuedAt + 3_000,
    actionHash: 'b'.repeat(64),
  });
  assert.equal(mismatch.allowed, false);
  assert(mismatch.errors.includes('action_mismatch'));

  const raw = fs.readFileSync(auditPath, 'utf8');
  assert(!raw.includes(nonce), 'audit leaked the one-shot nonce');
  const records = raw.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(records.filter(record => record.decision === 'allowed').length, 1);
  assert(records.every(record => /^[a-f0-9]{64}$/.test(record.nonceHash)));
  assert(records.every(record => /^[a-f0-9]{64}$/.test(record.authorizationHash)));
});

test('a real blocking guard fails closed when only the legacy global switch is set', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bypass-project-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, 'var', 'project-init'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'var', 'project-init', 'directory-contract.json'), '{}\n');
  const auditPath = path.join(projectRoot, 'audit.jsonl');
  const guard = path.join(ROOT, 'engine', 'scripts', 'hooks', 'project-directory-guard.cjs');
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 'session-real-guard',
    cwd: projectRoot,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectRoot, 'rtl', 'bad.sv'), content: 'module bad; endmodule' },
  };
  const baseline = spawnSync(process.execPath, [guard], {
    cwd: projectRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: cleanEnv(),
  });
  const result = spawnSync(process.execPath, [guard], {
    cwd: projectRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: cleanEnv({
      CLAUDE_GATES_DISABLED: 'true',
      CLAUDE_GATES_DISABLE_AUDIT_PATH: auditPath,
    }),
  });

  assert.equal(baseline.status, 2,
    `guard fixture was not blocking before bypass evaluation: ${baseline.stderr || baseline.stdout}`);
  assert.equal(result.status, 2,
    `bare legacy switch bypassed the directory guard: ${result.stderr || result.stdout}`);
  assert(fs.existsSync(auditPath), 'rejected guard-level bypass was not audited');
});

test('every direct guard delegates bypass authorization to the shared contract', () => {
  for (const guard of GUARDS) {
    const source = fs.readFileSync(guard, 'utf8');
    assert(source.includes('gate-bypass.cjs'), `${path.basename(guard)} does not use the shared bypass contract`);
    assert(!/process\.env\.CLAUDE_GATES_DISABLED\s*={2,3}/.test(source),
      `${path.basename(guard)} still contains an unaudited direct bypass`);
  }
});

test('real guard accepts only an unexpired exact gate and session binding', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bypass-bound-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, 'var', 'project-init'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'var', 'project-init', 'directory-contract.json'), '{}\n');
  const guard = path.join(ROOT, 'engine', 'scripts', 'hooks', 'project-directory-guard.cjs');
  const sessionId = 'session-exact-binding';
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: projectRoot,
    tool_name: 'Write',
    tool_input: { file_path: path.join(projectRoot, 'rtl', 'bad.sv'), content: 'module bad; endmodule' },
  });
  const issuedAt = Date.now();
  const base = {
    CLAUDE_GATES_DISABLED: 'true',
    CLAUDE_GATES_DISABLE_REASON: 'approved exact guard recovery',
    CLAUDE_GATES_DISABLE_ACTOR: 'operator-lihan',
    CLAUDE_GATES_DISABLE_TARGET: 'project-directory-guard.cjs',
    CLAUDE_GATES_DISABLE_SESSION: sessionId,
    CLAUDE_GATES_DISABLE_ISSUED_AT: String(issuedAt),
    CLAUDE_GATES_DISABLE_TTL_MS: '60000',
  };
  function run(overrides, name) {
    return spawnSync(process.execPath, [guard], {
      cwd: projectRoot,
      input: payload,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: cleanEnv({
        ...base,
        ...overrides,
        CLAUDE_GATES_DISABLE_AUDIT_PATH: path.join(projectRoot, `${name}.jsonl`),
      }),
    });
  }

  assert.equal(run({}, 'valid').status, 0, 'valid exact-target bypass was not honored');
  assert.equal(run({ CLAUDE_GATES_DISABLE_TARGET: 'hdl-gate.cjs' }, 'wrong-target').status, 2,
    'authorization for another gate leaked across targets');
  assert.equal(run({ CLAUDE_GATES_DISABLE_SESSION: 'another-session' }, 'wrong-session').status, 2,
    'authorization for another session leaked across sessions');
  assert.equal(run({
    CLAUDE_GATES_DISABLE_ISSUED_AT: String(issuedAt - 120_000),
    CLAUDE_GATES_DISABLE_TTL_MS: '1000',
  }, 'expired').status, 2, 'expired authorization was accepted');
});

test('malformed, overbroad, stale, and unauditable requests all fail closed without leaking fields', (t) => {
  const { evaluateGateBypass } = require(BYPASS_MODULE);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bypass-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  const sessionId = 'session-invalid-matrix';
  const base = {
    CLAUDE_GATES_DISABLED: 'true',
    CLAUDE_GATES_DISABLE_REASON: 'approved narrowly scoped recovery',
    CLAUDE_GATES_DISABLE_ACTOR: 'operator-lihan',
    CLAUDE_GATES_DISABLE_TARGET: 'hdl-gate.cjs',
    CLAUDE_GATES_DISABLE_SESSION: sessionId,
    CLAUDE_GATES_DISABLE_ISSUED_AT: String(now - 1000),
    CLAUDE_GATES_DISABLE_TTL_MS: '60000',
  };
  const cases = [
    ['short-reason', { CLAUDE_GATES_DISABLE_REASON: 'too short' }],
    ['short-actor', { CLAUDE_GATES_DISABLE_ACTOR: 'x' }],
    ['wildcard-target', { CLAUDE_GATES_DISABLE_TARGET: '*' }],
    ['wrong-target', { CLAUDE_GATES_DISABLE_TARGET: 'secret-target-value' }],
    ['wrong-session', { CLAUDE_GATES_DISABLE_SESSION: 'another-session' }],
    ['zero-ttl', { CLAUDE_GATES_DISABLE_TTL_MS: '0' }],
    ['long-ttl', { CLAUDE_GATES_DISABLE_TTL_MS: '300001' }],
    ['expired', {
      CLAUDE_GATES_DISABLE_ISSUED_AT: String(now - 10000),
      CLAUDE_GATES_DISABLE_TTL_MS: '1000',
    }],
    ['future', { CLAUDE_GATES_DISABLE_ISSUED_AT: String(now + 6000) }],
    ['bad-issued-at', { CLAUDE_GATES_DISABLE_ISSUED_AT: 'not-a-time' }],
    ['out-of-date-range', { CLAUDE_GATES_DISABLE_ISSUED_AT: '8640000000000001' }],
  ];

  for (const [name, override] of cases) {
    const auditPath = path.join(dir, `${name}.jsonl`);
    let result;
    assert.doesNotThrow(() => {
      result = evaluateGateBypass({
        gateId: 'hdl-gate.cjs',
        sessionId,
        now,
        auditPath,
        env: { ...base, ...override },
      });
    }, `${name} crashed bypass evaluation`);
    assert.equal(result.allowed, false, `${name} was authorized`);
    if (name === 'wrong-target') {
      assert.notEqual(result.target, 'secret-target-value', 'API returned a rejected raw target');
    }
    if (fs.existsSync(auditPath)) {
      const raw = fs.readFileSync(auditPath, 'utf8');
      assert(!raw.includes('secret-target-value'), `${name} leaked a rejected target`);
      assert(!raw.includes(sessionId), `${name} leaked a session identifier`);
    }
  }

  const directoryAsAudit = path.join(dir, 'directory.jsonl');
  fs.mkdirSync(directoryAsAudit);
  const unauditable = evaluateGateBypass({
    gateId: 'hdl-gate.cjs',
    sessionId,
    now,
    auditPath: directoryAsAudit,
    env: base,
  });
  assert.equal(unauditable.allowed, false, 'authorization survived an audit write failure');
  assert(unauditable.errors.includes('audit_write_failed'));

  const outsideAudit = path.resolve(os.tmpdir(), '..', `outside-${process.pid}.jsonl`);
  const outOfScope = evaluateGateBypass({
    gateId: 'hdl-gate.cjs',
    sessionId,
    now,
    auditPath: outsideAudit,
    env: base,
  });
  assert.equal(outOfScope.allowed, false, 'out-of-scope audit path was accepted');
  assert(outOfScope.errors.includes('audit_path_out_of_scope'));
});

test('file protection uses explicit project paths while retaining known model directory boundaries', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'file-protection-manifest-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const contractDir = path.join(projectRoot, 'var', 'project-init');
  fs.mkdirSync(contractDir, { recursive: true });
  fs.writeFileSync(path.join(contractDir, 'directory-contract.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectName: 'manifest-protection-fixture',
    protectedPaths: ['references/anchor.py', 'models/bittrue'],
  }, null, 2)}\n`);
  const guard = path.join(ROOT, 'engine', 'scripts', 'hooks', 'file-protection-guard.cjs');
  function run(filePath) {
    return spawnSync(process.execPath, [guard], {
      cwd: projectRoot,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'file-protection-session',
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'fixture' },
      }),
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: cleanEnv({
        CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
        CLAUDE_PROTECTED_WRITE_APPROVAL: '',
        CLAUDE_PROTECTED_WRITE_REASON: '',
      }),
    });
  }

  assert.equal(run(path.join(projectRoot, 'reports', 'golden_notes.md')).status, 0,
    'a filename merely containing golden was globally blocked without a matching protected path');
  assert.equal(run(path.join(projectRoot, 'references', 'anchor.py')).status, 2,
    'an exact manifest protected path was not blocked');
  assert.equal(run(path.join(projectRoot, 'models', 'bittrue', 'coefficients.json')).status, 2,
    'a child of a manifest protected directory was not blocked');
  // 仓库内既有路径改用模块判定, 不再看 CLI 退出码。这两条断言的是"边界还认得出",
  // 而退出码同时受**当前是否存在有效批准令牌**影响 —— 用户放一张合法令牌, 边界照旧
  // 成立但退出码变 0, 断言会无故翻红。更糟的是 spawn 走的是完整放行路径, 测试因此
  // 会去动真实的授权状态。判定用 decision: 无批准 block / 有批准 warn, 两者都不是 allow。
  const guardModule = require(path.join(ROOT, 'engine', 'scripts', 'hooks', 'file-protection-guard.cjs'));
  function boundaryDecision(filePath) {
    return guardModule.evaluate(
      { tool_name: 'Write', tool_input: { file_path: filePath } },
      { cwd: projectRoot, env: {} },
    ).decision;
  }

  assert.notEqual(boundaryDecision(path.join(ROOT, 'engineering-assets', 'models', 'comm', 'ofdm', 'manifest.json')),
    'allow', 'the governed engineering-assets/models boundary was not protected');
  assert.notEqual(boundaryDecision(path.join(
    ROOT,
    'engineering-assets',
    'knowledge',
    'docs',
    'templates',
    'golden_model_template',
    'config.m',
  )), 'allow', 'the known golden-model directory boundary was not protected');
});
