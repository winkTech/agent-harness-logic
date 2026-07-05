'use strict';

const VALID_DIFFICULTIES = new Set(['D1', 'D2', 'D3', 'D4']);
const VALID_VERDICTS = new Set(['pass', 'block']);

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
  if (testCase.schemaVersion !== undefined && testCase.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (!testCase.id || typeof testCase.id !== 'string') failures.push('id is required');
  if (!VALID_DIFFICULTIES.has(testCase.difficulty)) failures.push(`difficulty must be one of ${Array.from(VALID_DIFFICULTIES).join(', ')}`);
  if (!testCase.riskCategory || typeof testCase.riskCategory !== 'string') failures.push('riskCategory is required');

  const expected = normalizeVerdict(testCase.expectedHarnessVerdict);
  const actual = normalizeVerdict(testCase.actualHarnessVerdict);
  if (!VALID_VERDICTS.has(expected)) failures.push('expectedHarnessVerdict must be pass or block');
  if (!VALID_VERDICTS.has(actual)) failures.push('actualHarnessVerdict must be pass or block');

  return { ok: failures.length === 0, failures, expected, actual };
}

function safeRate(num, den) {
  if (!den) return null;
  return Number((num / den).toFixed(6));
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

  for (const testCase of cases) {
    const validation = validateHarnessCase(testCase);
    if (!validation.ok) {
      invalid.push({ id: testCase?.id || '<unknown>', failures: validation.failures });
      continue;
    }

    const expected = validation.expected;
    const actual = validation.actual;
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

  if (metrics?.invalid?.length) failures.push(`invalid harness cases: ${metrics.invalid.length}`);
  if (overall.tpr !== null && overall.tpr < minTpr) failures.push(`TPR ${overall.tpr} < ${minTpr}`);
  if (overall.tnr !== null && overall.tnr < minTnr) failures.push(`TNR ${overall.tnr} < ${minTnr}`);
  if (overall.balancedAccuracy !== null && overall.balancedAccuracy < minBalancedAccuracy) {
    failures.push(`BalancedAccuracy ${overall.balancedAccuracy} < ${minBalancedAccuracy}`);
  }
  if (overall.falsePositiveRate !== null && overall.falsePositiveRate > maxFalsePositiveRate) {
    failures.push(`FalsePositiveRate ${overall.falsePositiveRate} > ${maxFalsePositiveRate}`);
  }

  return { ok: failures.length === 0, failures };
}

function formatHarnessMetrics(metrics) {
  const overall = metrics?.overall || {};
  return [
    `cases=${metrics?.cases ?? 0}`,
    `TPR=${overall.tpr ?? 'n/a'}`,
    `TNR=${overall.tnr ?? 'n/a'}`,
    `Balanced=${overall.balancedAccuracy ?? 'n/a'}`,
    `FPR=${overall.falsePositiveRate ?? 'n/a'}`,
  ].join(' ');
}

module.exports = {
  computeHarnessMetrics,
  formatHarnessMetrics,
  meetsHarnessTargets,
  normalizeVerdict,
  validateHarnessCase,
};
