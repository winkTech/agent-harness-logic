'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const fixedReceipt = 'var/workflow/p2-fixed-point.json';
const architecture = '06_doc/architecture.yaml';
const strategy = '06_doc/verification_strategy.md';

function projectFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) return null;
  try {
    const base = fs.realpathSync(root);
    const file = fs.realpathSync(path.resolve(base, relative));
    const local = path.relative(base, file);
    if (local === '..' || local.startsWith('..' + path.sep) || path.isAbsolute(local)) return null;
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 ? file : null;
  } catch { return null; }
}

function positiveCount(n) { return Number.isSafeInteger(n) && n > 0; }

function readRecord(root, relative, digest) {
  const file = projectFile(root, relative);
  if (!file) throw new Error('missing or empty: ' + relative);
  try {
    const bytes = fs.readFileSync(file);
    if (digest) digest.update(bytes);
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  }
  catch { throw new Error('invalid JSON: ' + relative); }
}

function checkHashes(root, hashes, required) {
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) throw new Error('missing artifact hashes');
  for (const name of required) {
    if (typeof name !== 'string' || !Object.hasOwn(hashes, name)) throw new Error('missing artifact digest: ' + name);
  }
  for (const [name, expected] of Object.entries(hashes)) {
    const file = projectFile(root, name);
    if (!file) throw new Error('missing or empty: ' + name);
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error('artifact changed: ' + name);
  }
}

function checkSystemCases(root, data, required) {
  const scopeFile = 'var/workflow/golden-scope.json', goldenFile = 'var/workflow/golden-preflight.json';
  const approved = readRecord(root, scopeFile);
  const golden = readRecord(root, goldenFile);
  if (!Array.isArray(approved?.cases) || !approved.cases.length || !approved.entry || approved.entry !== golden?.entry
      || golden.entrySha256 !== data.hashes?.[approved.entry]) throw new Error('P2 baseline differs from reviewed Golden');
  required.push(scopeFile, goldenFile, approved.entry);
  for (const name of approved.cases) {
    const measurement = data.systemCases?.[name];
    if (!measurement) throw new Error('unmeasured P2 baseline case: ' + name);
    required.push(measurement);
    const run = readRecord(root, measurement);
    if (run?.case !== name || run.source !== 'normal' || !Array.isArray(run.oracleInputs) || run.oracleInputs.length
        || !positiveCount(run.compared_points) || !Array.isArray(run.checks) || !run.checks.length
        || !run.checks.every(c => typeof c?.metric === 'string' && c.metric.trim() && Number.isFinite(c.float) && Number.isFinite(c.fixed)
          && (c.min !== undefined || c.max !== undefined) && (c.min === undefined || (Number.isFinite(c.min) && c.fixed >= c.min))
          && (c.max === undefined || (Number.isFinite(c.max) && c.fixed <= c.max)))) {
      throw new Error('failed P2 float/fixed comparison: ' + name);
    }
    const metrics = new Map(run.checks.map(c => [c.metric, c]));
    if (metrics.size !== run.checks.length) throw new Error('duplicate P2 metric: ' + name);
    for (const limit of (approved.limits ?? []).filter(l => l.case === name)) {
      const m = metrics.get(limit.metric);
      if (!m || (limit.min === undefined && limit.max === undefined) || [m.float, m.fixed].some(v =>
        (limit.min !== undefined && (!Number.isFinite(limit.min) || v < limit.min)) ||
        (limit.max !== undefined && (!Number.isFinite(limit.max) || v > limit.max)))) {
        throw new Error('P2 measurement outside approved limits or missing: ' + name + '/' + limit.metric);
      }
    }
  }
  return { entry: approved.entry, cases: approved.cases, limits: approved.limits ?? [] };
}

