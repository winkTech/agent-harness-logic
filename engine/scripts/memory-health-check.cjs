#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const {
  purgeExpired,
} = require('../sqlite/store-memory.cjs');
const {
  shouldSyncMemoryFile,
  shouldIndexSemanticFile,
} = require('./lib/memory-file-policy.cjs');

const DAY_MS = 86_400_000;
const DEFAULT_INTERVAL_DAYS = 7;
const FILE_FACT_SOURCES = new Set([
  'migration:file',
  'hook:memory-sqlite-sync',
  'hook:postflight-observer',
]);

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name));
}

function inspectPromotedRuleIntegrity(home = HARNESS_ROOT) {
  const root = path.resolve(home);
  const rulesDir = path.join(root, 'docs', 'rules');
  const ledgerPath = path.join(root, 'var', 'maintenance', 'harness-rule-candidates.json');
  const {
    readLedger,
    validatePromotedRuleArtifact,
  } = require('./harness-rule-candidates.cjs');
  let candidates;
  try {
    candidates = readLedger(ledgerPath).candidates.filter((item) => item.status === 'promoted');
  } catch (error) {
    return {
      total: 0,
      valid: 0,
      invalid: 0,
      records: [],
      ledgerValid: false,
      error: error.message,
    };
  }
  const files = fs.existsSync(rulesDir)
    ? fs.readdirSync(rulesDir).filter((name) => /^90-promoted-hrc-.*\.md$/i.test(name))
    : [];
  const expectedFiles = candidates.map((candidate) => candidate.promotion?.rulesFile
    || path.basename(String(candidate.promotion?.rulesPath || `90-promoted-${candidate.id}.md`)));
  const names = [...new Set([...files, ...expectedFiles])].sort();
  const records = names.map((name) => {
    const filePath = path.join(rulesDir, name);
    const result = validatePromotedRuleArtifact(filePath, { ledgerPath });
    return { file: name, candidateId: result.candidateId || null, valid: result.valid, reason: result.reason };
  });
  return {
    total: records.length,
    valid: records.filter((item) => item.valid).length,
    invalid: records.filter((item) => !item.valid).length,
    records,
    ledgerValid: true,
  };
}

function inspectRuleCandidateLifecycle(home = HARNESS_ROOT, now = Date.now()) {
  const ledgerPath = path.join(path.resolve(home), 'var', 'maintenance', 'harness-rule-candidates.json');
  const { candidateCompleteness, readLedger } = require('./harness-rule-candidates.cjs');
  let ledger;
  try {
    ledger = readLedger(ledgerPath);
  } catch (error) {
    return {
      ledgerValid: false,
      error: error.message,
      total: 0,
      statusCounts: { candidate: 0, verified: 0, approved: 0, promoted: 0 },
      incomplete: 0,
      overdue: 0,
      records: [],
    };
  }
  const statusCounts = { candidate: 0, verified: 0, approved: 0, promoted: 0 };
  const reviewDays = { candidate: 30, verified: 90, approved: 90 };
  const records = ledger.candidates.map((candidate) => {
    if (Object.hasOwn(statusCounts, candidate.status)) statusCounts[candidate.status] += 1;
    const timestamp = candidate.status === 'verified'
      ? candidate.verification?.verifiedAt
      : candidate.status === 'approved'
        ? candidate.approval?.approvedAt
        : candidate.status === 'promoted'
          ? candidate.promotion?.promotedAt
          : candidate.stagedAt;
    const parsed = Date.parse(timestamp || '');
    const ageDays = Number.isFinite(parsed) ? Math.max(0, (now - parsed) / DAY_MS) : null;
    const maxReviewDays = reviewDays[candidate.status] || null;
    const missing = candidateCompleteness(candidate);
    return {
      id: candidate.id || null,
      status: candidate.status || 'invalid',
      ageDays,
      maxReviewDays,
      overdue: maxReviewDays !== null && (ageDays === null || ageDays > maxReviewDays),
      missing,
    };
  });
  return {
    ledgerValid: true,
    updatedAt: ledger.updatedAt || null,
    total: records.length,
    statusCounts,
    incomplete: records.filter((item) => item.missing.length > 0).length,
    overdue: records.filter((item) => item.overdue).length,
    records,
  };
}

function queryAttribution(db) {
  const required = [
    'memory_retrieval_exposures',
    'memory_applications',
    'memory_outcomes',
  ];
  const missingTables = required.filter((name) => !tableExists(db, name));
  if (missingTables.length > 0) {
    return {
      available: false,
      missingTables,
      exposures: 0,
      applications: 0,
      outcomes: 0,
      orphanApplications: 0,
      orphanOutcomes: 0,
    };
  }
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c || 0);
  const group = (table, field) => Object.fromEntries(db.prepare(
    `SELECT ${field} AS key, COUNT(*) AS count FROM ${table} GROUP BY ${field} ORDER BY ${field}`,
  ).all().map((row) => [row.key, Number(row.count || 0)]));
  const orphanApplications = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM memory_applications application
    LEFT JOIN memory_retrieval_exposures exposure
      ON exposure.exposure_id = application.exposure_id
      AND exposure.retrieval_id = application.retrieval_id
      AND exposure.session_id = application.session_id
      AND exposure.project_id = application.project_id
      AND exposure.memory_id = application.memory_id
    WHERE exposure.exposure_id IS NULL
  `).get().c || 0);
  const orphanOutcomes = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM memory_outcomes outcome
    LEFT JOIN memory_applications application
      ON application.application_id = outcome.application_id
      AND application.exposure_id = outcome.exposure_id
      AND application.retrieval_id = outcome.retrieval_id
      AND application.session_id = outcome.session_id
      AND application.project_id = outcome.project_id
      AND application.memory_id = outcome.memory_id
    WHERE application.application_id IS NULL
  `).get().c || 0);
  const now = Date.now();
  const windowStart = now - 30 * 86_400_000;
  const exposures30d = Number(db.prepare(
    'SELECT COUNT(*) AS c FROM memory_retrieval_exposures WHERE emitted_at >= ?',
  ).get(windowStart).c || 0);
  const outcomes30d = Number(db.prepare(
    'SELECT COUNT(*) AS c FROM memory_outcomes WHERE observed_at >= ?',
  ).get(windowStart).c || 0);
  return {
    available: true,
    missingTables: [],
    exposures: count('memory_retrieval_exposures'),
    applications: count('memory_applications'),
    outcomes: count('memory_outcomes'),
    distinctMemoriesExposed: Number(db.prepare(
      'SELECT COUNT(DISTINCT memory_id) AS c FROM memory_retrieval_exposures',
    ).get().c || 0),
    exposureStatus: group('memory_retrieval_exposures', 'status'),
    applicationStrength: group('memory_applications', 'evidence_strength'),
    outcomeVerdicts: group('memory_outcomes', 'verdict'),
    orphanApplications,
    orphanOutcomes,
    // 30d 窗口可见性 (2026-07-30): "有暴露但 outcome 恒 0 = 链路失效" 的计分
    // 判定尚未获批 (候选 hrc 走晋升流程), 这里只报数据不改评分 —— 现行合同仍是
    // "没有 outcome 本身不是失败, 孤儿身份链才是"。
    exposures30d,
    outcomes30d,
    outcomeChainStale: exposures30d > 0 && outcomes30d === 0,
  };
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

