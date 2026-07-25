'use strict';

const VALID_DIFFICULTIES = new Set(['D1', 'D2', 'D3', 'D4']);
const VALID_VERDICTS = new Set(['pass', 'block']);
const HARNESS_CASE_FIELDS = new Set([
  'schemaVersion',
  'id',
  'difficulty',
  'riskCategory',
  'agent',
  'taskType',
  'sourceSuite',
  'sourceTest',
  'expectedHarnessVerdict',
  'actualHarnessVerdict',
  'taskCompleted',
  'durationMs',
  'toolCalls',
  'userInterventions',
  'evidence',
  'notes',
]);

function normalizeVerdict(value) {
  const raw = String(value || '').toLowerCase();
  if (['pass', 'passed', 'allow', 'allowed', 'accept', 'accepted'].includes(raw)) return 'pass';
  if (['block', 'blocked', 'fail', 'failed', 'reject', 'rejected'].includes(raw)) return 'block';
  return '';
}

function validateHarnessCase(testCase) {
  const failures = [];
  if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)) {
    return { ok: false, failures: ['case must be an object'] };
  }
  if (testCase.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (!testCase.id || typeof testCase.id !== 'string') failures.push('id is required');
  if (!VALID_DIFFICULTIES.has(testCase.difficulty)) failures.push(`difficulty must be one of ${Array.from(VALID_DIFFICULTIES).join(', ')}`);
  if (!testCase.riskCategory || typeof testCase.riskCategory !== 'string') failures.push('riskCategory is required');

  for (const field of Object.keys(testCase)) {
    if (!HARNESS_CASE_FIELDS.has(field)) failures.push(`unexpected property: ${field}`);
  }
  for (const field of ['agent', 'taskType', 'sourceSuite', 'sourceTest', 'notes']) {
    if (testCase[field] !== undefined && typeof testCase[field] !== 'string') {
      failures.push(`${field} must be a string when provided`);
    }
  }
  if (testCase.evidence !== undefined
    && (!Array.isArray(testCase.evidence) || testCase.evidence.some((item) => typeof item !== 'string'))) {
    failures.push('evidence must be an array of strings when provided');
  }

  const expected = testCase.expectedHarnessVerdict;
  const actual = testCase.actualHarnessVerdict;
  if (!VALID_VERDICTS.has(expected)) failures.push('expectedHarnessVerdict must be pass or block');
  if (!VALID_VERDICTS.has(actual)) failures.push('actualHarnessVerdict must be pass or block');
  if (testCase.taskCompleted !== undefined && typeof testCase.taskCompleted !== 'boolean') {
    failures.push('taskCompleted must be boolean when provided');
  }
  for (const field of ['durationMs', 'toolCalls', 'userInterventions']) {
    const value = testCase[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      failures.push(`${field} must be a non-negative number when provided`);
    }
  }

  return { ok: failures.length === 0, failures, expected, actual };
}

function safeRate(num, den) {
  if (!den) return null;
  return Number((num / den).toFixed(6));
}

function safeAverage(total, samples) {
  if (!samples) return null;
  return Number((total / samples).toFixed(3));
}

function emptyOutcomeStats() {
  return {
    completionSamples: 0,
    completed: 0,
    durationSamples: 0,
    totalDurationMs: 0,
    toolCallSamples: 0,
    totalToolCalls: 0,
    interventionSamples: 0,
    totalUserInterventions: 0,
    casesWithUserIntervention: 0,
  };
}

function recordOutcome(stats, testCase) {
  if (typeof testCase.taskCompleted === 'boolean') {
    stats.completionSamples += 1;
    if (testCase.taskCompleted) stats.completed += 1;
  }
  if (Number.isFinite(testCase.durationMs)) {
    stats.durationSamples += 1;
    stats.totalDurationMs += testCase.durationMs;
  }
  if (Number.isFinite(testCase.toolCalls)) {
    stats.toolCallSamples += 1;
    stats.totalToolCalls += testCase.toolCalls;
  }
  if (Number.isFinite(testCase.userInterventions)) {
    stats.interventionSamples += 1;
    stats.totalUserInterventions += testCase.userInterventions;
    if (testCase.userInterventions > 0) stats.casesWithUserIntervention += 1;
  }
}

function finalizeOutcomes(stats) {
  return {
    completionSamples: stats.completionSamples,
    completed: stats.completed,
    completionRate: safeRate(stats.completed, stats.completionSamples),
    durationSamples: stats.durationSamples,
    averageDurationMs: safeAverage(stats.totalDurationMs, stats.durationSamples),
    toolCallSamples: stats.toolCallSamples,
    averageToolCalls: safeAverage(stats.totalToolCalls, stats.toolCallSamples),
    interventionSamples: stats.interventionSamples,
    averageUserInterventions: safeAverage(stats.totalUserInterventions, stats.interventionSamples),
    userInterventionRate: safeRate(stats.casesWithUserIntervention, stats.interventionSamples),
  };
}

function emptyCounts() {
  return {
    truePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
    falsePositive: 0,
    expectedPass: 0,
    expectedBlock: 0,
    total: 0,
  };
}

