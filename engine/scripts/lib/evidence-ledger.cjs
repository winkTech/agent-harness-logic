'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  readJson,
  updateJsonFileSync,
} = require('./project-scope.cjs');
const { sha256 } = require('./repair-contract.cjs');
const { classifyToolchainRun } = require('./toolchain-health.cjs');

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

  return {
    schemaVersion: 1,
    type: 'command',
    command,
    contractHash: opts.contractHash || behaviorContractHash(command),
    exitCode: status,
    signal: runResult?.signal || null,
    error: runResult?.error || null,
    startedAt,
    completedAt,
    durationMs: runResult?.durationMs ?? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    classification,
    status: classification.status === 'passed' ? 'passed' : 'failed',
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
    if (entry.classification?.status === 'toolchain_failure') {
      failures.push(`toolchain failure for command: ${entry.command}`);
    } else if (entry.exitCode !== 0) {
      failures.push(`command failed: ${entry.command} exit=${entry.exitCode}`);
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
