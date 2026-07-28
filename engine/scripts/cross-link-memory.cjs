#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { memoryScopeFromPayload } = require('./lib/project-scope.cjs');

const DEFAULT_FRESH_MS = 5 * 60 * 1000;

function compact(value, limit = 300) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, limit);
  try { return JSON.stringify(value).replace(/\s+/g, ' ').slice(0, limit); }
  catch { return String(value).slice(0, limit); }
}

function payloadTimestamp(payload) {
  const raw = payload.timestamp || payload.created_at || payload.createdAt
    || payload.event_time || payload.eventTime;
  if (raw === undefined || raw === null || raw === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function isFreshFailure(payload = {}, opts = {}) {
  const eventName = String(payload.hook_event_name || payload.event || '');
  if (eventName !== 'PostToolUseFailure') return false;
  const timestamp = payloadTimestamp(payload);
  if (timestamp === null) return true;
  const now = (opts.now || Date.now)();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_FRESH_MS;
  return timestamp <= now && now - timestamp <= maxAgeMs;
}

function buildQuery(payload = {}) {
  const toolInput = payload.tool_input || payload.toolInput || payload.tool?.input || {};
  const response = payload.tool_response || payload.tool_result || payload.response || {};
  return [
    compact(payload.error || response.error || response.stderr || response.message || payload.message, 300),
    compact(toolInput.command || toolInput.cmd || toolInput.file_path || toolInput.filePath, 160),
    compact(payload.tool_name || payload.toolName || payload.tool?.name, 40),
  ].filter(Boolean).join(' ').slice(0, 500);
}

function failureTriggerSignature(payload = {}) {
  const query = buildQuery(payload).toLowerCase();
  const signatures = [
    [/negative\s+hold\s+slack|\bwhs\s*=\s*-/, 'negative_hold_slack'],
    [/negative\s+setup\s+slack|\bwns\s*=\s*-/, 'negative_setup_slack'],
    [/\beisdir\b|illegal operation on a directory/, 'eisdir'],
    [/\beacces\b|permission denied|access is denied/, 'permission_denied'],
    [/timed?\s*out|\btimeout\b/, 'timeout'],
    [/syntax error|parse error|unexpected token/, 'syntax_error'],
  ];
  return signatures.find(([pattern]) => pattern.test(query))?.[1] || null;
}

function failureScope(payload = {}) {
  return {
    ...memoryScopeFromPayload(payload),
    triggerKind: 'tool_failure',
    triggerSignature: failureTriggerSignature(payload),
  };
}

function normalizeResult(record) {
  return {
    memoryId: record.id || record.memory_id || null,
    name: record.name || '(unnamed)',
    summary: compact(record.description || record.content, 180),
    confidence: record.confidence,
    source: record.source || 'unknown',
    sourceKey: record.source_key || null,
    status: record.status || 'active',
    updatedAt: record.updated_at || record.created_at || null,
  };
}

function evaluatePayload(payload = {}, deps = {}) {
  if (!isFreshFailure(payload, deps)) return null;
  const query = buildQuery(payload);
  if (!query) return null;

  let wDb;
  try {
    const openDb = deps.openDb || require('../sqlite/index.cjs').openDb;
    const retrieveMemory = deps.retrieveMemory || require('../sqlite/store-memory.cjs').retrieveMemory;
    wDb = openDb({ readonly: true });
    const scope = failureScope(payload);
    const shared = { db: wDb.db, trackHit: false, scope };
    const errors = retrieveMemory(query, {
      ...shared, namespaces: ['errors'], limit: 3, minConfidence: 0.8,
    }).map(normalizeResult);
    const learnings = retrieveMemory(query, {
      ...shared, namespaces: ['learnings'], limit: 2, minConfidence: 0.7,
    }).map(normalizeResult);
    const matches = [...errors, ...learnings];
    if (matches.length === 0) return null;

    const lines = ['[memory] 本次工具失败的相关已知经验:'];
    for (const match of matches) {
      lines.push(`- ${match.name}: ${match.summary} [source=${match.source}; `
        + `key=${match.sourceKey || 'none'}; confidence=${match.confidence}; `
        + `status=${match.status}; updated=${match.updatedAt || 'unknown'}]`);
    }
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: lines.join('\n'),
      },
    };
    require('./memory-retrieve-hook.cjs').recordInjectedExposures(payload, matches, {
      projectId: scope.projectId,
      triggerKind: 'tool-failure',
      query,
      targetPath: scope.relativePath,
      anchorCurrentTool: true,
    }, deps);
    return output;
  } catch {
    return null;
  } finally {
    try { wDb?.close(); } catch { /* fail-open cleanup */ }
  }
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { return; }
  const output = evaluatePayload(payload);
  if (output) process.stdout.write(JSON.stringify(output));
}

if (require.main === module) main();

module.exports = {
  buildQuery,
  evaluatePayload,
  failureScope,
  failureTriggerSignature,
  isFreshFailure,
};
