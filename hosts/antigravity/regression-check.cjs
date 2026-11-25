'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {parseArgs} = require('node:util');

const suite = 'policy-paths.test.cjs';
const fixedSuites = ['background', 'git-integrity', 'transcript', 'security-policy', 'policy-paths', 'stop-handoff'];
const originalProbeHash = 'c9e051c7556edd873dd3495c332081e1c473ce8cd64e25037c0ae8cd27788d4b';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Node runs this reporter in the test CLI. Setup, skip and process failures
// remain distinguishable from an assertion about policy behavior.
module.exports = async function* reporter(events) {
  const rows = [];
  let summary;
  for await (const {type, data} of events) {
    if (type === 'test:summary' && !data.file) summary = data.counts;
    if (!['test:pass','test:fail'].includes(type) || data.details?.type === 'suite') continue;
    const error = data.details?.error;
    let state = 'missing';
    if (!data.skip && !data.todo && type === 'test:pass') state = 'pass';
    if (!data.skip && !data.todo && type === 'test:fail' && error?.cause?.code === 'ERR_ASSERTION') state = 'fail';
    const id = path.basename(data.file || '') + '::' + data.name;
    rows.push({id, state, reason: error?.message || data.skip || data.todo || undefined});
  }
  yield JSON.stringify({rows, summary});
};

function invoke(args, cwd, env = process.env) {
  const proc = spawnSync(process.execPath, args, {cwd, env, windowsHide:true, encoding:'utf8', maxBuffer:16*1024*1024});
  return {exitCode:proc.status, error:proc.error?.message || proc.signal || undefined,
    stdout:proc.stdout || '', stderr:proc.stderr || ''};
}

function runTests(cwd, files, env) {
  const proc = invoke(['--test', '--test-concurrency=1', '--test-reporter=' + pathToFileURL(__filename).href, ...files], cwd, env);
  let data;
  try { data = JSON.parse(proc.stdout); } catch {}
  const runs = new Map();
  for (const {id, state, reason} of data?.rows || []) {
    runs.set(id, runs.has(id) ? {state:'missing', reason:'Duplicate test ID'} : {state, reason});
  }
  const unexpected = [...runs.entries()].filter(([,row]) => row.state !== 'pass');
  const counts = data?.summary;
  const ok = proc.exitCode === 0 && counts?.tests > 0 && counts.passed === counts.tests &&
    !unexpected.length && runs.size === counts.passed;
  return {runs, report:{ok, exitCode:proc.exitCode, counts, unexpected:Object.fromEntries(unexpected),
    error:proc.error || (!counts && (proc.stderr || 'Missing node:test summary')) || undefined}};
}