function inferNamespace(filePath, memoryDir) {
  const first = path.relative(memoryDir, filePath).split(path.sep)[0];
  return ({
    learnings: 'learnings',
    errors: 'errors',
    archive: 'archive',
    projects: 'project',
    references: 'reference',
    agents: 'learnings',
    work: 'reference',
  })[first] || 'learnings';
}

function isNoiseFile(filePath, content) {
  const base = path.basename(filePath);
  return /tool_success_|tool_error_|hook_failure_|auto-record/i.test(base)
    || /待分析|待补充/.test(content);
}

function normalizeSourcePath(filePath) {
  const normalized = path.resolve(String(filePath || '')).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function scanMarkdown(home, db) {
  const memoryDir = path.join(home, 'memory');
  const allFiles = walkMarkdown(memoryDir).sort();
  const currentFacts = [];
  let totalBytes = 0;
  let noiseFiles = 0;

  for (const filePath of allFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    totalBytes += fs.statSync(filePath).size;
    if (isNoiseFile(filePath, content)) noiseFiles += 1;
    if (!shouldSyncMemoryFile(filePath, { memoryDir, content })) continue;
    const namespace = inferNamespace(filePath, memoryDir);
    currentFacts.push({
      content,
      namespace,
      path: path.relative(home, filePath).replace(/\\/g, '/'),
      sourceKey: path.relative(memoryDir, filePath).replace(/\\/g, '/'),
      sourcePath: normalizeSourcePath(filePath),
    });
  }

  const databaseFacts = tableExists(db, 'facts')
    ? db.prepare('SELECT id, namespace, content, source, source_key, source_path, status FROM facts').all()
    : [];
  const currentKeys = new Set(currentFacts.map((item) => item.sourceKey));
  const fileBacked = databaseFacts.filter((item) => FILE_FACT_SOURCES.has(item.source));
  const activeFileBacked = fileBacked.filter((item) => (item.status || 'active') === 'active');
  const retiredFileBacked = fileBacked.filter((item) => (item.status || 'active') !== 'active');
  const stableActiveFileBacked = activeFileBacked.filter((item) => item.source_key && item.source_path);
  const legacyActiveFileBacked = activeFileBacked.filter((item) => !item.source_key || !item.source_path);
  const activeByKey = new Map(stableActiveFileBacked.map((item) => [
    String(item.source_key).replace(/\\/g, '/'),
    item,
  ]));
  let matched = 0;
  let missingInSqlite = 0;
  let contentMismatch = 0;
  let identityMismatch = 0;
  for (const current of currentFacts) {
    const stored = activeByKey.get(current.sourceKey);
    if (!stored) {
      missingInSqlite += 1;
      continue;
    }
    const identityMatches = normalizeSourcePath(stored.source_path) === current.sourcePath
      && stored.namespace === current.namespace;
    if (!identityMatches) identityMismatch += 1;
    if (stored.content !== current.content) contentMismatch += 1;
    if (identityMatches && stored.content === current.content) matched += 1;
  }

  return {
    markdown: {
      files: allFiles.length,
      bytes: totalBytes,
      noiseFiles,
      noiseRatio: allFiles.length > 0 ? noiseFiles / allFiles.length : 0,
      eligibleFacts: currentFacts.length,
    },
    consistency: {
      matched,
      missingInSqlite,
      staleInSqlite: stableActiveFileBacked.filter((item) => {
        const sourceKey = String(item.source_key).replace(/\\/g, '/');
        return !currentKeys.has(sourceKey);
      }).length,
      contentMismatch,
      identityMismatch,
      fileBackedFacts: fileBacked.length,
      activeFileBackedFacts: activeFileBacked.length,
      stableActiveFileFacts: stableActiveFileBacked.length,
      legacyActiveFileFacts: legacyActiveFileBacked.length,
      retiredFileFacts: retiredFileBacked.length,
    },
  };
}

function currentSemanticFiles(home) {
  const memoryDir = path.join(home, 'memory');
  const knowledgeDir = path.join(home, 'engineering-assets', 'knowledge');
  const roots = [
    memoryDir,
    path.join(knowledgeDir, 'primary'),
    path.join(knowledgeDir, 'docs'),
    path.join(knowledgeDir, 'references'),
  ];
  const files = [];
  for (const root of roots) {
    for (const filePath of walkMarkdown(root)) {
      if (shouldIndexSemanticFile(filePath, { home, memoryDir, knowledgeDir })) files.push(filePath);
    }
  }
  return files;
}

function inspectSemantic(home, now) {
  const metaPath = path.join(home, 'var', 'index', 'semantic-index-meta.json');
  const meta = readJson(metaPath, null);
  const current = new Map(currentSemanticFiles(home).map((filePath) => [
    path.relative(home, filePath).replace(/\\/g, '/'),
    fs.statSync(filePath).mtimeMs,
  ]));
  if (!meta || !Array.isArray(meta.files)) {
    return {
      found: false,
      stale: true,
      builtAt: null,
      indexed: 0,
      eligible: current.size,
      missing: 0,
      unindexed: current.size,
      changed: 0,
    };
  }

  const recorded = new Map(meta.files.map((item) => [String(item.path).replace(/\\/g, '/'), Number(item.mtime)]));
  const missing = [...recorded.keys()].filter((item) => !current.has(item)).length;
  const unindexed = [...current.keys()].filter((item) => !recorded.has(item)).length;
  const changed = [...current].filter(([item, mtime]) => recorded.has(item) && Math.abs(mtime - recorded.get(item)) > 1).length;
  const builtAt = Date.parse(meta.builtAt || '');
  const ageDays = Number.isFinite(builtAt) ? (now - builtAt) / DAY_MS : null;

  return {
    found: true,
    stale: missing > 0 || unindexed > 0 || changed > 0 || ageDays === null || ageDays >= DEFAULT_INTERVAL_DAYS,
    builtAt: meta.builtAt || null,
    ageDays,
    indexed: recorded.size,
    eligible: current.size,
    missing,
    unindexed,
    changed,
  };
}

function scheduledTaskMatches(task) {
  if (!task || task.enabled === false) return false;
  const text = JSON.stringify(task);
  if (/(?:^|\s)--dry-run(?![\w-])/i.test(text)) return false;
  return /weekly-maintenance/i.test(text)
    || (/memory-knowledge-maintenance\.cjs/i.test(text) && /(?:^|\s)--execute(?![\w-])/i.test(text));
}

function maintenanceCommandMatches(command) {
  const text = String(command || '');
  return /memory-knowledge-maintenance\.cjs/i.test(text)
    && /(?:^|\s)--auto(?:\s|$)/i.test(text)
    && /(?:^|\s)--execute(?:\s|$)/i.test(text)
    && !/(?:^|\s)--dry-run(?:\s|$)/i.test(text);
}

function settingsMaintenanceSources(home) {
  const sources = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const settings = readJson(path.join(home, name), {});
    const groups = settings?.hooks?.SessionStart;
    if (!Array.isArray(groups)) continue;
    const configured = groups.some((group) => {
      if (!group || group.enabled === false) return false;
      if (group.matcher != null && !/startup/i.test(String(group.matcher))) return false;
      if (!Array.isArray(group.hooks)) return false;
      return group.hooks.some((hook) => hook
        && hook.enabled !== false
        && hook.type === 'command'
        && maintenanceCommandMatches(hook.command));
    });
    if (configured) sources.push(`${name}:SessionStart`);
  }
  return sources;
}

