'use strict';

const crypto = require('node:crypto');

const RISK_LEVELS = Object.freeze(['R0', 'R1', 'R2', 'R3']);
const POLICY_MODES = Object.freeze(['shadow', 'enforce', 'off']);

function normalizeRiskLevel(value, fallback = 'R0') {
  const level = String(value || '').trim().toUpperCase();
  return RISK_LEVELS.includes(level) ? level : fallback;
}

function maxRiskLevel(...values) {
  return values
    .map((value) => normalizeRiskLevel(value))
    .reduce((highest, value) => (
      RISK_LEVELS.indexOf(value) > RISK_LEVELS.indexOf(highest) ? value : highest
    ), 'R0');
}

function raiseRiskLevel(value, steps = 1) {
  const start = RISK_LEVELS.indexOf(normalizeRiskLevel(value));
  const distance = Number.isFinite(Number(steps)) ? Math.max(0, Math.trunc(Number(steps))) : 1;
  return RISK_LEVELS[Math.min(RISK_LEVELS.length - 1, start + distance)];
}

function riskPolicyMode(env = process.env) {
  const mode = String(env?.CLAUDE_RISK_POLICY_MODE || 'shadow').trim().toLowerCase();
  return POLICY_MODES.includes(mode) ? mode : 'shadow';
}

function requiredEvidenceForRisk(value) {
  const level = normalizeRiskLevel(value);
  if (level === 'R1') return ['targeted-test'];
  if (level === 'R2') return ['task-contract', 'affected-regression'];
  if (level === 'R3') return ['exact-authorization', 'fresh-signoff-evidence'];
  return [];
}

function verificationEvidenceLevel(command) {
  const value = String(command || '').trim().replace(/\s+/g, ' ');
  if (!value) return 'R0';
  if (/\b(?:ruff\s+check|eslint|vlog\s+-lint|iverilog\s+[^\n]*-tnull|node\s+--check|tsc\s+--noEmit)\b/i.test(value)) {
    return 'R0';
  }
  if (/\b(?:run-all-tests\.cjs|full[-_ ]?regression|post[-_ ]?route|sign[-_ ]?off|bitstream)\b/i.test(value)) {
    return 'R3';
  }
  if (/\b(?:risk-policy-contract|preflight-router-contract|postflight-router-contract|lifecycle-router-contract|test_[\w.-]+|tb_[\w.-]+)\b/i.test(value)) {
    return 'R1';
  }
  if (/\b(?:pytest|py\.test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|cargo\s+test|go\s+test|regression|test-hooks)\b/i.test(value)) {
    return 'R2';
  }
  if (/\b(?:xsim|vsim|vvp)\b/i.test(value)) return 'R1';
  return 'R0';
}

function canonicalJson(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== 'object') return entry;
    return Object.fromEntries(
      Object.keys(entry).sort().filter(key => entry[key] !== undefined)
        .map(key => [key, normalize(entry[key])]),
    );
  };
  return JSON.stringify(normalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeEvidencePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function normalizeHashEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      path: normalizeEvidencePath(entry?.path),
      sha256: String(entry?.sha256 || '').trim().toLowerCase(),
    }))
    .filter(entry => entry.path && /^[a-f0-9]{64}$/.test(entry.sha256))
    .sort((a, b) => `${a.path}:${a.sha256}`.localeCompare(`${b.path}:${b.sha256}`));
}

function buildEvidenceKey(input = {}) {
  const inputs = {
    projectRoot: normalizeEvidencePath(input.projectRoot),
    fileHashes: normalizeHashEntries(input.fileHashes),
    testHashes: normalizeHashEntries(input.testHashes),
    goldenHashes: normalizeHashEntries(input.goldenHashes),
    command: String(input.command || '').trim().replace(/\s+/g, ' '),
    toolVersions: input.toolVersions && typeof input.toolVersions === 'object'
      ? Object.fromEntries(Object.entries(input.toolVersions)
        .map(([key, value]) => [String(key), String(value)])
        .sort(([a], [b]) => a.localeCompare(b)))
      : {},
    riskLevel: normalizeRiskLevel(input.riskLevel),
  };
  const contentHash = sha256(canonicalJson({
    projectRoot: inputs.projectRoot,
    fileHashes: inputs.fileHashes,
    testHashes: inputs.testHashes,
    goldenHashes: inputs.goldenHashes,
  }));
  return {
    evidenceKey: sha256(canonicalJson(inputs)),
    contentHash,
    inputs,
  };
}

function canReuseEvidence(entry, request = {}) {
  const requiredLevel = normalizeRiskLevel(request.riskLevel);
  if (requiredLevel === 'R3') return false;
  if (!entry || entry.status !== 'pass') return false;
  if (String(entry.evidenceKey || '') !== String(request.evidenceKey || '')) return false;
  if (RISK_LEVELS.indexOf(normalizeRiskLevel(entry.riskLevel)) < RISK_LEVELS.indexOf(requiredLevel)) {
    return false;
  }
  const now = Date.parse(request.now || new Date().toISOString());
  const expiresAt = Date.parse(entry.expiresAt || '');
  return Number.isFinite(now) && Number.isFinite(expiresAt) && expiresAt > now;
}

