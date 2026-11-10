#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_FILES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cjs', '.cs', '.css', '.go', '.h', '.hpp', '.html',
  '.java', '.js', '.json', '.jsx', '.md', '.mjs', '.php', '.py', '.rb',
  '.rs', '.sh', '.sql', '.sv', '.ts', '.tsx', '.txt', '.v', '.vue', '.yaml',
  '.yml',
]);
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '__pycache__', '.pytest_cache',
  '.venv', 'venv', 'dist', 'build', 'coverage',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function splitTargets(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTargetsJson(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('--targets-json must be a JSON array of non-empty strings');
  }
  return parsed;
}

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isInsideRoot(realPath, realRoot) {
  const relative = path.relative(realRoot, realPath);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function portableRelative(root, filePath) {
  return (path.relative(root, filePath) || path.basename(filePath)).replace(/\\/g, '/');
}

function resolveTargets(targets, root) {
  const realRoot = fs.realpathSync(root);
  const resolved = [];
  const errors = [];
  for (const target of targets) {
    const requested = String(target);
    const absolute = path.resolve(root, requested);
    if (!fs.existsSync(absolute)) {
      errors.push({ target: requested, code: 'missing_target' });
      continue;
    }
    try {
      const real = fs.realpathSync(absolute);
      if (!isInsideRoot(real, realRoot)) {
        errors.push({ target: requested, code: 'outside_root' });
        continue;
      }
      resolved.push({ requested, absolute, real });
    } catch (error) {
      errors.push({ target: requested, code: 'unreadable_target', errorCode: error.code || 'UNKNOWN' });
    }
  }
  return { realRoot, resolved, errors };
}

function collectFiles(targets, opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const resolution = resolveTargets(targets, root);
  const candidates = new Map();
  const visitedDirs = new Set();
  const errors = [...resolution.errors];

  function walk(entry, requestedTarget) {
    let real;
    let stat;
    try {
      real = fs.realpathSync(entry);
      if (!isInsideRoot(real, resolution.realRoot)) {
        errors.push({ target: requestedTarget, code: 'outside_root' });
        return;
      }
      stat = fs.statSync(real);
    } catch (error) {
      errors.push({ target: requestedTarget, code: 'unreadable_entry', errorCode: error.code || 'UNKNOWN' });
      return;
    }

    if (stat.isDirectory()) {
      if (visitedDirs.has(real)) return;
      visitedDirs.add(real);
      if (SKIP_DIRS.has(path.basename(real))) return;
      let children;
      try {
        children = fs.readdirSync(real).sort((a, b) => a.localeCompare(b, 'en'));
      } catch (error) {
        errors.push({ target: portableRelative(resolution.realRoot, real), code: 'unreadable_directory', errorCode: error.code || 'UNKNOWN' });
        return;
      }
      for (const child of children) walk(path.join(real, child), requestedTarget);
      return;
    }

    if (stat.isFile() && isTextFile(real) && stat.size <= MAX_FILE_BYTES) {
      candidates.set(real, portableRelative(resolution.realRoot, real));
    }
  }

  for (const target of resolution.resolved) walk(target.real, target.requested);
  const entries = [...candidates.entries()]
    .map(([filePath, relative]) => ({ filePath, relative }))
    .sort((a, b) => a.relative.localeCompare(b.relative, 'en'));
  const maxFiles = opts.maxFiles || DEFAULT_MAX_FILES;
  return {
    files: entries.slice(0, maxFiles),
    totalCandidates: entries.length,
    truncated: entries.length > maxFiles,
    errors,
    realRoot: resolution.realRoot,
  };
}

const SECRET_PATTERN = /\b(api[_-]?key|secret|password|passwd|token|private[_-]?key)\b\s*[:=]\s*(['"])([^'"\n]{8,})\2/i;
const PATTERNS = [
  { ruleId: 'dangerous-call-high', bucket: 'dangerousCalls', severity: 'HIGH', re: /\b(eval|execSync|spawnSync)\s*\(|\bchild_process\b|shell\s*:\s*true/i },
  { ruleId: 'dangerous-call-medium', bucket: 'dangerousCalls', severity: 'MEDIUM', re: /\bexec\s*\(|subprocess\.[A-Za-z_]+\([^)]*shell\s*=\s*True|pickle\.loads\s*\(|yaml\.load\s*\(/i },
  { ruleId: 'injection-sql', bucket: 'injectionRisks', severity: 'HIGH', re: /\b(SELECT|UPDATE|DELETE|INSERT)\b[\s\S]{0,80}(\+|\$\{|%s|format\()/i },
  { ruleId: 'injection-path', bucket: 'injectionRisks', severity: 'MEDIUM', re: /\.\.\/|\.\.\\|path\.join\([^)]*(req\.|request\.|input|param|query)/i },
  { ruleId: 'unsafe-config', bucket: 'configIssues', severity: 'MEDIUM', re: /\b(debug\s*[:=]\s*true|cors\s*\(\s*\)|Access-Control-Allow-Origin['"]?\s*[:=]\s*['"]\*)/i },
];

function redactEvidence(line) {
  return String(line)
    .replace(SECRET_PATTERN, (_all, key, quote, value) => `${key}=<redacted:${sha256(value).slice(0, 12)}>`)
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, (value) => `<redacted:${sha256(value).slice(0, 12)}>`)
    .trim()
    .slice(0, 160);
}

function emptyFindings() {
  return { hardcodedSecrets: [], injectionRisks: [], dangerousCalls: [], configIssues: [] };
}

function scanFile(filePath, root) {
  const findings = emptyFindings();
  const text = fs.readFileSync(filePath, 'utf8');
  const rel = portableRelative(root, filePath);
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const secret = line.match(SECRET_PATTERN);
    if (secret) {
      findings.hardcodedSecrets.push({
        file: rel,
        line: index + 1,
        severity: 'HIGH',
        ruleId: 'hardcoded-secret',
        key: secret[1].toLowerCase().replace(/-/g, '_'),
        valueHash: sha256(secret[3]),
      });
    }
    for (const pattern of PATTERNS) {
      if (!pattern.re.test(line)) continue;
      findings[pattern.bucket].push({
        file: rel,
        line: index + 1,
        severity: pattern.severity,
        ruleId: pattern.ruleId,
        evidence: redactEvidence(line),
      });
    }
  });
  return findings;
}

function mergeFindings(target, next) {
  for (const key of Object.keys(target)) target[key].push(...(next[key] || []));
}

function finalizeManifest(result) {
  return { ...result, manifestSha256: sha256(JSON.stringify(result)) };
}

function scan(targets, opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  let collection;
  try {
    collection = collectFiles(targets, { root, maxFiles: opts.maxFiles || DEFAULT_MAX_FILES });
  } catch (error) {
    return finalizeManifest({
      schemaVersion: 2,
      scanner: 'workflow-evidence-scan',
      root,
      targets,
      filesScanned: 0,
      scannedFiles: [],
      totalCandidates: 0,
      truncated: false,
      issueCount: 0,
      status: 'invalid_target',
      errors: [{ code: 'invalid_root', errorCode: error.code || 'UNKNOWN' }],
      findings: emptyFindings(),
    });
  }

  const findings = emptyFindings();
  for (const file of collection.files) mergeFindings(findings, scanFile(file.filePath, collection.realRoot));
  const issueCount = Object.values(findings).reduce((sum, items) => sum + items.length, 0);
  let status = issueCount > 0 ? 'issues_found' : 'clean';
  if (collection.errors.length > 0) status = 'invalid_target';
  else if (collection.totalCandidates === 0) status = 'empty_scan';
  else if (collection.truncated) status = 'truncated';

  return finalizeManifest({
    schemaVersion: 2,
    scanner: 'workflow-evidence-scan',
    root: collection.realRoot,
    targets,
    filesScanned: collection.files.length,
    scannedFiles: collection.files.map((file) => file.relative),
    totalCandidates: collection.totalCandidates,
    truncated: collection.truncated,
    issueCount,
    status,
    errors: collection.errors,
    findings,
  });
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const maxFilesRaw = argValue(args, '--max-files', String(DEFAULT_MAX_FILES));
  const maxFiles = Number(maxFilesRaw);
  const targetsArg = argValue(args, '--targets', '');
  const targetsJson = argValue(args, '--targets-json', '');
  const positional = args.filter((arg, idx) => (
    !arg.startsWith('--') && !['--targets', '--targets-json', '--root', '--max-files'].includes(args[idx - 1])
  ));

  let targets;
  try {
    targets = [...parseTargetsJson(targetsJson), ...splitTargets(targetsArg), ...positional];
    if (targets.length === 0) throw new Error('at least one target is required');
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 100000) {
      throw new Error('--max-files must be an integer between 1 and 100000');
    }
  } catch (error) {
    const result = finalizeManifest({
      schemaVersion: 2,
      scanner: 'workflow-evidence-scan',
      root,
      targets: [],
      filesScanned: 0,
      scannedFiles: [],
      totalCandidates: 0,
      truncated: false,
      issueCount: 0,
      status: 'invalid_target',
      errors: [{ code: 'invalid_arguments', message: error.message }],
      findings: emptyFindings(),
    });
    console.log(JSON.stringify(result, null, json ? 2 : 0));
    process.exit(2);
  }

  const result = scan(targets, { root, maxFiles });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`workflow-evidence-scan: ${result.status}, files=${result.filesScanned}, issues=${result.issueCount}, manifest=${result.manifestSha256}`);

  if (['invalid_target', 'empty_scan', 'truncated'].includes(result.status)) process.exit(2);
  if (result.issueCount > 0 && args.includes('--fail-on-issues')) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  collectFiles,
  isInsideRoot,
  redactEvidence,
  scan,
};
