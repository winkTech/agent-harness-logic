'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {runHdlWorkflow,createDispatchHistory} = require('../run-hdl-workflow.cjs');
const {buildWorkflowContext} = require('../agent-context-budget.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'hdl-runner-contract-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:60}));
  const projectRoot = path.join(dir,'project');
  fs.mkdirSync(projectRoot);
  return {args:{modules:[]}, projectRoot, stateDir:path.join(dir,'private'), runId:'test-run', agent:() => assert.fail('unexpected model dispatch')};
}

test('the package workflow stops at the real checkpoint without a model call and cannot select another script', async t => {
  const request = fixture(t);
  const before = await runHdlWorkflow(request);
  assert.equal(before.status, 'checkpoint', before.error);
  assert.equal(before.checkpoint, 'preflight');
  assert.equal(before.agentDispatches, 0);
  assert.equal(before.modelResponses, 0);
  assert.equal(fs.readFileSync(before.usagePath,'utf8'), '');
  await assert.rejects(runHdlWorkflow({...request,args:{workflowFile:'project-file.js'}}), /executable bindings/);
  await assert.rejects(runHdlWorkflow({...request,args:{projectRoot:request.stateDir}}), /selected absolute project/);
});

test('agent callback returns workflow-native data; actual responses and absent usage remain distinguishable', async t => {
  const request = fixture(t);
  request.args = {confirmed:true, modules:[]};
  const usage = {uncachedInputTokens:4,cachedInputTokens:8,outputTokens:3};
  const seen = [];
  const report = await runHdlWorkflow({...request, agent:async(prompt, options, receipt) => {
    const body = JSON.parse(prompt);
    seen.push(options.label);
    assert.ok(body.required.instructions);
    receipt.recordResponse({executor:'worker',callId:'1',usage,evidenceReads:2});
    receipt.recordResponse({executor:'worker',callId:'1',usage,evidenceReads:2});
    receipt.recordResponse({executor:'host',callId:'2',usage,evidenceReads:0});
    return 'fixture directory listing';
  }});
  assert.equal(report.status, 'checkpoint', report.error);
  assert.equal(report.checkpoint, 'layout-review');
  assert.deepEqual(seen, ['p0-infra']);
  assert.equal(report.agentDispatches, 1);
  assert.equal(report.modelResponses, 2);
  assert.equal(report.usage[0].evidenceReadsTotal,2);
  assert.deepEqual(report.usage[0].measuredTotal, {uncachedInputTokens:8,cachedInputTokens:16,outputTokens:6});
  const unknown = await runHdlWorkflow({...request,agent:() => 'fixture directory listing'});
  assert.equal(unknown.status,'checkpoint',unknown.error);
  assert.equal(unknown.modelResponses,null);
  assert.equal(unknown.unreportedDispatches,1);
  assert.equal(unknown.usage[0].measuredTotal,null);
  assert.equal(unknown.usage[0].evidenceReadsTotal,null);
  assert.ok(unknown.usage[0].estimatedPromptSubtotal > 0);
});

test('a dispatch over its soft budget journals the required-field expansion before calling the model', async t => {
  const f = fixture(t);
  // A legitimate long module identifier forces P0's mandatory instructions over its soft budget.
  const mod = 'module_'+'x'.repeat(4000);
  let sent = '';
  const report = await runHdlWorkflow({...f,args:{confirmed:true,modules:[mod]},agent:prompt => { sent=prompt; return 'P0'; }});
  assert.ok(sent.includes(mod));
  const event = fs.readFileSync(report.eventPath,'utf8').trim().split('\n').map(JSON.parse).find(e => e.type==='agent-dispatch' && e.label==='p0-infra');
  const policy = event.contextBudget;
  assert.equal(policy.budgetTokens,1000);
  assert.equal(policy.overBudget,true);
  assert.equal(policy.estimateMethod,'ceil(utf8Bytes/3)');
  assert.equal(policy.estimatedInputTokens,Math.ceil(Buffer.byteLength(sent)/3));
  assert.equal(policy.expansion.effectiveBudgetTokens,policy.estimatedInputTokens);
  assert.equal(policy.expansion.additionalEstimatedTokens,policy.estimatedInputTokens-policy.budgetTokens);
  assert.ok(policy.expansion.requiredFields.includes('instructions'));
});

test('CLI requires an explicit absolute host module and reports pause separately from success', t => {
  const f = fixture(t);
  const dir = path.dirname(f.projectRoot);
  const argsFile = path.join(dir,'args.json'), adapter = path.join(dir,'accepted.cjs');
  fs.writeFileSync(argsFile,'{}');
  fs.writeFileSync(adapter,"exports.agent = () => { throw Error('should stay behind preflight'); };");
  const argv = [require.resolve('../run-hdl-workflow.cjs'),'--project',f.projectRoot,'--args',argsFile,'--state-dir',f.stateDir,'--run-id',f.runId,'--host'];
  const invoke = name => spawnSync(process.execPath,[...argv,name],{cwd:dir, encoding:'utf8', windowsHide:true});
  assert.equal(invoke('./accepted.cjs').status,1);
  const response = invoke(adapter);
  assert.equal(response.status,2,response.stderr);
  assert.equal(JSON.parse(response.stdout).checkpoint,'preflight');
});