function inspectMaintenance(home, now, intervalDays = DEFAULT_INTERVAL_DAYS) {
  const statePath = path.join(home, 'var', 'maintenance', 'memory-knowledge-maintenance.json');
  const schedulePath = path.join(home, '.claude', 'scheduled_tasks.json');
  const state = readJson(statePath, {});
  const schedule = readJson(schedulePath, { tasks: [] });
  const last = Date.parse(state.lastExecutedAt || '');
  const ageDays = Number.isFinite(last) ? (now - last) / DAY_MS : null;
  const scheduleSources = settingsMaintenanceSources(home);
  if (Array.isArray(schedule.tasks) && schedule.tasks.some(scheduledTaskMatches)) {
    scheduleSources.push('.claude/scheduled_tasks.json');
  }
  return {
    lastExecutedAt: state.lastExecutedAt || null,
    ageDays,
    intervalDays,
    due: ageDays === null || ageDays >= intervalDays,
    scheduleConfigured: scheduleSources.length > 0,
    scheduleSources,
  };
}

const VERIFIED_SCOPE_KINDS = new Set([
  'global_harness', 'repository', 'path', 'component', 'toolchain',
]);

function inspectVerifiedFactCompleteness(db) {
  if (!tableExists(db, 'facts')) {
    return { verifiedTotal: 0, verifiedComplete: 0, verifiedIncomplete: 0, records: [] };
  }
  const rows = db.prepare(`
    SELECT id, project_id, scope_kind, path_scope, trigger_kind, evidence_ref, valid_until
    FROM facts
    WHERE COALESCE(status, 'active') = 'active'
      AND verification_state = 'verified'
    ORDER BY id
  `).all();
  const records = [];
  const missingText = (value) => value == null || String(value).trim() === '';
  for (const row of rows) {
    const scopeKind = String(row.scope_kind || '').trim();
    const missing = [];
    if (!VERIFIED_SCOPE_KINDS.has(scopeKind)) missing.push('scope_kind');
    if (scopeKind !== 'global_harness' && missingText(row.project_id)) missing.push('project_id');
    if (scopeKind === 'path' && missingText(row.path_scope)) missing.push('path_scope');
    if (missingText(row.trigger_kind)) missing.push('trigger_kind');
    if (missingText(row.evidence_ref)) missing.push('evidence_ref');
    if (row.valid_until == null || !Number.isFinite(Number(row.valid_until)) || Number(row.valid_until) <= 0) {
      missing.push('valid_until');
    }
    if (missing.length > 0) records.push({ id: row.id, scopeKind: scopeKind || null, missing });
  }
  return {
    verifiedTotal: rows.length,
    verifiedComplete: rows.length - records.length,
    verifiedIncomplete: records.length,
    records,
  };
}

