#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/harness-telemetry-prune.cjs — 遥测驱动规则/记忆“做减法”巡检报告（M5）
 *
 * 严格只读：依据 SQLite 中的 facts、memory_retrieval_exposures、memory_outcomes、
 * events(rule_load) 生成 30/90 天低价值资产治理建议（只输出候选清单，不自动删除规则）。
 *
 * 用法：
 *   node core/engine/scripts/harness-telemetry-prune.cjs [--days 90] [--json]
 */

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { openDb } = require('../sqlite/index.cjs');

function parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  return Date.parse(s);
}

function isDreamTelemetryNoise(name) {
  return /^dream-\d{4}-\d{2}-\d{2}-(?:tool-fail|transition)-/i.test(String(name || ''));
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name));
}

function listRuleFiles(root = HARNESS_ROOT) {
  const dirs = [path.join(root, 'core', 'rules')];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith('.md')) out.push(name);
    }
  }
  return out;
}

function analyzeTelemetry(dbOrHandle, opts = {}) {
  const db = dbOrHandle && dbOrHandle.db ? dbOrHandle.db : dbOrHandle;
  const days = Math.max(1, Number(opts.days || 90));
  const now = Number(opts.now ?? Date.now());
  const DAY_MS = 86_400_000;
  const cutoffMs = now - days * DAY_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const root = opts.root || HARNESS_ROOT;

  const summary = {
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    facts: { totalActive: 0, zeroHitTentative: 0, pruneCandidates: [] },
    rules: { tracked: 0, zeroLoadRules: [], loadCounts: {} },
    outcomes: { available: false, pass: 0, fail: 0, inconclusive: 0 },
  };

  if (tableExists(db, 'facts')) {
    const activeRows = db.prepare(`
      SELECT id, name, namespace, source, confidence, hit_count, created_at
      FROM facts
      WHERE COALESCE(status, 'active') = 'active'
    `).all();
    summary.facts.totalActive = activeRows.length;

    const exposedIds = new Set();
    if (tableExists(db, 'memory_retrieval_exposures')) {
      for (const row of db.prepare('SELECT DISTINCT memory_id FROM memory_retrieval_exposures WHERE memory_id IS NOT NULL').all()) {
        exposedIds.add(String(row.memory_id));
      }
    }

    const candidates = [];
    for (const row of activeRows) {
      const confVal = Number(row.confidence);
      const isTentative = Number.isFinite(confVal)
        ? confVal < 0.8
        : String(row.confidence || 'tentative').toLowerCase() === 'tentative';
      const hits = Number(row.hit_count || 0);
      const createdMs = parseTimestampMs(row.created_at);
      const ageDays = Number.isFinite(createdMs) ? Number(((now - createdMs) / DAY_MS).toFixed(1)) : null;
      const neverExposed = !exposedIds.has(String(row.id));
      const telemetryNoise = row.source === 'script:dream' && isDreamTelemetryNoise(row.name);
      if (isTentative && hits === 0) {
        summary.facts.zeroHitTentative += 1;
        if (neverExposed && (telemetryNoise || ageDays === null || ageDays >= days)) {
          candidates.push({
            id: row.id,
            name: row.name,
            source: row.source,
            ageDays,
            telemetryNoise,
            reason: telemetryNoise
              ? 'unanalyzed Dream telemetry counter with 0 hits and 0 exposures'
              : `tentative fact with 0 hits and 0 exposures over >=${days}d`,
          });
        }
      }
    }
    candidates.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
    summary.facts.pruneCandidates = candidates.slice(0, 50);
  }

  const ruleFiles = listRuleFiles(root).filter((f) => f.toLowerCase() !== 'readme.md');
  summary.rules.tracked = ruleFiles.length;
  const counts = Object.fromEntries(ruleFiles.map((f) => [f, 0]));
  if (tableExists(db, 'runtime_events')) {
    const rows = db.prepare(`
      SELECT payload FROM runtime_events
      WHERE type = 'rule_load' AND created_at >= ?
    `).all(cutoffIso);
    for (const row of rows) {
      let parsed = null;
      try { parsed = JSON.parse(String(row.payload || '')); } catch { parsed = null; }
      const files = Array.isArray(parsed?.files) ? parsed.files : [];
      for (const file of files) {
        const base = path.basename(String(file));
        if (Object.prototype.hasOwnProperty.call(counts, base)) counts[base] += 1;
      }
    }
  }
  summary.rules.loadCounts = counts;
  summary.rules.zeroLoadRules = ruleFiles.filter((f) => !f.startsWith('00-') && counts[f] === 0);

  if (tableExists(db, 'memory_outcomes')) {
    summary.outcomes.available = true;
    const rows = db.prepare('SELECT verdict, observed_at FROM memory_outcomes').all();
    for (const row of rows) {
      const ts = parseTimestampMs(row.observed_at);
      if (Number.isFinite(ts) && ts < cutoffMs) continue;
      const key = String(row.verdict || '').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(summary.outcomes, key)) {
        summary.outcomes[key] += 1;
      }
    }
  }

  return summary;
}

