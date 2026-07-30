#!/usr/bin/env node
'use strict';

/**
 * harness-gate-eval.cjs — payload 驱动的门禁行为评测执行器 (D8 评测扩容, 2026-07-30)。
 *
 * 语料: fixtures/harness-gate-cases.json (--cases 可换, red-team 集复用同一执行器)。
 * 每个 case 携带真实来源 (provenance) 的 hook payload / run 结果, 经真实门禁入口执行,
 * actualHarnessVerdict 由运行结果产生, 与 expectedHarnessVerdict 对账出 TPR/TNR/FPR。
 *
 * variance: --variance 时对 varianceKey 标记的 case 连跑 3 次, 报告一致率 (目标 ≥0.9)。
 *
 * 判定映射 (block = 门禁拦截 / 判定失败):
 *   bash-safety / file-protection / verification-gate-pre: decision === 'block'
 *   verification-verdict: verification.ok === false (PostToolUse 判定, warn 不算放行)
 *   toolchain-classify: status !== 'passed'
 *   evidence-status: status === 'failed'
 *   frustration-context: 强制模式切换注入非空 = block (语义: harness 干预)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_CORPUS = path.join(__dirname, 'fixtures', 'harness-gate-cases.json');
const VARIANCE_RUNS = 3;
const MIN_CASES_PER_ENTRY = 5;

// 门禁评测必须与真实运行状态隔离: 状态文件转移到临时目录, 持久化关闭。
const EVAL_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gate-eval-'));
process.env.CLAUDE_VERIFY_GATE_STATE_FILE = path.join(EVAL_TMP, 'verify-gate.json');
process.env.CLAUDE_VERIFICATION_LEDGER_FILE = path.join(EVAL_TMP, 'verification-ledger.json');
process.env.CLAUDE_HARNESS_NO_PERSIST = '1';

const {
  computeHarnessMetrics,
  formatHarnessMetrics,
  meetsHarnessTargets,
  validateHarnessCase,
} = require('../lib/harness-metrics.cjs');

function freshCwd(token) {
  const dir = path.join(EVAL_TMP, 'cwd', token.replace(/[^A-Za-z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * payload 里的 {{CWD}} 占位在执行时替换为该 case 专属的临时目录 —— 语料入库不带
 * 本机绝对路径 (05-harness 规则 8/9), 运行时按平台生成。
 */
function materialize(value, cwd) {
  if (typeof value === 'string') return value.replace(/\{\{CWD\}\}/g, cwd.replace(/\\/g, '/'));
  if (Array.isArray(value)) return value.map((item) => materialize(item, cwd));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, cwd)]));
  }
  return value;
}

