#!/usr/bin/env node
'use strict';

/**
 * cost-state-ingest — platform cost single source of truth.
 *
 * Streams JSONL session transcripts (default glob under projects/), collects:
 *  - per-session cost-state cumulative records (type === 'cost-state')
 *  - assistant message.usage token records
 * and cross-checks recorded per-model costUSD against tokens x unit price
 * (core/engine/config/cost-prices.json), flagging deviations > 2%.
 *
 * Dedupe keys (validated against real transcripts):
 *  - cost-state: sessionId + startTime + totalCostUSD
 *    (duplicate double-writes differ only in totalDuration by tens of ms)
 *  - assistant usage: message.id
 *    (duplicate double-writes carry identical message.usage; verified no
 *     message.id appears with more than one distinct usage payload)
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { atomicWriteJson, resolvePath } = require('./lib/project-scope.cjs');

const MISMATCH_THRESHOLD_PCT = 2;

function usage() {
  process.stderr.write([
    'Usage: node cost-state-ingest.cjs [options]',
    '  --glob   <pattern>   transcript glob (default: projects/**/*.jsonl)',
    '  --out    <path>      report output path (default: var/metrics/cost-state-report.json)',
    '  --prices <path>      price table (default: core/engine/config/cost-prices.json)',
    '  --json               print the report JSON to stdout',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    glob: 'projects/**/*.jsonl',
    out: 'var/metrics/cost-state-report.json',
    prices: 'core/engine/config/cost-prices.json',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--glob') args.glob = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--prices') args.prices = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      usage();
      process.exit(2);
    }
  }
  return args;
}

function normalizeModel(name) {
  if (typeof name !== 'string') return '';
  return name
    .trim()
    .replace(/-\d{8}$/, '')   // dated variants, e.g. claude-haiku-4-5-20251001
    .replace(/\[1m\]$/i, ''); // context-window variants, e.g. claude-opus-5[1m]
}

/* ---------------------------------------------------------------- glob */

function globToRegExp(pattern) {
  const segs = pattern.split('/');
  let re = '';
  segs.forEach((seg, i) => {
    if (seg === '**') {
      re += (i === segs.length - 1) ? '.*' : '(?:.*/)?';
    } else {
      re += seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]');
      if (i < segs.length - 1) re += '/';
    }
  });
  return new RegExp(`^${re}$`);
}

function globBaseSegments(pattern) {
  const base = [];
  for (const seg of pattern.split('/')) {
    if (seg.includes('*') || seg.includes('?')) break;
    base.push(seg);
  }
  return base;
}

function walkMatch(dir, rel, regex, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMatch(childPath, childRel, regex, out);
    else if (entry.isFile() && regex.test(childRel)) out.push(childPath);
  }
}

function manualGlob(pattern) {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    try {
      return fs.statSync(pattern).isFile() ? [pattern] : [];
    } catch {
      return [];
    }
  }
  const base = globBaseSegments(pattern).join('/');
  const relPattern = pattern.slice(base ? base.length + 1 : 0) || '**';
  const regex = globToRegExp(relPattern);
  const baseDir = base ? base : path.parse(pattern).root;
  const out = [];
  walkMatch(baseDir, '', regex, out);
  return out.sort();
}

function listFiles(pattern) {
  if (typeof fs.globSync === 'function') {
    try {
      return fs.globSync(pattern).map((p) => path.resolve(String(p))).sort();
    } catch {
      /* fall through to portable implementation */
    }
  }
  return manualGlob(pattern).map((p) => path.resolve(String(p))).sort();
}

/* --------------------------------------------------------------- ingest */

