#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/test-hooks/agent-managed-action-report.cjs <manifest-or-run-dir>',
    '  node engine/scripts/test-hooks/agent-managed-action-report.cjs --json <manifest-or-run-dir>',
    '',
    'Reads managed-action or managed-action-matrix evidence and prints a human-readable report.',
  ].join('\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveManifest(input) {
  const target = path.resolve(input || '');
  if (!target) throw new Error('missing manifest path or run directory');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    for (const name of ['managed-action-matrix.json', 'managed-eval.json']) {
      const candidate = path.join(target, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`no managed-action manifest found in ${target}`);
  }
  if (!fs.existsSync(target)) throw new Error(`manifest does not exist: ${target}`);
  return target;
}

function shortPath(filePath) {
  if (!filePath) return '';
  const cwd = process.cwd();
  const rel = path.relative(cwd, filePath);
  return rel && !rel.startsWith('..') ? rel : filePath;
}

function loadChildManifest(row) {
  if (!row?.manifestPath || !fs.existsSync(row.manifestPath)) return null;
  try {
    return readJson(row.manifestPath);
  } catch {
    return null;
  }
}

function evidenceForManagedEval(manifest) {
  const lines = [];
  for (const check of manifest.functionalChecks || []) {
    lines.push(`${check.name}=${check.status}`);
  }
  for (const failure of manifest.complianceFailures || []) {
    lines.push(`compliance: ${failure}`);
  }
  if (manifest.agentExitCode !== null && manifest.agentExitCode !== undefined) {
    lines.push(`agentExitCode=${manifest.agentExitCode}`);
  }
  return lines;
}

function rowReport(row) {
  const child = loadChildManifest(row);
  const dimensions = row.dimensions || child?.dimensions || {};
  const lines = [];
  lines.push([
    `- ${row.agent || child?.agent || 'agent'}`,
    row.kind || child?.kind || 'unknown',
    `status=${row.status || child?.status || 'unknown'}`,
    `readiness=${row.readinessStatus || child?.readiness?.agent?.status || 'unknown'}`,
    `protocol=${dimensions.protocolCompliance || 'unknown'}`,
    `functional=${dimensions.functionalStatus || 'unknown'}`,
    `overall=${dimensions.overallStatus || row.status || child?.status || 'unknown'}`,
  ].join(' | '));
  if (row.manifestPath) lines.push(`  manifest: ${shortPath(row.manifestPath)}`);
  const childEvidence = child ? evidenceForManagedEval(child) : [];
  if (childEvidence.length > 0) lines.push(`  evidence: ${childEvidence.join('; ')}`);
  const runner = row.evalRunner || {};
  if (runner.error) lines.push(`  runnerError: ${runner.error}`);
  if (runner.status !== undefined && runner.status !== null) lines.push(`  runnerExit=${runner.status}`);
  return lines;
}

function matrixSummary(manifest) {
  const summary = manifest.summary || {};
  return [
    `Manifest: ${shortPath(path.join(manifest.outRoot || '', 'managed-action-matrix.json'))}`,
    `Mode: ${manifest.mode || 'unknown'} live=${Boolean(manifest.live)}`,
    [
      'Summary:',
      `overall=${summary.overallStatus || 'unknown'}`,
      `passed=${summary.passed ?? 0}`,
      `blocked=${summary.blocked ?? 0}`,
      `failed=${summary.failed ?? 0}`,
      `notRun=${summary.notRun ?? 0}`,
      `total=${summary.total ?? (manifest.runs || []).length}`,
    ].join(' '),
    '',
    'Rows:',
    ...(manifest.runs || []).flatMap(rowReport),
    '',
    'False-positive controls:',
    '- blocked rows are not counted as passed',
    '- protocolCompliance and functionalStatus are reported separately',
    '- nonzero agent exits are compliance failures even when JSON is parseable',
    '- unavailable agents emit blocked manifests with no workspace mutation claim',
  ].join('\n');
}

function singleSummary(manifest, manifestPath) {
  const dimensions = manifest.dimensions || {};
  const lines = [
    `Manifest: ${shortPath(manifestPath)}`,
    `Mode: ${manifest.mode || 'unknown'} agent=${manifest.agent || 'unknown'} kind=${manifest.kind || 'unknown'}`,
    [
      'Summary:',
      `status=${manifest.status || 'unknown'}`,
      `protocol=${dimensions.protocolCompliance || 'unknown'}`,
      `functional=${dimensions.functionalStatus || 'unknown'}`,
      `overall=${dimensions.overallStatus || manifest.status || 'unknown'}`,
      `agentExitCode=${manifest.agentExitCode ?? 'not_run'}`,
    ].join(' '),
  ];
  const evidence = evidenceForManagedEval(manifest);
  if (evidence.length > 0) lines.push(`Evidence: ${evidence.join('; ')}`);
  if (manifest.readiness?.agent) {
    lines.push(`Readiness: ${manifest.readiness.agent.agent}=${manifest.readiness.agent.status}`);
  }
  return lines.join('\n');
}

function summarize(manifest, manifestPath) {
  if (manifest.mode === 'managed-action-matrix') return matrixSummary(manifest);
  if (manifest.mode === 'managed-action') return singleSummary(manifest, manifestPath);
  throw new Error(`unsupported manifest mode: ${manifest.mode || 'missing mode'}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    console.log(usage());
    return;
  }
  const json = args.includes('--json');
  const input = args.find((arg) => arg !== '--json');
  const manifestPath = resolveManifest(input);
  const manifest = readJson(manifestPath);
  if (json) {
    console.log(JSON.stringify({ manifestPath, manifest }, null, 2));
    return;
  }
  console.log(summarize(manifest, manifestPath));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