const ENTRIES = {
  'bash-safety': (input, ctx) => {
    const guard = require('../hooks/bash-safety-guard.cjs');
    const result = guard.evaluate(input, ctx.runtimeFrom(input));
    return { verdict: result?.decision === 'block' ? 'block' : 'pass', detail: result?.decision || 'allow' };
  },
  'file-protection': (input, ctx) => {
    const guard = require('../hooks/file-protection-guard.cjs');
    const result = guard.evaluate(input, ctx.runtimeFrom(input));
    return { verdict: result?.decision === 'block' ? 'block' : 'pass', detail: result?.decision || 'allow' };
  },
  'verification-gate-pre': (input, ctx) => {
    const gate = require('../hooks/verification-gate.cjs');
    const result = gate.evaluate(input, ctx.runtimeFrom(input));
    return { verdict: result?.decision === 'block' ? 'block' : 'pass', detail: `${result?.decision}:${result?.reason || ''}` };
  },
  'verification-verdict': (input) => {
    const gate = require('../hooks/verification-gate.cjs');
    const result = gate.evaluate(input);
    if (!result?.verification || typeof result.verification.ok !== 'boolean') {
      return { verdict: 'block', detail: `no verdict produced (decision=${result?.decision})` };
    }
    return {
      verdict: result.verification.ok ? 'pass' : 'block',
      detail: result.verification.reason,
    };
  },
  'toolchain-classify': (input) => {
    const { classifyToolchainRun } = require('../lib/toolchain-health.cjs');
    const result = classifyToolchainRun(input);
    return { verdict: result.status === 'passed' ? 'pass' : 'block', detail: `${result.status}:${result.reason}` };
  },
  'evidence-status': (input) => {
    const { statusFromEvidence, commandEvidence } = require('../lib/evidence-ledger.cjs');
    const entries = (input.entries || []).map((entry) => (entry.command !== undefined && entry.result !== undefined
      ? commandEvidence(entry.command, entry.result)
      : entry));
    const status = statusFromEvidence(entries, input.requiredCommands || []);
    return { verdict: status.status === 'failed' ? 'block' : 'pass', detail: status.failures.join('|') || status.status };
  },
  /**
   * 晋升规则硬门禁 (red-team: 账本篡改 / 未批准规则试图生效)。
   * block = 规则**生效并拦住**动作; pass = 规则不生效 (对未批准/被篡改的规则,
   * 期望正是 pass —— 它不该有执行力)。规则语料在 input.rules 里现造。
   */
  'promoted-gate': (input, ctx) => {
    const gate = require('../hooks/promoted-harness-gate.cjs');
    const rulesDir = path.join(ctx.cwd, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    for (const [name, content] of Object.entries(input.rules || {})) {
      fs.writeFileSync(path.join(rulesDir, name), content, 'utf8');
    }
    let ledgerPath;
    if (input.ledger !== undefined) {
      ledgerPath = path.join(ctx.cwd, 'candidates.json');
      fs.writeFileSync(ledgerPath, JSON.stringify(input.ledger), 'utf8');
    }
    const payload = input.payload || {};
    try {
      const result = gate.evaluate(payload, ctx.runtimeFrom(payload), { rulesDir, ledgerPath });
      return { verdict: result.decision === 'block' ? 'block' : 'pass', detail: result.diagnostics.join('; ') || result.decision };
    } catch (error) {
      // 策略字段非法时 loadPolicies 抛错 —— 对 red-team 而言"规则未生效"即防线成立
      return { verdict: 'pass', detail: `policy rejected: ${error.message}` };
    }
  },
  /**
   * 候选账本验证 (red-team: 伪造验证证据把候选推成 verified)。
   * block = 验证器拒绝了伪造证据 (防线成立); pass = 伪造被接受 (失守)。
   */
  'candidate-verify': (input, ctx) => {
    const candidates = require('../harness-rule-candidates.cjs');
    const ledgerPath = path.join(ctx.cwd, 'ledger.json');
    const staged = candidates.stageCandidate(input.candidate, { ledgerPath, stagedBy: 'red-team' });
    try {
      const verified = candidates.verifyCandidate(staged.id, {
        ledgerPath,
        verifiedBy: input.verifiedBy === undefined ? 'red-team' : input.verifiedBy,
        evidence: input.evidence,
      });
      return { verdict: 'pass', detail: `forged verification was ACCEPTED (status=${verified.status})` };
    } catch (error) {
      return { verdict: 'block', detail: `rejected: ${error.message}`.slice(0, 200) };
    }
  },
  'frustration-context': (input) => {
    const detector = require('../hooks/frustration-detector.cjs');
    const output = detector.retrieveContext(input.payload, {
      readState: () => input.state || {},
      updateState: (mutator) => mutator(input.state || {}),
      emitSignal: () => {},
    });
    return { verdict: output ? 'block' : 'pass', detail: output ? 'mode-switch injected' : 'no intervention' };
  },
};

function runCase(testCase) {
  const executor = ENTRIES[testCase.entry];
  if (!executor) throw new Error(`unknown entry: ${testCase.entry}`);
  const cwd = freshCwd(testCase.id);
  const ctx = { runtimeFrom: require('../hooks/preflight-router.cjs').runtimeFrom, cwd };
  for (const setupPayload of testCase.setup || []) {
    executor(materialize(setupPayload, cwd), ctx);
  }
  return executor(materialize(testCase.input, cwd), ctx);
}

function loadCorpus(corpusPath) {
  const cases = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  if (!Array.isArray(cases)) throw new Error('corpus must be an array');
  const ids = new Set();
  for (const testCase of cases) {
    const validation = validateHarnessCase(testCase);
    if (!validation.ok) throw new Error(`${testCase?.id || '<unknown>'}: ${validation.failures.join('|')}`);
    if (ids.has(testCase.id)) throw new Error(`duplicate case id: ${testCase.id}`);
    ids.add(testCase.id);
    if (!testCase.entry) throw new Error(`${testCase.id}: gate corpus requires executable entry`);
    if (!testCase.provenance) throw new Error(`${testCase.id}: corpus discipline requires provenance`);
  }
  return cases;
}

function runAll(opts = {}) {
  const corpusPath = opts.cases || DEFAULT_CORPUS;
  const cases = loadCorpus(corpusPath);
  const executed = [];
  const errors = [];

  for (const testCase of cases) {
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = runCase(testCase);
    } catch (error) {
      outcome = { verdict: 'block', detail: `executor error: ${error.message}` };
      errors.push({ id: testCase.id, error: error.message });
    }
    executed.push({
      ...testCase,
      actualHarnessVerdict: outcome.verdict,
      taskCompleted: outcome.verdict === testCase.expectedHarnessVerdict,
      durationMs: Date.now() - startedAt,
      evidence: [String(outcome.detail || '').slice(0, 300)],
    });
  }

  // variance: 关键 case 连跑 N 次, 判定一致才算稳定
  let variance = null;
  if (opts.variance) {
    const keys = cases.filter((testCase) => testCase.varianceKey);
    const perCase = keys.map((testCase) => {
      const verdicts = [];
      for (let run = 0; run < VARIANCE_RUNS; run += 1) {
        try { verdicts.push(runCase(testCase).verdict); }
        catch { verdicts.push('executor-error'); }
      }
      return { id: testCase.id, verdicts, consistent: new Set(verdicts).size === 1 };
    });
    const consistent = perCase.filter((entry) => entry.consistent).length;
    variance = {
      runsPerCase: VARIANCE_RUNS,
      keyCases: perCase.length,
      consistent,
      consistencyRate: perCase.length ? Number((consistent / perCase.length).toFixed(6)) : null,
      perCase,
    };
  }

  const metrics = computeHarnessMetrics(executed);
  const gate = meetsHarnessTargets(metrics, {
    minTpr: 1,
    minTnr: 1,
    minBalancedAccuracy: 1,
    maxFalsePositiveRate: 0,
    minCompletionRate: 1,
  });
  const failures = [...gate.failures];
  if (opts.variance && variance && (variance.consistencyRate === null || variance.consistencyRate < 0.9)) {
    failures.push(`variance consistency ${variance.consistencyRate} < 0.9`);
  }
  if (errors.length > 0) failures.push(`executor errors: ${errors.map((entry) => entry.id).join(', ')}`);

  const mismatches = executed
    .filter((entry) => entry.actualHarnessVerdict !== entry.expectedHarnessVerdict)
    .map((entry) => ({ id: entry.id, expected: entry.expectedHarnessVerdict, actual: entry.actualHarnessVerdict, evidence: entry.evidence }));

  // 覆盖率口径按**执行入口**要求 ≥MIN_CASES_PER_ENTRY, 而不是按 riskCategory:
  // 语料纪律 (只从真实失败/通过提炼) 与"每个细分类别凑够 N 条"直接冲突,
  // 硬凑会引入想象出来的 case。riskCategory 分布照实报告, 不设配额。
  const perEntry = {};
  const perRiskCategory = {};
  for (const entry of executed) {
    perEntry[entry.entry] = (perEntry[entry.entry] || 0) + 1;
    perRiskCategory[entry.riskCategory] = (perRiskCategory[entry.riskCategory] || 0) + 1;
  }
  const thinEntries = Object.entries(perEntry)
    .filter(([, count]) => count < (opts.minCasesPerEntry ?? MIN_CASES_PER_ENTRY))
    .map(([entry, count]) => `${entry}=${count}`);
  if (thinEntries.length > 0) failures.push(`entries below coverage floor: ${thinEntries.join(', ')}`);

  return {
    schemaVersion: 1,
    mode: 'harness-gate-eval',
    corpus: path.relative(HOME, corpusPath).replace(/\\/g, '/'),
    status: failures.length === 0 ? 'passed' : 'failed',
    cases: executed.length,
    coverage: { perEntry, perRiskCategory, minCasesPerEntry: opts.minCasesPerEntry ?? MIN_CASES_PER_ENTRY },
    metrics,
    variance,
    mismatches,
    failures,
  };
}

