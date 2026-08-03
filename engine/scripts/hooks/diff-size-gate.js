#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { gitSubcommand } = require('./verification-gate.cjs');

const MAX_STDIN = 1024 * 1024;
const WARN_FILES = Number.parseInt(process.env.DIFF_GATE_WARN_FILES || '20', 10);
const WARN_LINES = Number.parseInt(process.env.DIFF_GATE_WARN_LINES || '500', 10);
const BLOCK_FILES = Number.parseInt(process.env.DIFF_GATE_BLOCK_FILES || '40', 10);
const BLOCK_LINES = Number.parseInt(process.env.DIFF_GATE_BLOCK_LINES || '1000', 10);

// ── 范围溢出检查 ───────────────────────────────────────────────────────────
//
// 规模门禁量的是"改了多大", 量不出"改的是不是请求要的"。2026-08-01 的实例:
// 一次只需追加 3 条测试用例的改动, 因为用脚本重写了整个 JSON 而产生 887 行 diff,
// 其中仅约 37 行有语义。规模上它只到 warn 档(>500 行), 而真正的问题是**比例**
// —— 96% 的改动行与请求无关。
//
// 判据不靠模型自述, 用 git 自己算: 比较改动前后的**内容 token**, 看行数改动
// 与内容改动是否成比例。改了 887 行而内容只变了 4%, 就是重排, 不是工作。
//
// 不用 `git diff -w`: 它只忽略行内空白, 看不出"一行拆成七行"。而整文件重写恰恰
// 是这种形状 —— 紧凑单行 JSON 被 JSON.stringify(…, null, 2) 展开, 每行的空白
// 没变, 行的边界全变了, -w 统计出的语义行数与普通模式几乎一致, 检查完全失效
// (2026-08-01 首版实测如此)。因此归一化必须先抹掉全部空白再按结构分隔符切分,
// 让重排前后落到同一串 token 上。
//
// 保持 advisory: 合法的 style/format 提交本就该是高 churn, 硬拦会误伤; 而且
// "该不该拆分"是人的判断。门禁的职责是把这个比例摆到台面上, 不是替人决定。
const SCOPE_MIN_LINES = Number.parseInt(process.env.DIFF_GATE_SCOPE_MIN_LINES || '40', 10);
// 内容变动占比低于此值即判为重排主导。0.15 = 改动行数再多, 内容只动了不到 15%。
const SCOPE_SEMANTIC_FLOOR = Number.parseFloat(process.env.DIFF_GATE_SCOPE_SEMANTIC_FLOOR || '0.15');
const SCOPE_MAX_FILES = 40;              // 超出即放弃检测(fail-open), 不拖慢提交
const SCOPE_MAX_BYTES = 512 * 1024;      // diff 文本上限, 同上

/** 提交信息自称是格式化/重排类改动时跳过 —— 那种提交本来就应该全是 churn。 */
const FORMAT_INTENT = /\b(?:style|format|formatting|reformat|prettier|lint|whitespace|indent)\b|重排|缩进|格式化/i;

