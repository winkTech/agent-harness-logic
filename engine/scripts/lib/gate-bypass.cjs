#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withFileLockSync } = require('./project-scope.cjs');

const HARNESS_ROOT = path.resolve(__dirname, '../../..');
const MIN_REASON_LENGTH = 16;
const MAX_REASON_LENGTH = 512;
const MIN_ACTOR_LENGTH = 3;
const MAX_ACTOR_LENGTH = 128;
const MAX_TTL_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function bypassRequested(env) {
  return ['1', 'true'].includes(String(env?.CLAUDE_GATES_DISABLED || '').trim().toLowerCase());
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveAuditPath(explicitPath, env) {
  const selected = String(
    explicitPath
      || env?.CLAUDE_GATES_DISABLE_AUDIT_PATH
      || path.join(HARNESS_ROOT, 'var', 'audit', 'gate-bypass.jsonl'),
  ).trim();
  if (!selected || !path.isAbsolute(selected) || path.extname(selected).toLowerCase() !== '.jsonl') {
    throw new Error('audit_path_invalid');
  }

  const resolved = path.resolve(selected);
  if (!isWithin(HARNESS_ROOT, resolved) && !isWithin(os.tmpdir(), resolved)) {
    throw new Error('audit_path_out_of_scope');
  }
  return resolved;
}

function appendAudit(auditPath, record) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  const fd = fs.openSync(auditPath, 'a', 0o600);
  try {
    fs.appendFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readAuditRecords(auditPath) {
  try {
    if (!fs.existsSync(auditPath)) return [];
    return fs.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
  } catch {
    return [];
  }
}

function evaluateGateBypass({
  gateId,
  sessionId,
  env = process.env,
  now = Date.now(),
  auditPath,
  actionHash = '',
  requireActionBinding = false,
  oneShot = false,
}) {
  const requested = bypassRequested(env);
  if (!requested) return { requested: false, allowed: false, errors: [] };

  const reason = String(env.CLAUDE_GATES_DISABLE_REASON || '').trim();
  const actor = String(env.CLAUDE_GATES_DISABLE_ACTOR || '').trim();
  const target = String(env.CLAUDE_GATES_DISABLE_TARGET || '').trim();
  const boundSession = String(env.CLAUDE_GATES_DISABLE_SESSION || '').trim();
  const currentSession = String(sessionId || '').trim();
  const issuedAtRaw = String(env.CLAUDE_GATES_DISABLE_ISSUED_AT || '').trim();
  const ttlRaw = String(env.CLAUDE_GATES_DISABLE_TTL_MS || '').trim();
  const issuedAt = /^\d+$/.test(issuedAtRaw) ? Number(issuedAtRaw) : Date.parse(issuedAtRaw);
  const issuedAtValid = Number.isFinite(issuedAt) && Number.isFinite(new Date(issuedAt).getTime());
  const ttlMs = /^\d+$/.test(ttlRaw) ? Number(ttlRaw) : Number.NaN;
  const boundActionHash = String(env.CLAUDE_GATES_DISABLE_ACTION_SHA256 || '').trim().toLowerCase();
  const currentActionHash = String(actionHash || '').trim().toLowerCase();
  const nonce = String(env.CLAUDE_GATES_DISABLE_NONCE || '').trim();
  const errors = [];

  if (reason.length < MIN_REASON_LENGTH) errors.push('reason_too_short');
  if (reason.length > MAX_REASON_LENGTH) errors.push('reason_too_long');
  if (actor.length < MIN_ACTOR_LENGTH) errors.push('actor_too_short');
  if (actor.length > MAX_ACTOR_LENGTH) errors.push('actor_too_long');
  if (!target) errors.push('target_missing');
  else if (target === '*' || target !== String(gateId || '')) errors.push('target_mismatch');
  if (!boundSession) errors.push('session_binding_missing');
  if (!currentSession) errors.push('current_session_missing');
  if (boundSession && currentSession && boundSession !== currentSession) errors.push('session_mismatch');
  if (!issuedAtValid) errors.push('issued_at_invalid');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) errors.push('ttl_invalid');
  if (issuedAtValid && issuedAt > now + MAX_CLOCK_SKEW_MS) errors.push('not_yet_valid');
  if (issuedAtValid && Number.isSafeInteger(ttlMs) && now > issuedAt + ttlMs) {
    errors.push('authorization_expired');
  }
  if (requireActionBinding) {
    if (!/^[a-f0-9]{64}$/.test(boundActionHash)) errors.push('action_binding_missing');
    if (!/^[a-f0-9]{64}$/.test(currentActionHash)) errors.push('action_hash_invalid');
    if (/^[a-f0-9]{64}$/.test(boundActionHash)
        && /^[a-f0-9]{64}$/.test(currentActionHash)
        && boundActionHash !== currentActionHash) errors.push('action_mismatch');
  }
  if (oneShot && (nonce.length < 12 || nonce.length > 128)) errors.push('nonce_invalid');

  let resolvedAuditPath;
  try {
    resolvedAuditPath = resolveAuditPath(auditPath, env);
  } catch (error) {
    errors.push(error.message === 'audit_path_out_of_scope' ? 'audit_path_out_of_scope' : 'audit_path_invalid');
  }

  let allowedBeforeAudit = errors.length === 0;
  const nonceHash = digest(nonce);
  const authorizationHash = digest([
    String(gateId || ''),
    boundSession,
    issuedAtValid ? String(issuedAt) : '',
    Number.isSafeInteger(ttlMs) ? String(ttlMs) : '',
    boundActionHash,
    nonceHash,
  ].join('|'));
  const record = {
    event: 'gate-bypass-evaluation',
    decision: allowedBeforeAudit ? 'allowed' : 'rejected',
    gateId: String(gateId || ''),
    target: target === String(gateId || '') ? target : null,
    targetHash: digest(target),
    targetLength: target.length,
    reasonHash: digest(reason),
    reasonLength: reason.length,
    actorHash: digest(actor),
    sessionHash: digest(boundSession),
    actionHash: /^[a-f0-9]{64}$/.test(boundActionHash) ? boundActionHash : digest(boundActionHash),
    nonceHash,
    authorizationHash,
    evaluatedAt: new Date(now).toISOString(),
    issuedAt: issuedAtValid ? new Date(issuedAt).toISOString() : null,
    ttlMs: Number.isSafeInteger(ttlMs) ? ttlMs : null,
    errors: [...errors],
  };

  if (resolvedAuditPath) {
    try {
      withFileLockSync(resolvedAuditPath, () => {
        if (oneShot && allowedBeforeAudit) {
          const consumed = readAuditRecords(resolvedAuditPath).some(entry =>
            entry.decision === 'allowed' && entry.authorizationHash === authorizationHash
          );
          if (consumed) {
            errors.push('authorization_consumed');
            allowedBeforeAudit = false;
          }
        }
        record.decision = allowedBeforeAudit ? 'allowed' : 'rejected';
        record.errors = [...errors];
        appendAudit(resolvedAuditPath, record);
      });
    } catch {
      errors.push('audit_write_failed');
    }
  }

  return {
    requested: true,
    allowed: allowedBeforeAudit && !errors.includes('audit_write_failed'),
    errors,
    gateId: String(gateId || ''),
    target: target === String(gateId || '') ? target : null,
  };
}

function sessionIdFrom(payload, context, env = process.env) {
  return String(
    payload?.session_id
      || payload?.sessionId
      || payload?.session?.id
      || context?.session_id
      || context?.sessionId
      || context?.session?.id
      || env.CLAUDE_SESSION_ID
      || '',
  ).trim();
}

function evaluateGuardBypass({
  gateId,
  payload,
  context,
  env = process.env,
  now,
  auditPath,
  actionHash,
  requireActionBinding,
  oneShot,
}) {
  const result = evaluateGateBypass({
    gateId,
    sessionId: sessionIdFrom(payload, context, env),
    env,
    ...(now === undefined ? {} : { now }),
    ...(auditPath === undefined ? {} : { auditPath }),
    ...(actionHash === undefined ? {} : { actionHash }),
    ...(requireActionBinding === undefined ? {} : { requireActionBinding }),
    ...(oneShot === undefined ? {} : { oneShot }),
  });
  if (result.requested) {
    console.error(`[gate-bypass] ${JSON.stringify({
      event: 'gate-bypass-evaluation',
      gateId,
      decision: result.allowed ? 'allowed' : 'rejected',
      errors: result.errors,
    })}`);
  }
  return result;
}

module.exports = {
  bypassRequested,
  evaluateGateBypass,
  evaluateGuardBypass,
  sessionIdFrom,
};
