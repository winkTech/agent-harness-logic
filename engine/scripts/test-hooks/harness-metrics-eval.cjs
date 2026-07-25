#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HOME = path.resolve(__dirname, '..', '..', '..');
const CORPUS_FILE = path.join(__dirname, 'fixtures', 'harness-eval-cases.json');
const {
  computeHarnessMetrics,
  formatHarnessMetrics,
  meetsHarnessTargets,
  validateHarnessCase,
} = require('../lib/harness-metrics.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function test(name, fn) {
  try {
    const detail = fn();
    return { name, status: 'passed', detail: detail || '' };
  } catch (error) {
    return { name, status: 'failed', detail: error.stack || error.message };
  }
}

function runAll() {
  const results = [];

  results.push(test('harness eval case schema is valid JSON', () => {
    JSON.parse(fs.readFileSync(path.join(HOME, 'schemas/harness-eval-case.schema.json'), 'utf8'));
    return 'schema parsed';
  }));

  results.push(test('disk harness eval corpus is valid and reviewable', () => {
    const cases = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));
    assert(Array.isArray(cases), 'corpus must be an array');
    assert(cases.length >= 8, `expected at least 8 cases, got ${cases.length}`);
    const ids = new Set();
    for (const testCase of cases) {
      const validation = validateHarnessCase(testCase);
      assert(validation.ok, `${testCase?.id || '<unknown>'}: ${validation.failures.join('|')}`);
      assert(!ids.has(testCase.id), `duplicate case id: ${testCase.id}`);
      ids.add(testCase.id);
    }
    assert(cases.some((testCase) => testCase.expectedHarnessVerdict === 'pass'), 'corpus needs a pass case');
    assert(cases.some((testCase) => testCase.expectedHarnessVerdict === 'block'), 'corpus needs a block case');
    return `cases=${cases.length}`;
  }));

  results.push(test('case validation rejects missing expected verdict', () => {
    const validation = validateHarnessCase({
      schemaVersion: 1,
      id: 'bad-case',
      difficulty: 'D1',
      riskCategory: 'semantic',
      actualHarnessVerdict: 'pass',
    });
    assert(!validation.ok, 'invalid case should fail validation');
    assert(validation.failures.some((failure) => /expectedHarnessVerdict/.test(failure)), validation.failures.join('|'));
    return validation.failures.join('|');
  }));

  results.push(test('case validation enforces additionalProperties and evidence item types', () => {
    const validation = validateHarnessCase({
      schemaVersion: 1,
      id: 'strict-schema-case',
      difficulty: 'D1',
      riskCategory: 'schema-boundary',
      expectedHarnessVerdict: 'pass',
      actualHarnessVerdict: 'pass',
      evidence: ['valid', 42],
      unexpected: true,
    });
    assert(!validation.ok, 'schema-invalid case should fail validation');
    assert(validation.failures.some((failure) => /unexpected property/.test(failure)), validation.failures.join('|'));
    assert(validation.failures.some((failure) => /evidence/.test(failure)), validation.failures.join('|'));
    return validation.failures.join('|');
  }));

  results.push(test('TPR/TNR metrics expose false positives and false negatives', () => {
    const metrics = computeHarnessMetrics([
      { schemaVersion: 1, id: 'good-pass', difficulty: 'D1', riskCategory: 'true-success', expectedHarnessVerdict: 'pass', actualHarnessVerdict: 'pass' },
      { schemaVersion: 1, id: 'good-block', difficulty: 'D1', riskCategory: 'semantic-failure', expectedHarnessVerdict: 'block', actualHarnessVerdict: 'block' },
      { schemaVersion: 1, id: 'bad-pass', difficulty: 'D2', riskCategory: 'semantic-failure', expectedHarnessVerdict: 'block', actualHarnessVerdict: 'pass' },
      { schemaVersion: 1, id: 'bad-block', difficulty: 'D2', riskCategory: 'true-success', expectedHarnessVerdict: 'pass', actualHarnessVerdict: 'block' },
    ]);
    assert(metrics.overall.tpr === 0.5, `expected TPR 0.5, got ${metrics.overall.tpr}`);
    assert(metrics.overall.tnr === 0.5, `expected TNR 0.5, got ${metrics.overall.tnr}`);
    assert(metrics.overall.falsePositiveRate === 0.5, `expected FPR 0.5, got ${metrics.overall.falsePositiveRate}`);
    return formatHarnessMetrics(metrics);
  }));

  results.push(test('target gate fails nonzero false positive rate', () => {
    const metrics = computeHarnessMetrics([
      { schemaVersion: 1, id: 'semantic-fp', difficulty: 'D2', riskCategory: 'semantic-failure', expectedHarnessVerdict: 'block', actualHarnessVerdict: 'pass' },
    ]);
    const gate = meetsHarnessTargets(metrics, { maxFalsePositiveRate: 0 });
    assert(!gate.ok, 'target gate should fail false positive');
    assert(gate.failures.some((failure) => /FalsePositiveRate/.test(failure)), gate.failures.join('|'));
    return gate.failures.join('|');
  }));

  results.push(test('outcome metrics expose completion latency tool use and intervention', () => {
    const metrics = computeHarnessMetrics([
      {
        schemaVersion: 1,
        id: 'completed-without-help',
        difficulty: 'D1',
        riskCategory: 'true-success',
        expectedHarnessVerdict: 'pass',
        actualHarnessVerdict: 'pass',
        taskCompleted: true,
        durationMs: 100,
        toolCalls: 2,
        userInterventions: 0,
      },
      {
        schemaVersion: 1,
        id: 'incomplete-with-help',
        difficulty: 'D2',
        riskCategory: 'true-success',
        expectedHarnessVerdict: 'pass',
        actualHarnessVerdict: 'block',
        taskCompleted: false,
        durationMs: 300,
        toolCalls: 4,
        userInterventions: 1,
      },
    ]);
    assert(metrics.outcomes.completionRate === 0.5, `completion=${metrics.outcomes.completionRate}`);
    assert(metrics.outcomes.averageDurationMs === 200, `duration=${metrics.outcomes.averageDurationMs}`);
    assert(metrics.outcomes.averageToolCalls === 3, `tools=${metrics.outcomes.averageToolCalls}`);
    assert(metrics.outcomes.userInterventionRate === 0.5, `intervention=${metrics.outcomes.userInterventionRate}`);
    const gate = meetsHarnessTargets(metrics, { maxUserInterventionRate: 0 });
    assert(!gate.ok && gate.failures.some((failure) => /UserInterventionRate/.test(failure)), gate.failures.join('|'));
    return formatHarnessMetrics(metrics);
  }));

  results.push(test('configured outcome targets fail when no samples exist', () => {
    const metrics = computeHarnessMetrics([
      {
        schemaVersion: 1,
        id: 'verdict-only',
        difficulty: 'D1',
        riskCategory: 'missing-outcome-evidence',
        expectedHarnessVerdict: 'pass',
        actualHarnessVerdict: 'pass',
      },
      {
        schemaVersion: 1,
        id: 'blocked-control',
        difficulty: 'D1',
        riskCategory: 'missing-outcome-evidence',
        expectedHarnessVerdict: 'block',
        actualHarnessVerdict: 'block',
      },
    ]);
    const gate = meetsHarnessTargets(metrics, { minCompletionRate: 1 });
    assert(!gate.ok, 'missing completion samples must fail a configured target');
    assert(gate.failures.includes('CompletionRate has no samples'), gate.failures.join('|'));
    return gate.failures.join('|');
  }));

  const failed = results.filter((result) => result.status !== 'passed');
  return {
    schemaVersion: 1,
    mode: 'harness-metrics-eval',
    status: failed.length === 0 ? 'passed' : 'failed',
    results,
  };
}

function main() {
  const manifest = runAll();
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(manifest.status === 'passed' ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  runAll,
};