function log(message) {
  process.stderr.write(`[DiffGate] ${message}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (raw.length < MAX_STDIN) raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw.replace(/^\uFEFF/, '')));
  });
}

function exec(command, args, opts = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    ...opts,
  });
}

function parseDiffStat(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const fileChangedMatch = text.match(/(\d+)\s+files?\s+changed/);
  const insertMatch = text.match(/(\d+)\s+insertion/);
  const deleteMatch = text.match(/(\d+)\s+deletion/);
  const fileCount = lines.filter((line) => line.includes('|')).length
    || (fileChangedMatch ? Number.parseInt(fileChangedMatch[1], 10) : 0);
  const totalChanges = (insertMatch ? Number.parseInt(insertMatch[1], 10) : 0)
    + (deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0);
  return { fileCount, totalChanges, statOutput: text };
}

function getDiffStats(runtime = {}) {
  const run = runtime.exec || exec;
  const opts = runtime.cwd ? { cwd: runtime.cwd } : {};
  const refs = ['origin/main...HEAD', 'origin/master...HEAD', 'main...HEAD'];
  for (const ref of refs) {
    const result = run('git', ['diff', '--stat', ref], opts);
    if (result.status === 0) {
      const stats = parseDiffStat(result.stdout);
      return stats ? { ...stats, ref } : null;
    }
  }
  return null;
}

/** numstat 一行: `<added>\t<deleted>\t<path>`; 二进制文件是 `-\t-\t<path>`。 */
function parseNumstat(output) {
  const files = new Map();
  let total = 0;
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match || match[1] === '-') continue;
    const changed = Number.parseInt(match[1], 10) + Number.parseInt(match[2], 10);
    files.set(match[3], changed);
    total += changed;
  }
  return { files, total };
}

/**
 * 抹掉全部空白, 再按结构分隔符切成 token。
 * 重排(缩进、换行位置、一行拆多行)前后落到同一串 token; 真实的内容增删才改变它。
 */
function normalizeTokens(text) {
  const stripped = String(text || '').replace(/\s+/g, '');
  if (!stripped) return [];
  return stripped.split(/(?<=[;,{}[\]()])/).filter(Boolean);
}

/** token 多重集的对称差大小 —— 内容真正变了多少。 */
function tokenDelta(oldTokens, newTokens) {
  const counts = new Map();
  for (const token of oldTokens) counts.set(token, (counts.get(token) || 0) + 1);
  for (const token of newTokens) counts.set(token, (counts.get(token) || 0) - 1);
  let delta = 0;
  for (const value of counts.values()) delta += Math.abs(value);
  return delta;
}

/**
 * 把 unified diff 拆成 per-file 的增删文本。
 * 同一侧的行**先拼接再 token 化** —— 否则"一行拆成七行"这种重排在逐行 token 化
 * 下仍然对不上, 而它正是要抓的形状。
 */
function splitDiffByFile(diffText) {
  const files = new Map();
  let current = null;
  for (const line of String(diffText || '').split(/\r?\n/)) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) {
      current = { added: [], removed: [] };
      files.set(header[1], current);
      continue;
    }
    if (!current || /^(?:diff |index |--- |@@|new file|deleted file|similarity|rename )/.test(line)) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return files;
}

/**
 * 逐文件比较"改了多少行"与"内容真的变了多少"。
 *
 * 分母是**本次改动触及的 token 总量**, 不是文件规模 —— 首版拿整文件 token 数
 * 当分母, 于是"4000 行的文件里新增 54 行测试"也被算成"内容只变了 2%"而误报
 * (2026-08-01 在本仓库自身改动上实测到)。改动大小与文件大小无关, 只与改动有关。
 */
function getScopeStats(runtime = {}, args) {
  const run = runtime.exec || exec;
  const opts = runtime.cwd ? { cwd: runtime.cwd } : {};
  const raw = run('git', ['diff', '--numstat', ...args], opts);
  if (raw.status !== 0) return null;
  const plain = parseNumstat(raw.stdout);
  if (plain.total === 0 || plain.files.size > SCOPE_MAX_FILES) return null;

  const full = run('git', ['diff', '-U0', ...args], opts);
  if (full.status !== 0 || String(full.stdout || '').length > SCOPE_MAX_BYTES) return null;
  const perFile = splitDiffByFile(full.stdout);

  const offenders = [];
  for (const [file, changed] of plain.files) {
    if (changed < SCOPE_MIN_LINES) continue;
    const hunks = perFile.get(file);
    if (!hunks) continue;
    const addedTokens = normalizeTokens(hunks.added.join('\n'));
    const removedTokens = normalizeTokens(hunks.removed.join('\n'));
    const churn = addedTokens.length + removedTokens.length;
    if (!churn) continue;
    // 纯新增(无删除)天然是 100% 内容变动, 不可能是重排
    const semanticFraction = tokenDelta(removedTokens, addedTokens) / churn;
    if (semanticFraction <= SCOPE_SEMANTIC_FLOOR) {
      offenders.push({ file, changed, semanticFraction });
    }
  }
  offenders.sort((a, b) => b.changed - a.changed);
  return { total: plain.total, fileCount: plain.files.size, offenders };
}

/** 范围溢出诊断; 无可报告内容时返回空数组。 */
function scopeDiagnostics(runtime, args, command) {
  if (FORMAT_INTENT.test(command)) return [];
  const scope = getScopeStats(runtime, args);
  if (!scope || !scope.offenders.length) return [];

  const pct = (value) => `${Math.round(value * 100)}%`;
  const lines = ['⚠️  范围溢出审计: 行改动量与内容改动量不成比例'];
  for (const item of scope.offenders.slice(0, 5)) {
    lines.push(`   ${item.file}: 改动 ${item.changed} 行, 但内容只变了 ${pct(item.semanticFraction)} —— 其余是重排`);
  }
  if (scope.offenders.length > 5) lines.push(`   …另有 ${scope.offenders.length - 5} 个文件同样如此`);
  lines.push(
    '   规模不是问题, 比例才是。常见成因是整文件重写(脚本重生成、格式化工具跑全量),',
    '   把本可以是几行的改动变成全文件 diff, 审查者无法分辨哪几行才是真正的改动。',
    '   若确为格式化改动, 提交信息注明 style/format/重排 即可跳过本检查。',
  );
  return lines;
}

function commandFrom(payload) {
  return String(
    payload?.tool_input?.command
    || payload?.tool?.input?.command
    || payload?.input?.command
    || payload?.command
    || ''
  ).trim();
}

function evaluate(payload, runtime = {}) {
  const command = commandFrom(payload);
  const action = gitSubcommand(command);
  if ((action !== 'push' && action !== 'commit') || command.includes('--no-verify')) {
    return { source: 'diff-size-gate', decision: 'allow', diagnostics: [] };
  }

  // commit 时机只跑范围溢出: 规模阈值按分支累计算, 单次提交没有可比基线;
  // 而范围溢出恰恰要在这里说 —— 等到 push 才提示, 噪声已经进了历史。
  if (action === 'commit') {
    try {
      // 暂存区比对: base=HEAD, target='' 即 `git show :<file>`(索引区内容)
      const diagnostics = scopeDiagnostics(runtime, ["--cached"], command);
      return diagnostics.length
        ? { source: 'diff-size-gate', decision: 'warn', diagnostics, legacyExitCode: 0 }
        : { source: 'diff-size-gate', decision: 'allow', diagnostics: [] };
    } catch (error) {
      return { source: 'diff-size-gate', decision: 'allow', diagnostics: [`跳过：${error.message}`], error: error.message };
    }
  }

  try {
    const stats = getDiffStats(runtime);
    if (!stats || (stats.fileCount === 0 && stats.totalChanges === 0)) {
      return { source: 'diff-size-gate', decision: 'allow', diagnostics: [], stats };
    }
    const scope = stats.ref ? scopeDiagnostics(runtime, [stats.ref], command) : [];
    const isBlockThreshold = stats.fileCount >= BLOCK_FILES || stats.totalChanges >= BLOCK_LINES;
    const isWarnThreshold = stats.fileCount >= WARN_FILES || stats.totalChanges >= WARN_LINES;
    if (!isBlockThreshold && !isWarnThreshold) {
      return scope.length
        ? { source: 'diff-size-gate', decision: 'warn', diagnostics: scope, stats, legacyExitCode: 0 }
        : { source: 'diff-size-gate', decision: 'allow', diagnostics: [], stats };
    }

    const diagnostics = [
      '⚠️  变更集审计:',
      `   文件数: ${stats.fileCount} (警告 ${WARN_FILES} / 阻断 ${BLOCK_FILES})`,
      `   变更行: ${stats.totalChanges} (警告 ${WARN_LINES} / 阻断 ${BLOCK_LINES})`,
      `\n${stats.statOutput}`,
    ];
    if (isBlockThreshold) {
      diagnostics.push(
        `⚠️  变更很大 (文件≥${BLOCK_FILES} 或行≥${BLOCK_LINES})。`,
        '   强烈建议拆分为多个提交，便于审查与回滚。',
      );
    } else {
      diagnostics.push(
        '⚠️  变更较大，请确认是否应拆分为多个提交。',
        '   确认推送请重试: git push (无 --no-verify 也可放行)',
      );
    }
    diagnostics.push(...scope);
    return {
      source: 'diff-size-gate',
      decision: 'warn',
      diagnostics,
      stats,
      legacyExitCode: isBlockThreshold ? 1 : 0,
    };
  } catch (error) {
    return {
      source: 'diff-size-gate',
      decision: 'allow',
      diagnostics: [`跳过：${error.message}`],
      error: error.message,
    };
  }
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);
    const result = evaluate(JSON.parse(raw));
    for (const message of result.diagnostics) log(message);
    if (result.legacyExitCode === 1) process.exit(1);
  } catch (error) {
    log(`跳过：${error.message}`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  commandFrom,
  evaluate,
  getDiffStats,
  getScopeStats,
  parseDiffStat,
  parseNumstat,
  scopeDiagnostics,
};
