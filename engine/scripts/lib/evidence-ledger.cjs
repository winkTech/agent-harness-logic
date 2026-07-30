'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  readJson,
  updateJsonFileSync,
} = require('./project-scope.cjs');
const { sha256 } = require('./repair-contract.cjs');
const { classifyToolchainRun } = require('./toolchain-health.cjs');
const { markerVerdict } = require('./verification-markers.cjs');

function tail(text, limit = 2000) {
  const value = String(text || '');
  return value.length > limit ? value.slice(value.length - limit) : value;
}

function canonicalJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== 'object') return entry;
    const out = {};
    for (const key of Object.keys(entry).sort()) {
      if (entry[key] !== undefined) out[key] = normalize(entry[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function behaviorContractHash(command) {
  const normalized = String(command || '').trim().replace(/\s+/g, ' ');
  if (!normalized) throw new TypeError('behavior contract command is required');
  return sha256(normalized);
}

function evidenceEntrySha256(entry) {
  return sha256(canonicalJson(entry));
}

function commandEvidence(command, runResult, opts = {}) {
  const stdout = String(runResult?.stdout || '');
  const stderr = String(runResult?.stderr || '');
  const startedAt = opts.startedAt || runResult?.startedAt || new Date().toISOString();
  const completedAt = opts.completedAt || runResult?.completedAt || new Date().toISOString();
  const status = runResult?.status ?? runResult?.exitCode ?? null;
  const classification = classifyToolchainRun({
    command,
    status,
    signal: runResult?.signal || null,
    error: runResult?.error || null,
    stdout,
    stderr,
  });

  // Claude Code 的 Bash tool_response 只有 {stdout, stderr, interrupted}, 不带退出码;
  // exitCode:null 因此是"载荷未提供", 不是"没执行"。显式区分, 防止下游 (如候选验证器
  // 核对真实退出码) 把观察型条目误读成 spawn 失败, 也防止把它当成可信的 exit=0。
  const exitCodeKnown = status !== null
    || Boolean(runResult?.signal) || Boolean(runResult?.error);
  const timingKnown = runResult?.durationMs != null
    || Boolean((opts.startedAt || runResult?.startedAt) && (opts.completedAt || runResult?.completedAt));

  // 退出码未知时的状态判定 (2026-07-30 修): 旧实现直接用 classifyToolchainRun
  // 的结论, 而它对 status=null 一律返回 command_failed('did not return a normal
  // exit code') —— 于是**每条**观察型条目都被记成 failed。实测后果: 账本里 25 条
  // verification.accepted=true 的通过记录, 22 条 status='failed', 账本自我矛盾。
  // 现在退出码未知时按共享标记表判定, 既不默认通过也不默认失败:
  //   失败标记 → failed; 正面 PASS 标记 → passed; 都没有 → unknown。
  const failureIndicated = Boolean(runResult?.signal) || Boolean(runResult?.error)
    || runResult?.interrupted === true;
  let entryStatus;
  let statusBasis;
  if (exitCodeKnown || failureIndicated) {
    entryStatus = classification.status === 'passed' ? 'passed' : 'failed';
    statusBasis = 'exit-code';
  } else {
    const verdict = markerVerdict(`${stdout}\n${stderr}`);
    entryStatus = verdict.status;
    statusBasis = verdict.status === 'unknown' ? 'unknown' : 'markers';
  }

  return {
    schemaVersion: 1,
    type: 'command',
    command,
    contractHash: opts.contractHash || behaviorContractHash(command),
    exitCode: status,
    exitCodeKnown,
    signal: runResult?.signal || null,
    error: runResult?.error || null,
    interrupted: runResult?.interrupted === true || undefined,
    startedAt,
    completedAt,
    durationMs: runResult?.durationMs ?? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    timingKnown,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    classification,
    status: entryStatus,
    statusBasis,
  };
}

function readEvidenceLedger(filePath) {
  const ledger = readJson(filePath, null);
  if (!ledger || typeof ledger !== 'object') return { schemaVersion: 1, entries: [] };
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  if (!ledger.schemaVersion) ledger.schemaVersion = 1;
  return ledger;
}

function writeEvidenceLedger(filePath, entry, opts = {}) {
  const configuredMax = Number.parseInt(
    opts.maxEntries ?? process.env.CLAUDE_EVIDENCE_LEDGER_MAX_ENTRIES ?? '500',
    10,
  );
  const maxEntries = Number.isFinite(configuredMax) ? Math.max(10, configuredMax) : 500;
  return updateJsonFileSync(
    filePath,
    () => ({ schemaVersion: 1, entries: [] }),
    (raw) => {
      const ledger = raw && typeof raw === 'object' ? raw : { schemaVersion: 1, entries: [] };
      if (!Array.isArray(ledger.entries)) ledger.entries = [];
      if (!ledger.schemaVersion) ledger.schemaVersion = 1;
      ledger.entries.push({
        ...entry,
        recordedAt: entry.recordedAt || new Date().toISOString(),
      });
      if (ledger.entries.length > maxEntries) {
        const dropped = ledger.entries.length - maxEntries;
        ledger.entries = ledger.entries.slice(-maxEntries);
        ledger.droppedEntries = Number(ledger.droppedEntries || 0) + dropped;
      }
      return ledger;
    },
  );
}

function statusFromEvidence(entries, expectedCommands = []) {
  const list = Array.isArray(entries) ? entries : [];
  const failures = [];
  const byCommand = new Map(list.map((entry) => [entry.command, entry]));

  for (const command of expectedCommands) {
    if (!byCommand.has(command)) failures.push(`missing evidence for command: ${command}`);
  }
  for (const entry of list) {
    const observed = entry.exitCode === null && entry.exitCodeKnown === false;
    if (entry.classification?.status === 'toolchain_failure' && !observed) {
      failures.push(`toolchain failure for command: ${entry.command}`);
    } else if (entry.exitCode !== null && entry.exitCode !== 0) {
      failures.push(`command failed: ${entry.command} exit=${entry.exitCode}`);
    } else if (entry.status === 'failed') {
      // 观察型条目 (载荷无退出码) 按共享标记表判定的失败
      failures.push(entry.exitCode === null
        ? `command failed by verdict markers: ${entry.command}`
        : `command failed: ${entry.command}`);
    } else if (entry.status === 'unknown' && expectedCommands.includes(entry.command)) {
      // 必需命令没有任何可判读的证据 = 未验证, 不能算通过 (证据边界)
      failures.push(`no readable verdict evidence for required command: ${entry.command}`);
    }
  }

  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
  };
}

function ensureEvidenceDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  behaviorContractHash,
  canonicalJson,
  commandEvidence,
  ensureEvidenceDir,
  evidenceEntrySha256,
  readEvidenceLedger,
  statusFromEvidence,
  writeEvidenceLedger,
};