function checkFixedPoint(root, modules, withBaseline, hardLimits = {}) {
  const digest = createHash('sha256');
  const data = readRecord(root, fixedReceipt, digest);
  const required = [architecture, '06_doc/fixed_point_report.md', '06_doc/resource_budget_tracking.md'];
  const baseline = withBaseline ? checkSystemCases(root, data, required) : undefined;
  for (const name of ['DSP', 'LUT', 'BRAM']) {
    const budget = data?.resources?.[name];
    if (!Number.isFinite(budget?.estimate) || budget.estimate < 0 || (budget.limit !== null && (!Number.isFinite(budget.limit) || budget.limit < 0))) {
      throw new Error('missing P2 resource estimate or budget: ' + name);
    }
    if (Object.hasOwn(hardLimits, name) && budget.estimate > hardLimits[name]) {
      throw new Error('P2 hard limit exceeded: ' + name + ' ' + budget.estimate + ' > ' + hardLimits[name]);
    }
    if (budget.limit !== null && budget.estimate > budget.limit) {
      if (!budget.acceptedRisk) throw new Error('unresolved P2 resource overrun: ' + name);
      required.push(budget.acceptedRisk);
    }
  }
  const references = new Map();
  for (const mod of modules) {
    const entry = data?.modules?.[mod];
    if (!entry?.model || !entry.reference || !entry.measurement ||
        new Set([entry.model, entry.reference, entry.measurement]).size !== 3) throw new Error('missing independent P2 artifacts for ' + mod);
    required.push(entry.model, entry.reference, entry.measurement);
    const run = readRecord(root, entry.measurement);
    if (run?.module !== mod || !['rounding', 'overflow'].every(k => typeof run[k] === 'string' && run[k].trim())
        || !positiveCount(run.compared_points) || !Number.isFinite(run.max_error_limit)
        || run.max_error_limit < 0 || !positiveCount(run.selected_width) || !Array.isArray(run.trials)
        || !run.trials.every(t => positiveCount(t?.width) && Number.isFinite(t.max_error) && t.max_error >= 0)
        || !run.trials.some(t => t.width === run.selected_width && t.max_error <= run.max_error_limit)) {
      throw new Error('invalid or out-of-budget fixed-point comparison: ' + mod);
    }
    const widths = new Set(run.trials.map(t => t.width));
    if (widths.size !== run.trials.length || (widths.size < 2 && !(typeof run.fixed_width_basis === 'string' && run.fixed_width_basis.trim()))) {
      throw new Error('missing width sweep or specified exact-width basis: ' + mod);
    }
    references.set(mod, entry.model);
  }
  checkHashes(root, data.hashes, required);
  for (const mod of modules) {
    const { model, reference } = data.modules[mod];
    if (data.hashes[model] === data.hashes[reference]) throw new Error('P2 model and independent reference are identical: ' + mod);
  }
  return { models: references, baseline, receiptSha256: digest.digest('hex') };
}