function queryFacts(db, now) {
  if (!tableExists(db, 'facts')) {
    return {
      total: 0, fts: 0, active: 0, tombstone: 0, superseded: 0,
      confirmed: 0, tentative: 0, low: 0, permanent: 0, activeTtl: 0,
      sourceReconciledPermanent: 0, unmanagedPermanent: 0,
      expired: 0, expiredActive: 0, expiredRetired: 0, neverHit: 0, neverExposed: 0, dreamOutputs: 0,
      verifiedTotal: 0, verifiedComplete: 0, verifiedIncomplete: 0, verifiedIncompleteRecords: [],
    };
  }
  const verified = inspectVerifiedFactCompleteness(db);
  const facts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(COALESCE(status, 'active') = 'active') AS active,
      SUM(status = 'tombstone') AS tombstone,
      SUM(status = 'superseded') AS superseded,
      SUM(COALESCE(status, 'active') = 'active' AND confidence >= 0.8) AS confirmed,
      SUM(COALESCE(status, 'active') = 'active' AND confidence >= 0.3 AND confidence < 0.8) AS tentative,
      SUM(COALESCE(status, 'active') = 'active' AND confidence < 0.3) AS low,
      SUM(COALESCE(status, 'active') = 'active' AND ttl_until IS NULL) AS permanent,
      SUM(COALESCE(status, 'active') = 'active' AND ttl_until IS NOT NULL AND ttl_until > ?) AS active_ttl,
      SUM(COALESCE(status, 'active') = 'active' AND ttl_until IS NULL
        AND source_key IS NOT NULL AND source_path IS NOT NULL) AS source_reconciled_permanent,
      SUM(COALESCE(status, 'active') = 'active' AND ttl_until IS NULL
        AND (source_key IS NULL OR source_path IS NULL)) AS unmanaged_permanent,
      SUM(COALESCE(status, 'active') = 'active' AND ttl_until IS NOT NULL AND ttl_until <= ?) AS expired_active,
      SUM(COALESCE(status, 'active') != 'active' AND ttl_until IS NOT NULL AND ttl_until <= ?) AS expired_retired,
      SUM(COALESCE(status, 'active') = 'active' AND hit_count = 0) AS never_hit,
      SUM(COALESCE(status, 'active') = 'active' AND source = 'script:dream') AS dream_outputs
    FROM facts
  `).get(now, now, now);
  return {
    total: Number(facts.total || 0),
    fts: tableExists(db, 'facts_fts') ? Number(db.prepare('SELECT COUNT(*) AS c FROM facts_fts').get().c || 0) : 0,
    active: Number(facts.active || 0),
    tombstone: Number(facts.tombstone || 0),
    superseded: Number(facts.superseded || 0),
    confirmed: Number(facts.confirmed || 0),
    tentative: Number(facts.tentative || 0),
    low: Number(facts.low || 0),
    permanent: Number(facts.permanent || 0),
    activeTtl: Number(facts.active_ttl || 0),
    sourceReconciledPermanent: Number(facts.source_reconciled_permanent || 0),
    unmanagedPermanent: Number(facts.unmanaged_permanent || 0),
    expired: Number(facts.expired_active || 0),
    expiredActive: Number(facts.expired_active || 0),
    expiredRetired: Number(facts.expired_retired || 0),
    neverHit: Number(facts.never_hit || 0),
    // hit_count 在生产检索路径 (只读连接, trackHit:false) 永不递增, neverHit 是死仪表;
    // 真实使用口径是 memory_retrieval_exposures — neverExposed 才反映召回利用率。
    neverExposed: tableExists(db, 'memory_retrieval_exposures')
      ? Number(db.prepare(`
        SELECT COUNT(*) AS c FROM facts f
        WHERE COALESCE(f.status, 'active') = 'active'
          AND NOT EXISTS (SELECT 1 FROM memory_retrieval_exposures e WHERE e.memory_id = f.id)
      `).get().c || 0)
      : Number(facts.active || 0),
    dreamOutputs: Number(facts.dream_outputs || 0),
    verifiedTotal: verified.verifiedTotal,
    verifiedComplete: verified.verifiedComplete,
    verifiedIncomplete: verified.verifiedIncomplete,
    verifiedIncompleteRecords: verified.records,
  };
}

function normalizeScript(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function settingsCommandsFor(home, event) {
  const commands = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    const settings = readJson(path.join(home, name), {});
    const groups = settings?.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || group.enabled === false || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (hook?.enabled === false || hook?.type !== 'command') continue;
        commands.push({ source: `${name}:${event}`, command: String(hook.command || '') });
      }
    }
  }
  return commands;
}

function loadConsumerRegistry(home) {
  const manifest = readJson(path.join(home, 'engine', 'hooks', 'manifest.json'), {
    entries: [], consumerRegistry: [],
  });
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const registry = Array.isArray(manifest.consumerRegistry) ? manifest.consumerRegistry : [];
  return registry.filter((item) => item?.active === true && item.id).map((item) => {
    const entry = entries.find((candidate) => candidate?.active === true
      && normalizeScript(candidate.script) === normalizeScript(item.hostScript)
      && Array.isArray(candidate.events) && candidate.events.includes(item.event)
      && Array.isArray(candidate.consumers) && candidate.consumers.includes(item.id));
    const route = settingsCommandsFor(home, item.event).find(({ command }) =>
      normalizeScript(command).includes(normalizeScript(item.hostScript)));
    return {
      ...item,
      manifestDeclared: Boolean(entry),
      settingsDeclared: Boolean(route),
      routed: Boolean(entry && route),
      routeSource: route?.source || null,
    };
  });
}

function detectConsumerSchedules(home, consumerNames, overrides = {}) {
  const registry = new Map(loadConsumerRegistry(home).map((item) => [item.id, item]));
  const schedules = {};
  for (const consumer of consumerNames) {
    if (typeof overrides[consumer] === 'boolean') {
      schedules[consumer] = overrides[consumer];
      continue;
    }
    schedules[consumer] = registry.get(consumer)?.routed === true;
  }
  return schedules;
}

function queryEvents(db, opts = {}) {
  if (!tableExists(db, 'runtime_events')) {
    return {
      total: 0, safeWatermark: 0, maxId: 0, pending: 0, dreamOutputs: 0, byType: [], consumers: [], registry: [],
      sessionMetrics: { sessions: 0, singleton: 0, multi: 0, singletonRatio: 0, maxPerSession: 0 },
    };
  }
  const total = Number(db.prepare('SELECT COUNT(*) AS c FROM runtime_events').get().c || 0);
  const maxId = Number(db.prepare('SELECT MAX(event_id) AS c FROM runtime_events').get().c || 0);
  const consumerRows = tableExists(db, 'runtime_consumer_watermarks')
    ? db.prepare('SELECT consumer, watermark, updated_at FROM runtime_consumer_watermarks ORDER BY consumer').all()
    : [];
  const registry = loadConsumerRegistry(opts.home || HARNESS_ROOT);
  const registryById = new Map(registry.map((item) => [item.id, item]));
  const watermarkById = new Map(consumerRows.map((row) => [row.consumer, row]));
  const consumerNames = [...new Set([
    ...consumerRows.map((row) => row.consumer),
    ...registry.filter((item) => item.kind === 'event-stream' && item.requiresWatermark === true)
      .map((item) => item.id),
  ])].sort();
  const schedules = detectConsumerSchedules(opts.home || HARNESS_ROOT,
    consumerNames, opts.consumerSchedules || {});
  const heartbeatRows = tableExists(db, 'runtime_consumer_heartbeats')
    ? db.prepare('SELECT * FROM runtime_consumer_heartbeats ORDER BY consumer').all()
    : [];
  const heartbeats = new Map(heartbeatRows.map((row) => [row.consumer, {
    runId: row.run_id,
    status: row.status,
    lastStartedAt: row.last_started_at,
    lastCompletedAt: row.last_completed_at,
    lastExit: row.last_exit,
    processedThrough: Number(row.processed_through || 0),
    processed: Number(row.processed_count || 0),
    pending: Number(row.pending_count || 0),
    nextDueAt: row.next_due_at,
    lastError: row.last_error,
  }]));
  const consumers = consumerNames.map((consumer) => {
    const row = watermarkById.get(consumer) || null;
    const watermark = Number(row?.watermark || 0);
    const spec = registryById.get(consumer) || null;
    return {
      consumer,
      watermark,
      watermarkPresent: Boolean(row),
      pending: Number(db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE event_id > ?').get(watermark).c || 0),
      oldestPendingAt: db.prepare('SELECT MIN(created_at) AS at FROM runtime_events WHERE event_id > ?').get(watermark)?.at || null,
      updatedAt: row?.updated_at || null,
      scheduled: schedules[consumer] === true,
      registered: Boolean(spec),
      requiresHeartbeat: spec?.requiresHeartbeat === true,
      minBatch: Number(spec?.minBatch ?? 1),
      maxBatch: Number(spec?.maxBatch ?? 0),
      maxPendingAgeSeconds: Number(spec?.maxPendingAgeSeconds ?? 0),
      timeoutSeconds: Number(spec?.timeoutSeconds ?? 0),
      heartbeat: heartbeats.get(consumer) || null,
    };
  });
  const safeWatermark = consumers.length > 0
    ? Math.min(...consumers.map((item) => item.watermark))
    : 0;
  const pending = Number(db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE event_id > ?').get(safeWatermark).c || 0);
  const dreamOutputs = Number(db.prepare("SELECT COUNT(*) AS c FROM runtime_events WHERE type = 'dream_output'").get().c || 0);
  const row = db.prepare(`
    SELECT COUNT(*) AS sessions,
      SUM(c = 1) AS singleton,
      SUM(c > 1) AS multi,
      MAX(c) AS max_per_session
    FROM (SELECT session_id, COUNT(*) AS c FROM runtime_events GROUP BY session_id)
  `).get();
  const sessions = Number(row.sessions || 0);
  return {
    total,
    safeWatermark,
    maxId,
    pending,
    consumers,
    registry,
    dreamOutputs,
    byType: db.prepare('SELECT type, COUNT(*) AS count FROM runtime_events GROUP BY type ORDER BY count DESC').all(),
    sessionMetrics: {
      sessions,
      singleton: Number(row.singleton || 0),
      multi: Number(row.multi || 0),
      singletonRatio: sessions > 0 ? Number(row.singleton || 0) / sessions : 0,
      maxPerSession: Number(row.max_per_session || 0),
    },
  };
}

/**
 * 成本遥测断流探测 (D6 升级, 2026-07-29)。
 *
 * 活动信号取 runtime_consumer_heartbeats 的最近完成时间 (会话在跑 ⇒ Stop 在发生
 * ⇒ 应有成本行)。cost_ledger 缺表 / 有活动却无成本行 / 只剩 estimate 回退都要暴露 —
 * costs.jsonl 无声死亡 45 天的教训: 每条数据链路必须有断流判定。
 */
function queryCostTelemetry(db, now) {
  if (!tableExists(db, 'cost_ledger')) return { available: false };
  const parseAt = (value) => {
    const ts = Date.parse(value || '');
    return Number.isFinite(ts) ? ts : null;
  };
  const lastUsageAt = parseAt(db.prepare(
    "SELECT MAX(created_at) AS at FROM cost_ledger WHERE phase = 'usage'",
  ).get().at);
  const estimateRow = db.prepare(
    "SELECT MAX(created_at) AS at, COUNT(*) AS n FROM cost_ledger WHERE phase = 'estimate'",
  ).get();
  const usageRows = Number(db.prepare(
    "SELECT COUNT(*) AS n FROM cost_ledger WHERE phase = 'usage'",
  ).get().n || 0);
  const lastConsumerActivityAt = tableExists(db, 'runtime_consumer_heartbeats')
    ? parseAt(db.prepare(
      'SELECT MAX(last_completed_at) AS at FROM runtime_consumer_heartbeats',
    ).get().at)
    : null;
  const hasUsageColumns = (() => {
    try { db.prepare('SELECT cost_usd FROM cost_ledger LIMIT 1').get(); return true; }
    catch { return false; }
  })();
  const usd30d = hasUsageColumns
    ? Number(db.prepare(`
      SELECT ROUND(SUM(cost_usd), 4) AS usd FROM cost_ledger
      WHERE phase = 'usage' AND created_at >= ?
    `).get(new Date(now - 30 * 86400000).toISOString()).usd || 0)
    : 0;
  return {
    available: true,
    hasUsageColumns,
    usageRows,
    estimateRows: Number(estimateRow.n || 0),
    lastUsageAt: lastUsageAt ? new Date(lastUsageAt).toISOString() : null,
    lastEstimateAt: parseAt(estimateRow.at) ? new Date(parseAt(estimateRow.at)).toISOString() : null,
    lastConsumerActivityAt: lastConsumerActivityAt ? new Date(lastConsumerActivityAt).toISOString() : null,
    usd30d,
    _lastUsageTs: lastUsageAt,
    _lastAnyTs: Math.max(lastUsageAt || 0, parseAt(estimateRow.at) || 0) || null,
    _activityTs: lastConsumerActivityAt,
  };
}

/**
 * 交付与规划两条新数据链的断流探测 (D1/D2, 2026-07-30)。
 * 每接一个数据源必须同步加断流判定 —— costs.jsonl 无声死亡 45 天的直接补课。
 */
function queryDeliveryPlanTelemetry(db, now) {
  const sevenDays = 7 * 86400000;
  const thirtyDays = 30 * 86400000;
  const sqliteMs = (expr) => `CAST(strftime('%s', ${expr}) AS INTEGER) * 1000`;
  const delivery = tableExists(db, 'delivery_events')
    ? {
      available: true,
      rows: Number(db.prepare('SELECT COUNT(*) AS n FROM delivery_events').get().n || 0),
      lastAt: Number(db.prepare(`SELECT MAX(${sqliteMs('timestamp')}) AS t FROM delivery_events`).get().t || 0) || null,
      pass30d: Number(db.prepare(`SELECT COUNT(*) AS n FROM delivery_events WHERE status = 'pass' AND ${sqliteMs('timestamp')} >= ?`).get(now - thirtyDays).n || 0),
      fail30d: Number(db.prepare(`SELECT COUNT(*) AS n FROM delivery_events WHERE status = 'fail' AND ${sqliteMs('timestamp')} >= ?`).get(now - thirtyDays).n || 0),
    }
    : { available: false };
  const plans = tableExists(db, 'plan_snapshots')
    ? {
      available: true,
      snapshots: Number(db.prepare('SELECT COUNT(*) AS n FROM plan_snapshots').get().n || 0),
      reconciliations: tableExists(db, 'plan_reconciliations')
        ? Number(db.prepare('SELECT COUNT(*) AS n FROM plan_reconciliations').get().n || 0)
        : 0,
      lastReconciledAt: tableExists(db, 'plan_reconciliations')
        ? Number(db.prepare('SELECT MAX(reconciled_at) AS t FROM plan_reconciliations').get().t || 0) || null
        : null,
    }
    : { available: false };
  return {
    delivery,
    plans,
    _deliveryStale: delivery.available && delivery.lastAt !== null && now - delivery.lastAt > sevenDays,
    _planStale: plans.available && plans.snapshots > 0
      && (plans.lastReconciledAt === null || now - plans.lastReconciledAt > thirtyDays),
  };
}

/**
 * 受保护写入的审计对账 (D9, 2026-07-30)。
 *
 * 一次性令牌命中即被消费, 所以"审批文件为空"是正常终态 —— 真正要对账的是:
 *   1. 每条放行审计必须带非空 reason (证明当时存在批准);
 *   2. 审批文件里不该积压已过期令牌 (过期令牌是长期敞开的门的残影);
 *   3. 令牌不得含通配符 (逐文件批准是该通道的核心约束)。
 */
function queryProtectedWrites(home) {
  const auditFile = path.join(home, 'var', 'audit', 'protected-writes.jsonl');
  const approvalFile = path.join(home, 'var', 'audit', 'protected-write-approvals.json');
  const result = {
    auditAvailable: fs.existsSync(auditFile),
    approvalsAvailable: fs.existsSync(approvalFile),
    writes: 0,
    writesWithoutReason: 0,
    liveTokens: 0,
    expiredTokens: 0,
    wildcardTokens: 0,
  };
  if (result.auditAvailable) {
    let raw = '';
    try { raw = fs.readFileSync(auditFile, 'utf8'); } catch { raw = ''; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      result.writes += 1;
      let entry;
      try { entry = JSON.parse(line); } catch { result.writesWithoutReason += 1; continue; }
      if (!String(entry?.reason || '').trim()) result.writesWithoutReason += 1;
    }
  }
  if (result.approvalsAvailable) {
    let tokens = [];
    try { tokens = JSON.parse(fs.readFileSync(approvalFile, 'utf8')); } catch { tokens = []; }
    if (Array.isArray(tokens)) {
      const now = Date.now();
      for (const token of tokens) {
        const target = String(token?.path || '');
        if (target.includes('*') || target.includes('?')) result.wildcardTokens += 1;
        if (new Date(token?.expiresAt || 0).getTime() > now) result.liveTokens += 1;
        else result.expiredTokens += 1;
      }
    }
  }
  return result;
}

function buildHealthReport(opts = {}) {
  if (!opts.db) throw new Error('buildHealthReport requires an injected database');
  const db = opts.db;
  const home = path.resolve(opts.home || HARNESS_ROOT);
  const now = Number(opts.now ?? Date.now());
  const facts = queryFacts(db, now);
  const attribution = queryAttribution(db);
  const ruleCandidates = inspectRuleCandidateLifecycle(home, now);
  const promotedRules = inspectPromotedRuleIntegrity(home);
  const eventSnapshot = queryEvents(db, {
    home,
    consumerSchedules: opts.consumerSchedules,
  });
  const markdownSnapshot = scanMarkdown(home, db);
  const semantic = inspectSemantic(home, now);
  const maintenance = inspectMaintenance(home, now, opts.intervalDays || DEFAULT_INTERVAL_DAYS);
  const brokenLinks = tableExists(db, 'fact_links')
    ? Number(db.prepare(`
      SELECT COUNT(*) AS c FROM fact_links links
      LEFT JOIN facts source ON links.from_id = source.id
      LEFT JOIN facts target ON links.to_id = target.id
      WHERE source.id IS NULL OR target.id IS NULL
    `).get().c || 0)
    : 0;

  let score = 100;
  const issues = [];
  const issue = (code, severity, penalty, message, evidence) => {
    score -= penalty;
    issues.push({ code, severity, penalty, message, evidence });
  };

  if (facts.total !== facts.fts) issue('fts_mismatch', 'critical', 20, 'facts and FTS counts differ', { facts: facts.total, fts: facts.fts });
  if (!attribution.available) {
    issue('memory_attribution_schema_missing', 'critical', 20,
      'memory attribution tables are missing', { missingTables: attribution.missingTables });
  } else if (attribution.orphanApplications > 0 || attribution.orphanOutcomes > 0) {
    issue('memory_attribution_identity_broken', 'high', 15,
      'memory attribution rows do not preserve the complete identity chain', attribution);
  }
  if (!ruleCandidates.ledgerValid) {
    issue('candidate_ledger_invalid', 'critical', 20,
      'harness rule candidate ledger is unreadable or has an unsupported schema', ruleCandidates);
  } else {
    if (ruleCandidates.incomplete > 0) {
      issue('candidate_metadata_incomplete', 'medium', 5,
        'harness rule candidates are missing required distillation fields', ruleCandidates);
    }
    if (ruleCandidates.overdue > 0) {
      issue('candidate_review_overdue', 'medium', 5,
        'harness rule candidates exceeded their review window without automatic promotion', ruleCandidates);
    }
  }
  if (brokenLinks > 0) issue('broken_fact_links', 'high', 10, 'fact links reference missing facts', { brokenLinks });
  if (facts.expired > 0) issue('expired_facts_pending', 'medium', 5, 'expired facts have not been purged', { expired: facts.expired });
  if (eventSnapshot.consumers.length === 0 && eventSnapshot.total > 0) {
    issue('event_consumer_registry_missing', 'critical', 20, 'runtime events exist without consumer-specific watermarks', { total: eventSnapshot.total });
  }
  const missingWatermarks = eventSnapshot.consumers.filter((item) => item.registered && !item.watermarkPresent);
  if (missingWatermarks.length > 0) {
    issue('event_consumer_watermark_missing', 'critical', 20,
      'registered event consumers are missing durable watermarks', { consumers: missingWatermarks });
  }
  const brokenRegistryRoutes = eventSnapshot.registry.filter((item) => !item.routed);
  if (brokenRegistryRoutes.length > 0) {
    issue('event_consumer_route_mismatch', 'critical', 15,
      'registered consumers are not wired through an active manifest entry and settings hook',
      { consumers: brokenRegistryRoutes });
  }
  const unscheduledConsumers = eventSnapshot.consumers.filter((item) => !item.scheduled);
  if (unscheduledConsumers.length > 0) {
    issue('event_consumer_unscheduled', 'critical', 15, 'registered event consumers have no configured execution path', { consumers: unscheduledConsumers });
  }
  const neverRanConsumers = eventSnapshot.consumers.filter((item) => item.requiresHeartbeat && !item.heartbeat);
  if (neverRanConsumers.length > 0) {
    issue('event_consumer_never_ran', 'critical', 15,
      'registered consumers have no completed runtime heartbeat', { consumers: neverRanConsumers });
  }
  const failingConsumers = eventSnapshot.consumers.filter((item) => item.heartbeat?.status === 'failed');
  if (failingConsumers.length > 0) {
    issue('event_consumer_failing', 'critical', 15,
      'the latest registered consumer attempt failed', { consumers: failingConsumers });
  }
  const stalledConsumers = eventSnapshot.consumers.filter((item) => {
    if (item.heartbeat?.status !== 'running' || item.timeoutSeconds <= 0) return false;
    const started = Date.parse(item.heartbeat.lastStartedAt || '');
    return Number.isFinite(started) && now - started > item.timeoutSeconds * 1000;
  });
  if (stalledConsumers.length > 0) {
    issue('event_consumer_stale', 'critical', 15,
      'registered consumer heartbeat is stuck in running state', { consumers: stalledConsumers });
  }
  const backlogConsumers = eventSnapshot.consumers.filter((item) => {
    if (item.pending <= 0) return false;
    const oldest = Date.parse(item.oldestPendingAt || '');
    const nextDue = Date.parse(item.heartbeat?.nextDueAt || '');
    return item.pending > item.maxBatch
      || (Number.isFinite(oldest) && item.maxPendingAgeSeconds > 0
        && now - oldest > item.maxPendingAgeSeconds * 1000)
      || (Number.isFinite(nextDue) && nextDue <= now);
  });
  if (backlogConsumers.length > 0) {
    const severe = backlogConsumers.some((item) => item.pending > Math.max(200, item.maxBatch * 2));
    issue('pending_event_backlog', severe ? 'critical' : 'medium', severe ? 20 : 5,
      'runtime events exceeded a registered consumer batch or due-time boundary',
      { pending: eventSnapshot.pending, safeWatermark: eventSnapshot.safeWatermark, maxId: eventSnapshot.maxId, consumers: backlogConsumers });
  }
  const dreamOutputs = facts.dreamOutputs + eventSnapshot.dreamOutputs;
  if (eventSnapshot.total > 0 && dreamOutputs === 0) issue('dream_output_missing', 'critical', 15, 'events exist but Dream has produced no durable output', { events: eventSnapshot.total });
  if (eventSnapshot.sessionMetrics.sessions > 0 && eventSnapshot.sessionMetrics.singletonRatio >= 0.9) issue('session_identity_degraded', 'high', 15, 'most event sessions contain only one event', eventSnapshot.sessionMetrics);
  if (markdownSnapshot.consistency.missingInSqlite > 0
    || markdownSnapshot.consistency.staleInSqlite > 0
    || markdownSnapshot.consistency.contentMismatch > 0
    || markdownSnapshot.consistency.identityMismatch > 0
    || markdownSnapshot.consistency.legacyActiveFileFacts > 0) {
    issue('markdown_sqlite_drift', 'high', 15, 'Markdown and SQLite facts are not the same version set', markdownSnapshot.consistency);
  }
  if (markdownSnapshot.markdown.noiseFiles > 0) issue('memory_noise', markdownSnapshot.markdown.noiseRatio >= 0.1 ? 'high' : 'medium', markdownSnapshot.markdown.noiseRatio >= 0.1 ? 10 : 3, 'generated logs or unresolved placeholders remain in memory', { noiseFiles: markdownSnapshot.markdown.noiseFiles, noiseRatio: markdownSnapshot.markdown.noiseRatio });
  if (semantic.stale) issue('semantic_index_stale', 'high', 10, 'semantic index does not match the current eligible file set', semantic);
  if (maintenance.due) issue('maintenance_overdue', 'high', 10, 'memory maintenance is due', maintenance);
  if (!maintenance.scheduleConfigured) issue('maintenance_schedule_missing', 'high', 10, 'no enabled periodic memory maintenance task is configured', maintenance);
  if (facts.unmanagedPermanent > 0) {
    issue('freshness_governance_missing', 'medium', 3,
      'active facts lack both TTL and stable source reconciliation', {
        unmanagedPermanent: facts.unmanagedPermanent,
        sourceReconciledPermanent: facts.sourceReconciledPermanent,
        activeTtl: facts.activeTtl,
      });
  }
  if (facts.verifiedIncomplete > 0) {
    issue('verified_fact_metadata_incomplete', 'high', 15,
      'active verified facts lack a complete applicability, trigger, evidence, or validity contract', {
        total: facts.verifiedTotal,
        complete: facts.verifiedComplete,
        incomplete: facts.verifiedIncomplete,
        records: facts.verifiedIncompleteRecords,
      });
  }
  if (promotedRules.invalid > 0) {
    issue('promoted_rule_integrity_failed', 'high', 15,
      'promoted harness rule artifacts do not match explicit approval and ledger hashes', promotedRules);
  }

  const costs = queryCostTelemetry(db, now);
  if (!costs.available) {
    issue('cost_ledger_missing', 'high', 10, 'cost_ledger table is missing', {});
  } else {
    const sevenDays = 7 * 86400000;
    const activityRecent = costs._activityTs && now - costs._activityTs < sevenDays;
    const anyCostRecent = costs._lastAnyTs && now - costs._lastAnyTs < sevenDays;
    const usageRecent = costs._lastUsageTs && now - costs._lastUsageTs < sevenDays;
    if (activityRecent && !anyCostRecent) {
      issue('cost_telemetry_dead', 'high', 10,
        'sessions are running but no cost rows were written in the last 7 days', {
          lastConsumerActivityAt: costs.lastConsumerActivityAt,
          lastUsageAt: costs.lastUsageAt,
          lastEstimateAt: costs.lastEstimateAt,
        });
    } else if (activityRecent && !usageRecent) {
      issue('cost_usage_stale', 'medium', 5,
        'cost telemetry is running on the estimate fallback only — transcript usage rows are stale or absent', {
          lastConsumerActivityAt: costs.lastConsumerActivityAt,
          lastUsageAt: costs.lastUsageAt,
          lastEstimateAt: costs.lastEstimateAt,
        });
    }
  }

  const deliveryPlans = queryDeliveryPlanTelemetry(db, now);
  const activityRecentForPipes = (() => {
    const sevenDays = 7 * 86400000;
    return costs._activityTs && now - costs._activityTs < sevenDays;
  })();
  if (activityRecentForPipes && deliveryPlans._deliveryStale) {
    issue('delivery_telemetry_stale', 'medium', 5,
      'sessions are running but no delivery verdict was recorded in the last 7 days', {
        lastDeliveryAt: deliveryPlans.delivery.lastAt
          ? new Date(deliveryPlans.delivery.lastAt).toISOString() : null,
        rows: deliveryPlans.delivery.rows,
      });
  }
  if (activityRecentForPipes && deliveryPlans._planStale) {
    issue('plan_accuracy_stale', 'medium', 5,
      'plan snapshots exist but no plan-vs-actual reconciliation landed in the last 30 days', {
        snapshots: deliveryPlans.plans.snapshots,
        lastReconciledAt: deliveryPlans.plans.lastReconciledAt
          ? new Date(deliveryPlans.plans.lastReconciledAt).toISOString() : null,
      });
  }

  const protectedWrites = queryProtectedWrites(home);
  if (protectedWrites.writesWithoutReason > 0) {
    issue('protected_write_without_approval', 'critical', 20,
      'protected-write audit entries exist without a recorded approval reason', protectedWrites);
  }
  if (protectedWrites.wildcardTokens > 0) {
    issue('protected_write_wildcard_token', 'high', 15,
      'protected-write approval tokens contain wildcards — per-file approval is required', protectedWrites);
  }
  if (protectedWrites.expiredTokens > 0) {
    issue('protected_write_stale_token', 'medium', 5,
      'expired protected-write approval tokens are still present in the approvals file', protectedWrites);
  }

  score = Math.max(0, Math.min(100, score));
  const status = score < 70 ? 'unhealthy' : score < 90 ? 'degraded' : 'healthy';
  return {
    schemaVersion: 2,
    generatedAt: new Date(now).toISOString(),
    status,
    score,
    issues,
    metrics: {
      facts,
      attribution,
      ruleCandidates,
      promotedRules,
      costs: costs.available
        ? {
          available: true,
          hasUsageColumns: costs.hasUsageColumns,
          usageRows: costs.usageRows,
          estimateRows: costs.estimateRows,
          lastUsageAt: costs.lastUsageAt,
          lastEstimateAt: costs.lastEstimateAt,
          lastConsumerActivityAt: costs.lastConsumerActivityAt,
          usd30d: costs.usd30d,
        }
        : { available: false },
      delivery: deliveryPlans.delivery,
      plans: deliveryPlans.plans,
      protectedWrites,
      events: {
        total: eventSnapshot.total,
        safeWatermark: eventSnapshot.safeWatermark,
        maxId: eventSnapshot.maxId,
        pending: eventSnapshot.pending,
        consumers: eventSnapshot.consumers,
        registry: eventSnapshot.registry,
        dreamOutputs,
        byType: eventSnapshot.byType,
      },
      sessions: eventSnapshot.sessionMetrics,
      markdown: markdownSnapshot.markdown,
      consistency: markdownSnapshot.consistency,
      semantic,
      maintenance,
      integrity: { brokenLinks, ftsMatch: facts.total === facts.fts },
    },
  };
}

function printHuman(report) {
  console.log('Memory health report');
  console.log(`status=${report.status} score=${report.score}/100`);
  console.log(`events=${report.metrics.events.total} pending=${report.metrics.events.pending} safe_watermark=${report.metrics.events.safeWatermark}`);
  for (const consumer of report.metrics.events.consumers) {
    console.log(`consumer=${consumer.consumer} watermark=${consumer.watermark} pending=${consumer.pending} scheduled=${consumer.scheduled}`);
  }
  console.log(`dream_outputs=${report.metrics.events.dreamOutputs} singleton_ratio=${report.metrics.sessions.singletonRatio.toFixed(3)}`);
  console.log(`memory_exposures=${report.metrics.attribution.exposures} applications=${report.metrics.attribution.applications} outcomes=${report.metrics.attribution.outcomes}`);
  console.log(`rule_candidates=${report.metrics.ruleCandidates.total} overdue=${report.metrics.ruleCandidates.overdue}`);
  console.log(`markdown=${report.metrics.markdown.files} noise=${report.metrics.markdown.noiseFiles} missing_sqlite=${report.metrics.consistency.missingInSqlite} stale_sqlite=${report.metrics.consistency.staleInSqlite}`);
  console.log(`semantic_stale=${report.metrics.semantic.stale} maintenance_due=${report.metrics.maintenance.due} schedule=${report.metrics.maintenance.scheduleConfigured}`);
  for (const item of report.issues) console.log(`- [${item.severity}] ${item.code}: ${item.message}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { json: false, quick: false, fix: false, dbPath: null, home: HARNESS_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') opts.json = true;
    else if (arg === '--quick') opts.quick = true;
    else if (arg === '--fix') opts.fix = true;
    else if (arg === '--db-path') opts.dbPath = argv[++index];
    else if (arg === '--home') opts.home = path.resolve(argv[++index]);
  }
  return opts;
}

