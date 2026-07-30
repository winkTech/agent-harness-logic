'use strict';

/**
 * engine/sqlite/store-costs.cjs — 成本记账。
 *
 * 两条路径:
 *   1. recordTranscriptUsage — 解析 Stop payload 的 transcript JSONL, 取真实
 *      message.usage 按模型累加, phase='usage' 幂等 upsert (主路径);
 *   2. estimate — 字符数粗估, phase='estimate' (仅当无 transcript 时的回退)。
 *
 * 定价唯一来源: engine/toolchains/model-pricing.json (USD/MTok + cache 系数)。
 *
 * 依赖: cost_ledger 表 (001-init 建表, 009-cost-usage 加 usage 列)
 */

const fs = require('node:fs');
const path = require('node:path');
const { openDb, resolveDb } = require('./index.cjs');

const PRICING_FILE = path.join(__dirname, '..', 'toolchains', 'model-pricing.json');

let pricingCache = null;

/** 读取定价表 (进程内缓存)。opts.pricing 可注入测试替身。 */
function loadPricing(opts = {}) {
  if (opts.pricing) return opts.pricing;
  if (!pricingCache) {
    pricingCache = JSON.parse(fs.readFileSync(opts.pricingFile || PRICING_FILE, 'utf8'));
  }
  return pricingCache;
}