// Resolve local static dependencies of the module TB, RTL, and checker. Additional
// search paths and dynamically loaded inputs belong in the producer's hash manifest.
function localTestSources(root, entrypoints, searchDirs = ['02_sim']) {
  const sources = new Set(entrypoints);
  const scanned = new Set();
  for (const name of sources) {
    const file = projectFile(root, name);
    if (!file || scanned.has(file)) continue;
    scanned.add(file);
    const lower = name.toLowerCase();
    const isPy = lower.endsWith('.py');
    const isHdl = /\.(?:sv|svh|v|vh)$/.test(lower);
    if (!isPy && !isHdl) continue;
    const content = fs.readFileSync(file, 'utf8');
    const candidates = [];
    if (isPy) {
      for (const match of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([^#;\r\n]+))/gm)) {
        const imports = match[1] ? [match[1]] : match[2].split(',').map(s => s.trim().split(/\s+/)[0]);
        for (const module of imports) {
          if (!/^[A-Za-z_]\w*(?:\.\w+)*$/.test(module)) continue;
          const base = module.replace(/\./g, '/');
          candidates.push(base + '.py', base + '/__init__.py');
        }
      }
    } else {
      for (const match of content.matchAll(/^\s*`include\s+"([^"\r\n]+)"/gm)) candidates.push(match[1]);
    }
    const baseDir = path.posix.dirname(name.replace(/\\/g, '/'));
    for (const relative of candidates) {
      for (const dir of [baseDir, ...searchDirs]) {
        const dependency = path.posix.normalize(dir === '.' ? relative : path.posix.join(dir, relative));
        if (projectFile(root, dependency)) sources.add(dependency);
      }
    }
  }
  return [...sources];
}

function expandLocalSources(root, entrypoints) {
  const normalized = entrypoints.map(p => String(p).replace(/\\/g, '/'));
  const parentDirs = normalized
    .map(p => path.posix.dirname(path.posix.dirname(p)))
    .filter(d => d && d !== '.');
  return localTestSources(root, normalized, [...new Set([...parentDirs, '01_src/00_hdl', '02_sim', '08_py', '.'])]);
}

function checkVerification(root, mod, expectedModel) {
  const data = readRecord(root, 'var/workflow/p3/' + mod + '.json');
  if (data?.module !== mod || typeof data.reference !== 'string' || !data.reference
      || (expectedModel !== undefined && data.reference !== expectedModel)) throw new Error('incorrect vector reference for ' + mod);
  const sources = localTestSources(root, [`02_sim/${mod}/tb_${mod}.sv`, `02_sim/check_${mod}.py`]);
  const required = [architecture, strategy, data.reference, ...sources, `02_sim/tv/${mod}_tv.txt`];
  const planPath = 'var/workflow/p3-plan.json';
  const plan = readRecord(root, planPath);
  const scenarios = plan?.modules?.[mod];
  if (!Array.isArray(scenarios) || !scenarios.length || !scenarios.every(s => typeof s === 'string' && s.trim())
      || new Set(scenarios).size !== scenarios.length || !data.hashes?.[strategy] || plan.strategySha256 !== data.hashes[strategy]) {
    throw new Error('missing or stale verification plan for ' + mod);
  }
  required.push(planPath);
  const contract = '06_doc/interface_contract.md';
  if (Object.hasOwn(plan, 'interfaceContractSha256') || fs.existsSync(path.resolve(root, contract))) {
    if (!plan.interfaceContractSha256 || plan.interfaceContractSha256 !== data.hashes?.[contract]) {
      throw new Error('missing or stale design-reviewed interface contract for ' + mod);
    }
    required.push(contract);
    if (!Array.isArray(data.openInterfaceIssues)) throw new Error('missing P3 interface review for ' + mod);
    if (data.openInterfaceIssues.length) throw new Error('open P3 interface issue for ' + mod + ': ' + data.openInterfaceIssues.join(', '));
  }
  if (expectedModel !== undefined) required.push(fixedReceipt);
  const probes = new Set();
  for (const component of ['tb', 'checker']) {
    for (const kind of ['good', 'fault']) {
      const record = data.probes?.[component]?.[kind];
      if (!record || probes.has(record)) throw new Error('missing or reused P3 probe: ' + mod + '/' + component + '/' + kind);
      probes.add(record);
      required.push(record);
      const run = readRecord(root, record);
      if (run?.module !== mod || run.component !== component || run.kind !== kind || !positiveCount(run.compared_points)
          || !Number.isSafeInteger(run.mismatches) || run.mismatches < 0 || run.mismatches > run.compared_points
          || (kind === 'good' ? run.exitCode !== 0 || run.mismatches !== 0 : !positiveCount(run.exitCode) || !positiveCount(run.mismatches))) {
        throw new Error('unproven P3 comparison: ' + mod + '/' + component + '/' + kind);
      }
      if (kind === 'good' && scenarios.some(id => !positiveCount(run.scenarios?.[id]) || run.scenarios[id] > run.compared_points)) {
        throw new Error('unexercised planned scenario: ' + mod + '/' + component);
      }
    }
  }
  checkHashes(root, data.hashes, required);
  if (projectFile(root, data.reference) === projectFile(root, `02_sim/tv/${mod}_tv.txt`)) {
    throw new Error('P3 vector file cannot serve as its own generator: ' + mod);
  }
  return plan.interfaceContractSha256;
}

module.exports = { projectFile, checkFixedPoint, checkVerification, localTestSources, expandLocalSources };
