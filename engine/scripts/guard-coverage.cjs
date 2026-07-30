#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/guard-coverage.cjs — 守卫危险模式的测试覆盖率报告 (D9)。
 *
 * bash-safety-guard 的危险模式表逐条对应评测语料: 每个 category 至少要有一条
 * 真实 case 打到它。没有 case 的 category 就是"写了但从未被验证过"的防线 ——
 * 报告必须把它显式列出来, 而不是让覆盖率看起来是满的。
 *
 * 判定方式是**真实执行**: 把语料里的 bash-safety case 跑一遍, 看每条 case
 * 实际命中了哪个 category (guard 返回值带 category), 而不是按文本猜测。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = path.resolve(__dirname, '..', '..');
const CORPORA = [
  path.join(HOME, 'engine', 'scripts', 'test-hooks', 'fixtures', 'harness-gate-cases.json'),
  path.join(HOME, 'engine', 'scripts', 'test-hooks', 'fixtures', 'harness-redteam-cases.json'),
];

function loadGuard() {
  return {
    guard: require('./hooks/bash-safety-guard.cjs'),
    runtimeFrom: require('./hooks/preflight-router.cjs').runtimeFrom,
  };
}

/** 危险模式表的 category → 模式条数 (只读, 不改守卫)。 */
function guardCategories() {
  const source = fs.readFileSync(path.join(__dirname, 'hooks', 'bash-safety-guard.cjs'), 'utf8');
  const categories = new Map();
  const categoryRe = /category:\s*'([^']+)'/g;
  let match;
  while ((match = categoryRe.exec(source)) !== null) {
    // 每个 group 后面紧跟一个 patterns 数组; 统计其中的正则字面量条数
    const rest = source.slice(match.index);
    const patternsStart = rest.indexOf('patterns: [');
    const patternsEnd = rest.indexOf('\n    ],', patternsStart);
    const block = patternsStart >= 0 && patternsEnd > patternsStart
      ? rest.slice(patternsStart, patternsEnd)
      : '';
    const patternCount = (block.match(/^\s*\/(?![/*])/gm) || []).length;
    categories.set(match[1], patternCount);
  }
  return categories;
}

function coverage(opts = {}) {
  const { guard, runtimeFrom } = loadGuard();
  const declared = guardCategories();
  const hits = new Map();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-coverage-'));
  let cases = 0;
  try {
    for (const corpusPath of opts.corpora || CORPORA) {
      if (!fs.existsSync(corpusPath)) continue;
      for (const testCase of JSON.parse(fs.readFileSync(corpusPath, 'utf8'))) {
        if (testCase.entry !== 'bash-safety') continue;
        cases += 1;
        const payload = JSON.parse(
          JSON.stringify(testCase.input).replace(/\{\{CWD\}\}/g, tmp.replace(/\\/g, '/')),
        );
        const result = guard.evaluate(payload, runtimeFrom(payload));
        if (result.decision === 'block' && result.category) {
          hits.set(result.category, (hits.get(result.category) || 0) + 1);
        }
      }
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup */ }
  }

  const perCategory = [...declared.entries()].map(([category, patterns]) => ({
    category,
    patterns,
    cases: hits.get(category) || 0,
    covered: (hits.get(category) || 0) > 0,
  }));
  const uncovered = perCategory.filter((entry) => !entry.covered).map((entry) => entry.category);
  return {
    schemaVersion: 1,
    guard: 'bash-safety-guard',
    categories: perCategory.length,
    coveredCategories: perCategory.length - uncovered.length,
    coverageRate: perCategory.length
      ? Number(((perCategory.length - uncovered.length) / perCategory.length).toFixed(6))
      : null,
    casesExecuted: cases,
    uncovered,
    perCategory,
  };
}

function main(argv = process.argv.slice(2)) {
  const result = coverage({});
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`guard-coverage: ${result.coveredCategories}/${result.categories} categories covered `
      + `(rate=${result.coverageRate}) from ${result.casesExecuted} bash-safety cases`);
    for (const entry of result.perCategory) {
      console.log(`  ${entry.covered ? '✓' : '✗'} ${entry.category.padEnd(28)} patterns=${entry.patterns} cases=${entry.cases}`);
    }
    if (result.uncovered.length) console.log(`  UNCOVERED: ${result.uncovered.join(', ')}`);
  }
  // 覆盖率报告本身不做门禁 (门禁在 red-team 语料上); 未覆盖类别以退出码 1 提示
  return result.uncovered.length === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { coverage, guardCategories, main };
