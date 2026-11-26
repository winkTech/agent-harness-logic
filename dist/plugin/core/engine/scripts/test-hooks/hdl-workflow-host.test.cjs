'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHdlWorkflowBindings,timingReceipt} = require('../hdl-workflow-host.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hdl-actions-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const projectRoot = fs.mkdirSync(path.join(dir,'project'),{recursive:true});
  const stateDir = path.join(dir,'state');
  const file = (name,value) => fs.writeFileSync(path.join(projectRoot,name),value);
  file('approved.cjs',[
    "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync('case.json','utf8'));",
    "fs.appendFileSync('calls','1');",
    "if(data.skipLocale === process.env.LC_ALL && data.skipLocale)process.exit(0);",
    "if(data.busy && fs.statSync('calls').size===1){console.error('license temporarily unavailable');process.exit(1)}",
    "if(data.report)fs.writeFileSync(process.env.HARNESS_WORKFLOW_EVIDENCE,JSON.stringify(data.report));",
    "process.exitCode=data.exit || 0;",
  ].join('\n'));
  const profile = {top:'fixture',version:process.version,inputs:['approved.cjs','case.json'],executable:process.execPath,
    args:['approved.cjs'],tools:[{executable:process.execPath,versionArgs:['--version'],expectedVersion:process.version}]};
  const config = {projectRoot,stateDir,runId:'signed-run',profiles:{simulate:{fixture:profile}}};
  const action = req => createHdlWorkflowBindings(config).workflowAction({projectRoot,module:'fixture',kind:'simulate',...req});
  return {file,config,action,root:projectRoot};
}
const pass = {module:'fixture',status:'PASS',compared_points:16,mismatches:0};

test('changed effective environment cannot reuse private output, and phase acceptance requires the physical job',async t => {
  const f = fixture(t);
  const saved = process.env.LC_ALL;
  t.after(() => { if (saved === undefined) delete process.env.LC_ALL; else process.env.LC_ALL=saved; });
  f.file('case.json',JSON.stringify({report:pass,skipLocale:'skip-evidence'}));
  process.env.LC_ALL='publish-evidence';
  const a = await f.action();
  assert.equal(a.verified,true);
  const gate = () => f.action({kind:'evidence',argv:['--modules','fixture']});
  process.env.LC_ALL='skip-evidence';
  const b = await f.action();
  assert.equal(b.failureKind,'insufficient'); assert.equal(b.exitCode,0);
  assert.notEqual(a.jobId,b.jobId); assert.notEqual(a.evidencePath,b.evidencePath);
  await assert.rejects(gate,/STALE/);
  process.env.LC_ALL='publish-evidence';
  assert.equal((await gate()).ok,true);
  const publicFile=path.join(f.root,'02_sim/check_results/fixture.json');
  const original=fs.readFileSync(publicFile);
  fs.appendFileSync(publicFile,' ');
  await assert.rejects(gate,/STALE/);
  fs.writeFileSync(publicFile,original);
  fs.writeFileSync(a.evidencePath,'{}');
  await assert.rejects(gate,/STALE/);
  fs.writeFileSync(a.evidencePath,JSON.stringify(pass));
  const receipt=path.join(f.config.stateDir,a.jobId,'receipt.json');
  const physical=JSON.parse(fs.readFileSync(receipt));
  fs.writeFileSync(receipt,JSON.stringify({...physical,status:'failed',exitCode:1}));
  await assert.rejects(gate,/STALE/);
});