/** 最长前缀匹配模型定价; 未知模型回退 fallback。 */
function priceFor(model, pricing) {
  const models = pricing.models || {};
  let best = null;
  for (const key of Object.keys(models)) {
    if (model === key || model.startsWith(`${key}-`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? models[best] : pricing.fallback;
}

/** 单模型累计 usage → USD。 */
function costUsd(usage, pricing) {
  const p = priceFor(usage.model, pricing);
  const readMul = Number(pricing.cacheReadMultiplier ?? 0.1);
  const writeMul = Number(pricing.cacheWriteMultiplier ?? 1.25);
  return (
    usage.inputTokens * p.input
    + usage.cacheWriteTokens * p.input * writeMul
    + usage.cacheReadTokens * p.input * readMul
    + usage.outputTokens * p.output
  ) / 1e6;
}

/**
 * 解析 Claude Code 会话 transcript (JSONL) 的真实 usage。
 *
 * 只认 message.usage 存在的行; 按 message.id 去重 (同一消息多次落盘取最后一次);
 * 坏行/无关行静默跳过。返回按模型分组的累计值。
 * 文件不存在或整体不可读时抛错 (调用方回退 estimate)。
 */
function parseTranscriptUsage(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const byMessage = new Map();
  let anonymous = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const message = obj && obj.message;
    const usage = message && message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const model = String(message.model || 'unknown');
    if (model === '<synthetic>') continue;
    const key = message.id ? String(message.id) : `anon-${anonymous += 1}`;
    byMessage.set(key, {
      model,
      inputTokens: Number(usage.input_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens || 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens || 0),
    });
  }
  const byModel = new Map();
  for (const entry of byMessage.values()) {
    const acc = byModel.get(entry.model) || {
      model: entry.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0,
    };
    acc.inputTokens += entry.inputTokens;
    acc.outputTokens += entry.outputTokens;
    acc.cacheReadTokens += entry.cacheReadTokens;
    acc.cacheWriteTokens += entry.cacheWriteTokens;
    acc.requests += 1;
    byModel.set(entry.model, acc);
  }
  return [...byModel.values()];
}

/**
 * 主路径: transcript → 每 (session_id, model) 一行 phase='usage' 累计值, 幂等 upsert。
 * transcript 是全会话累计, 所以重复调用只刷新同一行, 不叠加。
 * 返回 { recorded, models, totalUsd }; 文件级错误抛出, 由调用方回退。
 */
function recordTranscriptUsage(entry, opts = {}) {
  const sessionId = String(entry.sessionId || '');
  const transcriptPath = String(entry.transcriptPath || '');
  if (!sessionId || !transcriptPath) throw new Error('recordTranscriptUsage requires sessionId and transcriptPath');
  const usages = parseTranscriptUsage(transcriptPath);
  if (usages.length === 0) return { recorded: 0, models: [], totalUsd: 0 };

  const pricing = loadPricing(opts);
  const db = resolveDb(opts);
  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE cost_ledger
    SET tokens_in = ?, tokens_out = ?, cache_read_tokens = ?, cache_write_tokens = ?,
        cost_usd = ?, cost_credits = ?, notes = ?, created_at = ?
    WHERE session_id = ? AND model = ? AND phase = 'usage'
  `);
  const insert = db.prepare(`
    INSERT INTO cost_ledger
      (session_id, phase, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_credits, notes, created_at)
    VALUES (?, 'usage', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalUsd = 0;
  const models = [];
  for (const usage of usages) {
    const usd = costUsd(usage, pricing);
    totalUsd += usd;
    models.push({ model: usage.model, usd, requests: usage.requests });
    const notes = `transcript:${usage.requests}req`;
    const changed = update.run(
      usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens,
      usd, usd, notes, now, sessionId, usage.model,
    ).changes;
    if (changed === 0) {
      insert.run(
        sessionId, usage.model, usage.inputTokens, usage.outputTokens,
        usage.cacheReadTokens, usage.cacheWriteTokens, usd, usd, notes, now,
      );
    }
  }
  return { recorded: usages.length, models, totalUsd };
}

/** usage 路径报告: 按日与按模型的真实成本。 */
function usageReport(opts = {}) {
  const db = resolveDb(opts);
  return {
    daily: db.prepare(`
      SELECT DATE(created_at) AS day, model, SUM(tokens_in) AS in_, SUM(tokens_out) AS out_,
             SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
             ROUND(SUM(cost_usd), 4) AS usd, COUNT(*) AS sessions
      FROM cost_ledger WHERE phase = 'usage'
      GROUP BY DATE(created_at), model ORDER BY day DESC LIMIT 60
    `).all(),
    byModel: db.prepare(`
      SELECT model, SUM(tokens_in) AS in_, SUM(tokens_out) AS out_,
             ROUND(SUM(cost_usd), 4) AS usd, COUNT(*) AS sessions
      FROM cost_ledger WHERE phase = 'usage' GROUP BY model ORDER BY usd DESC
    `).all(),
    total: db.prepare(`
      SELECT ROUND(SUM(cost_usd), 4) AS usd, COUNT(*) AS rows_
      FROM cost_ledger WHERE phase = 'usage'
    `).get(),
    estimateRows: db.prepare(`
      SELECT COUNT(*) AS n, MAX(created_at) AS last FROM cost_ledger WHERE phase = 'estimate'
    `).get(),
  };
}

/**
 * 记录一条成本条目。
 */
function recordSession(entry, opts = {}) {
  const db = resolveDb(opts);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cost_ledger (session_id, phase, tokens_in, tokens_out, cost_credits, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.sessionId,
    entry.phase || 'general',
    entry.tokensIn || 0,
    entry.tokensOut || 0,
    entry.costCredits || 0,
    entry.notes || null,
    now,
  );
}

/**
 * 查询 session 级别汇总。
 */
function sessionReport(sessionId, opts = {}) {
  const db = resolveDb(opts);
  return db.prepare(`
    SELECT
      COUNT(*) AS calls,
      SUM(tokens_in) AS totalIn,
      SUM(tokens_out) AS totalOut,
      SUM(cost_credits) AS totalCost,
      MIN(created_at) AS firstAt,
      MAX(created_at) AS lastAt
    FROM cost_ledger WHERE session_id = ?
  `).get(sessionId);
}

/**
 * 全局汇总 (按日/按阶段)。
 */
function summary(opts = {}) {
  const db = resolveDb(opts);
  return {
    daily: db.prepare(`
      SELECT DATE(created_at) AS day, SUM(tokens_in) AS in_, SUM(tokens_out) AS out_,
             SUM(cost_credits) AS cost, COUNT(*) AS calls
      FROM cost_ledger GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 30
    `).all(),
    byPhase: db.prepare(`
      SELECT phase, SUM(tokens_in) AS in_, SUM(tokens_out) AS out_,
             SUM(cost_credits) AS cost, COUNT(*) AS calls
      FROM cost_ledger GROUP BY phase ORDER BY cost DESC
    `).all(),
    total: db.prepare(`
      SELECT SUM(tokens_in) AS in_, SUM(tokens_out) AS out_, SUM(cost_credits) AS cost
      FROM cost_ledger
    `).get(),
  };
}

/**
 * 为当前 session 做一个快速估算 (在 Stop hook 中调用)。
 * 实际用量取决于 Claude Code 的 token 计数, 此处按输入+输出字符数估算。
 * @param {string} sessionId
 * @param {string} responseText — Claude 的本次响应文本
 * @param {object} [opts]
 */
function estimate(sessionId, responseText, opts = {}) {
  const db = resolveDb(opts);
  const tokensIn = Math.ceil((responseText.length || 0) * 0.4); // 粗略: 1 token ≈ 2.5 chars
  const tokensOut = Math.ceil((responseText.length || 0) * 0.3);
  const costCredits = (tokensIn + tokensOut) * 0.000003; // Claude Opus 粗估值

  db.prepare(`
    INSERT INTO cost_ledger (session_id, phase, tokens_in, tokens_out, cost_credits, notes, created_at)
    VALUES (?, 'estimate', ?, ?, ?, 'auto-estimate', ?)
  `).run(sessionId, tokensIn, tokensOut, costCredits, new Date().toISOString());
}

module.exports = {
  recordSession,
  sessionReport,
  summary,
  estimate,
  loadPricing,
  priceFor,
  costUsd,
  parseTranscriptUsage,
  recordTranscriptUsage,
  usageReport,
};

if (require.main === module) {
  const handle = openDb();
  try {
    console.log(JSON.stringify(usageReport({ db: handle.db }), null, 2));
  } finally {
    try { handle.close(); } catch { /* CLI cleanup */ }
  }
}
