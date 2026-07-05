#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HOME = path.resolve(__dirname, '..', '..', '..');
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