function finalizeCounts(counts) {
  const tpr = safeRate(counts.truePositive, counts.expectedPass);
  const tnr = safeRate(counts.trueNegative, counts.expectedBlock);
  const falsePositiveRate = safeRate(counts.falsePositive, counts.expectedBlock);
  const falseNegativeRate = safeRate(counts.falseNegative, counts.expectedPass);
  const balancedAccuracy = tpr === null && tnr === null
    ? null
    : Number((((tpr ?? 0) + (tnr ?? 0)) / (Number(tpr !== null) + Number(tnr !== null))).toFixed(6));
  return {
    ...counts,
    tpr,
    tnr,
    balancedAccuracy,
    falsePositiveRate,
    falseNegativeRate,
  };
}

function computeHarnessMetrics(cases = []) {
  const counts = emptyCounts();
  const byDifficulty = {};
  const byRiskCategory = {};
  const invalid = [];
  const outcomes = emptyOutcomeStats();

  for (const testCase of cases) {
    const validation = validateHarnessCase(testCase);
    if (!validation.ok) {
      invalid.push({ id: testCase?.id || '<unknown>', failures: validation.failures });
      continue;
    }

    const expected = validation.expected;
    const actual = validation.actual;
    recordOutcome(outcomes, testCase);
    counts.total += 1;
    if (expected === 'pass') counts.expectedPass += 1;
    else counts.expectedBlock += 1;

    if (!byDifficulty[testCase.difficulty]) byDifficulty[testCase.difficulty] = emptyCounts();
    if (!byRiskCategory[testCase.riskCategory]) byRiskCategory[testCase.riskCategory] = emptyCounts();
    for (const bucket of [byDifficulty[testCase.difficulty], byRiskCategory[testCase.riskCategory]]) {
      bucket.total += 1;
      if (expected === 'pass') bucket.expectedPass += 1;
      else bucket.expectedBlock += 1;
    }

    const isPositive = expected === 'pass';
    const isActualPass = actual === 'pass';
    const outcome = isPositive
      ? (isActualPass ? 'truePositive' : 'falseNegative')
      : (isActualPass ? 'falsePositive' : 'trueNegative');
    counts[outcome] += 1;
    byDifficulty[testCase.difficulty][outcome] += 1;
    byRiskCategory[testCase.riskCategory][outcome] += 1;
  }

  return {
    schemaVersion: 1,
    cases: counts.total,
    invalid,
    overall: finalizeCounts(counts),
    outcomes: finalizeOutcomes(outcomes),
    byDifficulty: Object.fromEntries(Object.entries(byDifficulty).map(([key, value]) => [key, finalizeCounts(value)])),
    byRiskCategory: Object.fromEntries(Object.entries(byRiskCategory).map(([key, value]) => [key, finalizeCounts(value)])),
  };
}

function meetsHarnessTargets(metrics, targets = {}) {
  const minTpr = targets.minTpr ?? 0.8;
  const minTnr = targets.minTnr ?? 0.9;
  const minBalancedAccuracy = targets.minBalancedAccuracy ?? 0.85;
  const maxFalsePositiveRate = targets.maxFalsePositiveRate ?? 0.05;
  const failures = [];
  const overall = metrics?.overall || {};

  const requireMinimum = (label, value, target) => {
    if (target === undefined) return;
    if (value === null || value === undefined) {
      failures.push(`${label} has no samples`);
    } else if (value < target) {
      failures.push(`${label} ${value} < ${target}`);
    }
  };
  const requireMaximum = (label, value, target) => {
    if (target === undefined) return;
    if (value === null || value === undefined) {
      failures.push(`${label} has no samples`);
    } else if (value > target) {
      failures.push(`${label} ${value} > ${target}`);
    }
  };

  if (metrics?.invalid?.length) failures.push(`invalid harness cases: ${metrics.invalid.length}`);
  requireMinimum('TPR', overall.tpr, minTpr);
  requireMinimum('TNR', overall.tnr, minTnr);
  requireMinimum('BalancedAccuracy', overall.balancedAccuracy, minBalancedAccuracy);
  requireMaximum('FalsePositiveRate', overall.falsePositiveRate, maxFalsePositiveRate);
  const outcomes = metrics?.outcomes || {};
  requireMinimum('CompletionRate', outcomes.completionRate, targets.minCompletionRate);
  requireMaximum('AverageDurationMs', outcomes.averageDurationMs, targets.maxAverageDurationMs);
  requireMaximum('AverageToolCalls', outcomes.averageToolCalls, targets.maxAverageToolCalls);
  requireMaximum('UserInterventionRate', outcomes.userInterventionRate, targets.maxUserInterventionRate);

  return { ok: failures.length === 0, failures };
}

function formatHarnessMetrics(metrics) {
  const overall = metrics?.overall || {};
  const outcomes = metrics?.outcomes || {};
  return [
    `cases=${metrics?.cases ?? 0}`,
    `TPR=${overall.tpr ?? 'n/a'}`,
    `TNR=${overall.tnr ?? 'n/a'}`,
    `Balanced=${overall.balancedAccuracy ?? 'n/a'}`,
    `FPR=${overall.falsePositiveRate ?? 'n/a'}`,
    `Completion=${outcomes.completionRate ?? 'n/a'}`,
    `AvgMs=${outcomes.averageDurationMs ?? 'n/a'}`,
    `AvgTools=${outcomes.averageToolCalls ?? 'n/a'}`,
    `Intervention=${outcomes.userInterventionRate ?? 'n/a'}`,
  ].join(' ');
}

module.exports = {
  computeHarnessMetrics,
  formatHarnessMetrics,
  meetsHarnessTargets,
  normalizeVerdict,
  validateHarnessCase,
};
