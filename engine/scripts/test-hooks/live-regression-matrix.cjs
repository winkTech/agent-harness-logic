#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MATRIX_SCRIPT = path.join(__dirname, 'agent-managed-action-matrix.cjs');

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8',
    timeout: opts.timeout || 20 * 60 * 1000,
    windowsHide: true,
  });
}

function spawnDiagnostics(result) {
  const rawExitCode = Number.isInteger(result?.status) ? result.status : null;
  const exitCode = rawExitCode === 0xFFFFFFFF ? -1 : rawExitCode;
  const signal = result?.signal || null;
  const error = result?.error?.message || null;
  const errorCode = result?.error?.code || null;
  const combined = `${errorCode || ''}\n${error || ''}`;
  return {
    exitCode,
    rawExitCode,
    signal,
    error,
    errorCode,
    timedOut: errorCode === 'ETIMEDOUT' || /timed out|etimedout/i.test(combined),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function summarizeFalsePositiveControls(matrix) {
  const rows = matrix.runs || [];
  const passedRows = rows.filter((row) => row.status === 'passed');
  const notRunPassed = rows.filter((row) => row.status === 'not_run' && row.dimensions?.overallStatus === 'passed');
  const blockedPassed = rows.filter((row) => row.status === 'blocked' && row.dimensions?.overallStatus === 'passed');
  const allPassedHaveFunctionalEvidence = passedRows.every((row) => row.dimensions?.functionalStatus === 'passed');
  return {
    notRunRowsCountedAsPassed: notRunPassed.length,
    blockedRowsCountedAsPassed: blockedPassed.length,
    allPassedRowsHaveFunctionalEvidence: allPassedHaveFunctionalEvidence,
    ok: notRunPassed.length === 0 && blockedPassed.length === 0 && allPassedHaveFunctionalEvidence,
  };
}

function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const report = args.includes('--report');
  const requireAllPassed = args.includes('--require-all-passed');
  const outRoot = path.resolve(argValue(args, '--out', path.join(os.tmpdir(), 'claude-harness-live-regression', new Date().toISOString().replace(/[:.]/g, '-'))));
  fs.mkdirSync(outRoot, { recursive: true });

  const matrixOut = path.join(outRoot, 'managed-action');
  const matrixArgs = [MATRIX_SCRIPT, '--out', matrixOut];
  const agents = argValue(args, '--agents', '');
  const kinds = argValue(args, '--kinds', '');
  if (agents) matrixArgs.push('--agents', agents);
  if (kinds) matrixArgs.push('--kinds', kinds);
  if (live) matrixArgs.push('--live');
  if (report) matrixArgs.push('--report');
  if (requireAllPassed) matrixArgs.push('--require-all-passed');

  const startedAt = new Date().toISOString();
  const result = runNode(matrixArgs);
  const diagnostics = spawnDiagnostics(result);
  const completedAt = new Date().toISOString();
  const matrixPath = path.join(matrixOut, 'managed-action-matrix.json');
  let matrix = null;
  if (fs.existsSync(matrixPath)) matrix = readJson(matrixPath);
  const fpControls = matrix ? summarizeFalsePositiveControls(matrix) : { ok: false, error: 'matrix manifest missing' };
  const manifest = {
    schemaVersion: 1,
    mode: live ? 'live-regression' : 'readiness-regression',
    live,
    outRoot,
    matrixPath: fs.existsSync(matrixPath) ? matrixPath : null,
    startedAt,
    completedAt,
    matrixExitCode: diagnostics.exitCode,
    matrixRawExitCode: diagnostics.rawExitCode,
    matrixSignal: diagnostics.signal,
    matrixError: diagnostics.error,
    matrixErrorCode: diagnostics.errorCode,
    matrixTimedOut: diagnostics.timedOut,
    matrixStdoutTail: String(result.stdout || '').slice(-2000),
    matrixStderrTail: String(result.stderr || '').slice(-2000),
    summary: matrix?.summary || null,
    falsePositiveControls: fpControls,
    verdict: diagnostics.exitCode === 0 && fpControls.ok ? 'passed' : 'failed',
  };
  const manifestPath = path.join(outRoot, 'live-regression-matrix.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(JSON.stringify({ manifestPath, verdict: manifest.verdict, summary: manifest.summary }, null, 2));
  if (manifest.verdict !== 'passed') process.exit(1);
}

if (require.main === module) main();

module.exports = {
  spawnDiagnostics,
  summarizeFalsePositiveControls,
};
