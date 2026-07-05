'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  isInsidePath,
  resolvePath,
} = require('./project-scope.cjs');

const DEFAULT_FORBIDDEN_CLAIMS = [
  '\\bverified\\b',
  '\\bverification\\s+passed\\b',
  '\\bpass(?:ed)?\\b',
  '\\bsynthesis\\s+passed\\b',
  '\\bvivado\\s+passed\\b',
  '\\btests?\\s+passed\\b',
  '已验证',
  '验证通过',
  '综合通过',
  '仿真通过'
];

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFile(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function normalizeRel(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

function resolveProjectFile(projectRoot, relPath) {
  return resolvePath(normalizeRel(relPath), projectRoot);
}

function unique(values) {
  return Array.from(new Set(values));
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    idx = text.indexOf(needle, idx);
    if (idx === -1) return count;
    count += 1;
    idx += needle.length;
  }
}

function compileRule(rule, kind, failures) {
  try {
    return new RegExp(rule.pattern, rule.flags || '');
  } catch (error) {
    failures.push(`${kind} regex does not compile for ${rule.file}: ${error.message}`);
    return null;
  }
}

function validateRepairSpec(spec, opts = {}) {
  const projectRoot = resolvePath(opts.projectRoot || process.cwd());
  const failures = [];

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, failures: ['repair spec must be an object'], projectRoot };
  }
  if (spec.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (!spec.id || typeof spec.id !== 'string') failures.push('id is required');
  if (!spec.objective || typeof spec.objective !== 'string') failures.push('objective is required');

  const allowedFiles = unique((spec.allowedFiles || []).map(normalizeRel).filter(Boolean));
  const readonlyFiles = unique((spec.readonlyFiles || []).map(normalizeRel).filter(Boolean));
  if (allowedFiles.length === 0) failures.push('allowedFiles must contain at least one file');

  for (const relPath of [...allowedFiles, ...readonlyFiles]) {
    const absPath = resolveProjectFile(projectRoot, relPath);
    if (!isInsidePath(absPath, projectRoot)) {
      failures.push(`path escapes project root: ${relPath}`);
    }
  }

  const allowed = new Set(allowedFiles);
  const readonly = new Set(readonlyFiles);
  const patches = Array.isArray(spec.patches) ? spec.patches : [];
  if (patches.length === 0) failures.push('patches must contain at least one patch');

  patches.forEach((patch, index) => {
    const relPath = normalizeRel(patch?.file);
    if (!relPath) failures.push(`patch[${index}].file is required`);
    if (!allowed.has(relPath)) failures.push(`patch[${index}] targets file outside allowedFiles: ${relPath}`);
    if (readonly.has(relPath)) failures.push(`patch[${index}] targets readonly file: ${relPath}`);
    if (typeof patch?.oldBlock !== 'string' || patch.oldBlock.length === 0) failures.push(`patch[${index}].oldBlock is required`);
    if (typeof patch?.newBlock !== 'string' || patch.newBlock.length === 0) failures.push(`patch[${index}].newBlock is required`);
    const absPath = resolveProjectFile(projectRoot, relPath);
    if (!isInsidePath(absPath, projectRoot)) failures.push(`patch[${index}] escapes project root: ${relPath}`);
  });

  for (const [kind, rules] of [
    ['requiredRegex', spec.requiredRegex || []],
    ['forbiddenRegex', spec.forbiddenRegex || []],
  ]) {
    if (!Array.isArray(rules)) {
      failures.push(`${kind} must be an array`);
      continue;
    }
    rules.forEach((rule, index) => {
      const relPath = normalizeRel(rule?.file);
      if (!allowed.has(relPath)) failures.push(`${kind}[${index}] targets file outside allowedFiles: ${relPath}`);
      if (!rule?.pattern || typeof rule.pattern !== 'string') failures.push(`${kind}[${index}].pattern is required`);
      if (rule?.pattern) compileRule({ ...rule, file: relPath }, kind, failures);
    });
  }

  if (spec.outputSentinel !== undefined && typeof spec.outputSentinel !== 'string') {
    failures.push('outputSentinel must be a string when present');
  }
  if (spec.forbiddenClaims !== undefined && !Array.isArray(spec.forbiddenClaims)) {
    failures.push('forbiddenClaims must be an array when present');
  }

  return {
    ok: failures.length === 0,
    failures,
    projectRoot,
    allowedFiles,
    readonlyFiles,
  };
}

function preflightPatches(spec, opts = {}) {
  const validation = validateRepairSpec(spec, opts);
  if (!validation.ok) return { ok: false, failures: validation.failures, updates: [] };

  const updates = [];
  const failures = [];
  for (const patch of spec.patches) {
    const relPath = normalizeRel(patch.file);
    const absPath = resolveProjectFile(validation.projectRoot, relPath);
    if (!fs.existsSync(absPath)) {
      failures.push(`patch target does not exist: ${relPath}`);
      continue;
    }
    const before = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
    const occurrences = countOccurrences(before, patch.oldBlock);
    if (occurrences !== 1) {
      failures.push(`oldBlock must match exactly once in ${relPath}; matched ${occurrences}`);
      continue;
    }
    const after = before.replace(patch.oldBlock, patch.newBlock);
    updates.push({
      relPath,
      absPath,
      before,
      after,
      beforeSha256: sha256(before),
      afterSha256: sha256(after),
      replacements: 1,
    });
  }

  return { ok: failures.length === 0, failures, updates, projectRoot: validation.projectRoot };
}

