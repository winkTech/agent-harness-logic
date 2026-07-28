#!/usr/bin/env node
'use strict';

/**
 * Audited lifecycle for durable harness rules.
 *
 * Dream output, maintenance findings, and error notes may only stage a
 * candidate.  Verification and explicit approval are separate operations;
 * promotion is impossible until both are recorded in the ledger.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const {
  behaviorContractHash,
  evidenceEntrySha256,
} = require('./lib/evidence-ledger.cjs');

const SCHEMA_VERSION = 1;
const PROMOTION_MARKER = 'harness-rule-candidate';

function isoNow(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('invalid lifecycle timestamp');
  return date.toISOString();
}

function defaultLedgerPath() {
  return path.join(HARNESS_ROOT, 'var', 'maintenance', 'harness-rule-candidates.json');
}

function readLedger(ledgerPath = defaultLedgerPath()) {
  if (!fs.existsSync(ledgerPath)) {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: null, candidates: [] };
  }
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); }
  catch (error) { throw new Error(`candidate ledger is invalid JSON: ${error.message}`); }
  if (ledger.schemaVersion !== SCHEMA_VERSION || !Array.isArray(ledger.candidates)) {
    throw new Error('candidate ledger schema is unsupported');
  }
  return ledger;
}

function writeLedger(ledgerPath, ledger, now) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: isoNow(now),
    candidates: ledger.candidates,
  };
  const temporary = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, ledgerPath);
  return payload;
}

function text(value) {
  return String(value || '').trim();
}

function normalizeSource(candidate) {
  if (candidate.source && typeof candidate.source === 'object') {
    return {
      kind: text(candidate.source.kind) || 'unknown',
      ref: text(candidate.source.ref || candidate.source.path || candidate.sourcePath),
    };
  }
  return {
    kind: text(candidate.source) || 'unknown',
    ref: text(candidate.sourcePath),
  };
}

function normalizeEnforcement(value) {
  if (!value || typeof value !== 'object') return { mode: 'advisory' };
  const mode = text(value.mode || 'advisory').toLowerCase();
  if (!['advisory', 'block'].includes(mode)) throw new Error(`unsupported enforcement mode: ${mode}`);
  if (mode === 'advisory') return { mode };
  const tools = Array.isArray(value.tools) ? value.tools.map(singleLine).filter(Boolean) : [];
  return {
    mode,
    tools,
    field: text(value.field).toLowerCase(),
    operator: text(value.operator).toLowerCase(),
    value: singleLine(value.value),
  };
}

function normalizeCandidate(candidate) {
  const normalized = {
    title: text(candidate.title),
    source: normalizeSource(candidate),
    rootCause: text(candidate.rootCause),
    verifiedFix: text(candidate.verifiedFix),
    prevention: text(candidate.prevention),
    triggerConditions: Array.isArray(candidate.triggerConditions)
      ? candidate.triggerConditions.map(text).filter(Boolean)
      : [],
    sourceEvidence: Array.isArray(candidate.evidence) ? candidate.evidence : [],
    enforcement: normalizeEnforcement(candidate.enforcement),
  };
  const canonical = JSON.stringify({
    title: normalized.title,
    source: normalized.source,
    rootCause: normalized.rootCause,
    verifiedFix: normalized.verifiedFix,
    prevention: normalized.prevention,
    triggerConditions: normalized.triggerConditions,
    enforcement: normalized.enforcement,
  });
  normalized.id = `hrc-${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
  return normalized;
}

function findCandidate(ledger, id) {
  const candidate = ledger.candidates.find((item) => item.id === id);
  if (!candidate) throw new Error(`candidate not found: ${id}`);
  return candidate;
}

function stageCandidate(input, opts = {}) {
  const ledgerPath = opts.ledgerPath || defaultLedgerPath();
  const now = isoNow(opts.now);
  const normalized = normalizeCandidate(input || {});
  if (!normalized.title) throw new Error('candidate title is required');
  const ledger = readLedger(ledgerPath);
  const existing = ledger.candidates.find((item) => item.id === normalized.id);
  if (existing) return existing;
  const candidate = {
    ...normalized,
    status: 'candidate',
    stagedAt: now,
    stagedBy: text(opts.stagedBy) || 'unknown',
    verification: null,
    approval: null,
    promotion: null,
  };
  ledger.candidates.push(candidate);
  writeLedger(ledgerPath, ledger, now);
  return candidate;
}

function candidateCompleteness(candidate) {
  const missing = [];
  for (const field of ['title', 'rootCause', 'verifiedFix', 'prevention']) {
    if (!text(candidate[field])) missing.push(field);
  }
  if (!Array.isArray(candidate.triggerConditions) || candidate.triggerConditions.length === 0) {
    missing.push('triggerConditions');
  }
  if (candidate.enforcement?.mode === 'block') {
    if (!Array.isArray(candidate.enforcement.tools) || candidate.enforcement.tools.length === 0) missing.push('enforcement.tools');
    if (!['command', 'file_path'].includes(candidate.enforcement.field)) missing.push('enforcement.field');
    if (!['contains', 'equals', 'prefix'].includes(candidate.enforcement.operator)) missing.push('enforcement.operator');
    if (text(candidate.enforcement.value).length < 3) missing.push('enforcement.value');
  }
  return missing;
}

function isInsideOrEqual(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function allowedEvidenceRoots(ledgerPath, opts = {}) {
  const ledgerDir = path.dirname(path.resolve(ledgerPath));
  const ledgerStateRoot = path.basename(ledgerDir).toLowerCase() === 'maintenance'
    ? path.dirname(ledgerDir)
    : ledgerDir;
  return [
    ledgerStateRoot,
    path.join(HARNESS_ROOT, 'var'),
    ...(Array.isArray(opts.evidenceRoots) ? opts.evidenceRoots : []),
  ].map((root) => path.resolve(root));
}

function loadEvidenceStep(step, expectedStatus, opts = {}) {
  if (!step || typeof step !== 'object') throw new Error(`${expectedStatus} evidence step is missing`);
  const status = text(step.status).toUpperCase();
  const command = text(step.command);
  const exitCode = Number(step.exitCode);
  const ledgerRef = text(step.ledger || step.artifact);
  const expectedHash = text(step.entrySha256 || step.entry_sha256).toLowerCase();
  if (status !== expectedStatus || !command || !ledgerRef || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`${expectedStatus} evidence must be ledger-backed with command, exitCode, and entrySha256`);
  }
  if (!Number.isInteger(exitCode) || (expectedStatus === 'RED' ? exitCode === 0 : exitCode !== 0)) {
    throw new Error(`${expectedStatus} evidence has an invalid real exit code`);
  }
  const ledgerPath = path.resolve(ledgerRef);
  if (!fs.existsSync(ledgerPath) || !fs.statSync(ledgerPath).isFile()) {
    throw new Error(`${expectedStatus} evidence ledger does not exist: ${ledgerRef}`);
  }
  const realLedgerPath = fs.realpathSync(ledgerPath);
  if (!allowedEvidenceRoots(opts.ledgerPath, opts).some((root) => isInsideOrEqual(root, realLedgerPath))) {
    throw new Error(`${expectedStatus} evidence ledger is outside the allowed roots`);
  }
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(realLedgerPath, 'utf8')); }
  catch (error) { throw new Error(`${expectedStatus} evidence ledger is invalid JSON: ${error.message}`); }
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.entries)) {
    throw new Error(`${expectedStatus} evidence ledger schema is unsupported`);
  }
  const entry = ledger.entries.find((item) => evidenceEntrySha256(item) === expectedHash);
  if (!entry) throw new Error(`${expectedStatus} evidence entry hash was not found in the ledger`);
  if (entry.schemaVersion !== 1 || entry.type !== 'command'
      || text(entry.command) !== command || Number(entry.exitCode) !== exitCode
      || !/^[a-f0-9]{64}$/.test(text(entry.stdoutSha256))
      || !/^[a-f0-9]{64}$/.test(text(entry.stderrSha256))) {
    throw new Error(`${expectedStatus} evidence entry does not match its declared command and exit code`);
  }
  const accepted = entry.verification?.gate === 'verification-gate'
    && entry.verification?.accepted === (expectedStatus === 'GREEN');
  if (!accepted) throw new Error(`${expectedStatus} evidence was not attested by verification-gate`);
  const recordedAt = Date.parse(entry.recordedAt || entry.completedAt || '');
  if (!Number.isFinite(recordedAt)) throw new Error(`${expectedStatus} evidence timestamp is invalid`);
  return { entry, entrySha256: expectedHash, ledgerPath: realLedgerPath, recordedAt };
}

function validateBehavioralEvidence(evidence, opts = {}) {
  const acceptedKinds = new Set(['behavioral_test', 'regression', 'integration_test', 'real_payload_test']);
  if (!acceptedKinds.has(text(evidence?.kind).toLowerCase())
      || text(evidence?.result).toUpperCase() !== 'PASS') {
    throw new Error('evidence kind/result is not an accepted behavioral PASS');
  }
  const red = loadEvidenceStep(evidence.red, 'RED', opts);
  const green = loadEvidenceStep(evidence.green, 'GREEN', opts);
  const command = text(evidence.red.command);
  const contractHash = text(evidence.contractHash || evidence.contract_hash).toLowerCase();
  const expectedContractHash = behaviorContractHash(command);
  if (command !== text(evidence.green.command)
      || contractHash !== expectedContractHash
      || red.entry.contractHash !== expectedContractHash
      || green.entry.contractHash !== expectedContractHash) {
    throw new Error('RED and GREEN evidence must bind the same behavior contract and command');
  }
  if (red.recordedAt > green.recordedAt) {
    throw new Error('RED evidence must be recorded before GREEN evidence');
  }
  return {
    ...evidence,
    contractHash: expectedContractHash,
    validation: {
      source: 'verification-ledger',
      redEntrySha256: red.entrySha256,
      greenEntrySha256: green.entrySha256,
      validatedAt: isoNow(opts.now),
    },
  };
}

function verifyCandidate(id, opts = {}) {
  const ledgerPath = opts.ledgerPath || defaultLedgerPath();
  const ledger = readLedger(ledgerPath);
  const candidate = findCandidate(ledger, id);
  if (candidate.status === 'verified') return candidate;
  if (candidate.status !== 'candidate') throw new Error(`candidate must be in candidate state, got ${candidate.status}`);
  const missing = candidateCompleteness(candidate);
  if (missing.length > 0) throw new Error(`candidate is incomplete; missing: ${missing.join(', ')}`);
  const evidence = Array.isArray(opts.evidence) ? opts.evidence : [];
  const validatedEvidence = [];
  const evidenceErrors = [];
  for (const item of evidence) {
    try { validatedEvidence.push(validateBehavioralEvidence(item, { ...opts, ledgerPath })); }
    catch (error) { evidenceErrors.push(error.message); }
  }
  if (validatedEvidence.length === 0) {
    throw new Error(`candidate verification is missing ledger-backed RED -> GREEN behavioral evidence${evidenceErrors.length ? `: ${evidenceErrors.join('; ')}` : ''}`);
  }
  const verifiedBy = text(opts.verifiedBy);
  if (!verifiedBy) throw new Error('verifiedBy is required');
  const now = isoNow(opts.now);
  candidate.status = 'verified';
  candidate.verification = { verifiedAt: now, verifiedBy, evidence: validatedEvidence };
  writeLedger(ledgerPath, ledger, now);
  return candidate;
}

function approveCandidate(id, opts = {}) {
  const ledgerPath = opts.ledgerPath || defaultLedgerPath();
  const ledger = readLedger(ledgerPath);
  const candidate = findCandidate(ledger, id);
  if (candidate.status === 'approved') return candidate;
  if (candidate.status !== 'verified') throw new Error(`candidate must be verified before approval, got ${candidate.status}`);
  if (opts.explicit !== true) throw new Error('explicit approval is required');
  const approvedBy = text(opts.approvedBy);
  if (!approvedBy) throw new Error('approvedBy is required');
  const now = isoNow(opts.now);
  candidate.status = 'approved';
  candidate.approval = { approvedAt: now, approvedBy, explicit: true };
  writeLedger(ledgerPath, ledger, now);
  return candidate;
}

function singleLine(value) {
  return text(value).replace(/\s+/g, ' ');
}

function frontmatterValue(value) {
  return `"${singleLine(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function triggerValue(candidate) {
  return candidate.triggerConditions
    .map((item) => singleLine(item).replace(/[;\r\n]+/g, ' '))
    .filter(Boolean)
    .join(';');
}

function renderRule(candidate) {
  const evidence = candidate.verification.evidence
    .filter((item) => item?.validation?.source === 'verification-ledger')
    .map((item) => `${singleLine(item.kind)} RED via ${singleLine(item.red.command || item.red.artifact)}; GREEN via ${singleLine(item.green.command || item.green.artifact)}`)
    .join('; ');
  const triggers = candidate.triggerConditions.map((item) => `  - ${singleLine(item)}`).join('\n');
  return [
    '---',
    `name: ${frontmatterValue(`promoted-${candidate.id}`)}`,
    `description: ${frontmatterValue(`Required action: ${candidate.prevention} [candidate ${candidate.id}]`)}`,
    'priority: L1',
    `trigger: ${frontmatterValue(triggerValue(candidate))}`,
    'skip: ""',
    `candidate_id: ${frontmatterValue(candidate.id)}`,
    `enforcement: ${frontmatterValue(candidate.enforcement?.mode || 'advisory')}`,
    ...(candidate.enforcement?.mode === 'block' ? [
      `gate_tools: ${frontmatterValue(candidate.enforcement.tools.join(';'))}`,
      `gate_field: ${frontmatterValue(candidate.enforcement.field)}`,
      `gate_operator: ${frontmatterValue(candidate.enforcement.operator)}`,
      `gate_value: ${frontmatterValue(candidate.enforcement.value)}`,
    ] : []),
    '---',
    '',
    `<!-- ${PROMOTION_MARKER}:${candidate.id} -->`,
    `# ${singleLine(candidate.title)}`,
    '',
    '- Trigger conditions:',
    triggers,
    `- Required action: ${singleLine(candidate.prevention)}`,
    `- Root cause: ${singleLine(candidate.rootCause)}`,
    `- Verified repair: ${singleLine(candidate.verifiedFix)}`,
    `- Behavioral evidence: ${evidence}`,
    `- Evidence boundary: applies only to the trigger conditions above; re-verify after contract changes.`,
    '',
  ].join('\n');
}

function promotedRulePath(candidate, requestedPath) {
  const requested = path.resolve(requestedPath || path.join(HARNESS_ROOT, 'docs', 'rules'));
  const rulesDir = path.extname(requested).toLowerCase() === '.md' ? path.dirname(requested) : requested;
  return path.join(rulesDir, `90-promoted-${candidate.id}.md`);
}

function validatePromotedRuleArtifact(filePath, opts = {}) {
  const resolvedPath = path.resolve(filePath);
  const ledgerPath = path.resolve(opts.ledgerPath || defaultLedgerPath());
  const nameMatch = path.basename(resolvedPath).match(/^90-promoted-(hrc-[a-f0-9]{16})\.md$/i);
  if (!nameMatch) return { valid: false, reason: 'not-a-promoted-rule-artifact' };
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    return { valid: false, reason: 'promoted-rule-artifact-missing' };
  }
  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    const candidateId = nameMatch[1].toLowerCase();
    const ledger = readLedger(ledgerPath);
    const candidate = ledger.candidates.find((item) => text(item.id).toLowerCase() === candidateId);
    if (!candidate || candidate.status !== 'promoted') {
      return { valid: false, reason: 'candidate-not-promoted-in-ledger', candidateId };
    }
    if (candidate.approval?.explicit !== true || !text(candidate.approval?.approvedBy)) {
      return { valid: false, reason: 'candidate-missing-explicit-approval', candidateId };
    }
    if (!candidate.verification?.evidence?.some(
      (item) => item?.validation?.source === 'verification-ledger',
    )) {
      return { valid: false, reason: 'candidate-missing-verified-evidence', candidateId };
    }
    if (!content.includes(`<!-- ${PROMOTION_MARKER}:${candidate.id} -->`)
        || !new RegExp(`^candidate_id:\\s*["']?${candidate.id}["']?\\s*$`, 'mi').test(content)) {
      return { valid: false, reason: 'candidate-identity-mismatch', candidateId };
    }
    const artifactSha256 = crypto.createHash('sha256').update(content).digest('hex');
    if (artifactSha256 !== text(candidate.promotion?.artifactSha256).toLowerCase()) {
      return { valid: false, reason: 'promoted-artifact-hash-mismatch', candidateId, artifactSha256 };
    }
    const recordedFile = text(candidate.promotion?.rulesFile)
      || path.basename(text(candidate.promotion?.rulesPath));
    if (recordedFile !== path.basename(resolvedPath) || !text(candidate.promotion?.promotedBy)) {
      return { valid: false, reason: 'promotion-record-mismatch', candidateId };
    }
    return { valid: true, reason: 'ledger-and-artifact-match', candidateId, candidate, artifactSha256 };
  } catch (error) {
    return { valid: false, reason: `promotion-ledger-invalid: ${error.message}` };
  }
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, filePath);
}

function promoteCandidate(id, opts = {}) {
  const ledgerPath = opts.ledgerPath || defaultLedgerPath();
  const requestedRulesPath = opts.rulesPath || path.join(HARNESS_ROOT, 'docs', 'rules');
  const ledger = readLedger(ledgerPath);
  const candidate = findCandidate(ledger, id);
  if (candidate.status !== 'approved' && candidate.status !== 'promoted') {
    throw new Error(`candidate must be approved before promotion, got ${candidate.status}`);
  }
  if (!candidate.verification || !Array.isArray(candidate.verification.evidence)
    || !candidate.verification.evidence.some((item) => item?.validation?.source === 'verification-ledger')) {
    throw new Error('candidate is missing verified behavioral PASS evidence');
  }
  if (!candidate.approval || candidate.approval.explicit !== true || !text(candidate.approval.approvedBy)) {
    throw new Error('candidate is missing explicit approval');
  }
  const promotedBy = text(opts.promotedBy);
  if (!promotedBy) throw new Error('promotedBy is required');
  const now = isoNow(opts.now);
  const rulesPath = promotedRulePath(candidate, requestedRulesPath);
  const marker = `<!-- ${PROMOTION_MARKER}:${candidate.id} -->`;
  let existing = '';
  try { existing = fs.readFileSync(rulesPath, 'utf8'); } catch { existing = ''; }
  if (candidate.status === 'promoted') {
    const validation = validatePromotedRuleArtifact(rulesPath, { ledgerPath });
    if (validation.valid) return candidate;
    throw new Error(`promoted artifact is missing or modified: ${validation.reason}`);
  }
  const renderedRule = renderRule(candidate);
  if (!existing.includes(marker)) atomicWrite(rulesPath, renderedRule);
  if (candidate.status !== 'promoted') {
    candidate.status = 'promoted';
    candidate.promotion = {
      promotedAt: now,
      promotedBy,
      rulesPath: path.resolve(rulesPath),
      rulesFile: path.basename(rulesPath),
      artifactSha256: crypto.createHash('sha256').update(renderedRule).digest('hex'),
      triggerSha256: crypto.createHash('sha256').update(triggerValue(candidate)).digest('hex'),
    };
    writeLedger(ledgerPath, ledger, now);
  }
  if (path.dirname(rulesPath) === path.join(HARNESS_ROOT, 'docs', 'rules')) {
    try { require('./rule-loader.cjs').invalidateRuleIndex(); } catch { /* fresh process still reloads */ }
  }
  return candidate;
}