test('duplicate publication leaves files intact and an invalid Golden candidate preserves the last accepted receipt',async t => {
  const f = fixture(t);
  const profile = f.config.profiles.simulate.fixture;
  f.config.profiles.golden=profile;
  const entry='approved.cjs', log='baseline.log', scope={entry,cases:['normal']};
  fs.mkdirSync(path.join(f.root,'var/workflow'),{recursive:true});
  f.file('var/workflow/golden-scope.json',JSON.stringify(scope)); f.file(log,'measured');
  const entrySha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(f.root,entry))).digest('hex');
  const report={entry,entryLog:log,exitCode:0,entrySha256,cases:[{name:'normal',oracleInputs:[],source:'normal',
    compared:16,criterion:'exact',passed:true,log}]};
  f.file('case.json',JSON.stringify({report}));
  const publish=() => f.action({kind:'golden',baseline:scope});
  const [a,b]=await Promise.all([publish(),publish()]);
  assert.ok(a.verified && b.verified); assert.equal(a.jobId,b.jobId);
  const runs=path.join(f.config.stateDir,'runs');
  const files=[path.join(f.root,'var/workflow/golden-preflight.json'),path.join(runs,fs.readdirSync(runs)[0],'golden.json')];
  const snapshot = files.map(file => {
    fs.utimesSync(file,1000000000,1000000000);
    return {bytes:fs.readFileSync(file),mtime:fs.statSync(file).mtimeMs};
  });
  assert.equal((await publish()).verified,true);
  f.file('case.json',JSON.stringify({report:{...report,cases:[]}}));
  assert.equal((await publish()).failureKind,'insufficient');
  files.forEach((file,i) => {
    assert.deepEqual(fs.readFileSync(file),snapshot[i].bytes);
    assert.equal(fs.statSync(file).mtimeMs,snapshot[i].mtime);
  });
});

test('concurrent hosts publish one project artifact and one acceptance receipt',async t => {
  const f=fixture(t);
  f.file('case.json',JSON.stringify({report:pass}));
  const loader=require.resolve('../hdl-workflow-host.cjs');
  const launch=require('node:util').promisify(require('node:child_process').execFile);
  const script=`
    const fs=require('node:fs'), path=require('node:path');
    const original=fs.renameSync;
    fs.renameSync=(from,to) => {
      original(from,to);
      if (['fixture.json','sim-fixture.json'].includes(path.basename(to))) console.log(path.basename(to));
    };
    const config=JSON.parse(process.argv[2]);
    require(process.argv[1]).createHdlWorkflowBindings(config).workflowAction({
      kind:'simulate',projectRoot:config.projectRoot,module:'fixture'
    }).then(result=>{ if (!result.verified) process.exitCode=1; });
  `;
  const runs=await Promise.all(Array.from({length:4},() => launch(process.execPath,['-e',script,loader,JSON.stringify(f.config)])));
  const writes=runs.flatMap(r => r.stdout.trim().split(/\s+/)).filter(Boolean).sort();
  assert.deepEqual(writes,['fixture.json','sim-fixture.json']);
  assert.equal(fs.readFileSync(path.join(f.root,'calls'),'utf8'),'1');
});

test('approved simulator deduplicates, checks inputs and rejects stale phase evidence',async t => {
  const f = fixture(t);
  f.file('case.json',JSON.stringify({report:pass}));
  const [a,b] = await Promise.all([f.action(),f.action()]);
  assert.ok(a.verified && b.verified); assert.equal(a.jobId,b.jobId);
  assert.equal(fs.readFileSync(path.join(f.root,'calls'),'utf8'),'1');
  assert.equal(a.toolVersions[0].version,process.version);
  const gate = () => f.action({kind:'evidence',argv:['--modules','fixture']});
  assert.equal((await gate()).ok,true);
  f.file('case.json',JSON.stringify({report:{...pass,compared_points:0}}));
  await assert.rejects(gate,/STALE/);
  const empty = await f.action();
  assert.equal(empty.failureKind,'insufficient');
  assert.notEqual(empty.jobId,a.jobId);
  f.file('case.json','{}');
  assert.equal((await f.action()).failureKind,'insufficient');
  f.file('case.json',JSON.stringify({report:{...pass,status:'FAIL',mismatches:20,first_fail_at:'cycle 8'},exit:1}));
  const failed = await f.action();
  assert.equal(failed.failureKind,'functional'); assert.match(failed.log_tail,/cycle 8/);
});

