#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('../../scripts/lib/harness-root.cjs');
const { shouldSyncMemoryFile } = require('../../scripts/lib/memory-file-policy.cjs');

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
};
