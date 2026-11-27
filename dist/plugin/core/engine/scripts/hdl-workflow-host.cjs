#!/usr/bin/env node
'use strict';

// Trusted host adapter. Profiles are approved by the caller, never taken from
// model messages, workflow args, environment discovery, or project defaults.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {submitJob, readJob, waitJob, workflowEnvironment} = require('./lib/workflow-job.cjs');
const {atomicWriteJson,withFileLockSync} = require('./lib/project-scope.cjs');
const {projectFile,expandLocalSources} = require('./lib/hdl-phase-readiness.cjs');
const {resolvePackAsset} = require('./lib/pack-config.cjs');
const {parseArgs: gateArgs,checkGolden,checkRedlines} = require('./hdl-evidence-gate.cjs');
const {buildWorkflowContext} = require('./agent-context-budget.cjs');

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const ident = s => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);
const integer = n => Number.isSafeInteger(n) && n >= 0;
function inside(root, target) {
  const relative = path.relative(root,target);
  return relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
}

function invokeScript(script, argv, cwd) {
  const p = spawnSync(process.execPath,[path.join(__dirname,script),...argv],{
    cwd, encoding:'utf8', windowsHide:true, shell:false, timeout:120000, maxBuffer:8*1024*1024,
  });
  if (p.error || p.signal || ![0,1].includes(p.status)) throw new Error(script + ': ' + (p.error?.message || p.stderr || p.signal || p.status));
  return {exit:p.status, output:p.stdout.trim()};
}

function evidenceGate(root, argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(s => typeof s !== 'string') || argv.includes('--project-root')) {
    throw new Error('Invalid evidence gate arguments');
  }
  const opts = gateArgs(argv);
  if (opts.error || (opts.modules && !opts.modules.every(ident)) ||
      (opts.vivadoSummary && !projectFile(root,opts.vivadoSummary))) throw new Error(opts.error || 'Invalid gate scope');
  const {exit,output} = invokeScript('hdl-evidence-gate.cjs',['--project-root',root,...argv],root);
  const end = /\r?\nRESULT: (PASS|FAIL)$/.exec(output);
  const parsed = end && JSON.parse(output.slice(0,end.index));
  if (parsed?.gate !== 'hdl-evidence-gate' || path.resolve(parsed.projectRoot) !== root ||
      parsed.ok !== (exit === 0) || parsed.ok !== (end[1] === 'PASS')) throw new Error('Incomplete evidence gate result');
  return {executed:true,ok:parsed.ok,failures:parsed.failures,gateJson:JSON.stringify(parsed)};
}

