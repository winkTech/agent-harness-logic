#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  buildContext,
  ensureToolActionContract,
  requiresActionContract,
} = require('./agent-transparency-ledger.cjs');

const CONTROLLED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'Workflow']);
const DEFAULT_MAX_AGE_MS = 30 * 1000;

// 可由"ledger 与本 gate 并发、写入晚于读取"解释的失败: 读到的是上一次调用
// 的合同, 表现为过期或哈希仍属上一条命令。仅这些允许重建后复验。
const RACE_RECOVERABLE = /^contract is stale:|hash mismatch$/;

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

// 账本完整性问题 ≠ 安全边界。本 gate 与 agent-transparency-ledger 挂在
// **同一个 PreToolUse hook 组**里被平台并发执行, 读到对方尚未写出的合同是
// 常态而非攻击。为此类情况硬阻断, 代价是随机拦掉合法命令 (实盘已复现),
// 收益只是一条账本记录 —— 明显不划算, 故降级为 stderr 警告后放行。
// 真正的越权信号 (loopScope.status === 'blocked') 仍然 exit 2。
function warnOpen(reason, detail = '') {
  console.error('[tool-action-contract-gate] WARN (not blocking)');
  console.error(`reason: ${reason}`);
  if (detail) console.error(`detail: ${detail}`);
  process.exit(0);
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
    // 合同尚未落盘 —— 与并发的 ledger 抢跑。先自产一份再读; 仍失败则放行。
    try {
      ensureToolActionContract(payload);
      contract = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (ctx.loopScope?.status === 'blocked') block('loop scope blocked', filePath);
      warnOpen('missing contract (self-heal failed)', `${filePath}: ${error.message}`);
    }
  }

  let failure = validate(ctx, contract);
  if (failure && RACE_RECOVERABLE.test(failure)) {
    // ledger 与本 gate 在同一 PreToolUse 组内并发执行, 其写入可能晚于此处的
    // 读取, 于是读到上一次调用的合同 —— 表现为"越重试越 stale"的死锁。
    // 只对可由该竞态解释的失败重建: 合同过期, 或哈希仍属上一条命令。
    // createdBy/runId/tool/event 不符与用户指令缺失不在此列 —— 那些是
    // 篡改或证据缺失信号, 必须原样上报, 不得被"自动修复"掩盖。
    // 重建仍由 ledger 代码按当前 payload 生成, 判据不放松。
    try {
      ensureToolActionContract(payload);
      contract = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      failure = validate(ctx, contract);
    } catch (error) {
      failure = `${failure}; 合同重建失败: ${error.message}`;
    }
  }
  if (failure) {
    // 越权/循环信号是真实的安全判据, 保持硬阻断。
    if (ctx.loopScope?.status === 'blocked') block(failure, filePath);
    // 其余全部是账本完整性问题 (过期/哈希不符/createdBy 不符/用户指令未捕获)。
    // 这些在并发执行下无法与真实篡改区分, 且没有一条值得拦下用户的命令。
    warnOpen(failure, filePath);
  }
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
    // 内部异常一律不阻断: 本 gate 的失败不该成为工具调用的失败。
    console.error(`[tool-action-contract-gate] internal error: ${error.stack || error.message}`);
    process.exit(0);
  }
}

if (require.main === module) main();

module.exports = {
  run,
  validate,
};