test('checkpoint resumption only reuses approved input-bound, independently verified artifacts', async t => {
  const f = fixture(t), input = path.join(f.projectRoot,'spec'), output = path.join(f.projectRoot,'layout');
  f.args.confirmed = true;
  fs.writeFileSync(input, 'v1');
  let calls = 0, accepted = true;
  f.agent = () => { calls++; fs.writeFileSync(output, 'verified layout'); return 'P0'; };
  f.agentReceipts = {'p0-infra':{version:'v1', inputs:['spec'],outputs:['layout'],
    verify:({result}) => accepted && result === 'P0' && fs.readFileSync(output,'utf8') === 'verified layout'}};
  assert.equal((await runHdlWorkflow(f)).status, 'checkpoint');
  const replay = await runHdlWorkflow({...f,args:{...f.args,resumeFromRunId:f.runId}});
  assert.equal(replay.agentDispatches, 0);
  assert.equal(replay.reusedModelSteps, 1);
  assert.equal(calls, 1);
  fs.writeFileSync(output,'stale layout');
  assert.equal((await runHdlWorkflow(f)).agentDispatches, 1);
  fs.writeFileSync(input,'v2');
  assert.equal((await runHdlWorkflow(f)).agentDispatches, 1);
  assert.equal((await runHdlWorkflow({...f,signoffId:'fresh-signoff'})).agentDispatches, 1);
  assert.equal((await runHdlWorkflow({...f,args:{...f.args,part:'another-part'}})).agentDispatches, 1);
  accepted = false;
  const rejected = await runHdlWorkflow(f);
  assert.equal(rejected.status,'failed');
  assert.match(rejected.error,/artifact verification failed/);
});

test('a real local verification exits zero without its artifact and blocks before any model dispatch', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'tool.cjs'), "require('node:fs').writeFileSync('called','once');");
  fs.writeFileSync(path.join(f.projectRoot,'golden.m'), 'x=1;');
  const profile = {executable:process.execPath, args:['tool.cjs'], version:process.version, inputs:['tool.cjs','golden.m'],
    tools:[{executable:process.execPath,versionArgs:['--version'],expectedVersion:process.version}]};
  const result = await runHdlWorkflow({...f, profiles:{golden:profile}, args:{goldenBaseline:{entry:'golden.m',cases:['check']}}});
  assert.equal(result.status, 'failed');
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'called'),'utf8'), 'once');
  assert.equal(result.modelResponses, 0);
  assert.equal(result.agentDispatches, 0);
  assert.equal(result.actions, 1);
  const action = fs.readFileSync(result.eventPath,'utf8').trim().split('\n').map(JSON.parse).find(row => row.type === 'action-end');
  assert.equal(action.disposition,'executed');
  assert.equal(action.evidencePath,null);
  assert.equal(action.verified,false);
});

test('job journal distinguishes fresh execution, attachment and replay with the real artifact path', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'tool.cjs'),
    "setTimeout(() => require('node:fs').writeFileSync(process.env.HARNESS_WORKFLOW_EVIDENCE,'{}'),250)");
  fs.writeFileSync(path.join(f.projectRoot,'golden.m'),'x=1;');
  f.args = {goldenBaseline:{entry:'golden.m',cases:['base']}};
  f.profiles = {golden:{executable:process.execPath,args:['tool.cjs'],inputs:['tool.cjs','golden.m'],version:'fixture-v1',
    tools:[{executable:process.execPath,versionArgs:['--version'],expectedVersion:process.version}]}};
  const reports = await Promise.all([runHdlWorkflow(f),runHdlWorkflow(f)]);
  reports.push(await runHdlWorkflow(f));
  const actions = reports.map(r => fs.readFileSync(r.eventPath,'utf8').trim().split('\n').map(JSON.parse).find(e => e.type === 'action-end'));
  assert.deepEqual(actions.map(e => e.disposition).sort(),['executed','reattached','reused']);
  assert.equal(new Set(actions.map(e => e.jobId)).size,1);
  assert.equal(new Set(actions.map(e => e.evidencePath)).size,1);
  assert.equal(fs.readFileSync(actions[0].evidencePath,'utf8'),'{}');
  assert.ok(actions.every(e => e.ok === false && e.verified === false));
});