function timingReceipt(data, profile, runDir, {projectRoot, startedAtMs} = {}) {
  const stages = data.stages_run;
  const stage = profile.stage || 'synth';
  const requiredStages = stage === 'route' ? ['rtlcheck','synth','opt','place','route'] : ['rtlcheck','synth'];
  const area = data.synth || {}, timing = data[stage] || {};
  const failures = Array.isArray(data.blocking) ? data.blocking.slice() : ['missing blocking report'];
  if (data.tool !== 'vivado_flow' || !data.vivado_version || (profile.vivadoVersion && !String(data.vivado_version).includes(profile.vivadoVersion)) ||
      data.top !== profile.top || data.part !== profile.part ||
      !Array.isArray(stages) || !requiredStages.every(s => stages.includes(s)) || data.aborted !== false ||
      data.constrained !== true || (profile.requireIoConstraints && data.io_constrained !== true)) failures.push('missing implementation scope or constraints');
  const metrics = ['lut','ff','bram','uram','dsp','srl'];
  const resources = Object.fromEntries(metrics.map(k => [k,area[k]]));
  if (!metrics.every(k => integer(resources[k]))) failures.push('missing resource metrics');
  for (const [key,limit] of Object.entries(profile.resourceLimits || {})) {
    if (!Object.hasOwn(resources,key) || !integer(limit) || resources[key] > limit) failures.push('resource limit: '+key);
  }
  const mandatoryChecks = requiredStages.filter(s => ['rtlcheck','synth','route'].includes(s));
  const optionalChecks = requiredStages.filter(s => ['opt','place'].includes(s));
  if (!mandatoryChecks.every(s => integer(data[s]?.critical) && integer(data[s]?.error)) ||
      !optionalChecks.every(s => (data[s]?.critical === undefined || integer(data[s]?.critical)) &&
        (data[s]?.error === undefined || integer(data[s]?.error)))) {
    failures.push('incomplete stage diagnostics');
  }
  const critical = requiredStages.reduce((n,s) => n+(integer(data[s]?.critical) ? data[s].critical : 0),0);
  const errors = requiredStages.reduce((n,s) => n+(integer(data[s]?.error) ? data[s].error : 0),0);
  if (critical || errors) failures.push('critical diagnostics or errors');
  if (!Number.isFinite(timing.wns) || !Number.isFinite(timing.whs)) failures.push('missing setup or hold evidence');
  else if (timing.wns < (profile.minWns ?? 0) || timing.whs < (profile.minWhs ?? 0)) failures.push('timing threshold failed');
  if (stage === 'route') {
    let text = '';
    if (typeof data.report_dir === 'string' && data.report_dir.trim()) {
      const inRunDir = runDir && path.resolve(runDir,data.report_dir,'route_status.rpt');
      if (inRunDir && fs.existsSync(inRunDir) && inside(runDir,fs.realpathSync.native(inRunDir))) {
        text = fs.readFileSync(inRunDir,'utf8');
      } else if (projectRoot && !path.isAbsolute(data.report_dir)) {
        const inProject = path.resolve(projectRoot,data.report_dir,'route_status.rpt');
        if (fs.existsSync(inProject)) {
          const realReport = fs.realpathSync.native(inProject);
          const stat = fs.statSync(realReport);
          if (inside(projectRoot,realReport) && stat.isFile() && Number.isFinite(startedAtMs) && stat.mtimeMs >= startedAtMs - 1000) {
            text = fs.readFileSync(realReport,'utf8');
          }
        }
      }
    }
    const count = metric => Number(new RegExp('# of '+metric+'\\.*\\s*:\\s*(\\d+)\\s*:','i').exec(text)?.[1]);
    const total = count('routable nets');
    if (!(total > 0 && total === count('fully routed nets') && count('nets with routing errors') === 0)) {
      failures.push('missing or incomplete route status report for this run');
    }
  }
  const report = {top:data.top,part:data.part,ok:data.ok,stages_run:stages,rtlcheck:data.rtlcheck,
    synth:data.synth,route:data.route,blocking:data.blocking,skipped_reports:data.skipped_reports};
  for (const key of ['tool','vivado_version','aborted','constrained','io_constrained','report_dir','opt','place']) {
    if (data[key] !== undefined) report[key] = data[key];
  }
  return {tool_available:true,flow_ran:true,ok:data.ok === true && !failures.length,
    report,stage,stages_run:stages,critical,errors,wns_ns:timing.wns,whs_ns:timing.whs,resources,
    blocking_items:failures,waived_items:requiredStages.flatMap(s => Array.isArray(data[s]?.waived) ? data[s].waived : []),
    skipped_reports:data.skipped_reports || []};
}

function diagnosticExcerpt(file) {
  if (!fs.existsSync(file)) return '';
  const fd = fs.openSync(file,'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size,16384));
    const read = at => buffer.subarray(0,fs.readSync(fd,buffer,0,buffer.length,at)).toString('utf8').split(/\r?\n/);
    const first = read(0);
    const last = size > buffer.length ? read(size-buffer.length) : first;
    const error = first.concat(last).find(line => /\b(?:error|fatal|mismatch|licen[cs]e|FAILED)\b/i.test(line));
    return (error || last.filter(Boolean).at(-1) || '').slice(0,600);
  } finally { fs.closeSync(fd); }
}

