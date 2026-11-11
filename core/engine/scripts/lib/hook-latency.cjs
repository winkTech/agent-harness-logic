'use strict';

/**
 * core/engine/scripts/lib/hook-latency.cjs — Hook 开销遥测 (D7, 2026-07-29)。
 *
 * 设计约束 (度量不得反噬速度):
 *   - 热路径只做一次 JSONL append, 不碰 SQLite (事件表是消费者流, 混入会污染水位);
 *   - 只读环境 (NO_PERSIST 等) 零写入;
 *   - 文件超限自动轮转一份 .1, 上限 ~5MB, 失败静默。
 *
 * report(): per-script p50/p95/max/count + 每脚本预算与超标判定 (M4a 档位硬门)。
 *
 * 预算档位 (warm p95):
 *   preflight-router 200ms / postflight-router 250ms / prompt-context 300ms /
 *   其余**同步**入口 500ms / async 入口不计入 (平台不阻塞等待, 延迟不进热路径)。
 * 同步还是 async 以 hosts/claude-code/registrations.json 里该脚本的 `async: true` 为准 —— 不硬编码
 * 脚本名单; 同一脚本既有同步又有 async 注册时按同步算 (同步那条仍在热路径上)。
 * env `CLAUDE_HARNESS_LATENCY_SCALE` (默认 1, CI 设 3) 把所有档位整体放大。
 */

const fs = require('node:fs');
const path = require('node:path');
const { varPath } = require('./harness-state.cjs');
const { HARNESS_ROOT } = require('./harness-root.cjs');

// Phase 2.4：防写开关双名兼容（宿主名映射集中在 io/env.cjs，本文件不出现宿主词）。
const { envValue } = require('../io/env.cjs');
function envFlag(name) {
  const v = envValue(process.env, name);
  return v === '1' || v === 'true';
}

const STORE_FILE = varPath('metrics', 'hook-latency.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;

/** 档位表: 脚本名 (无扩展名, 小写) → 基准预算 ms。未列出的同步入口用 DEFAULT_SYNC_BUDGET_MS。 */
const SCRIPT_BUDGETS_MS = {
  'preflight-router': 200,
  'postflight-router': 250,
  'prompt-context': 300,
};
const DEFAULT_SYNC_BUDGET_MS = 500;
/** 兼容既有导出名: 现在含义是"未列档位的同步入口预算"。 */
const P95_BUDGET_MS = DEFAULT_SYNC_BUDGET_MS;
const REGISTRATIONS_FILE = path.join(HARNESS_ROOT, 'core', 'engine', 'hooks', 'registrations.json');

function persistenceDisabled() {
  return envFlag('HARNESS_NO_PERSIST')
    || envFlag('HARNESS_VERIFY_READONLY')
    || envFlag('HARNESS_NO_DIAGNOSTIC_WRITES')
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

// ── 预算档位 ───────────────────────────────────────────────────────────────

/** `.../hooks/preflight-router.cjs` / `stop-runner:evidence` → `preflight-router` / `stop-runner`。 */
function normalizeScriptName(script) {
  const raw = String(script || '').trim().replace(/\\/g, '/');
  const base = raw.split('/').pop() || raw;
  return base.split(':')[0].replace(/\.(?:cjs|mjs|js)$/i, '').toLowerCase();
}

/** 从一条 hook 命令行里取出被执行的脚本名 (可能有多个: `--batch a,b`)。 */
function scriptNamesFromCommand(command) {
  const names = [];
  for (const token of String(command || '').split(/\s+/)) {
    if (!/\.(?:cjs|mjs|js)$/i.test(token)) continue;
    names.push(normalizeScriptName(token));
  }
  return names;
}

function readRegistrations(opts = {}) {
  if (opts.registrations) return opts.registrations;
  try {
    return JSON.parse(fs.readFileSync(opts.registrationsFile || REGISTRATIONS_FILE, 'utf8'));
  } catch {
    return null; // 未渲染/无模板: 全部按同步入口判, 不静默放行
  }
}

/**
 * 脚本名 → { sync, async }。async-only 的脚本才不计入预算。
 * @returns {Map<string, {sync: boolean, async: boolean}>}
 */
function registrationIndex(opts = {}) {
  const doc = readRegistrations(opts);
  const index = new Map();
  for (const groups of Object.values(doc?.hooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [group];
      for (const hook of hooks) {
        const isAsync = Boolean(hook?.async || group?.async);
        for (const name of scriptNamesFromCommand(hook?.command || hook?.run || '')) {
          const record_ = index.get(name) || { sync: false, async: false };
          if (isAsync) record_.async = true;
          else record_.sync = true;
          index.set(name, record_);
        }
      }
    }
  }
  return index;
}

function latencyScale(env = process.env) {
  const raw = Number(env?.CLAUDE_HARNESS_LATENCY_SCALE);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * 某脚本的 warm p95 预算。
 * @returns {{script, name, tier, registered, async, baseBudgetMs, scale, budgetMs}}
 *          `budgetMs === null` 表示不计入 (async 入口)。
 */
function budgetFor(script, opts = {}) {
  const index = opts.index || registrationIndex(opts);
  const name = normalizeScriptName(script);
  const registration = index.get(name) || null;
  const isAsync = Boolean(registration && registration.async && !registration.sync);
  const scale = Number.isFinite(opts.scale) && opts.scale > 0
    ? opts.scale
    : latencyScale(opts.env || process.env);
  const base = isAsync ? null : (SCRIPT_BUDGETS_MS[name] ?? DEFAULT_SYNC_BUDGET_MS);
  return {
    script: String(script || ''),
    name,
    tier: isAsync ? 'async' : (SCRIPT_BUDGETS_MS[name] != null ? name : 'default-sync'),
    registered: Boolean(registration),
    async: isAsync,
    baseBudgetMs: base,
    scale,
    budgetMs: base === null ? null : Math.round(base * scale),
  };
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
  const index = opts.index || registrationIndex(opts);
  const scale = Number.isFinite(opts.scale) && opts.scale > 0
    ? opts.scale
    : latencyScale(opts.env || process.env);
  const scripts = [...byScript.entries()].map(([script, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    const budget = budgetFor(script, { index, scale });
    return {
      script,
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95,
      max: sorted[sorted.length - 1] || 0,
      budgetMs: budget.budgetMs,
      budgetTier: budget.tier,
      async: budget.async,
      overBudget: budget.budgetMs !== null && p95 > budget.budgetMs,
    };
  }).sort((a, b) => b.p95 - a.p95);
  return {
    budgetMs: Math.round(DEFAULT_SYNC_BUDGET_MS * scale),
    scale,
    budgets: Object.fromEntries(scripts.map(entry => [entry.script, entry.budgetMs])),
    scripts,
    overBudget: scripts.filter(s => s.overBudget),
  };
}

module.exports = {
  record,
  timed,
  report,
  P95_BUDGET_MS,
  DEFAULT_SYNC_BUDGET_MS,
  SCRIPT_BUDGETS_MS,
  normalizeScriptName,
  scriptNamesFromCommand,
  registrationIndex,
  latencyScale,
  budgetFor,
};

if (require.main === module) {
  console.log(JSON.stringify(report(), null, 2));
}