function emptyTokens() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function addTokens(target, usage) {
  target.inputTokens += Number(usage.input_tokens) || 0;
  target.outputTokens += Number(usage.output_tokens) || 0;
  target.cacheReadInputTokens += Number(usage.cache_read_input_tokens) || 0;
  target.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens) || 0;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function expectedCost(usage, price) {
  const perMTok = (tokens, unit) => ((Number(tokens) || 0) * (Number(unit) || 0)) / 1e6;
  return perMTok(usage.inputTokens, price.input)
    + perMTok(usage.outputTokens, price.output)
    + perMTok(usage.cacheCreationInputTokens, price.cacheWrite)
    + perMTok(usage.cacheReadInputTokens, price.cacheRead);
}

function crossCheckSession(prices, sessionId, costState, sinks) {
  const modelUsage = costState.byModel || {};
  for (const [rawModel, usage] of Object.entries(modelUsage)) {
    if (!usage || typeof usage !== 'object') continue;
    const normalized = normalizeModel(rawModel);
    const price = prices.prices[normalized];
    if (!price) {
      sinks.priceGaps.push({ sessionId, model: rawModel, normalized, reason: 'no price entry' });
      continue;
    }
    if (price.input == null || price.output == null) {
      sinks.priceGaps.push({ sessionId, model: rawModel, normalized, reason: 'null price (unverified/approx)' });
      continue;
    }
    if (typeof usage.costUSD !== 'number') continue;
    const expected = expectedCost(usage, price);
    const recorded = usage.costUSD;
    const deltaPct = recorded !== 0
      ? ((recorded - expected) / recorded) * 100
      : (expected === 0 ? 0 : 100);
    if (Math.abs(deltaPct) > MISMATCH_THRESHOLD_PCT) {
      sinks.mismatches.push({
        sessionId,
        model: rawModel,
        normalized,
        recorded: round(recorded, 6),
        expected: round(expected, 6),
        deltaPct: round(deltaPct, 2),
        approxPrice: price.approx === true,
      });
    }
    // recorded cost rollup
    const rollupEntry = sinks.rollup[normalized] || (sinks.rollup[normalized] = {
      models: new Set(),
      ...emptyTokens(),
      assistantRecords: 0,
      recordedCostUSD: 0,
      expectedCostUSD: 0,
    });
    rollupEntry.models.add(rawModel);
    rollupEntry.recordedCostUSD += recorded;
  }
}

