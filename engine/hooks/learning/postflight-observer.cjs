#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('../../scripts/lib/harness-root.cjs');
const { shouldSyncMemoryFile } = require('../../scripts/lib/memory-file-policy.cjs');
const { withFileLockSync } = require('../../scripts/lib/project-scope.cjs');

const RAW_RISK_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const AGGREGATE_RISK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_RAW_RISK_EVENTS = 5000;

function sessionIdFrom(payload = {}) {
  return String(
    payload.session_id
    || payload.sessionId
    || payload.thread_id
    || payload.threadId
    || process.env.CLAUDE_SESSION_ID
    || '',
  );
}

function toolNameFrom(payload = {}) {
  if (typeof payload.tool === 'string') return payload.tool;
  return String(payload.tool_name || payload.toolName || payload.tool?.name || payload.name || '');
}

function toolInputFrom(payload = {}) {
  return payload.tool_input || payload.toolInput || payload.tool?.input || payload.input || payload.arguments || {};
}

function compact(value, limit = 200) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, limit);
  try { return JSON.stringify(value).slice(0, limit); }
  catch { return String(value).slice(0, limit); }
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function atomicWriteText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* cleanup */ }
  }
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
  } catch {
    return [];
  }
}

function recordRiskTelemetry(payload = {}, opts = {}) {
  const env = opts.env || process.env;
  if (env.CLAUDE_HARNESS_NO_PERSIST === '1'
      || env.CLAUDE_HARNESS_VERIFY_READONLY === '1'
      || env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1') {
    return { recorded: false, reason: 'persistence-disabled' };
  }
  const eventName = String(payload.hook_event_name || payload.event || '');
  if (!['PostToolUse', 'PostToolUseFailure'].includes(eventName)) {
    return { recorded: false, reason: 'event-not-applicable' };
  }
  const policy = require('../../scripts/lib/risk-policy.cjs');
  const preflight = require('../../scripts/hooks/preflight-router.cjs');
  const runtime = preflight.runtimeFrom(payload);
  const assessment = policy.classifyRisk(preflight.riskFactsFromRuntime(runtime));
  const nowMs = Date.parse(opts.now || new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new TypeError('risk telemetry timestamp is invalid');
  const timestamp = new Date(nowMs).toISOString();
  const telemetryDir = path.resolve(opts.telemetryDir || path.join(HARNESS_ROOT, 'var', 'telemetry'));
  const rawPath = path.join(telemetryDir, 'risk-events.jsonl');
  const dailyPath = path.join(telemetryDir, 'risk-daily.json');
  const bypassRequested = ['1', 'true'].includes(String(env.CLAUDE_GATES_DISABLED || '').toLowerCase())
    && String(env.CLAUDE_GATES_DISABLE_TARGET || '') === 'risk-policy.cjs';
  const kind = bypassRequested ? 'bypass'
    : eventName === 'PostToolUseFailure' ? 'failure'
      : ['R2', 'R3'].includes(assessment.effectiveRiskLevel) ? 'upgrade'
        : 'success';
  const projectHash = digest(runtime.cwd);

  withFileLockSync(rawPath, () => {
    const retained = readJsonLines(rawPath).filter(entry => {
      const at = Date.parse(entry.timestamp || '');
      return Number.isFinite(at) && at >= nowMs - RAW_RISK_RETENTION_MS;
    });
    if (kind !== 'success') {
      retained.push({
        schemaVersion: 1,
        timestamp,
        kind,
        eventName,
        tool: runtime.toolName,
        riskLevel: assessment.effectiveRiskLevel,
        riskReasons: assessment.riskReasons,
        requiredEvidence: assessment.requiredEvidence,
        sessionHash: digest(sessionIdFrom(payload)),
        projectHash,
        targetHash: digest(runtime.filePath),
        commandHash: digest(runtime.command),
        bypassTargetHash: kind === 'bypass' ? digest(env.CLAUDE_GATES_DISABLE_TARGET) : null,
      });
    }
    const bounded = retained.slice(-MAX_RAW_RISK_EVENTS);
    atomicWriteText(rawPath, bounded.length ? `${bounded.map(entry => JSON.stringify(entry)).join('\n')}\n` : '');
  });

  if (kind === 'success') {
    withFileLockSync(dailyPath, () => {
      let aggregate;
      try { aggregate = JSON.parse(fs.readFileSync(dailyPath, 'utf8')); }
      catch { aggregate = { schemaVersion: 1, days: {} }; }
      if (!aggregate.days || typeof aggregate.days !== 'object') aggregate.days = {};
      for (const day of Object.keys(aggregate.days)) {
        const dayMs = Date.parse(`${day}T00:00:00.000Z`);
        if (!Number.isFinite(dayMs) || dayMs < nowMs - AGGREGATE_RISK_RETENTION_MS) {
          delete aggregate.days[day];
        }
      }
      const day = timestamp.slice(0, 10);
      const key = `${projectHash.slice(0, 16)}:${runtime.toolName || 'unknown'}:${assessment.effectiveRiskLevel}`;
      aggregate.days[day] ||= {};
      aggregate.days[day][key] = Number(aggregate.days[day][key] || 0) + 1;
      atomicWriteText(dailyPath, `${JSON.stringify(aggregate, null, 2)}\n`);
    });
  }
  return { recorded: true, kind, riskLevel: assessment.effectiveRiskLevel };
}

function defaultWarn(record) {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function droppedWriteWarning(payload, actions, error) {
  return {
    event: 'postflight-observer-warning',
    kind: 'dropped-write',
    errorCode: 'SQLITE_WRITE_DROPPED',
    hookEvent: String(payload?.hook_event_name || payload?.event || 'unknown'),
    actions,
    message: compact(error?.message || error, 160),
  };
}

function auxiliaryFailureWarning(payload, source, error) {
  return {
    event: 'postflight-observer-warning',
    kind: 'auxiliary-failure',
    source,
    errorCode: 'OBSERVER_AUXILIARY_FAILED',
    hookEvent: String(payload?.hook_event_name || payload?.event || 'unknown'),
    message: compact(error?.message || error, 160),
  };
}

function runAuxiliaryServices(payload = {}, opts = {}) {
  const eventName = String(payload.hook_event_name || payload.event || '');
  const services = [];
  const injectedRuntime = Boolean(opts.dbPath || opts.db || opts.openDb);
  if ((eventName === 'PostToolUse' || eventName === 'Stop')
      && (typeof opts.ledgerRun === 'function' || !injectedRuntime)) {
    services.push({
      source: 'agent-transparency-ledger',
      run: opts.ledgerRun || ((input) => {
        if (process.env.CLAUDE_TRANSPARENCY_LEDGER_DISABLED === '1') return null;
        return require('../../scripts/hooks/agent-transparency-ledger.cjs').run(input);
      }),
      args: [payload],
    });
  }
  if ((eventName === 'PostToolUse' || eventName === 'PostToolUseFailure')
      && (typeof opts.riskTelemetry === 'function' || !injectedRuntime)) {
    services.push({
      source: 'risk-telemetry',
      run: opts.riskTelemetry || recordRiskTelemetry,
      args: [payload],
    });
  }
  if (eventName === 'Stop' && (typeof opts.skillEvolve === 'function' || !injectedRuntime)) {
    services.push({
      source: 'skill-evolve',
      run: opts.skillEvolve || (() => require('../../scripts/skill-evolve.cjs').runSkillEvolve({
        logger: () => {},
      })),
      args: [],
    });
  }
  if (eventName === 'Stop' && (typeof opts.fpRateHarvest === 'function' || !injectedRuntime)) {
    services.push({
      source: 'fp-rate',
      run: opts.fpRateHarvest || (() => require('../../scripts/fp-rate-tracker.cjs').harvestFpRate()),
      args: [],
    });
  }
  // 规划对账 (D2): 会话收尾时按已完成的需求门禁记录做 计划→实际 对账。
  // 只读门禁文件 + 已落库遥测, 不做模型自评; harvest 内部 fail-open。
  if (eventName === 'Stop' && (typeof opts.planAccuracy === 'function' || !injectedRuntime)) {
    services.push({
      source: 'plan-accuracy',
      run: opts.planAccuracy || ((input) => require('../../scripts/plan-accuracy.cjs').harvestPlanAccuracy({
        sessionId: String(input.session_id || input.sessionId || '') || undefined,
      })),
      args: [payload],
    });
  }

  const completed = [];
  const warnings = [];
  for (const service of services) {
    try {
      service.run(...service.args);
      completed.push(service.source);
    } catch (error) {
      const warning = auxiliaryFailureWarning(payload, service.source, error);
      warnings.push(warning);
      (opts.warn || defaultWarn)(warning);
    }
  }
  return { completed, warnings };
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function frontmatterTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMemoryFact(filePath, memoryDir) {
  if (!filePath || path.extname(filePath).toLowerCase() !== '.md') return null;
  const normalized = path.resolve(filePath);
  if (!isInside(memoryDir, normalized)) return null;

  const content = fs.readFileSync(normalized, 'utf8');
  if (!shouldSyncMemoryFile(normalized, { memoryDir, content })) return null;
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const frontmatter = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index].trim() === '---') {
        bodyStart = index + 1;
        break;
      }
      const match = lines[index].match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
      if (match) frontmatter[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const body = lines.slice(bodyStart).join('\n').trim();
  if (!body) return null;
  const relative = path.relative(memoryDir, normalized);
  const firstDir = relative.split(path.sep)[0];
  const namespaces = {
    learnings: 'learnings',
    errors: 'errors',
    archive: 'archive',
    projects: 'project',
    references: 'reference',
    agents: 'learnings',
    work: 'reference',
  };
  const namespaceAliases = {
    user: 'user',
    feedback: 'feedback',
    project: 'project',
    projects: 'projects',
    reference: 'reference',
    references: 'reference',
    learning: 'learnings',
    learnings: 'learnings',
    error: 'errors',
    errors: 'errors',
    archive: 'archive',
  };
  const requestedNamespace = String(frontmatter.namespace || frontmatter.type || '').trim().toLowerCase();
  const namespace = namespaceAliases[requestedNamespace] || namespaces[firstDir] || 'learnings';
  const name = frontmatter.name || path.basename(normalized, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const verified = /^(?:true|yes|1)$/i.test(frontmatter.verified || '')
    || /^(?:verified|validated)$/i.test(frontmatter.status || '')
    || /^(?:passed|verified|validated)$/i.test(frontmatter.validation || '');
  const requestedVerification = String(frontmatter.verification_state || '').trim().toLowerCase();
  const allowedVerification = new Set(['candidate', 'verified', 'needs_reverify']);
  const validUntil = frontmatterTimestamp(frontmatter.valid_until);
  const evidenceRef = frontmatter.evidence_ref || null;
  let verificationState = allowedVerification.has(requestedVerification)
    ? requestedVerification
    : (verified && evidenceRef ? 'verified' : 'candidate');
  if (verificationState === 'verified') {
    if (!evidenceRef || validUntil === null || validUntil <= Date.now()) {
      verificationState = 'needs_reverify';
    }
  }
  return {
    namespace,
    name,
    content,
    description: frontmatter.description || body.split('\n')[0].replace(/^#\s+/, '').slice(0, 100) || name,
    source: 'hook:postflight-observer',
    confidence: namespace === 'errors' ? (verificationState === 'verified' ? 0.9 : 0.4) : 0.7,
    source_path: normalized,
    source_key: relative.replace(/\\/g, '/'),
    projectId: frontmatter.project_id || null,
    scopeKind: frontmatter.scope_kind || 'unscoped',
    pathScope: frontmatter.path_scope || null,
    triggerKind: frontmatter.trigger_kind || null,
    triggerSignature: frontmatter.trigger_signature || null,
    verificationState,
    evidenceRef,
    contractHash: frontmatter.contract_hash || null,
    validUntil,
  };
}

function correctionDetails(payload = {}) {
  const eventName = String(payload.hook_event_name || payload.event || '');
  if (eventName !== 'UserPromptSubmit') return null;
  const prompt = String(payload.prompt || payload.user_prompt || payload.message || '').trim();
  if (!/(?:不对|错了|应该是|不是.{0,40}(?:而是|应该)|that's wrong|\bincorrect\b|\bshould be\b|\bnot .{0,40} but\b)/i.test(prompt)) {
    return null;
  }
  return {
    message: compact(prompt, 300),
    correction: compact(prompt, 300),
    cwd: compact(payload.cwd || '', 160),
  };
}

function verificationDetails(payload = {}, toolName = '', toolInput = {}) {
  const eventName = String(payload.hook_event_name || payload.event || '');
  if (eventName !== 'PostToolUse' || !['Bash', 'PowerShell'].includes(toolName)) return null;
  const command = String(toolInput.command || toolInput.cmd || '').trim();
  if (!/(?:test|pytest|ctest|regression|verify|verification|vlog|vsim|xsim|iverilog|verilator)/i.test(command)) {
    return null;
  }
  const response = payload.tool_response || payload.tool_result || payload.response || {};
  const status = response.status ?? response.exit_code ?? response.exitCode ?? response.code;
  if (![0, '0', 'success', 'passed'].includes(status)) return null;
  return {
    command: compact(command, 240),
    evidence: compact(response.stdout || response.output || response.result || 'exit=0', 240),
    tool: toolName,
    status: 'passed',
  };
}

function explicitResolution(payload = {}) {
  const signal = payload.learning_event || payload.learningEvent
    || payload.memory_event || payload.memoryEvent;
  if (!signal || signal.type !== 'resolution') return null;
  const rootCause = compact(signal.rootCause || signal.root_cause, 300);
  const fix = compact(signal.fix || signal.repair, 300);
  const verification = signal.verification;
  if (!rootCause || !fix || !verification) return null;
  return {
    rootCause,
    fix,
    verification: typeof verification === 'object'
      ? {
        command: compact(verification.command, 240),
        evidence: compact(verification.evidence || verification.result, 240),
      }
      : { evidence: compact(verification, 240) },
  };
}

function handlePayload(payload = {}, opts = {}) {
  const eventName = String(payload.hook_event_name || payload.event || '');
  const toolName = toolNameFrom(payload);
  const toolInput = toolInputFrom(payload);
  const assistantMessage = String(
    payload.last_assistant_message
    || payload.lastAssistantMessage
    || payload.assistant_message
    || '',
  );
  const memoryDir = path.resolve(opts.memoryDir || path.join(HARNESS_ROOT, 'memory'));
  const sessionId = sessionIdFrom(payload);
  let memoryFact = null;
  if (eventName === 'PostToolUse'
      && ['Write', 'Edit', 'MultiEdit'].includes(toolName)
      && toolInput.file_path) {
    try { memoryFact = parseMemoryFact(toolInput.file_path, memoryDir); }
    catch { memoryFact = null; }
  }
  const actions = [];
  const lifecycle = [];
  if (sessionId && eventName === 'PostToolUseFailure') actions.push('signal:tool_fail');
  const correction = sessionId ? correctionDetails(payload) : null;
  if (correction) {
    lifecycle.push({ type: 'user_correct', details: correction });
    actions.push('signal:user_correct');
  }
  const verification = sessionId ? verificationDetails(payload, toolName, toolInput) : null;
  if (verification) {
    lifecycle.push({ type: 'verification_pass', details: verification });
    actions.push('signal:verification_pass');
  }
  const resolution = sessionId ? explicitResolution(payload) : null;
  if (resolution) {
    lifecycle.push({ type: 'resolution', details: resolution });
    actions.push('signal:resolution');
  }
  if (sessionId && eventName === 'PostToolUse' && toolName === 'Skill' && toolInput.skill) {
    actions.push(`skill:${toolInput.skill}`);
  }
  const transcriptPath = String(payload.transcript_path || payload.transcriptPath || '');
  if (sessionId && eventName === 'Stop') {
    if (transcriptPath) actions.push('cost:usage');
    else if (assistantMessage) actions.push('cost:estimate');
  }
  if (memoryFact) actions.push('memory:sync');
  if (sessionId && (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure')) {
    actions.push('memory:attribution');
  }
  if (actions.length === 0) {
    return {
      ok: true,
      dropped: false,
      actions,
      auxiliary: runAuxiliaryServices(payload, opts),
    };
  }

  let wDb;
  let result;
  try {
    const openDb = opts.openDb || require('../../sqlite/index.cjs').openDb;
    wDb = openDb(opts.dbPath ? { path: opts.dbPath } : {});
    const events = require('../../sqlite/store-events.cjs');
    if (actions.includes('signal:tool_fail')) {
      const response = payload.tool_response || payload.tool_result || payload.response || {};
      events.record({
        sessionId,
        type: 'tool_fail',
        payload: {
          tool: compact(toolName || 'unknown', 80),
          error: compact(payload.error || response.error || response.stderr || payload.message || '', 200),
          command: compact(toolInput.command || toolInput.cmd || '', 240),
          cwd: compact(payload.cwd || '', 160),
          isInterrupt: payload.is_interrupt === true || response.interrupted === true,
          _v: 2,
        },
      }, null, { db: wDb.db });
    }
    if (lifecycle.length > 0) {
      const collector = require('./signal-collector.cjs');
      for (const signal of lifecycle) {
        collector.recordLifecycleSignal(signal.type, payload, signal.details, { db: wDb.db });
      }
    }
    const skillAction = actions.find(action => action.startsWith('skill:'));
    if (skillAction) {
      const skillName = skillAction.slice('skill:'.length);
      const skills = require('../../sqlite/store-skills.cjs');
      if (skills.get(skillName, { db: wDb.db })) {
        skills.touch(skillName, {
          success: true,
          query: compact(toolInput.args || skillName, 200),
          durationMs: 0,
        }, { db: wDb.db });
      }
      events.record({
        sessionId,
        type: 'skill_trigger',
        payload: { skill: skillName, args: compact(toolInput.args || '', 200) },
      }, null, { db: wDb.db });
    }
    if (actions.includes('cost:usage')) {
      const costs = require('../../sqlite/store-costs.cjs');
      try {
        const usage = costs.recordTranscriptUsage({ sessionId, transcriptPath }, { db: wDb.db });
        if (usage.recorded === 0 && assistantMessage) costs.estimate(sessionId, assistantMessage, { db: wDb.db });
      } catch (error) {
        (opts.warn || defaultWarn)({
          event: 'postflight-observer-warning',
          kind: 'cost-usage-dropped',
          sessionId,
          error: compact(error.message || error, 200),
        });
        if (assistantMessage) costs.estimate(sessionId, assistantMessage, { db: wDb.db });
      }
    }
    if (actions.includes('cost:estimate')) {
      require('../../sqlite/store-costs.cjs').estimate(sessionId, assistantMessage, { db: wDb.db });
    }
    if (actions.includes('memory:sync')) {
      require('../../sqlite/store-memory.cjs').writeMemory(memoryFact, { db: wDb.db });
    }
    let attribution = null;
    if (actions.includes('memory:attribution')) {
      try {
        const observe = opts.attributionObserver
          || require('../../sqlite/store-memory-attribution.cjs').observePostTool;
        attribution = observe(payload, {
          db: wDb.db,
          projectId: opts.projectId,
          correlationId: opts.correlationId,
          now: opts.now,
        });
      } catch (error) {
        attribution = {
          recorded: 0,
          dropped: true,
          reason: compact(error.message || error, 200),
        };
        (opts.warn || defaultWarn)({
          event: 'postflight-observer-warning',
          kind: 'memory-attribution-dropped',
          sessionId,
          projectId: compact(opts.projectId || payload.project_id || payload.projectId || '', 160),
          error: attribution.reason,
        });
      }
    }
    result = { ok: true, dropped: false, actions, attribution };
  } catch (error) {
    const warning = droppedWriteWarning(payload, actions, error);
    (opts.warn || defaultWarn)(warning);
    result = { ok: true, dropped: true, actions, warning };
  } finally {
    try { wDb?.close(); } catch { /* fail-open observer cleanup */ }
  }
  return { ...result, auxiliary: runAuxiliaryServices(payload, opts) };
}

function handleRaw(raw, opts = {}) {
  let payload;
  try {
    payload = JSON.parse(String(raw || '{}'));
  } catch (error) {
    const warning = {
      event: 'postflight-observer-warning',
      kind: 'invalid-payload',
      errorCode: 'INVALID_HOOK_PAYLOAD',
      message: compact(error.message, 160),
    };
    (opts.warn || defaultWarn)(warning);
    return { ok: true, dropped: true, actions: [], warning };
  }
  return handlePayload(payload, opts);
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); }
  catch { /* missing stdin is an empty payload */ }
  handleRaw(raw);
}

if (require.main === module) main();

module.exports = {
  handlePayload,
  handleRaw,
  sessionIdFrom,
  toolNameFrom,
  toolInputFrom,
  parseMemoryFact,
  correctionDetails,
  verificationDetails,
  explicitResolution,
  auxiliaryFailureWarning,
  runAuxiliaryServices,
  recordRiskTelemetry,
};
