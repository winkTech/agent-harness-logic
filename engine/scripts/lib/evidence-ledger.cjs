'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  atomicWriteJson,
  readJson,
} = require('./project-scope.cjs');
const { sha256 } = require('./repair-contract.cjs');
const { classifyToolchainRun } = require('./toolchain-health.cjs');

function tail(text, limit = 2000) {
  const value = String(text || '');
  return value.length > limit ? value.slice(value.length - limit) : value;
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

function writeEvidenceLedger(filePath, entry) {
  const ledger = readEvidenceLedger(filePath);
  ledger.entries.push({
    ...entry,
    recordedAt: entry.recordedAt || new Date().toISOString(),
  });
  atomicWriteJson(filePath, ledger);
  return ledger;
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
  commandEvidence,
  ensureEvidenceDir,
  readEvidenceLedger,
  statusFromEvidence,
  writeEvidenceLedger,
};