function optionValue(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

function readInput(filePath) {
  if (!filePath) throw new Error('--input JSON_FILE is required');
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const ledgerPath = optionValue(argv, '--ledger', defaultLedgerPath());
  const id = optionValue(argv, '--id');
  let result;
  if (command === 'stage') {
    result = stageCandidate(readInput(optionValue(argv, '--input')), { ledgerPath, stagedBy: optionValue(argv, '--by', 'cli') });
  } else if (command === 'verify') {
    const input = readInput(optionValue(argv, '--input'));
    result = verifyCandidate(id, { ledgerPath, verifiedBy: optionValue(argv, '--by'), evidence: input.evidence });
  } else if (command === 'approve') {
    result = approveCandidate(id, { ledgerPath, approvedBy: optionValue(argv, '--by'), explicit: argv.includes('--explicit') });
  } else if (command === 'promote') {
    result = promoteCandidate(id, {
      ledgerPath,
      rulesPath: optionValue(argv, '--rules', path.join(HARNESS_ROOT, 'docs', 'rules')),
      promotedBy: optionValue(argv, '--by'),
    });
  } else if (command === 'list') {
    result = readLedger(ledgerPath);
  } else {
    console.error('Usage: harness-rule-candidates.cjs stage|verify|approve|promote|list [options]');
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}

module.exports = {
  readLedger,
  stageCandidate,
  verifyCandidate,
  approveCandidate,
  promoteCandidate,
  candidateCompleteness,
  validateBehavioralEvidence,
  renderRule,
  promotedRulePath,
  validatePromotedRuleArtifact,
  main,
};
