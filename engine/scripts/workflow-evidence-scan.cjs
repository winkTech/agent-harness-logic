#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_FILES = 2000;
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

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function splitTargets(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function collectFiles(targets, maxFiles = DEFAULT_MAX_FILES) {
  const files = [];
  const seen = new Set();

  function add(filePath) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    files.push(resolved);
  }

  function walk(entry) {
    if (files.length >= maxFiles) return;
    if (!fs.existsSync(entry)) return;
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      const base = path.basename(entry);
      if (SKIP_DIRS.has(base)) return;
      for (const child of fs.readdirSync(entry)) walk(path.join(entry, child));
      return;
    }
    if (stat.isFile() && isTextFile(entry) && stat.size <= 1024 * 1024) add(entry);
  }

  for (const target of targets) walk(target);
  return files;
}

const PATTERNS = [
  {
    bucket: 'hardcodedSecrets',
    severity: 'HIGH',
    re: /\b(api[_-]?key|secret|password|passwd|token|private[_-]?key)\b\s*[:=]\s*['"][^'"\n]{8,}['"]/i,
  },
  {
    bucket: 'dangerousCalls',
    severity: 'HIGH',
    re: /\b(eval|execSync|spawnSync)\s*\(|\bchild_process\b|shell\s*:\s*true/i,
  },
  {
    bucket: 'dangerousCalls',
    severity: 'MEDIUM',
    re: /\bexec\s*\(|subprocess\.[A-Za-z_]+\([^)]*shell\s*=\s*True|pickle\.loads\s*\(|yaml\.load\s*\(/i,
  },
  {
    bucket: 'injectionRisks',
    severity: 'HIGH',
    re: /\b(SELECT|UPDATE|DELETE|INSERT)\b[\s\S]{0,80}(\+|\$\{|%s|format\()/i,
  },
  {
    bucket: 'injectionRisks',
    severity: 'MEDIUM',
    re: /\.\.\/|\.\.\\|path\.join\([^)]*(req\.|request\.|input|param|query)/i,
  },
  {
    bucket: 'configIssues',
    severity: 'MEDIUM',
    re: /\b(debug\s*[:=]\s*true|cors\s*\(\s*\)|Access-Control-Allow-Origin['"]?\s*[:=]\s*['"]\*)/i,
  },
];

function scanFile(filePath, root) {
  const findings = {
    hardcodedSecrets: [],
    injectionRisks: [],
    dangerousCalls: [],
    configIssues: [],
  };
  const text = fs.readFileSync(filePath, 'utf8');
  const rel = path.relative(root, filePath) || path.basename(filePath);
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (!pattern.re.test(line)) continue;
      findings[pattern.bucket].push({
        file: rel,
        line: index + 1,
        severity: pattern.severity,
        evidence: line.trim().slice(0, 160),
      });
    }
  });

  return findings;
}

function mergeFindings(target, next) {
  for (const key of Object.keys(target)) target[key].push(...(next[key] || []));
}

function scan(targets, opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const resolvedTargets = targets.map((target) => path.resolve(root, target));
  const files = collectFiles(resolvedTargets, opts.maxFiles || DEFAULT_MAX_FILES);
  const findings = {
    hardcodedSecrets: [],
    injectionRisks: [],
    dangerousCalls: [],
    configIssues: [],
  };

  for (const file of files) mergeFindings(findings, scanFile(file, root));

  const issueCount = Object.values(findings).reduce((sum, items) => sum + items.length, 0);
  return {
    schemaVersion: 1,
    scanner: 'workflow-evidence-scan',
    root,
    targets,
    filesScanned: files.length,
    issueCount,
    status: issueCount > 0 ? 'issues_found' : 'clean',
    findings,
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const targetsArg = argValue(args, '--targets', '');
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const positional = args.filter((arg, idx) => (
    !arg.startsWith('--') && args[idx - 1] !== '--targets' && args[idx - 1] !== '--root'
  ));
  const targets = [
    ...splitTargets(targetsArg),
    ...positional,
  ];

  if (targets.length === 0) {
    console.error('workflow-evidence-scan requires --targets or positional target paths');
    process.exit(2);
  }

  const result = scan(targets, { root });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`workflow-evidence-scan: ${result.status}, files=${result.filesScanned}, issues=${result.issueCount}`);
    for (const [bucket, items] of Object.entries(result.findings)) {
      for (const item of items) {
        console.log(`${bucket} ${item.severity} ${item.file}:${item.line} ${item.evidence}`);
      }
    }
  }
  if (result.issueCount > 0 && args.includes('--fail-on-issues')) process.exit(1);
}

if (require.main === module) main();

module.exports = { collectFiles, scan };
