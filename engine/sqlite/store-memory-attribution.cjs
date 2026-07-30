'use strict';

const crypto = require('node:crypto');
const { resolveDb } = require('./index.cjs');

const TRIGGER_KINDS = new Set(['user-query', 'task-context', 'tool-failure', 'rule-trigger']);
const APPLICATION_EVIDENCE = new Map([
  ['observed-followup', 'weak'],
  ['trigger-match', 'medium'],
  ['rule-enforced', 'strong'],
]);
const OUTCOME_VERDICTS = new Set(['pass', 'fail', 'inconclusive']);
const DEFAULT_EXPOSURE_TTL_MS = 30 * 60 * 1000;
const FORBIDDEN_CLAIMS = ['applied', 'success', 'successful', 'verified', 'caused'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function canonicalJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== 'object') return entry;
    const out = {};
    for (const key of Object.keys(entry).sort()) {
      if (entry[key] !== undefined) out[key] = normalize(entry[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function requiredString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`[memory-attribution] ${label} is required`);
  return normalized;
}

function optionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function rejectClaims(signal = {}) {
  for (const field of FORBIDDEN_CLAIMS) {
    if (Object.prototype.hasOwnProperty.call(signal, field)) {
      throw new TypeError(`[memory-attribution] model/self claim '${field}' is not accepted evidence`);
    }
  }
}

function normalizedSha256(value, fallback, label) {
  const explicit = optionalString(value);
  if (explicit) {
    if (!/^[a-f0-9]{64}$/i.test(explicit)) {
      throw new TypeError(`[memory-attribution] ${label} must be sha256 hex`);
    }
    return explicit.toLowerCase();
  }
  const raw = requiredString(fallback, label.replace(/Sha256$/, ''));
  return sha256(raw);
}

function evidenceSha256(value, fallback, label) {
  const explicit = optionalString(value);
  if (explicit) {
    if (!/^[a-f0-9]{64}$/i.test(explicit)) {
      throw new TypeError(`[memory-attribution] ${label} must be sha256 hex`);
    }
    return explicit.toLowerCase();
  }
  if (fallback === undefined || fallback === null) {
    throw new TypeError(`[memory-attribution] ${label.replace(/Sha256$/, '')} is required`);
  }
  return sha256(String(fallback));
}

function createRetrievalId() {
  return `mr_${crypto.randomUUID()}`;
}

function toolInputFrom(payload = {}) {
  return payload.tool_input || payload.toolInput || payload.tool?.input
    || payload.input || payload.arguments || {};
}

function toolNameFrom(payload = {}) {
  return requiredString(
    payload.tool_name || payload.toolName || payload.tool?.name || payload.name,
    'toolName',
  );
}

function sessionIdFrom(payload = {}) {
  return optionalString(
    payload.session_id || payload.sessionId || payload.thread_id || payload.threadId,
  );
}

function toolInputSha256(payload = {}) {
  return sha256(canonicalJson(toolInputFrom(payload)));
}

function responseDigest(payload = {}) {
  const response = payload.tool_response || payload.tool_result || payload.response || {};
  if (typeof response === 'string') {
    return { status: null, stdoutSha256: sha256(response), stderrSha256: sha256('') };
  }
  return {
    status: response?.status ?? response?.exit_code ?? response?.exitCode ?? null,
    signal: response?.signal || null,
    interrupted: response?.interrupted === true,
    errorSha256: sha256(response?.error || ''),
    stdoutSha256: sha256(response?.stdout || response?.output || ''),
    stderrSha256: sha256(response?.stderr || ''),
  };
}

function verificationEvidenceFromPayload(payload = {}) {
  const input = toolInputFrom(payload);
  const raw = payload.tool_response || payload.tool_result || payload.response || {};
  if (typeof raw === 'string') {
    return {
      command: input.command || input.cmd || '',
      stdout: raw,
      stderr: '',
    };
  }
  return {
    command: input.command || input.cmd || '',
    stdout: raw?.stdout || raw?.output || '',
    stderr: raw?.stderr || raw?.error || '',
  };
}

function actionSha256FromPayload(payload = {}) {
  return sha256(canonicalJson({
    eventName: payload.hook_event_name || payload.event || '',
    toolName: payload.tool_name || payload.toolName || payload.tool?.name || payload.name || '',
    toolInputSha256: toolInputSha256(payload),
    response: responseDigest(payload),
  }));
}

function correlationIdFromPayload(payload = {}) {
  const platformId = optionalString(
    payload.tool_use_id || payload.toolUseId || payload.tool_call_id
      || payload.toolCallId || payload.invocation_id || payload.invocationId,
  );
  if (platformId) return platformId;
  const sessionId = sessionIdFrom(payload);
  if (!sessionId) return null;
  return `mc_${sha256(canonicalJson({
    sessionId,
    eventName: payload.hook_event_name || payload.event || '',
    actionSha256: actionSha256FromPayload(payload),
    timestamp: payload.timestamp || payload.created_at || payload.createdAt || null,
  })).slice(0, 32)}`;
}

function exposureIdFor(retrievalId, memoryId) {
  return `mx_${sha256(`${retrievalId}\u0000${memoryId}`).slice(0, 32)}`;
}

function applicationIdFor(exposureId, correlationId, actionSha256) {
  return `ma_${sha256(`${exposureId}\u0000${correlationId}\u0000${actionSha256}`).slice(0, 32)}`;
}

function outcomeIdFor(applicationId, correlationId, evidenceHashes) {
  return `mo_${sha256([
    applicationId,
    correlationId,
    evidenceHashes.commandSha256,
    evidenceHashes.stdoutSha256,
    evidenceHashes.stderrSha256,
  ].join('\u0000')).slice(0, 32)}`;
}

function recordExposure(signal = {}, opts = {}) {
  rejectClaims(signal);
  const db = resolveDb(opts);
  const sessionId = requiredString(signal.sessionId || signal.session_id, 'sessionId');
  const projectId = requiredString(signal.projectId || signal.project_id, 'projectId');
  const memoryId = requiredString(signal.memoryId || signal.memory_id, 'memoryId');
  const retrievalId = requiredString(signal.retrievalId || signal.retrieval_id, 'retrievalId');
  const correlationId = optionalString(signal.correlationId || signal.correlation_id) || retrievalId;
  const triggerKind = requiredString(signal.triggerKind || signal.trigger_kind, 'triggerKind');
  if (!TRIGGER_KINDS.has(triggerKind)) {
    throw new TypeError(`[memory-attribution] invalid triggerKind: ${triggerKind}`);
  }
  const querySha256 = normalizedSha256(
    signal.querySha256 || signal.query_sha256,
    signal.query,
    'querySha256',
  );
  const anchorTool = optionalString(signal.anchorTool || signal.anchor_tool);
  const anchorInputSha256 = optionalString(
    signal.anchorInputSha256 || signal.anchor_input_sha256,
  );
  if (anchorInputSha256 && !/^[a-f0-9]{64}$/i.test(anchorInputSha256)) {
    throw new TypeError('[memory-attribution] anchorInputSha256 must be sha256 hex');
  }
  if ((anchorTool && !anchorInputSha256) || (!anchorTool && anchorInputSha256)) {
    throw new TypeError('[memory-attribution] anchorTool and anchorInputSha256 must be provided together');
  }
  const rank = Number(signal.rank ?? 1);
  const confidence = Number(signal.confidence);
  if (!Number.isInteger(rank) || rank < 1) throw new TypeError('[memory-attribution] rank must be >= 1');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError('[memory-attribution] confidence must be between 0 and 1');
  }
  const now = Number(opts.now ?? Date.now());
  const ttlMs = Number(opts.ttlMs ?? DEFAULT_EXPOSURE_TTL_MS);
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('[memory-attribution] now and ttlMs must be finite and ttlMs > 0');
  }
  const exposureId = exposureIdFor(retrievalId, memoryId);
  const result = db.prepare(`
    INSERT OR IGNORE INTO memory_retrieval_exposures (
      exposure_id, retrieval_id, correlation_id, session_id, project_id, memory_id,
      trigger_kind, query_sha256, target_path, anchor_tool, anchor_input_sha256,
      rank, confidence, emitted_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    exposureId,
    retrievalId,
    correlationId,
    sessionId,
    projectId,
    memoryId,
    triggerKind,
    querySha256,
    optionalString(signal.targetPath || signal.target_path),
    anchorTool,
    anchorInputSha256 ? anchorInputSha256.toLowerCase() : null,
    rank,
    confidence,
    now,
    now + ttlMs,
  );
  return {
    exposureId,
    retrievalId,
    correlationId,
    created: Number(result.changes || 0) === 1,
  };
}

function recordApplication(signal = {}, opts = {}) {
  rejectClaims(signal);
  const db = resolveDb(opts);
  const sessionId = requiredString(signal.sessionId || signal.session_id, 'sessionId');
  const projectId = requiredString(signal.projectId || signal.project_id, 'projectId');
  const memoryId = requiredString(signal.memoryId || signal.memory_id, 'memoryId');
  const retrievalId = requiredString(signal.retrievalId || signal.retrieval_id, 'retrievalId');
  const exposureId = requiredString(signal.exposureId || signal.exposure_id, 'exposureId');
  const correlationId = requiredString(signal.correlationId || signal.correlation_id, 'correlationId');
  const eventName = requiredString(signal.eventName || signal.event_name, 'eventName');
  const toolName = requiredString(signal.toolName || signal.tool_name, 'toolName');
  const evidenceKind = requiredString(signal.evidenceKind || signal.evidence_kind, 'evidenceKind');
  const evidenceStrength = requiredString(
    signal.evidenceStrength || signal.evidence_strength,
    'evidenceStrength',
  );
  const requiredStrength = APPLICATION_EVIDENCE.get(evidenceKind);
  if (!requiredStrength || evidenceStrength !== requiredStrength) {
    throw new TypeError(
      `[memory-attribution] ${evidenceKind || 'unknown'} requires evidenceStrength=${requiredStrength || 'invalid'}`,
    );
  }
  const actionSha256 = normalizedSha256(
    signal.actionSha256 || signal.action_sha256,
    signal.action,
    'actionSha256',
  );
  const exposure = db.prepare(`
    SELECT exposure_id FROM memory_retrieval_exposures
    WHERE exposure_id = ? AND retrieval_id = ? AND session_id = ?
      AND project_id = ? AND memory_id = ?
  `).get(exposureId, retrievalId, sessionId, projectId, memoryId);
  if (!exposure) throw new TypeError('[memory-attribution] exposure identity chain is missing or mismatched');

  const now = Number(opts.now ?? Date.now());
  if (!Number.isFinite(now)) throw new TypeError('[memory-attribution] now must be finite');
  const applicationId = applicationIdFor(exposureId, correlationId, actionSha256);
  const result = db.prepare(`
    INSERT OR IGNORE INTO memory_applications (
      application_id, exposure_id, retrieval_id, correlation_id, session_id,
      project_id, memory_id, event_name, tool_name, action_sha256, target_path,
      evidence_kind, evidence_strength, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    applicationId,
    exposureId,
    retrievalId,
    correlationId,
    sessionId,
    projectId,
    memoryId,
    eventName,
    toolName,
    actionSha256,
    optionalString(signal.targetPath || signal.target_path),
    evidenceKind,
    evidenceStrength,
    now,
  );
  return {
    applicationId,
    exposureId,
    retrievalId,
    correlationId,
    created: Number(result.changes || 0) === 1,
    evidenceKind,
    evidenceStrength,
    causalClaim: 'unproven',
  };
}