async function ingest() {
  const args = parseArgs(process.argv.slice(2));
  const pricesPath = resolvePath(args.prices, HARNESS_ROOT);
  const outPath = resolvePath(args.out, HARNESS_ROOT);
  const rawGlob = path.isAbsolute(args.glob) ? args.glob : path.join(HARNESS_ROOT, args.glob);

  let prices;
  try {
    prices = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`Cannot read price table ${pricesPath}: ${error.message}\n`);
    process.exit(2);
  }

  const files = listFiles(rawGlob.replace(/\\/g, '/'));

  const state = {
    usageSeen: new Set(),       // message.id
    costStateSeen: new Set(),   // sessionId|startTime|totalCostUSD
    sessionCost: new Map(),     // sessionId -> {rec, file, snapshots}
    totals: { usageRecords: 0, ...emptyTokens() },
    rollup: {},
    files: { count: files.length, lines: 0, parseErrors: 0, costStateRaw: 0, costStateDeduped: 0, usageRaw: 0, usageDeduped: 0 },
    mismatches: [],
    priceGaps: [],
  };

  for (const file of files) {
    const relFile = path.relative(HARNESS_ROOT, file).split(path.sep).join('/');
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      state.files.lines++;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        state.files.parseErrors++;
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;
      const sessionId = typeof rec.sessionId === 'string' && rec.sessionId
        ? rec.sessionId
        : path.basename(file, '.jsonl');

      if (rec.type === 'cost-state') {
        state.files.costStateRaw++;
        const key = `${sessionId}|${rec.startTime}|${rec.totalCostUSD}`;
        if (state.costStateSeen.has(key)) continue;
        state.costStateSeen.add(key);
        state.files.costStateDeduped++;
        const current = state.sessionCost.get(sessionId);
        if (!current || Number(rec.totalCostUSD) >= Number(current.rec.totalCostUSD)) {
          state.sessionCost.set(sessionId, { rec, file: relFile });
        }
        if (current) current.snapshots++;
        else state.sessionCost.get(sessionId).snapshots = 1;
      } else if (rec.type === 'assistant' && rec.message && rec.message.usage) {
        state.files.usageRaw++;
        const id = rec.message.id;
        if (typeof id === 'string' && id && state.usageSeen.has(id)) continue;
        if (typeof id === 'string' && id) state.usageSeen.add(id);
        state.files.usageDeduped++;
        state.totals.usageRecords++;
        addTokens(state.totals, rec.message.usage);
        const normalized = normalizeModel(rec.message.model) || 'unknown';
        const entry = state.rollup[normalized] || (state.rollup[normalized] = {
          models: new Set(),
          ...emptyTokens(),
          assistantRecords: 0,
          recordedCostUSD: 0,
          expectedCostUSD: 0,
        });
        entry.models.add(rec.message.model);
        entry.assistantRecords++;
        addTokens(entry, rec.message.usage);
      }
    }
  }

  // finalize sessions + cross-check final cumulative snapshot per session
  const sessions = [];
  const sinks = { mismatches: state.mismatches, priceGaps: state.priceGaps, rollup: state.rollup };
  for (const [sessionId, item] of [...state.sessionCost.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rec = item.rec;
    const byModel = {};
    for (const [raw, usage] of Object.entries(rec.modelUsage || {})) {
      byModel[raw] = {
        inputTokens: Number(usage.inputTokens) || 0,
        outputTokens: Number(usage.outputTokens) || 0,
        thinkingTokens: Number(usage.thinkingTokens) || 0,
        cacheReadInputTokens: Number(usage.cacheReadInputTokens) || 0,
        cacheCreationInputTokens: Number(usage.cacheCreationInputTokens) || 0,
        costUSD: typeof usage.costUSD === 'number' ? usage.costUSD : null,
      };
    }
    sessions.push({
      sessionId,
      file: item.file,
      snapshots: item.snapshots || 1,
      costState: {
        totalCostUSD: typeof rec.totalCostUSD === 'number' ? rec.totalCostUSD : null,
        totalAPIDuration: rec.totalAPIDuration ?? null,
        totalToolDuration: rec.totalToolDuration ?? null,
        totalLinesAdded: rec.totalLinesAdded ?? null,
        totalLinesRemoved: rec.totalLinesRemoved ?? null,
        byModel,
      },
    });
    crossCheckSession(prices, sessionId, { byModel }, sinks);
  }

  // per-model expected cost from rolled-up assistant tokens (where price known)
  for (const [normalized, entry] of Object.entries(state.rollup)) {
    const price = prices.prices[normalized];
    entry.models = [...entry.models].sort();
    entry.expectedCostUSD = (price && price.input != null && price.output != null)
      ? round(expectedCost(entry, price), 6)
      : null;
    entry.recordedCostUSD = entry.recordedCostUSD ? round(entry.recordedCostUSD, 6) : 0;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    priceVersion: prices.version ?? null,
    dedupe: {
      costState: 'sessionId|startTime|totalCostUSD',
      assistantUsage: 'message.id',
    },
    filesScanned: state.files,
    sessions,
    totals: state.totals,
    modelRollup: Object.fromEntries(Object.entries(state.rollup).sort(([a], [b]) => a.localeCompare(b))),
    mismatches: state.mismatches,
    priceGaps: state.priceGaps,
  };

  atomicWriteJson(outPath, report);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stderr.write(`sessions=${sessions.length} totalCostUSD=${round(sessions.reduce((sum, s) => sum + (s.costState.totalCostUSD || 0), 0), 4)} `
      + `in=${state.totals.inputTokens} out=${state.totals.outputTokens} `
      + `mismatches=${state.mismatches.length} priceGaps=${state.priceGaps.length} `
      + `report=${outPath}\n`);
  }
}

ingest().catch((error) => {
  process.stderr.write(`cost-state-ingest failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