function main() {
  const args = parseArgs();
  const { openDb } = require('../sqlite/index.cjs');
  const wDb = openDb({
    ...(args.dbPath ? { path: args.dbPath } : {}),
    readonly: !args.fix,
  });
  if (args.fix) {
    const db = wDb.db;
    const mainCount = Number(db.prepare('SELECT COUNT(*) AS c FROM facts').get().c || 0);
    const ftsCount = Number(db.prepare('SELECT COUNT(*) AS c FROM facts_fts').get().c || 0);
    if (mainCount !== ftsCount) db.exec("INSERT INTO facts_fts (facts_fts) VALUES ('rebuild')");
    purgeExpired({ db });
  }
  const report = buildHealthReport({ db: wDb.db, home: args.home });
  wDb.close();

  if (args.json || (args.quick && report.status !== 'healthy')) console.log(JSON.stringify(report));
  else if (!args.quick) printHuman(report);
  if (report.status === 'unhealthy') process.exitCode = 2;
  else if (report.status === 'degraded') process.exitCode = 1;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(JSON.stringify({ status: 'error', error: error.message }));
    process.exit(2);
  }
}

module.exports = {
  buildHealthReport,
  inspectMaintenance,
  inspectSemantic,
  scanMarkdown,
  queryEvents,
  inspectVerifiedFactCompleteness,
  inspectRuleCandidateLifecycle,
  inspectPromotedRuleIntegrity,
  queryAttribution,
  queryCostTelemetry,
  queryDeliveryPlanTelemetry,
  queryProtectedWrites,
  detectConsumerSchedules,
  loadConsumerRegistry,
  parseArgs,
};