function recordOutcome(signal = {}, opts = {}) {
  rejectClaims(signal);
  const db = resolveDb(opts);
  const sessionId = requiredString(signal.sessionId || signal.session_id, 'sessionId');
  const projectId = requiredString(signal.projectId || signal.project_id, 'projectId');
  const memoryId = requiredString(signal.memoryId || signal.memory_id, 'memoryId');
  const retrievalId = requiredString(signal.retrievalId || signal.retrieval_id, 'retrievalId');
  const exposureId = requiredString(signal.exposureId || signal.exposure_id, 'exposureId');
  const applicationId = requiredString(signal.applicationId || signal.application_id, 'applicationId');
  const correlationId = requiredString(signal.correlationId || signal.correlation_id, 'correlationId');
  const evidenceSource = requiredString(
    signal.evidenceSource || signal.evidence_source,
    'evidenceSource',
  );
  if (evidenceSource !== 'verification-gate') {
    throw new TypeError('[memory-attribution] evidenceSource must be verification-gate');
  }
  const verdict = requiredString(signal.verdict, 'verdict');
  if (!OUTCOME_VERDICTS.has(verdict)) {
    throw new TypeError(`[memory-attribution] invalid verdict: ${verdict}`);
  }
  if (typeof signal.accepted !== 'boolean') {
    throw new TypeError('[memory-attribution] accepted must be a boolean from verification-gate');
  }
  if ((verdict === 'pass') !== signal.accepted) {
    throw new TypeError('[memory-attribution] accepted must be true only for verdict=pass');
  }
  const reason = requiredString(signal.reason, 'reason').slice(0, 300);
  const commandSha256 = normalizedSha256(
    signal.commandSha256 || signal.command_sha256,
    signal.command,
    'commandSha256',
  );
  const stdoutSha256 = evidenceSha256(
    signal.stdoutSha256 || signal.stdout_sha256,
    signal.stdout,
    'stdoutSha256',
  );
  const stderrSha256 = evidenceSha256(
    signal.stderrSha256 || signal.stderr_sha256,
    signal.stderr,
    'stderrSha256',
  );
  const application = db.prepare(`
    SELECT application_id FROM memory_applications
    WHERE application_id = ? AND exposure_id = ? AND retrieval_id = ?
      AND session_id = ? AND project_id = ? AND memory_id = ?
  `).get(applicationId, exposureId, retrievalId, sessionId, projectId, memoryId);
  if (!application) throw new TypeError('[memory-attribution] application identity chain is missing or mismatched');

  const now = Number(opts.now ?? Date.now());
  if (!Number.isFinite(now)) throw new TypeError('[memory-attribution] now must be finite');
  const evidenceHashes = { commandSha256, stdoutSha256, stderrSha256 };
  const outcomeId = outcomeIdFor(applicationId, correlationId, evidenceHashes);
  const result = db.prepare(`
    INSERT OR IGNORE INTO memory_outcomes (
      outcome_id, application_id, exposure_id, retrieval_id, correlation_id,
      session_id, project_id, memory_id, verdict, accepted, reason,
      command_sha256, stdout_sha256, stderr_sha256, evidence_source, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    outcomeId,
    applicationId,
    exposureId,
    retrievalId,
    correlationId,
    sessionId,
    projectId,
    memoryId,
    verdict,
    signal.accepted ? 1 : 0,
    reason,
    commandSha256,
    stdoutSha256,
    stderrSha256,
    evidenceSource,
    now,
  );
  const stored = db.prepare(`
    SELECT verdict, accepted, evidence_source FROM memory_outcomes
    WHERE outcome_id = ?
  `).get(outcomeId);
  if (!stored || stored.verdict !== verdict
      || Boolean(stored.accepted) !== signal.accepted
      || stored.evidence_source !== evidenceSource) {
    throw new TypeError('[memory-attribution] conflicting outcome replay for existing evidence');
  }
  db.prepare(`
    UPDATE memory_retrieval_exposures
    SET status = ?
    WHERE exposure_id = ? AND retrieval_id = ? AND session_id = ?
      AND project_id = ? AND memory_id = ?
  `).run(
    // inconclusive 判定不能翻成 verified-fail —— 那会让"读不到判据"在账本里
    // 长得跟"验证失败"一样, 后续任何按状态做的统计都会跟着错。
    stored.accepted ? 'verified-pass' : verdict === 'inconclusive' ? 'unverified' : 'verified-fail',
    exposureId,
    retrievalId,
    sessionId,
    projectId,
    memoryId,
  );
  return {
    outcomeId,
    applicationId,
    exposureId,
    retrievalId,
    correlationId,
    verdict,
    accepted: signal.accepted,
    created: Number(result.changes || 0) === 1,
    causalClaim: 'unproven',
  };
}

function projectIdFromPayload(payload = {}, opts = {}) {
  const explicit = optionalString(opts.projectId || payload.project_id || payload.projectId);
  if (explicit) return explicit;
  if (!optionalString(payload.cwd)) return null;
  try {
    // 必须与 exposure 侧 (memory-retrieve-hook → memoryScopeFromPayload) 用同一个
    // 归一化入口: 旧实现直接 findProjectRoot, 在无项目标记的 cwd 上回退到文件系统
    // 根, 而 exposure 侧回退到 cwd 本身 —— 两侧 projectId 不一致, application/outcome
    // 的身份链查询永远落空 (2026-07-30 D5.3 端到端契约实测)。
    return require('../scripts/lib/project-scope.cjs').memoryScopeFromPayload(payload).projectId;
  } catch {
    return null;
  }
}

function observePostToolInternal(payload = {}, opts = {}, trustedVerification = null) {
  const db = resolveDb(opts);
  const eventName = optionalString(payload.hook_event_name || payload.event);
  if (!['PostToolUse', 'PostToolUseFailure'].includes(eventName)) {
    return { recorded: 0, anchorsConsumed: 0, rejected: true, reason: 'not-post-tool-event' };
  }
  const sessionId = sessionIdFrom(payload);
  const projectId = projectIdFromPayload(payload, opts);
  const correlationId = optionalString(opts.correlationId) || correlationIdFromPayload(payload);
  if (!sessionId || !projectId || !correlationId) {
    return { recorded: 0, anchorsConsumed: 0, rejected: true, reason: 'missing-identity' };
  }
  let toolName;
  try { toolName = toolNameFrom(payload); }
  catch {
    return { recorded: 0, anchorsConsumed: 0, rejected: true, reason: 'missing-tool' };
  }
  const now = Number(opts.now ?? Date.now());
  if (!Number.isFinite(now)) {
    return { recorded: 0, anchorsConsumed: 0, rejected: true, reason: 'invalid-time' };
  }
  const inputSha256 = toolInputSha256(payload);
  const actionSha256 = actionSha256FromPayload(payload);
  const exposures = db.prepare(`
    SELECT * FROM memory_retrieval_exposures
    WHERE session_id = ? AND project_id = ? AND status = 'emitted'
      AND emitted_at <= ? AND expires_at > ?
    ORDER BY emitted_at DESC, rank ASC
    LIMIT 5
  `).all(sessionId, projectId, now, now);
  if (exposures.length === 0) {
    return { recorded: 0, anchorsConsumed: 0, rejected: false, reason: 'no-active-exposure' };
  }

  let recorded = 0;
  let outcomesRecorded = 0;
  let anchorsConsumed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const exposure of exposures) {
      if (exposure.anchor_tool && exposure.anchor_input_sha256 && !exposure.anchor_consumed_at) {
        const sameAnchor = exposure.anchor_tool.toLowerCase() === toolName.toLowerCase()
          && exposure.anchor_input_sha256 === inputSha256;
        anchorsConsumed += Number(db.prepare(`
          UPDATE memory_retrieval_exposures SET anchor_consumed_at = ?
          WHERE exposure_id = ? AND anchor_consumed_at IS NULL
        `).run(now, exposure.exposure_id).changes || 0);
        if (sameAnchor) continue;
      }
      const result = recordApplication({
        sessionId: exposure.session_id,
        projectId: exposure.project_id,
        memoryId: exposure.memory_id,
        retrievalId: exposure.retrieval_id,
        exposureId: exposure.exposure_id,
        correlationId,
        eventName,
        toolName,
        actionSha256,
        evidenceKind: 'observed-followup',
        evidenceStrength: 'weak',
      }, { db, now });
      if (result.created) recorded += 1;
      if (trustedVerification) {
        const evidence = verificationEvidenceFromPayload(payload);
        // 判定不可读 ≠ 记忆没用 (2026-07-30): 输出被管道截断时门禁看不到判据,
        // 旧实现记成 fail outcome, 退役规则据此把两条无辜记忆的 TTL 砍到 14 天。
        // 这类判定落 inconclusive —— 既进账本可查, 又不参与奖惩。
        const unreadable = !trustedVerification.ok
          && require('../scripts/lib/verification-markers.cjs').isUnreadableVerdict(trustedVerification.reason);
        const outcome = recordOutcome({
          sessionId: exposure.session_id,
          projectId: exposure.project_id,
          memoryId: exposure.memory_id,
          retrievalId: exposure.retrieval_id,
          exposureId: exposure.exposure_id,
          applicationId: result.applicationId,
          correlationId,
          verdict: trustedVerification.ok ? 'pass' : unreadable ? 'inconclusive' : 'fail',
          accepted: trustedVerification.ok,
          reason: trustedVerification.reason,
          command: evidence.command,
          stdout: evidence.stdout,
          stderr: evidence.stderr,
          evidenceSource: 'verification-gate',
        }, { db, now });
        if (outcome.created) outcomesRecorded += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { recorded, outcomesRecorded, anchorsConsumed, rejected: false, correlationId };
}

function observePostTool(payload = {}, opts = {}) {
  return observePostToolInternal(payload, opts, null);
}

function observeVerificationGateResult(payload = {}, gateResult = {}, opts = {}) {
  const verification = gateResult?.verification;
  const decision = optionalString(gateResult?.decision);
  const source = optionalString(gateResult?.source);
  const validVerdict = verification
    && typeof verification === 'object'
    && typeof verification.ok === 'boolean'
    && optionalString(verification.reason);
  const validDecision = verification?.ok === true
    ? decision === 'allow'
    : (decision === 'warn' || decision === 'block');
  if (source !== 'verification-gate' || !validVerdict || !validDecision) {
    return {
      recorded: 0,
      outcomesRecorded: 0,
      anchorsConsumed: 0,
      rejected: true,
      reason: 'not-normalized-verification-gate-verdict',
    };
  }
  return observePostToolInternal(payload, opts, {
    ok: verification.ok,
    reason: requiredString(verification.reason, 'verification reason').slice(0, 300),
  });
}

function targetPathFromPayload(payload = {}) {
  try {
    return require('../scripts/lib/project-scope.cjs').memoryScopeFromPayload(payload).relativePath || null;
  } catch {
    return null;
  }
}

function observePromotedHarnessGateResult(payload = {}, gateResult = {}, opts = {}) {
  const source = optionalString(gateResult?.source);
  const decision = optionalString(gateResult?.decision);
  const policy = gateResult?.policy;
  const memoryId = optionalString(policy?.candidateId);
  const eventName = optionalString(payload.hook_event_name || payload.event);
  if (source !== 'promoted-harness-gate' || decision !== 'block'
      || !memoryId || eventName !== 'PreToolUse') {
    return {
      recorded: 0,
      exposuresRecorded: 0,
      rejected: true,
      reason: 'not-normalized-promoted-harness-block',
    };
  }

  const db = resolveDb(opts);
  const sessionId = sessionIdFrom(payload);
  const projectId = projectIdFromPayload(payload, opts);
  const correlationId = optionalString(opts.correlationId) || correlationIdFromPayload(payload);
  let toolName;
  try { toolName = toolNameFrom(payload); }
  catch { toolName = null; }
  if (!sessionId || !projectId || !correlationId || !toolName) {
    return {
      recorded: 0,
      exposuresRecorded: 0,
      rejected: true,
      reason: 'missing-identity',
    };
  }

  const now = Number(opts.now ?? Date.now());
  if (!Number.isFinite(now)) {
    return { recorded: 0, exposuresRecorded: 0, rejected: true, reason: 'invalid-time' };
  }
  const actionSha256 = actionSha256FromPayload(payload);
  const retrievalId = `mr_rule_${sha256(canonicalJson({
    sessionId,
    projectId,
    memoryId,
    correlationId,
    actionSha256,
  })).slice(0, 32)}`;
  const targetPath = targetPathFromPayload(payload);
  let exposure;
  let application;
  db.exec('BEGIN IMMEDIATE');
  try {
    exposure = recordExposure({
      sessionId,
      projectId,
      memoryId,
      retrievalId,
      correlationId,
      triggerKind: 'rule-trigger',
      querySha256: sha256(canonicalJson({
        source,
        policyFile: optionalString(policy.file),
        candidateId: memoryId,
        actionSha256,
      })),
      targetPath,
      rank: 1,
      confidence: 1,
    }, { db, now });
    application = recordApplication({
      sessionId,
      projectId,
      memoryId,
      retrievalId,
      exposureId: exposure.exposureId,
      correlationId,
      eventName,
      toolName,
      actionSha256,
      targetPath,
      evidenceKind: 'rule-enforced',
      evidenceStrength: 'strong',
    }, { db, now });
    db.prepare(`
      UPDATE memory_retrieval_exposures SET status = 'unverified'
      WHERE exposure_id = ? AND retrieval_id = ? AND session_id = ?
        AND project_id = ? AND memory_id = ?
    `).run(exposure.exposureId, retrievalId, sessionId, projectId, memoryId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    recorded: application.created ? 1 : 0,
    exposuresRecorded: exposure.created ? 1 : 0,
    rejected: false,
    retrievalId,
    correlationId,
    applicationId: application.applicationId,
    causalClaim: 'unproven',
  };
}

module.exports = {
  APPLICATION_EVIDENCE,
  DEFAULT_EXPOSURE_TTL_MS,
  actionSha256FromPayload,
  applicationIdFor,
  canonicalJson,
  correlationIdFromPayload,
  createRetrievalId,
  exposureIdFor,
  observePostTool,
  observePromotedHarnessGateResult,
  observeVerificationGateResult,
  outcomeIdFor,
  recordApplication,
  recordExposure,
  recordOutcome,
  sha256,
  toolInputSha256,
};