function applyRepairSpec(spec, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const preflight = preflightPatches(spec, opts);
  if (!preflight.ok) return { ok: false, failures: preflight.failures, applied: [] };

  if (!dryRun) {
    for (const update of preflight.updates) {
      fs.writeFileSync(update.absPath, update.after.replace(/\n/g, '\n'), 'utf8');
    }
  }

  return {
    ok: true,
    dryRun,
    failures: [],
    applied: preflight.updates.map((update) => ({
      file: update.relPath,
      beforeSha256: update.beforeSha256,
      afterSha256: update.afterSha256,
      replacements: update.replacements,
    })),
  };
}

function readSpecFile(specPath) {
  return JSON.parse(fs.readFileSync(specPath, 'utf8'));
}

function evaluateRepairContent(spec, opts = {}) {
  const validation = validateRepairSpec(spec, opts);
  if (!validation.ok) return { ok: false, failures: validation.failures, checks: [] };

  const failures = [];
  const checks = [];
  const projectRoot = validation.projectRoot;

  function readTarget(relPath) {
    const absPath = resolveProjectFile(projectRoot, relPath);
    if (!fs.existsSync(absPath)) {
      failures.push(`content target does not exist: ${relPath}`);
      return '';
    }
    return fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
  }

  for (const rule of spec.requiredRegex || []) {
    const relPath = normalizeRel(rule.file);
    const pattern = compileRule({ ...rule, file: relPath }, 'requiredRegex', failures);
    if (!pattern) continue;
    const text = readTarget(relPath);
    const matched = pattern.test(text);
    checks.push({ type: 'requiredRegex', file: relPath, description: rule.description || rule.pattern, status: matched ? 'passed' : 'failed' });
    if (!matched) failures.push(`required pattern missing in ${relPath}: ${rule.description || rule.pattern}`);
  }

  for (const rule of spec.forbiddenRegex || []) {
    const relPath = normalizeRel(rule.file);
    const pattern = compileRule({ ...rule, file: relPath }, 'forbiddenRegex', failures);
    if (!pattern) continue;
    const text = readTarget(relPath);
    const matched = pattern.test(text);
    checks.push({ type: 'forbiddenRegex', file: relPath, description: rule.description || rule.pattern, status: matched ? 'failed' : 'passed' });
    if (matched) failures.push(`forbidden pattern present in ${relPath}: ${rule.description || rule.pattern}`);
  }

  return { ok: failures.length === 0, failures, checks };
}

function evaluateOutputText(spec, text) {
  const failures = [];
  const value = String(text || '').trim();
  if (spec?.outputSentinel && value !== spec.outputSentinel) {
    failures.push(`output sentinel mismatch: expected exactly ${JSON.stringify(spec.outputSentinel)}`);
  }

  const claims = [
    ...DEFAULT_FORBIDDEN_CLAIMS,
    ...(Array.isArray(spec?.forbiddenClaims) ? spec.forbiddenClaims : []),
  ];
  for (const patternText of claims) {
    const pattern = new RegExp(patternText, 'iu');
    if (pattern.test(value)) failures.push(`forbidden self-verification claim matched: ${patternText}`);
  }

  return { ok: failures.length === 0, failures };
}

function comparePlanToSpec(plan, spec) {
  const failures = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, failures: ['plan must be an object'] };
  }
  if (plan.schemaVersion !== 1) failures.push('plan.schemaVersion must be 1');
  const output = plan.output || plan.finalText || '';
  const outputCheck = evaluateOutputText(spec, output);
  failures.push(...outputCheck.failures);

  const planPatches = Array.isArray(plan.patches) ? plan.patches : [];
  const planClaims = {
    ...plan,
    patches: planPatches.map((patch) => ({
      file: normalizeRel(patch?.file),
      description: patch?.description || '',
    })),
  };
  const claimCheck = evaluateOutputText({ ...spec, outputSentinel: undefined }, JSON.stringify(planClaims));
  failures.push(...claimCheck.failures.map((failure) => `plan contains forbidden claim: ${failure}`));

  if (planPatches.length !== spec.patches.length) {
    failures.push(`plan patch count mismatch: expected ${spec.patches.length}, got ${planPatches.length}`);
  }

  const specPatches = spec.patches.map((patch) => ({
    file: normalizeRel(patch.file),
    oldBlock: patch.oldBlock,
    newBlock: patch.newBlock,
  }));

  planPatches.forEach((patch, index) => {
    const expected = specPatches[index];
    if (!expected) return;
    if (normalizeRel(patch?.file) !== expected.file) failures.push(`plan patch[${index}].file mismatch`);
    if (patch?.oldBlock !== expected.oldBlock) failures.push(`plan patch[${index}].oldBlock mismatch`);
    if (patch?.newBlock !== expected.newBlock) failures.push(`plan patch[${index}].newBlock mismatch`);
  });

  return { ok: failures.length === 0, failures };
}

module.exports = {
  DEFAULT_FORBIDDEN_CLAIMS,
  applyRepairSpec,
  comparePlanToSpec,
  evaluateOutputText,
  evaluateRepairContent,
  hashFile,
  normalizeRel,
  preflightPatches,
  readSpecFile,
  sha256,
  validateRepairSpec,
};
