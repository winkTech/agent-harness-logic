'use strict';

/**
 * engine/scripts/lib/hook-latency.cjs — Hook 开销遥测 (D7, 2026-07-29)。
 *
 * 设计约束 (度量不得反噬速度):
 *   - 热路径只做一次 JSONL append, 不碰 SQLite (事件表是消费者流, 混入会污染水位);
 *   - 只读环境 (NO_PERSIST 等) 零写入;
 *   - 文件超限自动轮转一份 .1, 上限 ~5MB, 失败静默。
 *
 * report(): per-script p50/p95/max/count + 超预算清单 (预算: 单事件 p95 < 2000ms)。
 */

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./harness-root.cjs');

const STORE_FILE = path.join(HARNESS_ROOT, 'var', 'metrics', 'hook-latency.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;
const P95_BUDGET_MS = 2000;

function persistenceDisabled() {
  return process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1'
    || process.env.CLAUDE_HOOK_NO_WRITE === '1';
}

/** 记一条 hook 执行耗时。任何失败静默 — 遥测绝不能影响 hook 本体。 */
function record(script, event, durationMs) {
  if (persistenceDisabled()) return;
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    try {
      const stat = fs.statSync(STORE_FILE);
      if (stat.size > MAX_BYTES) fs.renameSync(STORE_FILE, `${STORE_FILE}.1`);
    } catch { /* 首次写入 */ }
    fs.appendFileSync(STORE_FILE, `${JSON.stringify({
      script: String(script || 'unknown'),
      event: String(event || ''),
      ms: Math.max(0, Math.round(durationMs)),
      at: new Date().toISOString(),
    })}\n`, 'utf8');
  } catch { /* 静默 */ }
}

/** 包装一个 async main: 记录整个 hook 进程的 wall time。 */
async function timed(script, event, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    record(script, event, Date.now() - started);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function report(opts = {}) {
  const file = opts.file || STORE_FILE;
  const byScript = new Map();
  for (const source of [file, `${file}.1`]) {
    let raw;
    try { raw = fs.readFileSync(source, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const list = byScript.get(entry.script) || [];
      list.push(Number(entry.ms) || 0);
      byScript.set(entry.script, list);
    }
  }
  const scripts = [...byScript.entries()].map(([script, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      script,
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] || 0,
      overBudget: percentile(sorted, 95) > P95_BUDGET_MS,
    };
  }).sort((a, b) => b.p95 - a.p95);
  return { budgetMs: P95_BUDGET_MS, scripts, overBudget: scripts.filter(s => s.overBudget) };
}

module.exports = { record, timed, report, P95_BUDGET_MS };

if (require.main === module) {
  console.log(JSON.stringify(report(), null, 2));
}