test('environment retry is bounded and separate from a design attempt',async t => {
  const f = fixture(t);
  f.file('case.json',JSON.stringify({busy:true,report:pass}));
  const r = await f.action();
  assert.equal(r.ok,true); assert.equal(r.attempt,1); assert.equal(r.environmentRetries,1);
  assert.equal(fs.readFileSync(path.join(f.root,'calls'),'utf8'),'11');
  const again = await f.action();
  assert.equal(again.jobId,r.jobId); assert.equal(again.disposition,'reused');
});

test('synthesis evidence requires both timing checks and the requested verification scope',async t => {
  const f = fixture(t), p = f.config.profiles.simulate.fixture;
  f.file('clocks.xdc','fixture clock');
  f.config.profiles.vivado = {...p,part:'test-part',constraints:['clocks.xdc'],stage:'synth'};
  const report = {tool:'vivado_flow',top:'fixture',part:'test-part',vivado_version:'fixture version',constrained:true,
    aborted:false,ok:true,stages_run:['rtlcheck','synth'],blocking:[],rtlcheck:{critical:0,error:0},
    synth:{critical:0,error:0,wns:0.2,whs:0.05,lut:1,ff:1,bram:0,uram:0,dsp:0,srl:0}};
  const check = async data => { f.file('case.json',JSON.stringify({report:data})); return f.action({kind:'vivado',part:'test-part'}); };
  assert.equal((await check(report)).ok,true);
  assert.equal((await check({...report,synth:{...report.synth,whs:null}})).ok,false);
  assert.equal((await check({...report,constrained:false})).ok,false);
  f.config.profiles.vivado.stage='route';
  assert.equal((await check(report)).ok,false);
});

test('full regression checks each mandatory case and a separate signoff never reuses old acceptance',async t => {
  const f = fixture(t);
  f.config.profiles.regression = {...f.config.profiles.simulate.fixture,cases:['basic','backpressure']};
  const req = {kind:'regression',modules:['fixture']};
  const report = {...pass,modules:['fixture'],cases:{basic:{status:'PASS',compared_points:8}}};
  f.file('case.json',JSON.stringify({report}));
  assert.equal((await f.action(req)).ok,false);
  report.cases.backpressure={status:'PASS',compared_points:8};
  f.file('case.json',JSON.stringify({report}));
  const a = await f.action(req); assert.equal(a.coverageComplete,true);
  f.config.signoffId='next-acceptance';
  assert.notEqual((await f.action(req)).jobId,a.jobId);
});

test('transitive SystemVerilog includes and local Python imports invalidate simulation and evidence stamps',async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root,'rtl'),{recursive:true});
  fs.mkdirSync(path.join(f.root,'02_sim'),{recursive:true});
  f.file('rtl/defs.svh','`define WIDTH 8\n');
  f.file('rtl/fixture.sv','`include "defs.svh"\nmodule fixture; endmodule\n');
  f.file('02_sim/helper_mod.py','SCALE = 1\n');
  f.file('02_sim/check_fixture.py','from helper_mod import SCALE\n');
  f.config.profiles.simulate.fixture.inputs = ['approved.cjs','case.json','rtl/fixture.sv','02_sim/check_fixture.py'];
  f.file('case.json',JSON.stringify({report:pass}));

  const first = await f.action();
  assert.equal(first.verified,true);
  const gate = () => f.action({kind:'evidence',argv:['--modules','fixture']});
  assert.equal((await gate()).ok,true);

  f.file('rtl/defs.svh','`define WIDTH 16\n');
  await assert.rejects(gate,/STALE/);
  const second = await f.action();
  assert.equal(second.verified,true);
  assert.notEqual(second.jobId,first.jobId);

  f.file('02_sim/helper_mod.py','SCALE = 2\n');
  await assert.rejects(gate,/STALE/);
  const third = await f.action();
  assert.equal(third.verified,true);
  assert.notEqual(third.jobId,second.jobId);
});

