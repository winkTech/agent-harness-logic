#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { shouldSyncMemoryFile } = require('./lib/memory-file-policy.cjs');

const DAY_MS = 86_400_000;
const STATE_RELATIVE_PATH = path.join('var', 'maintenance', 'memory-knowledge-maintenance.json');
const DEFAULTS = {
  intervalDays: 7,
  workDays: 14,
  autoWorkDays: 7,
  abandonedWorkDays: 45,
  errorDays: 90,
  projectDays: 30,
  sourceDays: 365,
  largeSourceBytes: 250_000,
  maxSnippetChars: 240,
  eventRetentionDays: 14,
  reconcile: true,
};
function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    ...DEFAULTS,
    execute: false,
    dryRun: true,
    auto: false,
    force: false,
    json: false,
    reindex: true,
    home: HARNESS_ROOT,
    dbPath: null,
    candidateLedger: null,
  };
  const numeric = {
    'interval-days': 'intervalDays',
    'work-days': 'workDays',
    'auto-work-days': 'autoWorkDays',
    'abandoned-work-days': 'abandonedWorkDays',
    'error-days': 'errorDays',
    'project-days': 'projectDays',
    'source-days': 'sourceDays',
    'large-source-bytes': 'largeSourceBytes',
    'max-snippet-chars': 'maxSnippetChars',
    'event-retention-days': 'eventRetentionDays',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') { opts.execute = true; opts.dryRun = false; }
    else if (arg === '--dry-run') { opts.execute = false; opts.dryRun = true; }
    else if (arg === '--auto') opts.auto = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-reindex') opts.reindex = false;
    else if (arg === '--reindex') opts.reindex = true;
    else if (arg === '--reconcile') opts.reconcile = true;
    else if (arg === '--no-reconcile') opts.reconcile = false;
    else if (arg === '--home') opts.home = path.resolve(argv[++index]);
    else if (arg === '--db-path') opts.dbPath = argv[++index];
    else if (arg === '--candidate-ledger') opts.candidateLedger = argv[++index];
    else if (numeric[arg.slice(2)]) {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} expects a non-negative number`);
      opts[numeric[arg.slice(2)]] = value;
    }
  }
  return opts;
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}

function walkMarkdown(root, files = []) {
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(full);
  }
  return files;
}

function parseFrontmatter(content) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const frontmatter = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === '---') { bodyStart = index + 1; break; }
      const match = lines[index].match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
      if (match) frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { frontmatter, body: lines.slice(bodyStart).join('\n').trim() };
}

function extractDate(filePath, content) {
  const { frontmatter } = parseFrontmatter(content);
  const raw = frontmatter.updated || frontmatter.date || frontmatter.created || '';
  const fromFrontmatter = String(raw).match(/\d{4}-\d{2}-\d{2}/);
  if (fromFrontmatter) return fromFrontmatter[0];
  const fromName = path.basename(filePath).match(/\d{4}-\d{2}-\d{2}/);
  if (fromName) return fromName[0];
  try { return new Date(fs.statSync(filePath).mtimeMs).toISOString().slice(0, 10); }
  catch { return null; }
}

function daysOld(dateString, now = new Date()) {
  const timestamp = Date.parse(`${dateString || ''}T00:00:00Z`);
  return Number.isFinite(timestamp) ? Math.floor((now.getTime() - timestamp) / DAY_MS) : null;
}

function isCompleted(content) {
  return /status\s*:\s*(completed|complete|done|完成|已完成)/i.test(content);
}

function isAutoRecord(filePath) {
  return /tool_success_|tool_error_|hook_failure_|auto-record/i.test(path.basename(filePath));
}

function isNoise(filePath, content) {
  return isAutoRecord(filePath) || /待分析|待补充/.test(content);
}

function firstHeading(content) {
  const { body } = parseFrontmatter(content);
  return (body.split(/\r?\n/).find((line) => line.trim()) || '').replace(/^#+\s*/, '').trim();
}

function compactSnippet(content, max) {
  return parseFrontmatter(content).body.replace(/\s+/g, ' ').trim().slice(0, max);
}

function relative(home, filePath) {
  return path.relative(home, filePath).replace(/\\/g, '/');
}

function collectMemoryCandidates(opts, now = new Date(), runtime = {}) {
  const home = path.resolve(runtime.home || opts.home || HARNESS_ROOT);
  const memoryDir = path.join(home, 'memory');
  const candidates = [];
  const add = (filePath, kind, reason, ageDays, content) => candidates.push({
    kind,
    file: relative(home, filePath),
    ageDays,
    reason,
    title: firstHeading(content) || path.basename(filePath, '.md'),
    snippet: compactSnippet(content, opts.maxSnippetChars),
    content,
    absolutePath: filePath,
  });

  for (const filePath of walkMarkdown(path.join(memoryDir, 'work'))) {
    if (/template/i.test(path.basename(filePath))) continue;
    const content = readText(filePath);
    const age = daysOld(extractDate(filePath, content), now);
    if (age === null) continue;
    if (isAutoRecord(filePath) && age >= opts.autoWorkDays) add(filePath, 'work-auto', 'generated work record past retention', age, content);
    else if (isCompleted(content) && age >= opts.workDays) add(filePath, 'work-completed', 'completed work memory past retention', age, content);
    else if (!isCompleted(content) && age >= opts.abandonedWorkDays) add(filePath, 'work-stale-open', 'open work memory requires review', age, content);
  }

  for (const filePath of walkMarkdown(path.join(memoryDir, 'errors'))) {
    if (/template/i.test(path.basename(filePath))) continue;
    const content = readText(filePath);
    const age = daysOld(extractDate(filePath, content), now);
    if (age !== null && age >= opts.errorDays) add(filePath, 'error-old', 'error record requires distillation or rejection', age, content);
  }

  for (const filePath of walkMarkdown(path.join(memoryDir, 'projects'))) {
    const content = readText(filePath);
    const age = daysOld(extractDate(filePath, content), now);
    if (age !== null && isCompleted(content) && age >= opts.projectDays) add(filePath, 'project-completed', 'completed project memory requires durable-summary review', age, content);
  }
  return candidates;
}

function collectKnowledgeCandidates(opts, now = new Date(), runtime = {}) {
  const home = path.resolve(runtime.home || opts.home || HARNESS_ROOT);
  const sourceDir = path.join(home, 'engineering-assets', 'knowledge', 'archive', 'sources');
  const candidates = [];
  for (const filePath of walkMarkdown(sourceDir)) {
    const content = readText(filePath);
    const ageDays = daysOld(extractDate(filePath, content), now);
    const sizeBytes = fs.statSync(filePath).size;
    if ((ageDays !== null && ageDays >= opts.sourceDays) || sizeBytes >= opts.largeSourceBytes) {
      candidates.push({
        kind: 'literature-source',
        file: relative(home, filePath),
        ageDays,
        sizeBytes,
        reason: sizeBytes >= opts.largeSourceBytes ? 'large archived source requires review' : 'old archived source requires review',
        title: firstHeading(content) || path.basename(filePath, '.md'),
      });
    }
  }
  return candidates;
}

function section(content, names) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const wanted = names.map((name) => name.toLowerCase());
  const start = lines.findIndex((line) => {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1]?.toLowerCase();
    return heading && wanted.some((name) => heading === name || heading.includes(name));
  });
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function ruleCandidateFrom(candidate) {
  if (candidate.kind !== 'error-old' || isNoise(candidate.absolutePath, candidate.content)) return null;
  const rootCause = section(candidate.content, ['root cause', '根因']);
  const verifiedFix = section(candidate.content, ['verified fix', '已验证修复', '验证修复']);
  const prevention = section(candidate.content, ['prevention', '预防']);
  const triggerText = section(candidate.content, ['trigger conditions', '触发条件', '适用条件']);
  if (!rootCause || !verifiedFix || !prevention || !triggerText) return null;
  const triggerConditions = triggerText.split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
  return {
    source: 'maintenance:file',
    sourcePath: candidate.file,
    title: candidate.title,
    rootCause,
    verifiedFix,
    prevention,
    triggerConditions,
    evidence: [{ kind: 'source_record', path: candidate.file }],
    status: 'candidate',
  };
}

function loadState(home) {
  return readJson(path.join(home, STATE_RELATIVE_PATH), {});
}

function dueState(home, now, intervalDays) {
  const state = loadState(home);
  const last = Date.parse(state.lastExecutedAt || '');
  const ageDays = Number.isFinite(last) ? (now.getTime() - last) / DAY_MS : null;
  return {
    due: ageDays === null || ageDays >= intervalDays,
    ageDays,
    lastExecutedAt: state.lastExecutedAt || null,
    nextDueAt: Number.isFinite(last) ? new Date(last + intervalDays * DAY_MS).toISOString() : null,
  };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name));
}

function inspectEventConsumers(db, cutoff) {
  if (!tableExists(db, 'runtime_events') || !tableExists(db, 'runtime_consumer_watermarks')) {
    return {
      registeredConsumers: 0,
      safeWatermark: 0,
      consumers: [],
      consumedEventsPastRetention: 0,
    };
  }
  const consumers = db.prepare(
    'SELECT consumer, watermark, updated_at FROM runtime_consumer_watermarks ORDER BY consumer',
  ).all().map((row) => {
    const watermark = Number(row.watermark || 0);
    return {
      consumer: row.consumer,
      watermark,
      pending: Number(db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE event_id > ?').get(watermark).c || 0),
      updatedAt: row.updated_at || null,
    };
  });
  const safeWatermark = consumers.length > 0
    ? Math.min(...consumers.map((item) => item.watermark))
    : 0;
  return {
    registeredConsumers: consumers.length,
    safeWatermark,
    consumers,
    consumedEventsPastRetention: consumers.length > 0
      ? Number(db.prepare(
        'SELECT COUNT(*) AS c FROM runtime_events WHERE event_id <= ? AND created_at < ?',
      ).get(safeWatermark, cutoff).c || 0)
      : 0,
  };
}

function defaultInspectSqlite(context) {
  try {
    const { openDb } = require('../sqlite/index.cjs');
    const wDb = openDb({ ...(context.dbPath ? { path: context.dbPath } : {}), readonly: true });
    const db = wDb.db;
    const cutoff = new Date(context.now.getTime() - context.opts.eventRetentionDays * DAY_MS).toISOString();
    const eventConsumers = inspectEventConsumers(db, cutoff);
    const result = {
      totalFacts: tableExists(db, 'facts') ? Number(db.prepare('SELECT COUNT(*) AS c FROM facts').get().c || 0) : 0,
      expiredFacts: tableExists(db, 'facts') ? Number(db.prepare('SELECT COUNT(*) AS c FROM facts WHERE ttl_until IS NOT NULL AND ttl_until <= ?').get(context.now.getTime()).c || 0) : 0,
      ...eventConsumers,
    };
    wDb.close();
    return result;
  } catch (error) {
    return { error: error.message, totalFacts: null, expiredFacts: null, consumedEventsPastRetention: null };
  }
}

function defaultRetainEvents(plan, context) {
  const { openDb } = require('../sqlite/index.cjs');
  const { purgeConsumedEvents } = require('../sqlite/store-events.cjs');
  const wDb = openDb(context.dbPath ? { path: context.dbPath } : {});
  const db = wDb.db;
  if (!tableExists(db, 'runtime_events') || !tableExists(db, 'runtime_consumer_watermarks')) {
    wDb.close();
    return { deleted: 0, reason: 'event tables missing' };
  }
  const result = purgeConsumedEvents(plan.eventRetentionDays, { db });
  wDb.close();
  return result;
}

function fileFacts(home) {
  const memoryDir = path.join(home, 'memory');
  const { parseMemoryFact } = require('../hooks/learning/postflight-observer.cjs');
  const output = [];
  for (const filePath of walkMarkdown(memoryDir)) {
    const content = readText(filePath);
    if (!shouldSyncMemoryFile(filePath, { memoryDir, content }) || isNoise(filePath, content)) continue;
    const parsed = parseMemoryFact(filePath, memoryDir);
    if (!parsed) continue;
    const verifiedError = parsed.namespace === 'errors'
      && Boolean(section(content, ['root cause', '根因']))
      && Boolean(section(content, ['verified fix', '已验证修复', '验证修复']))
      && Boolean(section(content, ['prevention', '预防']))
      && Boolean(section(content, ['trigger conditions', '触发条件', '适用条件']));
    output.push({
      ...parsed,
      source: 'migration:file',
      sourceKey: parsed.source_key,
      sourcePath: parsed.source_path,
      confidence: parsed.namespace === 'errors' ? (verifiedError ? 0.9 : 0.4) : parsed.confidence,
    });
  }
  return output;
}

function defaultReconcileFacts(_plan, context) {
  const { openDb } = require('../sqlite/index.cjs');
  const { reconcileMemoryFacts, softDeleteMemory } = require('../sqlite/store-memory.cjs');
  const wDb = openDb(context.dbPath ? { path: context.dbPath } : {});
  const db = wDb.db;
  const current = fileFacts(context.home);
  const reconciled = reconcileMemoryFacts(current, { db });
  const legacyOrphans = db.prepare(`
    SELECT id FROM facts
    WHERE source = 'migration:file'
      AND source_key IS NULL
      AND source_path IS NULL
      AND COALESCE(status, 'active') = 'active'
  `).all();
  let retiredLegacy = 0;
  for (const fact of legacyOrphans) {
    softDeleteMemory(fact.id, { db });
    retiredLegacy += 1;
  }
  wDb.close();
  return {
    ...reconciled,
    inserted: reconciled.created,
    removed: 0,
    matched: reconciled.updated + reconciled.moved,
    eligible: current.length,
    retiredLegacy,
  };
}

/**
 * 归因驱动的记忆退役 (D5.4, 2026-07-30)。
 * 三条证据规则, 全部只缩短 ttl_until (从检索中退役), 不删行不动 Markdown:
 *   A negative-outcome: 30d 内 ≥2 次 fail outcome 且 0 次 pass → TTL 14d;
 *   B exposed-never-applied: 90d 内 ≥5 次暴露且从无 application → TTL 30d;
 *   C never-exposed: 遥测已连续在线 ≥90d 时, 90d 前创建且从未被暴露的
 *     非 verified 事实 → TTL 30d。遥测在线时长门槛防止用"仪表刚接上"
 *     的空白历史误判存量事实 (召回 2026-07-29 才修通)。
 */
const ATTRIBUTION_RETIREMENT = {
  negativeWindowDays: 30, negativeMinFails: 2, negativeTtlDays: 14,
  unusedWindowDays: 90, unusedMinExposures: 5, unusedTtlDays: 30,
  neverExposedDays: 90, neverExposedTtlDays: 30,
};

function collectAttributionRetirement(context) {
  try {
    const { openDb } = require('../sqlite/index.cjs');
    const wDb = openDb({ ...(context.dbPath ? { path: context.dbPath } : {}), readonly: true });
    const db = wDb.db;
    try {
      if (!tableExists(db, 'facts') || !tableExists(db, 'memory_retrieval_exposures')) {
        return { actions: [], telemetryLiveSince: null, reason: 'attribution tables missing' };
      }
      const now = context.now.getTime();
      const cfg = ATTRIBUTION_RETIREMENT;
      const actions = new Map();
      const push = (row, rule, reason, ttlDays) => {
        const ttlUntil = now + ttlDays * DAY_MS;
        const existing = actions.get(row.id);
        if (!existing || ttlUntil < existing.ttlUntil) {
          actions.set(row.id, { id: row.id, name: row.name, source: row.source, rule, reason, ttlUntil });
        }
      };

      const negative = db.prepare(`
        SELECT f.id, f.name, f.source,
               SUM(CASE WHEN o.verdict = 'fail' THEN 1 ELSE 0 END) AS fails,
               SUM(CASE WHEN o.verdict = 'pass' THEN 1 ELSE 0 END) AS passes
        FROM facts f JOIN memory_outcomes o ON o.memory_id = f.id
        WHERE COALESCE(f.status, 'active') = 'active' AND o.observed_at >= ?
        GROUP BY f.id HAVING fails >= ? AND passes = 0
      `).all(now - cfg.negativeWindowDays * DAY_MS, cfg.negativeMinFails);
      for (const row of negative) {
        push(row, 'negative-outcome', `${row.fails} 次 fail outcome, 0 次 pass (${cfg.negativeWindowDays}d)`, cfg.negativeTtlDays);
      }

      const unused = db.prepare(`
        SELECT f.id, f.name, f.source, COUNT(e.exposure_id) AS exposures
        FROM facts f JOIN memory_retrieval_exposures e ON e.memory_id = f.id
        WHERE COALESCE(f.status, 'active') = 'active' AND e.emitted_at >= ?
          AND NOT EXISTS (SELECT 1 FROM memory_applications a WHERE a.memory_id = f.id)
        GROUP BY f.id HAVING exposures >= ?
      `).all(now - cfg.unusedWindowDays * DAY_MS, cfg.unusedMinExposures);
      for (const row of unused) {
        push(row, 'exposed-never-applied', `${row.exposures} 次暴露无任何 application (${cfg.unusedWindowDays}d)`, cfg.unusedTtlDays);
      }

      const oldest = Number(db.prepare('SELECT MIN(emitted_at) AS t FROM memory_retrieval_exposures').get()?.t || 0);
      const telemetryLiveSince = oldest > 0 ? oldest : null;
      if (telemetryLiveSince && telemetryLiveSince <= now - cfg.neverExposedDays * DAY_MS) {
        const neverExposed = db.prepare(`
          SELECT f.id, f.name, f.source
          FROM facts f
          WHERE COALESCE(f.status, 'active') = 'active'
            AND COALESCE(f.verification_state, 'candidate') != 'verified'
            AND f.created_at <= ?
            AND NOT EXISTS (SELECT 1 FROM memory_retrieval_exposures e WHERE e.memory_id = f.id)
        `).all(now - cfg.neverExposedDays * DAY_MS);
        for (const row of neverExposed) {
          push(row, 'never-exposed', `创建 ${cfg.neverExposedDays}d 以上且从未被暴露`, cfg.neverExposedTtlDays);
        }
      }
      return { telemetryLiveSince, actions: [...actions.values()] };
    } finally {
      wDb.close();
    }
  } catch (error) {
    return { actions: [], telemetryLiveSince: null, error: error.message };
  }
}

function defaultRetireAttribution(plan, context) {
  const list = plan.attributionRetirement?.actions || [];
  if (list.length === 0) return { downgraded: 0, planned: 0 };
  const { openDb } = require('../sqlite/index.cjs');
  const wDb = openDb(context.dbPath ? { path: context.dbPath } : {});
  try {
    // 只缩短 ttl_until, 永不延长; reconcile 的 COALESCE 语义保证 Markdown
    // 对账不会复活被降级的 TTL。
    const stmt = wDb.db.prepare(`
      UPDATE facts SET ttl_until = ?, updated_at = ?
      WHERE id = ? AND (ttl_until IS NULL OR ttl_until > ?)
    `);
    let downgraded = 0;
    for (const action of list) {
      downgraded += Number(stmt.run(action.ttlUntil, context.now.getTime(), action.id, action.ttlUntil).changes || 0);
    }
    return { downgraded, planned: list.length };
  } finally {
    wDb.close();
  }
}

function defaultStageCandidates(candidates, context) {
  if (candidates.length === 0) return { staged: 0, ids: [] };
  const candidateModule = require('./harness-rule-candidates.cjs');
  const ledgerPath = context.opts.candidateLedger
    ? path.resolve(context.opts.candidateLedger)
    : path.join(context.home, 'var', 'maintenance', 'harness-rule-candidates.json');
  const ids = candidates.map((candidate) => candidateModule.stageCandidate(candidate, { ledgerPath }).id);
  return { staged: ids.length, ids, ledgerPath };
}

/**
 * 周报表快照 (2026-07-30)。
 *
 * 骑这条**已被调度**的路径 (settings.json 的 SessionStart 调
 * `--auto --execute --interval-days 7`), 因为 weekly-maintenance.sh 在本机
 * 根本没有调度器 —— 报表写在那里等于从未自动跑过。
 * 只读采集 + 写自己的快照文件; 不打 stdout (SessionStart 路径会污染会话上下文)。
 */
function defaultWriteWeeklyReport(_plan, context) {
  try {
    const report = require('./weekly-report.cjs').collectWeeklyReport({
      write: true,
      now: context.now.getTime(),
    });
    return {
      reportFile: report.reportFile || null,
      tenDimension: report.tenDimension?.summary || null,
      erroredSections: report.erroredSections || [],
      emptySections: report.emptySections || [],
    };
  } catch (error) {
    // 报表失败绝不能影响维护本体 (保留、对账、索引重建才是主职责)
    return { skipped: true, reason: error.message };
  }
}

function defaultRebuildIndex(_plan, context) {
  const script = path.join(context.home, 'engine', 'scripts', 'semantic-search.cjs');
  const result = spawnSync(process.execPath, [script, 'index', '--rebuild', '--home', context.home], {
    cwd: context.home,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function defaultSaveState(state, context) {
  const statePath = path.join(context.home, STATE_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function runMaintenance(opts = parseArgs(), now = new Date(), runtime = {}) {
  const home = path.resolve(runtime.home || opts.home || HARNESS_ROOT);
  const due = dueState(home, now, opts.intervalDays);
  if (opts.auto && !opts.force && !due.due) {
    return { skipped: true, reason: 'maintenance_not_due', mode: opts.execute ? 'execute' : 'dry-run', due: false, nextDueAt: due.nextDueAt };
  }

  const context = { home, now, opts, dbPath: opts.dbPath || null };
  const memoryCandidates = collectMemoryCandidates(opts, now, { home });
  const knowledgeCandidates = collectKnowledgeCandidates(opts, now, { home });
  const ruleCandidates = memoryCandidates.map(ruleCandidateFrom).filter(Boolean);
  const fileActions = memoryCandidates.map((candidate) => ({
    file: candidate.file,
    kind: candidate.kind,
    action: ruleCandidateFrom(candidate) ? 'stage_rule_candidate' : 'retain_for_review',
    reason: candidate.reason,
  }));
  const inspection = (runtime.inspectSqlite || defaultInspectSqlite)(context);
  const attributionRetirement = (runtime.collectAttributionRetirement || collectAttributionRetirement)(context);
  const plan = {
    eventRetentionDays: opts.eventRetentionDays,
    reconcile: opts.reconcile,
    reindex: opts.reindex,
    ruleCandidates,
    fileActions,
    knowledgeActions: knowledgeCandidates.map((candidate) => ({ ...candidate, action: 'retain_for_review' })),
    attributionRetirement,
  };
  const counts = {
    memoryCandidates: memoryCandidates.length,
    actionableMemory: ruleCandidates.length,
    knowledgeCandidates: knowledgeCandidates.length,
    attributionRetirement: attributionRetirement.actions.length,
    moved: 0,
  };

  const base = {
    skipped: false,
    mode: opts.execute ? 'execute' : 'dry-run',
    due: due.due,
    dueState: due,
    generatedAt: now.toISOString(),
    plan,
    inspection,
    counts,
    sqlite: inspection,
    summaryFile: null,
    moved: {},
  };
  if (!opts.execute) return { ...base, results: null };

  const results = {
    events: (runtime.retainEvents || defaultRetainEvents)(plan, context),
    reconcile: opts.reconcile ? (runtime.reconcileFacts || defaultReconcileFacts)(plan, context) : { skipped: true },
    candidates: (runtime.stageCandidates || defaultStageCandidates)(ruleCandidates, context),
    attributionRetirement: (runtime.retireAttribution || defaultRetireAttribution)(plan, context),
    reindex: opts.reindex ? (runtime.rebuildIndex || defaultRebuildIndex)(plan, context) : { skipped: true },
    weeklyReport: (runtime.writeWeeklyReport || defaultWriteWeeklyReport)(plan, context),
  };
  const state = {
    lastExecutedAt: now.toISOString(),
    nextDueAt: new Date(now.getTime() + opts.intervalDays * DAY_MS).toISOString(),
    lastMode: 'execute',
    lastCounts: counts,
    lastResults: results,
  };
  (runtime.saveState || defaultSaveState)(state, context);
  return { ...base, results, state };
}

function printHuman(result) {
  if (result.skipped) {
    console.log(`[memory-knowledge-maintenance] skipped: ${result.reason}`);
    return;
  }
  console.log(`[memory-knowledge-maintenance] ${result.mode} due=${result.due}`);
  console.log(`  memory candidates=${result.counts.memoryCandidates} rule candidates=${result.plan.ruleCandidates.length}`);
  console.log(`  event retention=${result.plan.eventRetentionDays}d reconcile=${result.plan.reconcile} reindex=${result.plan.reindex}`);
  if (result.results) console.log(`  results=${JSON.stringify(result.results)}`);
}

function main() {
  const opts = parseArgs();
  const result = runMaintenance(opts);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (result.results?.reindex?.status !== undefined && result.results.reindex.status !== 0) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`[memory-knowledge-maintenance] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  collectMemoryCandidates,
  collectKnowledgeCandidates,
  dueState,
  ruleCandidateFrom,
  fileFacts,
  inspectEventConsumers,
  runMaintenance,
  run: runMaintenance,
  defaultInspectSqlite,
  defaultRetainEvents,
  defaultReconcileFacts,
  ATTRIBUTION_RETIREMENT,
  collectAttributionRetirement,
  defaultRetireAttribution,
  defaultWriteWeeklyReport,
};