test('only delivered evidence to one confirmed recipient and history epoch can be elided', t => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir);
  const identity = {projectRoot:f.projectRoot, runId:f.runId, signoffId:'s1', workflowDigest:'revision'};
  const opts = {agentType:'logic-engineer', affinityKey:'rtl:fifo', label:'repair-1'};
  const route = {threadId:'host-thread-1',epoch:'session-epoch-1',historyAvailable:true};
  const packet = {kind:'repair',required:{goal:'preserve FIFO order'},evidence:[{id:'sim',ref:'trace.json',summary:'first mismatch 7'}]};
  const routeAndPack = (fields = {}, routeResult = route, execution = identity) => {
    const options = {...opts,...fields};
    const carrier = createDispatchHistory(buildWorkflowContext,() => routeResult,execution,f.stateDir);
    return carrier.forDispatch(carrier.prepare(packet,options).prompt,options);
  };
  const evidence = delivery => JSON.parse(delivery.prompt).evidence[0];
  const firstAttempt = routeAndPack();
  assert.equal(evidence(firstAttempt).summary,'first mismatch 7');
  // A failed callback has no delivery receipt.
  const next = routeAndPack();
  assert.equal(evidence(next).summary,'first mismatch 7');
  next.delivered();
  const repair = routeAndPack({label:'repair-2'});
  assert.deepEqual(evidence(repair),{id:'sim',ref:'trace.json'});
  assert.deepEqual(JSON.parse(repair.prompt).required,packet.required);
  assert.deepEqual(repair.history,route);
  for (const other of [
    routeAndPack({agentType:'reviewer'}),routeAndPack({affinityKey:'rtl:uart'}),routeAndPack({},null),
    routeAndPack({},{...route,historyAvailable:false}),routeAndPack({},{...route,epoch:'after-compaction'}),
    routeAndPack({},{...route,threadId:'worker-2'}),routeAndPack({},route,{...identity,runId:'another-user-run'}),
    routeAndPack({},route,{...identity,signoffId:'new-contract'}),routeAndPack({},route,{...identity,projectRoot:'another-project'})
  ]) assert.equal(evidence(other).summary,'first mismatch 7');
});

test('real dispatch records delivery only after the selected host thread accepts the callback', async t => {
  const f = fixture(t);
  f.args.confirmed = true;
  const route = {threadId:'layout',epoch:'fresh',historyAvailable:true};
  f.contextHistory = (options, identity) => {
    assert.equal(options.label,'p0-infra');
    assert.equal(identity.projectRoot,fs.realpathSync.native(f.projectRoot));
    assert.equal(identity.signoffId,f.runId);
    return route;
  };
  f.agent = (prompt,options,receipt) => {
    assert.deepEqual(receipt.history,route);
    throw new Error('delivery failed');
  };
  const failed = await runHdlWorkflow(f);
  assert.equal(failed.status,'failed');
  assert.match(failed.error,/delivery failed/);
  const receipts = () => fs.readdirSync(f.stateDir).filter(n => n.startsWith('hdl-history-'));
  assert.equal(receipts().length,0);
  f.agent = (prompt,options,receipt) => { assert.deepEqual(receipt.history,route); return 'received'; };
  assert.equal((await runHdlWorkflow(f)).status,'checkpoint');
  assert.equal(receipts().length,1);
});

test('signoffId preserves approved receipts across recovery runIds and allows rtl-code reuse while blocking reviewers', async t => {
  const f = fixture(t), spec = path.join(f.projectRoot,'spec'), layout = path.join(f.projectRoot,'layout');
  f.args = {confirmed:true, modules:[]};
  fs.writeFileSync(spec,'v1');
  let calls = 0;
  f.agent = () => { calls++; fs.writeFileSync(layout,'ok'); return 'P0'; };
  f.agentReceipts = {
    'p0-infra':{version:'v1',inputs:['spec'],outputs:['layout'],verify:()=>fs.readFileSync(layout,'utf8')==='ok'},
    'rtl-code-mac':{version:'v1',inputs:['spec'],outputs:['layout'],verify:()=>true},
  };
  const r1 = await runHdlWorkflow({...f,runId:'attempt-1',signoffId:'signoff-shared'});
  assert.equal(r1.status,'checkpoint');
  assert.equal(calls,1);
  // Changing runId while keeping signoffId reuses verified preparatory artifacts
  const r2 = await runHdlWorkflow({...f,runId:'attempt-2',signoffId:'signoff-shared'});
  assert.equal(r2.status,'checkpoint');
  assert.equal(r2.reusedModelSteps,1);
  assert.equal(r2.agentDispatches,0);
  assert.equal(calls,1);

  // Attempting to attach agentReceipts to a non-reusable verification/review step is rejected
  const badPolicy = await runHdlWorkflow({
    ...f,
    args:{goldenBaseline:{entry:'spec',cases:['base']},confirmAllCheckpoints:true},
    agent:() => 'stub',
    agentReceipts:{'golden-preflight-run':{version:'v1',inputs:['spec'],outputs:['layout'],verify:()=>true}},
  });
  assert.equal(badPolicy.status,'failed');
  assert.match(badPolicy.error || '',/Incomplete trusted artifact receipt policy: golden-preflight-run/);
});