function riskActionHash(action = {}) {
  return sha256(canonicalJson({
    toolName: String(action.toolName || ''),
    cwd: normalizeEvidencePath(action.cwd),
    filePath: normalizeEvidencePath(action.filePath),
    command: String(action.command || '').trim().replace(/\s+/g, ' '),
    input: action.input && typeof action.input === 'object' ? action.input : {},
  }));
}

function classifyRisk(facts = {}) {
  const reasons = [];
  let minimumRiskLevel = facts.readOnly && !facts.mutating ? 'R0' : 'R1';

  if (minimumRiskLevel === 'R0') reasons.push('read-only');
  else reasons.push('state-changing-action');

  const strictSignals = [
    ['newModule', 'new-module'],
    ['interfaceChange', 'interface-change'],
    ['clockResetCdcChange', 'clock-reset-cdc-change'],
    ['goldenChange', 'golden-change'],
    ['sharedCoreChange', 'shared-core-change'],
    ['repeatedFailure', 'repeated-failure'],
  ];
  for (const [key, reason] of strictSignals) {
    if (!facts[key]) continue;
    minimumRiskLevel = maxRiskLevel(minimumRiskLevel, 'R2');
    reasons.push(reason);
  }

  const protectedSignals = [
    ['destructive', 'destructive-action'],
    ['crossProject', 'cross-project-action'],
    ['protectedTarget', 'protected-target'],
    ['releaseAction', 'release-action'],
  ];
  for (const [key, reason] of protectedSignals) {
    if (!facts[key]) continue;
    minimumRiskLevel = 'R3';
    reasons.push(reason);
  }

  if (facts.graphStale || facts.uncertain) {
    minimumRiskLevel = raiseRiskLevel(minimumRiskLevel);
    reasons.push(facts.graphStale ? 'stale-dependency-evidence' : 'uncertain-change-scope');
  }

  const stickyRiskLevel = normalizeRiskLevel(facts.persistedRiskLevel);
  if (RISK_LEVELS.indexOf(stickyRiskLevel) > RISK_LEVELS.indexOf(minimumRiskLevel)) {
    minimumRiskLevel = stickyRiskLevel;
    reasons.push('sticky-task-risk');
  }

  const effectiveRiskLevel = maxRiskLevel(minimumRiskLevel, facts.agentRiskLevel);

  return {
    minimumRiskLevel,
    effectiveRiskLevel,
    riskReasons: [...new Set(reasons)],
    requiredEvidence: requiredEvidenceForRisk(effectiveRiskLevel),
  };
}

function applyRiskPolicy(assessment = {}, opts = {}) {
  const mode = POLICY_MODES.includes(String(opts.mode || '').toLowerCase())
    ? String(opts.mode).toLowerCase()
    : riskPolicyMode(opts.env);
  const effectiveRiskLevel = normalizeRiskLevel(assessment.effectiveRiskLevel);
  const reason = String(assessment.riskReasons?.[0] || 'risk-policy-escalation');
  const requiredEvidence = Array.isArray(assessment.requiredEvidence)
    ? assessment.requiredEvidence
    : requiredEvidenceForRisk(effectiveRiskLevel);
  const base = {
    source: 'risk-policy',
    mode,
    effectiveRiskLevel,
    requiredEvidence,
    blocking: false,
    diagnostics: [],
    advisory: null,
    remediation: '',
  };
  if (mode === 'off' || effectiveRiskLevel === 'R0' || effectiveRiskLevel === 'R1') {
    return { ...base, decision: 'allow' };
  }

  const evidenceText = requiredEvidence.join(', ') || 'proportional verification';
  const remediation = `Provide ${evidenceText} before delivery.`;
  if (mode === 'enforce' && effectiveRiskLevel === 'R3' && opts.authorized !== true) {
    return {
      ...base,
      decision: 'block',
      blocking: true,
      diagnostics: [`R3 protected action requires exact authorization and fresh evidence (${reason}). ${remediation}`],
      remediation,
    };
  }

  return {
    ...base,
    decision: 'warn',
    advisory: {
      source: 'risk-policy',
      status: mode === 'shadow' ? 'shadow' : 'warning',
      blocking: false,
      message: `Risk ${effectiveRiskLevel}: ${reason}. ${remediation}`,
    },
    remediation,
  };
}

module.exports = {
  RISK_LEVELS,
  POLICY_MODES,
  normalizeRiskLevel,
  maxRiskLevel,
  raiseRiskLevel,
  riskPolicyMode,
  requiredEvidenceForRisk,
  verificationEvidenceLevel,
  buildEvidenceKey,
  canReuseEvidence,
  riskActionHash,
  classifyRisk,
  applyRiskPolicy,
};