function readBaseline(dir) {
  dir = path.resolve(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  const policy = fs.readFileSync(path.join(dir,'tool-policy.cjs'));
  if (manifest.version !== 1 || sha(policy) !== manifest.sha256 ||
      !Array.isArray(manifest.tests) || !manifest.tests.length ||
      !manifest.tests.every(id => typeof id === 'string' && id.includes('::')) ||
      new Set(manifest.tests).size !== manifest.tests.length) throw new Error('Invalid baseline manifest or policy hash: ' + dir);
  return {dir, manifest, policy};
}

function compare(baseline, currentPolicy, tmp) {
  const fixture = fs.readFileSync(path.join(__dirname,suite));
  fs.writeFileSync(path.join(tmp,suite), fixture);
  function measure(policy) {
    fs.writeFileSync(path.join(tmp,'tool-policy.cjs'),policy);
    return runTests(tmp,[suite]);
  }
  const old = measure(baseline.policy);
  const current = measure(currentPolicy);
  const ids = new Set([...baseline.manifest.tests.filter(id => id.startsWith(suite+'::')), ...old.runs.keys(), ...current.runs.keys()]);
  const labels = {'pass/pass':'stable', 'fail/pass':'fixed', 'pass/fail':'regression', 'fail/fail':'bothFail'};
  const cases = Array.from(ids).sort().map(id => {
    const before = old.runs.get(id)?.state || 'missing';
    const after = current.runs.get(id)?.state || 'missing';
    return {id, before, after, outcome:labels[before+'/'+after] || 'inconclusive'};
  });
  const oldExitSupported = old.report.exitCode === 0 ||
    (old.report.exitCode === 1 && old.report.unexpected && Object.values(old.report.unexpected).some(row => row.state === 'fail'));
  return {ok:!!(old.report.counts && oldExitSupported && current.report.ok && cases.length &&
    cases.every(item => ['stable','fixed'].includes(item.outcome))),
    scope:suite, baseline:baseline.dir, beforeSha256:baseline.manifest.sha256,
    afterSha256:sha(currentPolicy), testSha256:sha(fixture), old:old.report, current:current.report, cases};
}

function currentStage(script, args = [], cwd = __dirname) {
  const proc = invoke([script,...args],cwd);
  return {ok:proc.exitCode === 0, exitCode:proc.exitCode, output:proc.stdout.trim(), error:proc.error || proc.stderr.trim() || undefined};
}

function main() {
  const {values} = parseArgs({options:{baseline:{type:'string'}, 'save-baseline':{type:'string'}}});
  const fixed = path.join(__dirname,'regression-baseline');
  const saved = values['save-baseline'];
  const pinned = fs.existsSync(fixed) || !saved ? readBaseline(fixed) : null;
  const previous = values.baseline ? readBaseline(values.baseline) : pinned;
  const policyFile = path.join(__dirname,'tool-policy.cjs');
  const policy = fs.readFileSync(policyFile);
  const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.cjs')).sort();
  if (!files.length) throw new Error('No plugin test files found');
  const missingSuites = fixedSuites.map(name => name+'.test.cjs').filter(name => !files.includes(name));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'lp-regression-'));
  try {
    const probeFile = path.join(tmp,'probes.json');
    const tests = runTests(__dirname,files,{...process.env, LP_PROBE_REPORT:probeFile});
    const passed = [...tests.runs].filter(([,row]) => row.state === 'pass').map(([id]) => id).sort();
    const expected = new Set([...(pinned?.manifest.tests || []), ...(previous?.manifest.tests || [])]);
    const missingTests = [...expected].filter(id => !passed.includes(id)).sort();
    const probes = fs.existsSync(probeFile) ? JSON.parse(fs.readFileSync(probeFile,'utf8')) : [];
    const baselineCases = JSON.parse(fs.readFileSync(path.join(__dirname,'security-probes.baseline.json'),'utf8'));
    const probeIDs = new Set(probes.filter(row => row.result === 'matched').map(row => row.id));
    const original = [...baselineCases.shell, ...baselineCases.tool].map(row => [row.id, row.expected, row.sha256 ?? null]);
    original.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
    const contractSha256 = sha(JSON.stringify(original));
    const probeOK = contractSha256 === originalProbeHash && probes.length === 38 && original.every(([id]) => probeIDs.has(id));
    const source = require('./resolve-root.cjs').resolveHarnessRoot(__dirname).root;
    const isInstalledPlugin = fs.existsSync(path.join(__dirname, 'plugin.json')) && fs.existsSync(path.join(__dirname, 'skills'));
    let drift;
    if (isInstalledPlugin) {
      drift = currentStage('sync-from-claude.cjs', ['--check']);
    } else {
      const staged = path.join(tmp, 'staged-plugin');
      const build = currentStage('sync-from-claude.cjs', ['--target', staged, '--copy-runtime'], __dirname);
      drift = build.ok ? currentStage('sync-from-claude.cjs', ['--check', '--target', staged], __dirname) : build;
    }
    drift.ok = drift.ok && drift.output.split(/\r?\n/).some(line => /^\[sync-from-claude\] OK: zero drift \([1-9]\d* skills verified\)$/.test(line));
    const contracts = {};
    for (const [name, marker] of [['preflight-router-contract','PREFLIGHT_ROUTER_RESULT: PASS'],
      ['evidence-status-basis-contract','evidence-status-basis-contract: all assertions passed']]) {
      const contract = currentStage(path.join('core','engine','scripts','test-hooks',name+'.cjs'),[],source);
      contract.ok = contract.ok && contract.output.split(/\r?\n/).includes(marker);
      contracts[name] = contract;
    }
    const smoke = currentStage('smoke-test.cjs');
    if (smoke.ok) {
      const observed = JSON.parse(smoke.output);
      smoke.ok = observed.ok === true && observed.results?.length === 5;
      smoke.results = observed.results;
      delete smoke.output;
    }
    const comparison = previous ? compare(previous,policy,tmp) : undefined;
    const policyUnchanged = policy.equals(fs.readFileSync(policyFile));
    const ok = tests.report.ok && !missingSuites.length && !missingTests.length && probeOK && drift.ok && smoke.ok &&
      Object.values(contracts).every(stage => stage.ok) && policyUnchanged && (!comparison || comparison.ok);
    const report = {ok, tests:tests.report, missingSuites, missingTests, probes:{ok:probeOK, matched:probeIDs.size, contractSha256},
      drift, contracts, smoke, policyUnchanged, comparison};
    if (ok && saved) {
      require('./regression-baseline.cjs').save(path.resolve(saved), policy, passed);
      report.saved = path.resolve(saved);
    }
    console.log(JSON.stringify(report,null,2));
    process.exitCode = ok ? 0 : 1;
  } finally {
    fs.rmSync(tmp,{recursive:true,force:true,maxRetries:6,retryDelay:100});
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ok:false, error:error.message}));
    process.exitCode = 1;
  }
}
