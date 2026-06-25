/**
 * engine/scripts/lib/judge-service.cjs — Judge 服务模块 (P2)
 *
 * 共享库: 提供基于规则的 judge、ELO 评分、多 judge 投票。
 * 替代 judge-calibration.cjs 中的 mockJudge()。
 *
 * 用法: const { callJudge, updateElo, runMultipleJudges } = require('./judge-service.cjs');
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = path.join(os.homedir(), '.claude');
const ELO_FILE = path.join(HOME, 'var', 'judge-elo.json');

// ═════════════════════════════════════════════════════════════════════════════
// ELO 评分
// ═════════════════════════════════════════════════════════════════════════════

function expectedScore(ratingA, ratingB) {
  return 1.0 / (1.0 + Math.pow(10, (ratingB - ratingA) / 400.0));
}

function updateElo(ratingA, ratingB, scoreA, K) {
  if (K === undefined) K = 32;
  const expectedA = expectedScore(ratingA, ratingB);
  return {
    newA: Math.round(ratingA + K * (scoreA - expectedA)),
    newB: Math.round(ratingB + K * (1 - scoreA - expectedA)),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ELO 状态持久化
// ═════════════════════════════════════════════════════════════════════════════

function getEloState() {
  try {
    if (fs.existsSync(ELO_FILE)) {
      return JSON.parse(fs.readFileSync(ELO_FILE, 'utf8'));
    }
  } catch {}
  return { ratings: { default: 1500 }, history: [] };
}

function saveEloState(state) {
  const dir = path.dirname(ELO_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ELO_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function recordEloMatch(judgeName, opponentName, score, K) {
  const state = getEloState();
  const aRating = state.ratings[judgeName] || 1500;
  const bRating = state.ratings[opponentName] || 1500;
  const { newA, newB } = updateElo(aRating, bRating, score, K);
  state.ratings[judgeName] = newA;
  state.ratings[opponentName] = newB;
  state.history.push({
    judge: judgeName,
    opponent: opponentName,
    score,
    aRating, bRating, newA, newB,
    timestamp: new Date().toISOString(),
  });
  // 最多保留 500 条历史
  if (state.history.length > 500) state.history = state.history.slice(-500);
  saveEloState(state);
  return { newA, newB };
}

// ═════════════════════════════════════════════════════════════════════════════
// 基于规则的 Judge (替代 mockJudge)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 对样本进行基于规则的判断。
 * @param {object} sample - { id, category, input: { description, file? }, expected: { verdict, issues } }
 * @returns {{ verdict: string, issues: string[], confidence: number, correct: boolean }}
 */
function callJudge(sample) {
  const desc = (sample?.input?.description || sample?.input?.code || '');
  const descLow = desc.toLowerCase();
  const expected = sample?.expected || { verdict: 'pass', issues: [] };
  const foundIssues = [];

  // ── 规则集: 中英文双语匹配 ──

  // Latch 推断
  if (/latch/i.test(descLow) || /缺少.*else/i.test(desc) || /inferred latch/i.test(descLow)) {
    foundIssues.push('组合逻辑中可能出现 latch');
  }

  // 位宽不匹配
  if (/位宽不匹配/i.test(desc) || /width.*mismatch/i.test(descLow) || /bit.*bit.*assign/i.test(descLow)) {
    foundIssues.push('位宽不匹配');
  }

  // CDC 跨时钟域
  if (/跨时钟域/i.test(desc) || /未同步/i.test(desc) || /cross.?clock/i.test(descLow) ||
      /cdc/i.test(descLow) || /async.*sync/i.test(descLow)) {
    foundIssues.push('跨时钟域信号需同步');
  }

  // FSM 输出未寄存
  if (/fsm.*(?:输出|output)/i.test(desc) && /(?:组合|combo|寄存器|register)/i.test(desc)) {
    foundIssues.push('FSM 输出建议寄存');
  }

  // 关键路径
  if (/关键路径/i.test(desc) || /critical.?path/i.test(descLow) || /timing/i.test(descLow)) {
    foundIssues.push('关键路径过长');
  }

  // 硬编码密钥
  if (/硬编码/i.test(desc) || /密钥/i.test(desc) || /hardcod/i.test(descLow) ||
      /key.*fpga/i.test(descLow) || /bitstream.*key/i.test(descLow) ||
      /secret.*hard/i.test(descLow)) {
    foundIssues.push('硬编码密钥');
  }

  // ── 如果没有匹配任何规则，按类别默认 ──
  if (foundIssues.length === 0) {
    const defaultIssues = {
      hdl_correctness: '未识别到具体模式',
      hdl_performance: '未识别到性能问题',
      hdl_security: '未识别到安全问题',
    };
    const defIssue = defaultIssues[sample?.category];
    if (defIssue) foundIssues.push(defIssue);
  }

  // ── 判定 verdict ──
  let verdict = 'pass';
  if (foundIssues.length > 0) {
    const critical = foundIssues.filter(i => /(?:latch|位宽|密钥|key|secret|跨时钟|未同步)/.test(i));
    if (critical.length > 0) {
      verdict = 'fail';
    } else if (foundIssues.some(i => /(?:未识别|建议|path|关键路径)/.test(i))) {
      verdict = 'warn';
    } else {
      verdict = 'warn';
    }
  }

  // ── 与期望比较 (关键词重叠匹配) ──
  const verdictMatch = verdict === expected.verdict;
  const issuesMatch = expected.issues.length === 0 ||
    expected.issues.every(ei => {
      // 提取关键词：中文 2 字 bigrams + 英文词 3+ 字符
      const cjkChars = ei.match(/[一-鿿]/g) || [];
      const cjkBigrams = [];
      for (let i = 0; i < cjkChars.length - 1; i++) {
        cjkBigrams.push(cjkChars[i] + cjkChars[i + 1]);
      }
      const enKw = ei.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      const keywords = [...new Set([...cjkBigrams, ...enKw])];
      if (keywords.length === 0) return true;
      // 至少一个关键词出现在实际 issues 中 (大小写不敏感)
      return keywords.some(kw => foundIssues.some(fi => fi.toLowerCase().includes(kw.toLowerCase())));
    });

  return {
    verdict,
    issues: foundIssues,
    confidence: foundIssues.length > 0 && !foundIssues.some(i => i.startsWith('未识别')) ? 0.85 : 0.5,
    correct: verdictMatch && issuesMatch,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 多 Judge 投票
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 运行多个 judge 实例并投票聚合。
 * @param {object} sample - 样本
 * @param {number} count - judge 实例数
 * @returns {{ results, majorityVerdict, unanimous, correct }}
 */
function runMultipleJudges(sample, count) {
  count = count || 3;
  const results = [];
  for (let i = 0; i < count; i++) {
    const result = callJudge(sample);
    result.judgeId = `judge-${i + 1}`;
    results.push(result);
  }

  // 多数投票
  const verdictCounts = {};
  for (const r of results) {
    verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
  }
  const majorityVerdict = Object.entries(verdictCounts)
    .sort((a, b) => b[1] - a[1])[0][0];

  const unanimous = new Set(results.map(r => r.verdict)).size === 1;
  const majorityCorrect = results.filter(r => r.verdict === majorityVerdict)
    .some(r => r.correct);

  return { results, majorityVerdict, unanimous, correct: majorityCorrect };
}

module.exports = {
  callJudge,
  updateElo,
  expectedScore,
  getEloState,
  saveEloState,
  recordEloMatch,
  runMultipleJudges,
};
