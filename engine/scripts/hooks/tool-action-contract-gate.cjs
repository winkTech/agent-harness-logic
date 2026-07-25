#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  buildContext,
  requiresActionContract,
} = require('./agent-transparency-ledger.cjs');

const CONTROLLED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'Workflow']);
const DEFAULT_MAX_AGE_MS = 30 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function block(reason, detail = '') {
  console.error('[tool-action-contract-gate] BLOCKED');
  console.error(`reason: ${reason}`);
  if (detail) console.error(`detail: ${detail}`);
  console.error('required: run agent-transparency-ledger first and preserve the fresh tool-action-contract.json artifact.');
  process.exit(2);
}

function maxAgeMs() {
  const value = Number(process.env.CLAUDE_TOOL_ACTION_CONTRACT_MAX_AGE_MS || DEFAULT_MAX_AGE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_AGE_MS;
}

function validate(ctx, contract) {
  if (!contract || typeof contract !== 'object') return 'tool-action-contract.json is missing or invalid JSON';
  if (contract.createdBy !== 'agent-transparency-ledger') return 'contract was not created by agent-transparency-ledger';
  if (contract.runId !== ctx.runId) return `runId mismatch: expected ${ctx.runId}, got ${contract.runId || 'missing'}`;
  if (contract.tool !== ctx.toolName) return `tool mismatch: expected ${ctx.toolName}, got ${contract.tool || 'missing'}`;
  if ((contract.event || '') !== (ctx.eventName || '')) return `event mismatch: expected ${ctx.eventName || 'unknown'}, got ${contract.event || 'missing'}`;

  if (contract.loopScope?.status === 'blocked') {
    return `cross-thread delegation blocked: ${contract.loopScope.reason || 'loop scope mismatch'}`;
  }
  if (ctx.loopScope?.isDelegation) {
    if (!contract.loopScope) return 'cross-thread delegation is missing a loop scope contract';
    if (contract.loopScope.currentThreadId !== ctx.loopScope.currentThreadId) return 'loop scope current thread mismatch';
    if (contract.loopScope.sourceThreadId !== ctx.loopScope.sourceThreadId) return 'loop scope source thread mismatch';
    if (contract.loopScope.objectiveHash !== ctx.loopScope.objectiveHash) return 'loop scope objective hash mismatch';
    if (contract.loopScope.projectRoot !== ctx.loopScope.projectRoot) return 'loop scope project root mismatch';
  }

  const age = Date.now() - Date.parse(contract.updatedAt || '');
  if (!Number.isFinite(age)) return 'contract updatedAt is missing or unparsable';
  if (age > maxAgeMs()) return `contract is stale: ${age}ms old`;

  if (ctx.filePath) {
    const fileHash = contract.toolPayload?.filePathSha256 || '';
    if (fileHash !== sha256(ctx.filePath)) return 'file path hash mismatch';
  }
  if (ctx.command) {
    const commandHash = contract.toolPayload?.commandSha256 || '';
    if (commandHash !== sha256(ctx.command)) return 'command hash mismatch';
  }
  if (ctx.content) {
    const contentHash = contract.toolPayload?.contentSha256 || '';
    if (contentHash !== sha256(ctx.content)) return 'content hash mismatch';
  }

  if (contract.match?.status === 'missing-user-instruction'
      && process.env.CLAUDE_TOOL_ACTION_CONTRACT_ALLOW_MISSING_USER !== '1') {
    return 'latest user instruction was not captured; cannot prove this action matches user intent';
  }

  return '';
}

function run(payload) {
  const ctx = buildContext(payload);
  if (!CONTROLLED_TOOLS.has(ctx.toolName)) return { ok: true, skipped: true };
  if ((ctx.eventName || '') !== 'PreToolUse') return { ok: true, skipped: true };
  if (!requiresActionContract(ctx)) return { ok: true, skipped: true, reason: 'not-high-risk' };

  const filePath = path.join(ctx.runDir, 'tool-action-contract.json');
  let contract = null;
  try {
    contract = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    block('missing contract', filePath);
  }

  const failure = validate(ctx, contract);
  if (failure) block(failure, filePath);
  return { ok: true, skipped: false };
}

function main() {
  const payload = parsePayload(readStdin());
  try {
    const ctx = buildContext(payload);
    if (process.env.CLAUDE_TOOL_ACTION_CONTRACT_GATE_DISABLED === '1'
        && ctx.loopScope?.status !== 'blocked') process.exit(0);
    run(payload);
    process.exit(0);
  } catch (error) {
    if (error && error.code === 'ENOENT') block('missing contract', error.path || '');
    console.error(`[tool-action-contract-gate] internal error: ${error.stack || error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  run,
  validate,
};