function createHdlWorkflowBindings({projectRoot,stateDir,runId,signoffId = runId,profiles = {},recoverJobs = false}) {
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(stateDir) || typeof runId !== 'string' || !runId.trim()) {
    throw new Error('An absolute project, private state directory and stable run ID are required');
  }
  const root = fs.realpathSync.native(projectRoot);
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  const state = fs.realpathSync.native(stateDir);
  if (inside(root,state)) throw new Error('Job state must be outside the project');
  const receiptDir = path.join(state,'runs',hash(JSON.stringify([root,runId])));
  fs.mkdirSync(receiptDir,{recursive:true,mode:0o700});
  const observed = new Map();
  function toolVersions(profile,env = workflowEnvironment(profile.env)) {
    return (profile.tools || []).map(tool => {
      if (!path.isAbsolute(tool.executable) || !Array.isArray(tool.versionArgs) ||
          !tool.versionArgs.every(arg => typeof arg === 'string') || !tool.expectedVersion?.trim()) throw new Error('Invalid tool version probe');
      const file = fs.realpathSync.native(tool.executable);
      const key = JSON.stringify([file,fs.statSync(file).mtimeMs,tool.versionArgs,tool.expectedVersion,hash(JSON.stringify(env))]);
      if (!observed.has(key)) {
        const p = spawnSync(file,tool.versionArgs,{cwd:root,env:{...env},windowsHide:true,shell:false,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
        const line = (p.stdout+'\n'+p.stderr).split(/\r?\n/).find(s => s.includes(tool.expectedVersion));
        if (p.status !== 0 || !line) throw new Error('Tool preflight failed: '+file+' expected '+tool.expectedVersion);
        observed.set(key,{file,version:line.trim().slice(0,220)});
      }
      return observed.get(key);
    });
  }
  function describe(profile, contract) {
    if (!profile || !path.isAbsolute(profile.executable || '') || !Array.isArray(profile.args) ||
        !Array.isArray(profile.inputs) || !profile.inputs.length || !profile.version?.trim()) throw new Error('Incomplete approved tool profile');
    const executable = fs.realpathSync.native(profile.executable);
    fs.accessSync(executable,fs.constants.X_OK);
    const stat = fs.statSync(executable);
    const declared = [...new Set([...profile.inputs,...(profile.constraints || [])])];
    for (const rel of declared) {
      if (!projectFile(root,rel)) throw new Error('Missing or out-of-project input: '+rel);
    }
    const inputs = {};
    for (const rel of expandLocalSources(root,declared).sort()) {
      const file = projectFile(root,rel);
      if (!file) throw new Error('Missing or out-of-project input: '+rel);
      inputs[rel] = hash(fs.readFileSync(file));
    }
    const env = workflowEnvironment(profile.env);
    return hash(JSON.stringify({contract,profile,inputs,executable,size:stat.size,mtime:stat.mtimeMs,env,tools:toolVersions(profile,env)}));
  }
  function stamp(name) { return path.join(receiptDir,name+'.json'); }
  function publicationPath(relative) {
    const file = path.join(root,relative);
    let ancestor = path.dirname(file);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (!inside(root,fs.realpathSync.native(ancestor))) throw new Error('Evidence directory escapes project');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    if (!inside(root,fs.realpathSync.native(path.dirname(file)))) throw new Error('Invalid evidence directory');
    return file;
  }
  function checkAccepted(name, profile, relative) {
    const record = json(stamp(name));
    const file = projectFile(root,relative);
    if (!file || describe(profile,record.contract) !== record.inputDigest || hash(fs.readFileSync(file)) !== record.artifactHash) {
      throw new Error('STALE evidence: '+name);
    }
    const job = readJob(state,record.jobId);
    if (job.status !== 'succeeded' || job.exitCode !== 0 || job.action !== name || job.inputDigest !== record.inputDigest ||
        job.evidencePath !== record.evidencePath || !job.evidencePath || !fs.existsSync(job.evidencePath) ||
        hash(JSON.stringify(json(job.evidencePath))) !== record.evidenceDigest) throw new Error('STALE job evidence: '+name);
  }
  async function workflowAction(req) {
    if (fs.realpathSync.native(path.resolve(req.projectRoot)) !== root) throw new Error('Project scope differs from the authorized root');
    if (req.kind === 'evidence') {
      const args = req.argv;
      if (!Array.isArray(args)) throw new Error('Gate argv is required');
      const opts = gateArgs(args);
      if (!opts.error && !opts.rtlReady && !opts.fixedPoint && !opts.arch && !opts.checklist) {
        for (const mod of opts.modules) {
          if (!ident(mod)) throw new Error('Invalid module identifier');
          if (Object.hasOwn(profiles.simulate || {},mod)) checkAccepted('sim-'+mod,profiles.simulate[mod],'02_sim/check_results/'+mod+'.json');
        }
        if (opts.golden && profiles.golden) checkAccepted('golden',profiles.golden,'var/workflow/golden-preflight.json');
      }
      return evidenceGate(root,args);
    }
    if (req.kind === 'module-order') {
      if (!Array.isArray(req.modules) || !req.modules.length || !req.modules.every(ident)) throw new Error('Invalid module list');
      if (req.reindex && invokeScript('code-graph-index.cjs',['sync',root],root).exit !== 0) throw new Error('Code graph sync failed');
      const p = invokeScript('module-order.cjs',['--project',root,'--modules',req.modules.join(','),'--check'],root);
      const data = JSON.parse(p.output);
      if (typeof data.ok !== 'boolean' || data.ok !== (p.exit === 0)) throw new Error('Invalid topology report');
      return {executed:true,...data,raw:p.output};
    }
    if (req.kind === 'infra') {
      if (!workflowAction.supports('infra')) throw new Error('Unsupported HDL action: infra');
      const dirs = ['01_src/00_hdl','01_src/01_ip','02_sim/tv','02_sim/check_results','03_xdc','04_prj','05_bin','06_doc','07_mat','08_py'];
      for (const rel of dirs) fs.mkdirSync(path.join(root,rel),{recursive:true});
      const giPath = path.join(root,'.gitignore');
      const giRequired = ['work/','transcript','*.wlf','vsim.wlf','*.wdb','xsim.dir/','__pycache__/','*.pyc','*.vcd','*.vcd.lxt','*.ini','.Xil/'];
      const giExisting = fs.existsSync(giPath) ? fs.readFileSync(giPath,'utf8') : '';
      const giLines = new Set(giExisting.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
      const giMissing = giRequired.filter(p => !giLines.has(p));
      if (giMissing.length) {
        fs.writeFileSync(giPath, (giExisting && !giExisting.endsWith('\n') ? giExisting+'\n' : giExisting)+giMissing.join('\n')+'\n', 'utf8');
      }
      const mkPath = path.join(root,'Makefile');
      if (!fs.existsSync(mkPath)) {
        fs.writeFileSync(mkPath, [
          '.PHONY: lint compile sim clean',
          'lint:',
          '\t@echo "lint target ready"',
          'compile:',
          '\t@echo "compile target ready"',
          'sim:',
          '\t@echo "sim target ready"',
          'clean:',
          '\trm -rf work transcript *.wlf vsim.wlf *.wdb xsim.dir __pycache__ *.vcd',
          '',
        ].join('\n'), 'utf8');
      }
      const rmPath = path.join(root,'README.md');
      if (!fs.existsSync(rmPath)) fs.writeFileSync(rmPath, '# HDL Project\n', 'utf8');
      let rtlCount = 0;
      const scanRtl = dir => {
        for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
          const p = path.join(dir,entry.name);
          if (entry.isDirectory()) scanRtl(p);
          else if (/\.(?:sv|v)$/i.test(entry.name)) rtlCount++;
        }
      };
      scanRtl(path.join(root,'01_src/00_hdl'));
      const contractRel = 'var/project-init/directory-contract.json';
      const contractData = {schemaVersion:1,canonicalLayout:true,directories:dirs,rtlSourceCount:rtlCount,
        emptyProject:rtlCount === 0,modules:Array.isArray(req.modules) ? req.modules : [],generatedAt:new Date().toISOString()};
      const contractAbs = publicationPath(contractRel);
      atomicWriteJson(contractAbs,contractData,{retryBusyRename:true});
      return {executed:true,ok:true,verified:true,evidencePath:contractAbs,contractPath:contractRel,rtlSourceCount:rtlCount,summary:'canonical HDL layout verified'};
    }
    if (req.kind === 'p3-selftest') {
      if (!workflowAction.supports('p3-selftest')) throw new Error('Unsupported HDL action: p3-selftest');
      if (!Array.isArray(req.modules) || !req.modules.length || !req.modules.every(ident)) throw new Error('Invalid module list');
      const flags = ['--rtl-ready',...(req.lite ? ['--lite'] : req.withBaseline ? ['--with-baseline'] : []),
        ...(Array.isArray(req.limitFlags) ? req.limitFlags : []),'--modules',req.modules.join(',')];
      const gate = evidenceGate(root,flags);
      if (gate.ok) {
        return {executed:true,ok:true,verified:true,deferredToAgent:false,gateJson:gate.gateJson,summary:'P3 testbench and checker probes verified on disk'};
      }
      return {executed:false,ok:false,deferredToAgent:true,failures:gate.failures};
    }
    if (req.kind === 'redline') {
      if (!workflowAction.supports('redline')) throw new Error('Unsupported HDL action: redline');
      if (!Array.isArray(req.modules) || !req.modules.length || !req.modules.every(ident)) throw new Error('Invalid module list');
      const scan = checkRedlines(root,req.modules);
      const failures = scan.ok ? [] : scan.findings.filter(f => f.severity === 'error')
        .map(err => `redline(${err.rule}): ${err.file}:${err.line} — ${err.message}`);
      return {executed:true,verified:true,ok:scan.ok,failures,gateJson:JSON.stringify(scan),
        summary:scan.ok ? 'static redline scan clean' : failures.join('; ').slice(0,400)};
    }
    if (req.kind === 'single-top') {
      if (!workflowAction.supports('single-top')) throw new Error('Unsupported HDL action: single-top');
      if (!Array.isArray(req.modules) || req.modules.length !== 1 || !ident(req.modules[0])) throw new Error('single-top requires exactly one module');
      const mod = req.modules[0];
      if (Object.hasOwn(profiles.simulate || {},mod)) checkAccepted('sim-'+mod,profiles.simulate[mod],'02_sim/check_results/'+mod+'.json');
      const gate = evidenceGate(root,['--modules',mod,'--redlines']);
      const issues = gate.ok ? [] : gate.failures.map(f => ({severity:'critical',module:mod,signal:'*',description:f}));
      for (const topRel of ['01_src/00_hdl/top/top.sv','01_src/00_hdl/top/top.v']) {
        const topFile = projectFile(root,topRel);
        if (!topFile) continue;
        const src = fs.readFileSync(topFile,'utf8');
        if (!new RegExp('\\b'+mod+'\\b').test(src)) {
          issues.push({severity:'critical',module:'top',signal:'instantiation',description:`${topRel} does not instantiate ${mod}`});
        }
        const scannerPath = resolvePackAsset('fpga','engine','hdl-redline-scanner.cjs');
        if (scannerPath) {
          const scan = require(scannerPath).scanContent(src,topFile);
          for (const finding of scan.findings.filter(f => f.severity === 'error')) {
            issues.push({severity:'critical',module:'top',signal:finding.rule,description:finding.message});
          }
        }
      }
      const ok = issues.length === 0;
      return {executed:true,verified:ok,ok,overall:ok ? 'pass' : 'fail',issues,root_cause:ok ? 'none' : mod,
        fix_suggestion:ok ? 'none' : issues.map(i => i.description).join('; ').slice(0,400),
        summary:ok ? `single-module integration verified (${mod})` : `single-module integration issues (${issues.length})`};
    }
    if (req.kind === 'report') {
      if (!workflowAction.supports('report')) throw new Error('Unsupported HDL action: report');
      const mods = Array.isArray(req.modules) ? req.modules : [];
      const comps = Array.isArray(req.moduleComparisons) ? req.moduleComparisons : [];
      const synth = req.synthesis || {};
      const reviews = req.reviews || {};
      const lines = [
        '# HDL Workflow Verification Report',
        '',
        `- Mode: \`${req.mode || 'full'}\``,
        `- Modules: ${mods.map(m => `\`${m}\``).join(', ') || '(none)'}`,
        `- Hard Resource Limits: \`${JSON.stringify(req.hardLimits || {})}\``,
        '',
        '## Module Bit-True Verification (Phase 4 / 4.5)',
        ...comps.map(r => `- \`${r.module}\`: ${r.pass ? 'PASS' : 'FAIL'} (compared_points=${r.compared_points ?? 0}, max_error_lsb=${r.max_error_lsb ?? 0}) — \`02_sim/check_results/${r.module}.json\``),
        '',
        '## Regression & Coverage (Phase 6)',
        req.mode === 'lite'
          ? '- Lite mode: full coverage regression skipped.'
          : `- Regression receipt: \`${req.regressionPath || '02_sim/'}\` (${req.regressionSummary || 'verified'})`,
        '',
        '## Vivado Synthesis & Timing (Phase 6b)',
        synth.toolAvailable === true && synth.report
          ? `- Vivado (\`${synth.report.top}\` @ \`${synth.report.part}\`, stages: \`${(synth.report.stages_run || []).join('->')}\`): ok=${synth.report.ok}, synth WNS=${synth.report.synth?.wns ?? 'N/A'}ns, WHS=${synth.report.synth?.whs ?? 'N/A'}ns, resources=\`${JSON.stringify(synth.report.synth || {})}\` — \`${synth.evidencePath}\``
          : `- 无 EDA 环境, 综合级结论未验证 (${synth.reason || 'vivado skipped'})`,
        '',
        '## Independent Code Reviews (Phase 7)',
        ...Object.entries(reviews).map(([k,v]) => `- **${k}**: pass=${v?.pass} — ${v?.summary || ''} (${(v?.evidence || []).join(', ')})`),
        '',
      ];
      const reportRel = '06_doc/workflow-verification.md';
      const absReport = publicationPath(reportRel);
      fs.mkdirSync(path.dirname(absReport),{recursive:true});
      const content = lines.join('\n');
      fs.writeFileSync(absReport,content,'utf8');
      return {executed:true,ok:true,verified:true,evidencePath:absReport,reportPath:reportRel,summary:content.slice(0,500)};
    }
    const sim = req.kind === 'simulate';
    if (sim && !ident(req.module)) throw new Error('Invalid simulation module');
    if (!workflowAction.supports(req.kind)) throw new Error('Unsupported HDL action: '+req.kind);
    const profile = sim ? profiles.simulate[req.module] : profiles[req.kind];
    const name = sim ? 'sim-'+req.module : req.kind;
    if ((sim || req.kind === 'vivado') && !ident(profile?.top)) throw new Error('Approved top is required: '+name);
    if (sim && profile.minComparedPoints !== undefined && (!Number.isSafeInteger(profile.minComparedPoints) || profile.minComparedPoints < 1)) {
      throw new Error('minComparedPoints must be a positive integer');
    }
    if (req.kind === 'vivado' && (!profile.part || (req.part && profile.part !== req.part) ||
        !Array.isArray(profile.constraints) || !profile.constraints.length || !['synth','route'].includes(profile.stage || 'synth'))) {
      throw new Error('Invalid part, stage or timing constraints');
    }
    const regression = req.kind === 'regression';
    if (regression && (!Array.isArray(req.modules) || !req.modules.length || !req.modules.every(ident) ||
        !Array.isArray(profile.cases) || !profile.cases.length || !profile.cases.every(s => typeof s === 'string' && s.trim()))) {
      throw new Error('Full regression requires explicit modules and mandatory cases');
    }
    const contract = sim ? {module:req.module,top:profile.top} : req.kind === 'golden' ? req.baseline :
      regression ? {modules:req.modules,cases:profile.cases,signoffId} : {top:profile.top,part:profile.part};
    const inputDigest = describe(profile,contract);
    const attempt = req.attempt ?? 1;
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid attempt');
    const maxEnvRetries = profile.environmentRetries ?? 1;
    if (!integer(maxEnvRetries) || maxEnvRetries > 2) throw new Error('environmentRetries must be 0, 1 or 2');
    let evidencePath, job, completed, envRetry = 0;
    for (;;) {
      job = submitJob({stateDir:state,cwd:root,action:name,executable:profile.executable,args:profile.args,
        inputDigest,attempt,timeoutMs:profile.timeoutMs ?? 3600000,env:profile.env,
        evidenceScope:hash(JSON.stringify([runId,envRetry])),recoverDead:recoverJobs === true});
      completed = await waitJob(state,job.jobId);
      evidencePath = completed.evidencePath;
      if (!evidencePath) break;
      if (completed.status !== 'failed' || envRetry >= maxEnvRetries || fs.existsSync(evidencePath) ||
          !/\bEBUSY\b|licen[cs]e.{0,50}(?:busy|all.{0,10}in use|temporarily unavailable)/i.test(diagnosticExcerpt(completed.logPath))) break;
      envRetry++;
      await new Promise(resolve => setTimeout(resolve,1000*envRetry));
      if (describe(profile,contract) !== inputDigest) throw new Error('Inputs changed before environment retry');
    }
    const ref = {jobId:job.jobId,inputSha256:inputDigest,evidencePath,logPath:completed.logPath,exitCode:completed.exitCode,
      disposition:!job.reused ? 'executed' : ['queued','running'].includes(job.status) ? 'reattached' : 'reused',
      profileVersion:profile.version,toolVersions:toolVersions(profile),attempt,environmentRetries:envRetry};
    function fail(kind, reason) {
      return {...ref,executed:true,ok:false,reason,gate_executed:false,gate_ok:false,compared_points:0,
        log_tail:reason,failureKind:kind,failureSignature:hash(reason),tool_available:true,flow_ran:false,blocking_items:[reason]};
    }
    if (describe(profile,contract) !== inputDigest) return fail('insufficient','Inputs changed during validation');
    let data;
    try { data = json(evidencePath); } catch {}
    if (completed.status !== 'succeeded' || completed.exitCode !== 0) {
      if (sim && data?.module === req.module && data.status === 'FAIL' && integer(data.mismatches) && data.mismatches > 0 &&
          Number.isSafeInteger(data.compared_points) && data.compared_points > 0) {
        return fail('functional','comparison failed: '+String(data.first_fail_at ?? req.module).slice(0,300));
      }
      const reason = diagnosticExcerpt(completed.logPath) || completed.error || 'tool exit '+completed.exitCode;
      const kind = completed.status === 'failed' && ['functional','invalid','environment'].includes(data?.failureKind) ? data.failureKind : 'environment';
      return fail(kind,completed.status+': '+reason);
    }
    if (!data || typeof data !== 'object') return fail('insufficient','Missing fresh structured tool evidence');
    if (req.kind === 'vivado') {
      const startedAtMs = Date.parse(completed.startedAt || completed.submittedAt);
      return {...ref,...timingReceipt(data,profile,path.dirname(evidencePath),{projectRoot:root,startedAtMs})};
    }
    if (regression) {
      const complete = data.status === 'PASS' && integer(data.compared_points) && data.compared_points > 0 &&
        data.mismatches === 0 && Array.isArray(data.modules) && req.modules.every(mod => data.modules.includes(mod)) &&
        profile.cases.every(id => data.cases?.[id]?.status === 'PASS' && integer(data.cases[id].compared_points) && data.cases[id].compared_points > 0);
      if (!complete) return fail('insufficient','Missing passing module or mandatory case evidence');
      return {...ref,ok:true,executed:true,verified:true,coverageComplete:true,compared_points:data.compared_points};
    }
    const relative = sim ? '02_sim/check_results/'+req.module+'.json' : 'var/workflow/golden-preflight.json';
    if (sim && (data.module !== req.module || data.status !== 'PASS' || !Number.isSafeInteger(data.compared_points) ||
        data.compared_points < (profile.minComparedPoints ?? 1) || data.mismatches !== 0)) {
      return fail(data.status === 'FAIL' && data.mismatches > 0 ? 'functional' : 'insufficient','Invalid module comparison: '+String(data.first_fail_at ?? req.module));
    }
    if (!sim && (!req.baseline || data.entry !== req.baseline.entry)) return fail('insufficient','Golden original entry mismatch');
    if (!sim) {
      const checked = checkGolden(root,data);
      if (checked.failures.length) return fail('insufficient',checked.failures.join('; ').slice(0,600));
    }
    const file = publicationPath(relative);
    return withFileLockSync(file,() => {
      if (describe(profile,contract) !== inputDigest) return fail('insufficient','Inputs changed before delivery');
      const prior = fs.existsSync(stamp(name)) && json(stamp(name));
      const evidenceDigest = hash(JSON.stringify(data));
      if (prior.jobId === ref.jobId) {
        if (prior.evidenceDigest !== evidenceDigest || !fs.existsSync(file) || hash(fs.readFileSync(file)) !== prior.artifactHash) {
          return fail('insufficient','Evidence changed after delivery');
        }
      } else {
        atomicWriteJson(file,data,{retryBusyRename:true});
        const gate = evidenceGate(root,sim ? ['--modules',req.module] : ['--golden']);
        if (!gate.ok) return fail('insufficient',gate.failures.join('; ').slice(0,600));
        const artifactHash = hash(fs.readFileSync(file));
        atomicWriteJson(stamp(name),{contract,inputDigest,artifactHash,evidenceDigest,...ref},{retryBusyRename:true});
      }
      return {...ref,executed:true,ok:true,gate_executed:true,gate_ok:true,compared_points:data.compared_points,
        log_tail:'',summary:name+' verified',verified:true};
    },{timeoutMs:30000});
  }
  const det = profiles.deterministic === true;
  const detKinds = {
    infra:'infra',
    'p3-selftest':'p3Selftest',
    redline:'redline',
    'single-top':'singleTop',
    report:'report',
  };
  workflowAction.supports = kind => kind === 'evidence' || kind === 'module-order' ||
    (['simulate','golden','vivado','regression'].includes(kind) && !!profiles[kind]) ||
    (Object.hasOwn(detKinds,kind) && !!(det || profiles[kind] || profiles[detKinds[kind]]));
  return {workflowAction,workflowContext:buildWorkflowContext};
}

module.exports = {createHdlWorkflowBindings,timingReceipt};