test('route stage accepts fresh project route_status.rpt, rejects stale reports and opt/place errors, and preserves p6b parity',async t => {
  const f = fixture(t), p = f.config.profiles.simulate.fixture;
  f.file('clocks.xdc','create_clock -period 5.0 [get_ports clk]\n');
  f.file('vivado-stub.cjs',[
    "const fs=require('node:fs'), path=require('node:path');",
    "const cfg=JSON.parse(fs.readFileSync('case.json','utf8'));",
    "if (cfg.writeFreshRoute) {",
    "  fs.mkdirSync('04_prj/rpt',{recursive:true});",
    "  fs.writeFileSync('04_prj/rpt/route_status.rpt',cfg.routeText);",
    "}",
    "fs.writeFileSync(process.env.HARNESS_WORKFLOW_EVIDENCE,JSON.stringify(cfg.report));",
  ].join('\n'));
  f.config.profiles.vivado = {...p,executable:process.execPath,args:['vivado-stub.cjs'],
    inputs:['vivado-stub.cjs','case.json'],part:'xc7a35t',constraints:['clocks.xdc'],stage:'route'};

  const routeText = [
    'Design Route Status',
    '  # of routable nets.............. : 42 :',
    '  # of fully routed nets.......... : 42 :',
    '  # of nets with routing errors... : 0 :',
  ].join('\n');
  const baseReport = {
    tool:'vivado_flow',top:'fixture',part:'xc7a35t',vivado_version:'2023.1.1',constrained:true,
    aborted:false,ok:true,report_dir:'04_prj/rpt',stages_run:['rtlcheck','synth','opt','place','route'],blocking:[],
    rtlcheck:{critical:0,error:0},
    synth:{critical:0,error:0,wns:0.4,whs:0.1,lut:10,ff:12,bram:0,uram:0,dsp:1,srl:0},
    opt:{wns:0.35,whs:0.09},
    place:{wns:0.25,whs:0.07},
    route:{critical:0,error:0,wns:0.18,whs:0.05},
  };

  // Stale pre-existing 04_prj/rpt/route_status.rpt from a prior run must be rejected
  fs.mkdirSync(path.join(f.root,'04_prj/rpt'),{recursive:true});
  const rptFile = path.join(f.root,'04_prj/rpt/route_status.rpt');
  fs.writeFileSync(rptFile,routeText);
  const oldSec = (Date.now() - 20000) / 1000;
  fs.utimesSync(rptFile,oldSec,oldSec);
  f.file('case.json',JSON.stringify({writeFreshRoute:false,report:baseReport}));
  const staleRes = await f.action({kind:'vivado',part:'xc7a35t'});
  assert.equal(staleRes.ok,false);
  assert.match(staleRes.blocking_items.join('; '),/route status report/);

  // Freshly written 04_prj/rpt/route_status.rpt during this job must pass
  f.file('case.json',JSON.stringify({writeFreshRoute:true,routeText,report:baseReport}));
  const freshRes = await f.action({kind:'vivado',part:'xc7a35t'});
  assert.equal(freshRes.ok,true,freshRes.blocking_items.join('; '));

  // Parity: feeding freshRes.report back into timingReceipt for synth or fresh route preserves acceptance
  const synthParity = timingReceipt(freshRes.report,{...f.config.profiles.vivado,stage:'synth'},f.root);
  assert.equal(synthParity.ok,true,synthParity.blocking_items.join('; '));

  // opt or place stage error/critical must block signoff
  f.file('case.json',JSON.stringify({writeFreshRoute:true,routeText,report:{...baseReport,place:{...baseReport.place,error:2}}}));
  const placeErr = await f.action({kind:'vivado',part:'xc7a35t'});
  assert.equal(placeErr.ok,false);
  assert.equal(placeErr.errors,2);
});