function retireDreamNoiseFacts(dbOrHandle, opts = {}) {
  const db = dbOrHandle && dbOrHandle.db ? dbOrHandle.db : dbOrHandle;
  const dryRun = opts.dryRun !== false;
  if (!tableExists(db, 'facts')) return { dryRun, retired: 0, ids: [] };
  const exposedIds = new Set();
  if (tableExists(db, 'memory_retrieval_exposures')) {
    for (const row of db.prepare('SELECT DISTINCT memory_id FROM memory_retrieval_exposures WHERE memory_id IS NOT NULL').all()) {
      exposedIds.add(String(row.memory_id));
    }
  }
  const rows = db.prepare(`
    SELECT id, name FROM facts
    WHERE COALESCE(status, 'active') = 'active'
      AND source = 'script:dream'
      AND COALESCE(hit_count, 0) = 0
  `).all();
  const targets = rows.filter((r) => isDreamTelemetryNoise(r.name) && !exposedIds.has(String(r.id)));
  if (!dryRun && targets.length > 0) {
    const stmt = db.prepare("UPDATE facts SET status = 'tombstone', updated_at = ? WHERE id = ?");
    const nowIso = new Date().toISOString();
    for (const item of targets) stmt.run(nowIso, item.id);
  }
  return { dryRun, retired: targets.length, ids: targets.map((t) => t.id) };
}

function parseCli(argv) {
  const out = { days: 90, json: false, retireNoise: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--retire-noise') out.retireNoise = true;
    else if (argv[i] === '--days') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) out.days = v;
    }
  }
  return out;
}

function main() {
  const opts = parseCli(process.argv.slice(2));
  const db = openDb();
  try {
    const retired = opts.retireNoise ? retireDreamNoiseFacts(db, { dryRun: false }) : null;
    const report = analyzeTelemetry(db, { days: opts.days });
    if (retired) report.retiredDreamNoise = retired;
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      if (retired) console.log(`[telemetry-prune] Retired ${retired.retired} zero-hit Dream telemetry noise row(s) via tombstone`);
      console.log(`[telemetry-prune] Window: ${report.windowDays}d | Active facts: ${report.facts.totalActive} (zero-hit tentative: ${report.facts.zeroHitTentative}, prune candidates: ${report.facts.pruneCandidates.length})`);
      console.log(`[telemetry-prune] Core rules tracked: ${report.rules.tracked} | Zero-load rules: ${report.rules.zeroLoadRules.length ? report.rules.zeroLoadRules.join(', ') : 'none'}`);
      console.log(`[telemetry-prune] Outcomes (${report.windowDays}d): pass=${report.outcomes.pass} fail=${report.outcomes.fail} inconclusive=${report.outcomes.inconclusive}`);
    }
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { analyzeTelemetry, listRuleFiles, parseTimestampMs, retireDreamNoiseFacts };
