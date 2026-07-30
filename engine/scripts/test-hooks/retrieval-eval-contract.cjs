#!/usr/bin/env node
'use strict';

/**
 * retrieval-eval-contract.cjs — 检索金标评测契约 (D4)。
 *
 * 两件事分开锁:
 *   1. **评测器行为**在临时 fixture 上验证 (可判定、跨环境稳定): 命中/未命中/
 *      MRR 排名、阈值门禁、金标缺 expected 时报错、陈旧索引失败关闭。
 *   2. **真实索引的 precision** 只在本机索引存在且新鲜时校验 (var/ 不入版本库,
 *      干净 checkout 与 CI 上没有对象可评, 按 05-harness 规则 8 显式跳过)。
 *
 * 路径亲和度是这轮的实质修复: 只按正文 TF-IDF 排序时, "LDPC 定点量化"命中的是
 * 其他模块的 fixed_point_report.md (30 例金标 6 miss)。加入路径亲和度后
 * hitRate 0.8→0.967, precision@5 0.722→0.9, MRR 0.637→0.85。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const semantic = require(path.join(ROOT, 'engine/scripts/semantic-search.cjs'));

const MIN_PRECISION = 0.8;
const MIN_HIT_RATE = 0.9;

function writeFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-eval-'));
  const write = (relative, content) => {
    const full = path.join(home, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };
  // 两篇正文高度相似、只有路径不同的文档 —— 正是路径亲和度要解决的形态
  write('memory/learnings/ldpc-fixed-point.md',
    '# 定点报告\n\n定点量化 位宽 报告 误差 分析 覆盖 全流程 定点 量化 位宽 报告\n');
  write('memory/learnings/ofdm-fixed-point.md',
    '# 定点报告\n\n定点量化 位宽 报告 误差 分析 覆盖 全流程 定点 量化 位宽 报告\n');
  write('memory/learnings/unrelated-topic.md',
    '# 目录纪律\n\n项目目录 结构 清理 纪律 与定点无关\n');
  return home;
}

function evalWith(home, cases, opts = {}) {
  const casesFile = path.join(home, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify({ schemaVersion: 1, cases }), 'utf8');
  return semantic.evaluateRetrieval({ home, casesFile, topK: opts.topK || 3, ...opts });
}

function main() {
  const home = writeFixtureHome();
  try {
    const build = semantic.buildSemanticIndex({ home });
    assert.equal(build.fileCount, 3, `fixture index should hold 3 files, got ${build.fileCount}`);

    // 1. 路径亲和度让同正文的两篇按路径区分: ldpc 查询必须先返回 ldpc 那篇
    const hit = evalWith(home, [{
      id: 'ldpc', query: 'ldpc 定点量化 位宽',
      expected: ['memory/learnings/ldpc-fixed-point.md'],
    }]);
    assert.equal(hit.perCase[0].hit, true, `path affinity failed to disambiguate: ${JSON.stringify(hit.perCase[0].returned)}`);
    assert.equal(hit.perCase[0].returned[0], 'memory/learnings/ldpc-fixed-point.md',
      `expected the path-matching document first, got ${hit.perCase[0].returned[0]}`);
    assert.equal(hit.perCase[0].reciprocalRank, 1);
    assert.equal(hit.status, 'passed');

    // 2. 未命中必须如实报 miss, 不得被"返回了同类文档"糊过去
    const miss = evalWith(home, [{
      id: 'nonexistent', query: '定点量化 位宽',
      expected: ['memory/learnings/does-not-exist.md'],
    }]);
    assert.equal(miss.perCase[0].hit, false);
    assert.equal(miss.summary.hitRate, 0);
    assert.equal(miss.status, 'failed');
    assert.ok(miss.failures.some((f) => /hitRate/.test(f)), miss.failures.join('|'));

    // 3. 阈值默认值必须生效 (曾因 Number(null)=0 让门禁形同虚设)
    const defaults = evalWith(home, [{
      id: 'nonexistent', query: '定点量化', expected: ['memory/learnings/does-not-exist.md'],
    }], { minPrecision: null, minHitRate: undefined });
    assert.equal(defaults.thresholds.minPrecision, MIN_PRECISION, 'null must fall back to the default precision floor');
    assert.equal(defaults.thresholds.minHitRate, MIN_HIT_RATE);
    assert.equal(defaults.status, 'failed', 'a total miss must fail under default thresholds');

    // 4. 金标 case 缺 expected → 直接报错, 不允许无判据的 case 混进语料
    assert.throws(() => evalWith(home, [{ id: 'no-expected', query: 'x' }]),
      /expected documents are required/);

    // 5. 索引陈旧时失败关闭 (改一个文件的 mtime 即制造漂移)
    const drifted = path.join(home, 'memory/learnings/ldpc-fixed-point.md');
    fs.appendFileSync(drifted, '\n追加内容制造 mtime 漂移\n', 'utf8');
    const stale = evalWith(home, [{
      id: 'ldpc', query: 'ldpc 定点量化', expected: ['memory/learnings/ldpc-fixed-point.md'],
    }]);
    assert.equal(stale.freshness.stale, true, 'appending to an indexed file must be detected as drift');
    assert.equal(stale.status, 'failed');
    assert.ok(stale.failures.some((f) => /index is stale/.test(f)), stale.failures.join('|'));
    assert.equal(stale.perCase[0].status, 'stale_index', 'stale index must return no results, not old vectors');

    // 6. 真实金标集: 语料结构在任何环境都校验; precision 只在本机索引新鲜时校验
    const realCases = JSON.parse(fs.readFileSync(
      path.join(ROOT, semantic.DEFAULT_EVAL_CASES), 'utf8',
    ));
    assert.ok(Array.isArray(realCases.cases) && realCases.cases.length >= 20,
      `golden set needs >=20 cases, got ${realCases.cases?.length}`);
    const ids = new Set();
    for (const testCase of realCases.cases) {
      assert.ok(testCase.id && !ids.has(testCase.id), `duplicate or missing case id: ${testCase.id}`);
      ids.add(testCase.id);
      assert.ok(testCase.query, `${testCase.id}: query is required`);
      assert.ok(Array.isArray(testCase.expected) && testCase.expected.length > 0,
        `${testCase.id}: expected documents are required`);
      assert.ok(testCase.provenance, `${testCase.id}: provenance is required`);
    }

    const realFreshness = semantic.inspectIndexFreshness({ home: ROOT });
    if (!realFreshness.found || realFreshness.stale) {
      console.log(`retrieval-eval-contract: SKIP real-index precision (index ${realFreshness.found ? realFreshness.reason : 'missing'}; var/ is not versioned)`);
    } else {
      const real = semantic.evaluateRetrieval({ home: ROOT, topK: 5 });
      assert.ok(real.summary.precisionAtK >= MIN_PRECISION,
        `real precision@5 ${real.summary.precisionAtK} < ${MIN_PRECISION} (misses: ${real.summary.misses.join(', ')})`);
      assert.ok(real.summary.hitRate >= MIN_HIT_RATE,
        `real hitRate@5 ${real.summary.hitRate} < ${MIN_HIT_RATE}`);
      console.log(`retrieval-eval-contract: real index hitRate=${real.summary.hitRate} precision@5=${real.summary.precisionAtK} MRR=${real.summary.mrr}`);
    }

    console.log('retrieval-eval-contract: all assertions passed');
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

main();
