#!/usr/bin/env node
'use strict';

/**
 * Contract test for cost-state-ingest.cjs.
 * Runs the script against a synthetic fixture transcript and asserts:
 *  - report shape (all required top-level fields)
 *  - cost-state / assistant-usage dedupe keys collapse double-writes
 *  - token totals are summed once per unique message
 *  - recorded-vs-price mismatch detection triggers (>2%) and stays silent when within tolerance
 *  - malformed lines are skipped and counted
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'cost-state-ingest.cjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'cost-state-ingest-fixture.jsonl');

let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function main() {
  const tmpOut = path.join(os.tmpdir(), `cost-state-report-contract-${process.pid}-${Date.now()}.json`);
  let result;
  try {
    result = spawnSync(process.execPath, [
      SCRIPT,
      '--glob', FIXTURE.replace(/\\/g, '/'),
      '--out', tmpOut,
      '--prices', path.join(__dirname, '..', '..', 'config', 'cost-prices.json'),
      '--json',
    ], { encoding: 'utf8', timeout: 30000 });
  } catch (error) {
    process.stdout.write(`contract test could not spawn script: ${error.message}\n`);
    process.exit(1);
  }

  assert('script exits 0', result.status === 0, `status=${result.status} stderr=${(result.stderr || '').slice(0, 400)}`);

  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    /* handled below */
  }
  assert('stdout is valid report JSON', !!report);

  if (!report) {
    process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  }

  // 1. required top-level fields
  for (const field of ['generatedAt', 'priceVersion', 'filesScanned', 'sessions', 'totals', 'modelRollup', 'mismatches', 'priceGaps']) {
    assert(`report has ${field}`, report[field] !== undefined);
  }

  // 2. bad line skipped and counted
  assert('parseErrors === 1 (malformed line skipped)', report.filesScanned.parseErrors === 1,
    `got ${report.filesScanned.parseErrors}`);

  // 3. dedupe: 3 raw assistant usage records -> 2 unique message.id
  assert('usageRaw === 3', report.filesScanned.usageRaw === 3, `got ${report.filesScanned.usageRaw}`);
  assert('usageDeduped === 2 (message.id dedupe)', report.filesScanned.usageDeduped === 2,
    `got ${report.filesScanned.usageDeduped}`);

  // 4. dedupe: 3 raw cost-state records -> 2 unique snapshots
  assert('costStateRaw === 3', report.filesScanned.costStateRaw === 3, `got ${report.filesScanned.costStateRaw}`);
  assert('costStateDeduped === 2 (sessionId|startTime|totalCostUSD dedupe)',
    report.filesScanned.costStateDeduped === 2, `got ${report.filesScanned.costStateDeduped}`);

  // 5. session: single session, final cumulative snapshot wins
  assert('exactly one session', report.sessions.length === 1, `got ${report.sessions.length}`);
  const session = report.sessions[0];
  assert('session final totalCostUSD === 8.5 (max snapshot kept)',
    session && session.costState.totalCostUSD === 8.5,
    `got ${session && session.costState.totalCostUSD}`);
  assert('session keeps byModel with both models',
    session && session.costState.byModel && session.costState.byModel['claude-opus-5']
    && session.costState.byModel['claude-haiku-4-5-20251001']);

  // 6. token totals counted once per unique message
  const totals = report.totals;
  assert('totals.inputTokens === 2010 (10+2000, dup excluded)', totals.inputTokens === 2010, `got ${totals.inputTokens}`);
  assert('totals.outputTokens === 105 (5+100)', totals.outputTokens === 105, `got ${totals.outputTokens}`);
  assert('totals.cacheReadInputTokens === 2', totals.cacheReadInputTokens === 2, `got ${totals.cacheReadInputTokens}`);
  assert('totals.cacheCreationInputTokens === 1', totals.cacheCreationInputTokens === 1, `got ${totals.cacheCreationInputTokens}`);

  // 7. mismatch detection: opus recorded 8.5 vs expected 7.9125 -> ~7.42% deviation
  assert('exactly one mismatch', report.mismatches.length === 1,
    `got ${report.mismatches.length}: ${JSON.stringify(report.mismatches)}`);
  const mismatch = report.mismatches[0];
  assert('mismatch is claude-opus-5', mismatch && mismatch.model === 'claude-opus-5',
    mismatch && mismatch.model);
  assert('mismatch has recorded/expected/deltaPct fields',
    mismatch && typeof mismatch.recorded === 'number' && typeof mismatch.expected === 'number'
    && typeof mismatch.deltaPct === 'number');
  assert('mismatch deltaPct magnitude > 2', mismatch && Math.abs(mismatch.deltaPct) > 2,
    mismatch && `deltaPct=${mismatch.deltaPct}`);
  assert('mismatch recorded === 8.5', mismatch && mismatch.recorded === 8.5,
    mismatch && mismatch.recorded);
  assert('mismatch expected === 7.9125', mismatch && mismatch.expected === 7.9125,
    mismatch && mismatch.expected);

  // 8. haiku within tolerance -> no mismatch, no price gap
  assert('priceGaps empty for fixture', report.priceGaps.length === 0,
    JSON.stringify(report.priceGaps));

  // 9. model rollup normalized (dated haiku variant merges under claude-haiku-4-5)
  const rollup = report.modelRollup;
  assert('rollup has normalized claude-haiku-4-5', !!rollup['claude-haiku-4-5'],
    Object.keys(rollup).join(','));
  assert('rollup haiku inputTokens === 2000', rollup['claude-haiku-4-5']
    && rollup['claude-haiku-4-5'].inputTokens === 2000);
  assert('rollup opus recordedCostUSD === 8.5', rollup['claude-opus-5']
    && rollup['claude-opus-5'].recordedCostUSD === 8.5,
    rollup['claude-opus-5'] && rollup['claude-opus-5'].recordedCostUSD);

  // 10. report file written atomically and parses
  let fileReport = null;
  try {
    fileReport = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
  } catch {
    /* handled below */
  }
  assert('--out file written and parses', !!fileReport && fileReport.generatedAt === report.generatedAt);
  try { fs.unlinkSync(tmpOut); } catch { /* best effort */ }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main();