function main() {
  const args = process.argv.slice(2);
  const casesIdx = args.indexOf('--cases');
  const opts = {
    cases: casesIdx >= 0 ? path.resolve(args[casesIdx + 1]) : undefined,
    variance: args.includes('--variance'),
  };
  let manifest;
  try {
    manifest = runAll(opts);
  } finally {
    try { fs.rmSync(EVAL_TMP, { recursive: true, force: true }); } catch { /* eval cleanup */ }
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    console.log(`harness-gate-eval: ${manifest.status} cases=${manifest.cases} ${formatHarnessMetrics(manifest.metrics)}`);
    console.log(`coverage: ${Object.entries(manifest.coverage.perEntry).map(([key, value]) => `${key}=${value}`).join(' ')}`);
    if (manifest.variance) console.log(`variance: ${manifest.variance.consistent}/${manifest.variance.keyCases} consistent (${manifest.variance.consistencyRate})`);
    for (const mismatch of manifest.mismatches) {
      console.log(`  MISMATCH ${mismatch.id}: expected=${mismatch.expected} actual=${mismatch.actual} ${mismatch.evidence}`);
    }
    for (const failure of manifest.failures) console.log(`  FAIL ${failure}`);
  }
  process.exit(manifest.status === 'passed' ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runAll, loadCorpus, ENTRIES };
