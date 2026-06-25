#!/usr/bin/env node
/**
 * engine/scripts/judge-calibration.cjs — LLM-as-Judge 校准度评估
 *
 * 🔍 P2-1: Judge 校准度评估
 * 参照: [3] MT-Bench / Chatbot Arena — "judge 本身也需要被评估"
 *
 * 用人工标注的基准样本测试 Verifier/Judge agent 的判断准确率。
 * 支持导入标注集、运行 Judge 对比、生成校准报告。
 *
 * 用法:
 *   node engine/scripts/judge-calibration.cjs init              # 创建基准样本模板
 *   node engine/scripts/judge-calibration.cjs run <sample-file>  # 运行校准
 *   node engine/scripts/judge-calibration.cjs report             # 查看校准报告
 *   node engine/scripts/judge-calibration.cjs report --json      # JSON
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = path.join(os.homedir(), '.claude');
const SAMPLES_DIR = path.join(HOME, 'var', 'calibration-samples');
const RESULTS_FILE = path.join(HOME, 'var', 'calibration-results.json');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

// ── 基准样本格式 ────────────────────────────────────────────────────────────
//
// 每个样本:
// {
//   id: "sample-001",
//   category: "hdl_correctness" | "hdl_performance" | "hdl_security" | "general",
//   input: { file: "...", description: "..." },
//   expected: { verdict: "pass"|"fail", issues: ["..."] },
//   notes: "人工标注说明"
// }

const DEFAULT_SAMPLES = [
  {
    id: 'sample-001',
    category: 'hdl_correctness',
    input: { description: '组合逻辑中 inferred latch' },
    expected: { verdict: 'fail', issues: ['组合逻辑中缺少 else 分支导致 latch'] },
    notes: '典型 latch 问题，Judge 应检出',
  },
  {
    id: 'sample-002',
    category: 'hdl_correctness',
    input: { description: '位宽不匹配: 16bit 赋值到 8bit 信号' },
    expected: { verdict: 'fail', issues: ['位宽不匹配'] },
    notes: '隐式截断，Judge 应标记',
  },
  {
    id: 'sample-003',
    category: 'hdl_correctness',
    input: { description: '跨时钟域信号未同步' },
    expected: { verdict: 'fail', issues: ['CDC 未同步'] },
    notes: '单 bit 跨时钟域需要 2FF 同步器',
  },
  {
    id: 'sample-004',
    category: 'hdl_performance',
    input: { description: 'FSM 输出用组合逻辑直接驱动外部寄存器' },
    expected: { verdict: 'warn', issues: ['FSM 输出建议寄存'] },
    notes: '非严格错误但可能有时序风险',
  },
  {
    id: 'sample-005',
    category: 'general',
    input: { description: '缺少注释，代码可读性差' },
    expected: { verdict: 'pass', issues: [] },
    notes: '风格问题不阻断，可提醒但不判 fail',
  },
  {
    id: 'sample-006',
    category: 'hdl_security',
    input: { description: '代码中硬编码了 FPGA bitstream 密钥' },
    expected: { verdict: 'fail', issues: ['硬编码密钥'] },
    notes: '安全红线，必须标记',
  },
];

// ── 初始化 ──────────────────────────────────────────────────────────────────

function initSamples() {
  ensureDir(SAMPLES_DIR);
  for (const sample of DEFAULT_SAMPLES) {
    const filePath = path.join(SAMPLES_DIR, `${sample.id}.json`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(sample, null, 2), 'utf8');
      console.log(`  创建: ${sample.id} (${sample.category})`);
    } else {
      console.log(`  跳过: ${sample.id} (已存在)`);
    }
  }
  console.log(`\n基准样本目录: ${SAMPLES_DIR}`);
  console.log(`共 ${DEFAULT_SAMPLES.length} 个样本`);
  console.log('\n提示: 用实际 RTL 代码替换 input.description，人工标注 expected 后运行 calibration。');
}

// ── 模拟 Judge 运行 ─────────────────────────────────────────────────────────
// 实际使用时，这里应调用 Verifier agent。当前为 mock 演示。

function mockJudge(sample) {
  // 简单基于 category 的 mock 判断
  const verdicts = {
    hdl_correctness: 'fail',
    hdl_performance: 'warn',
    general: 'pass',
    hdl_security: 'fail',
  };
  return {
    verdict: verdicts[sample.category] || 'pass',
    issues: sample.expected.issues,
    confidence: 0.85,
  };
}

// ── 运行校准 ─────────────────────────────────────────────────────────────────

function runCalibration(sampleFile) {
  let samples;

  if (sampleFile) {
    // 单个文件
    const filePath = path.resolve(sampleFile);
    if (!fs.existsSync(filePath)) {
      console.error(`文件不存在: ${filePath}`);
      return;
    }
    samples = [JSON.parse(fs.readFileSync(filePath, 'utf8'))];
  } else {
    // 扫描目录
    if (!fs.existsSync(SAMPLES_DIR)) {
      console.error('基准样本目录为空。先运行 init 创建初始样本。');
      return;
    }
    samples = fs.readdirSync(SAMPLES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, f), 'utf8')));
  }

  if (samples.length === 0) {
    console.log('[judge-calibration] 无样本可评估');
    return;
  }

  console.log(`\n运行 Judge 校准: ${samples.length} 个样本\n`);

  const results = [];
  let correct = 0, total = 0;

  for (const sample of samples) {
    total++;
    process.stdout.write(`  ${sample.id.padEnd(16)} `);

    const judgeResult = mockJudge(sample);
    const expected = sample.expected;

    // 判断 verdict 是否一致
    const verdictMatch = judgeResult.verdict === expected.verdict;
    // 判断 issues 覆盖
    const foundIssues = expected.issues.every(issue =>
      judgeResult.issues.some(ji => ji.includes(issue) || issue.includes(ji))
    );
    const isCorrect = verdictMatch && foundIssues;

    if (isCorrect) {
      console.log(`✅ (verdict=${judgeResult.verdict})`);
      correct++;
    } else {
      console.log(`❌ 期望=(${expected.verdict}:${expected.issues.join(',')}) 实际=(${judgeResult.verdict}:${judgeResult.issues.join(',')})`);
    }

    results.push({
      id: sample.id,
      category: sample.category,
      expected: sample.expected,
      actual: judgeResult,
      correct: isCorrect,
      details: { verdictMatch, foundIssues },
    });
  }

  // 汇总
  const accuracy = total > 0 ? (correct / total * 100).toFixed(1) : '0.0';
  console.log(`\n━━━ 校准结果 ━━━`);
  console.log(`  准确率: ${accuracy}% (${correct}/${total})`);

  // 按类别统计
  const byCat = {};
  for (const r of results) {
    if (!byCat[r.category]) byCat[r.category] = { total: 0, correct: 0 };
    byCat[r.category].total++;
    if (r.correct) byCat[r.category].correct++;
  }
  for (const [cat, stats] of Object.entries(byCat)) {
    const rate = stats.total > 0 ? (stats.correct / stats.total * 100).toFixed(0) : '-';
    console.log(`  [${cat}] ${rate}% (${stats.correct}/${stats.total})`);
  }

  // 保存
  const output = {
    runAt: new Date().toISOString(),
    samplesCount: total,
    correctCount: correct,
    accuracy: parseFloat(accuracy),
    byCategory: byCat,
    results,
  };

  ensureDir(path.dirname(RESULTS_FILE));
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n结果已保存: ${RESULTS_FILE}`);
  console.log('\n💡 提示: 将 mockJudge() 替换为实际 Verifier agent 调用以获得真实校准数据。');
}

// ── 报告 ────────────────────────────────────────────────────────────────────

function generateReport(jsonOutput) {
  if (!fs.existsSync(RESULTS_FILE)) {
    console.log('[judge-calibration] 暂无校准数据。运行 run 命令生成。');
    return;
  }

  const data = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));

  if (jsonOutput) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log('\n━━━ Judge 校准度报告 ━━━');
  console.log(`📊 校准运行: ${data.runAt || '未知'}`);
  console.log(`✅ 准确率:   ${data.accuracy || 'N/A'}% (${data.correctCount}/${data.samplesCount || 0})`);
  console.log('');

  if (data.byCategory) {
    console.log('按类别:');
    for (const [cat, stats] of Object.entries(data.byCategory)) {
      const bar = stats.total > 0 ? '█'.repeat(Math.round(stats.correct / stats.total * 20)) : '';
      const rate = stats.total > 0 ? (stats.correct / stats.total * 100).toFixed(0) : '-';
      console.log(`  ${cat.padEnd(20)} ${bar} ${stats.correct}/${stats.total} (${rate}%)`);
    }
    console.log('');
  }

  if (data.results) {
    const failures = data.results.filter(r => !r.correct);
    if (failures.length > 0) {
      console.log('失败样本:');
      for (const f of failures) {
        console.log(`  ❌ ${f.id} (${f.category}): 期望=${f.expected.verdict}, 实际=${f.actual.verdict}`);
      }
      console.log('');
    }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'init':
      initSamples();
      break;
    case 'run':
      runCalibration(process.argv[3]);
      break;
    case 'report':
      generateReport(process.argv.includes('--json'));
      break;
    default:
      console.log(`
用法:
  node engine/scripts/judge-calibration.cjs init              # 初始化基准样本
  node engine/scripts/judge-calibration.cjs run [sample-file] # 运行校准
  node engine/scripts/judge-calibration.cjs report [--json]   # 查看报告
`);
  }
}

main();
