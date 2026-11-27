#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {AsyncLocalStorage} = require('node:async_hooks');
const {parseArgs} = require('node:util');
const {createHdlWorkflowBindings} = require('./hdl-workflow-host.cjs');
const {summarizeWorkflowUsage, resolveWorkflowModelTier} = require('./agent-context-budget.cjs');
const {projectFile} = require('./lib/hdl-phase-readiness.cjs');
const {resolvePackAsset} = require('./lib/pack-config.cjs');
const {atomicWriteJson} = require('./lib/project-scope.cjs');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const usageText = 'node run-hdl-workflow.cjs --host <absolute trusted .cjs> --args <jsonfile> --project <absolute project> --state-dir <absolute private directory> --run-id <stable ID> [--signoff-id <independent signoff>] [--recover] [--auto-host]';
const reusableSteps = new Set(['p0-infra','p1a-system-design','p1b-algo-arch','p1b-logic-arch','p2-fixed-point','p3-tb','p3-vectors','p3-selftest']);
const isReusableStep = label => typeof label === 'string' && (reusableSteps.has(label) || /^rtl-code-[A-Za-z_][A-Za-z0-9_$]*$/.test(label));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fileSetDigest(projectRoot, names) {
  const entries = [];
  for (const name of names) {
    const file = projectFile(projectRoot,name);
    if (!file) return null;
    entries.push([name,digest(fs.readFileSync(file))]);
  }
  return digest(JSON.stringify(entries));
}

// Routing is decided at dispatch time. An artifact cache hit never enters this
// path and therefore cannot make evidence appear delivered to a conversation.
function createDispatchHistory(pack, contextHistory, identity, stateDir) {
  const prepared = new WeakMap();
  function prepare(packet, options) {
    const full = pack(packet);
    if (options) prepared.set(options, {packet, full});
    return full;
  }
  function forDispatch(prompt, options) {
    const entry = prepared.get(options);
    prepared.delete(options);
    if (!entry || entry.full.prompt !== prompt) return {prompt};
    const route = contextHistory?.(options, identity);
    const metrics = entry.full.metrics;
    if (route == null) return {prompt, metrics};
    if (typeof route.threadId !== 'string' || !route.threadId.trim() ||
        typeof route.epoch !== 'string' || !route.epoch.trim() || typeof route.historyAvailable !== 'boolean') {
      throw new TypeError('contextHistory requires threadId, epoch and historyAvailable');
    }
    const history = {threadId:route.threadId, epoch:route.epoch, historyAvailable:route.historyAvailable};
    const affinity = options.affinityKey || options.label;
    if (!affinity) return {prompt, metrics, history};
    const scope = digest(JSON.stringify([identity,options.acceptanceId || '',options.agentType || 'host',affinity,
      history.threadId,history.epoch,entry.packet.kind]));
    const file = path.join(stateDir,'hdl-history-'+scope+'.json');
    let previous;
    if (history.historyAvailable && fs.existsSync(file)) {
      try { previous = JSON.parse(fs.readFileSync(file,'utf8')); } catch { /* Resend full evidence. */ }
      if (!Array.isArray(previous?.shown) || !previous.shown.every(row => Array.isArray(row) && row.length === 2 &&
          typeof row[0] === 'string' && /^[a-f0-9]{64}$/.test(row[1]))) previous = null;
    }
    const current = previous ? pack({...entry.packet, scope}, {previous,historyAvailable:true}) :
      {prompt, metrics, receipt:{...entry.full.receipt,scope}};
    return {prompt:current.prompt, metrics:current.metrics, history,
      delivered:() => atomicWriteJson(file,current.receipt,{retryBusyRename:true})};
  }
  return {prepare, forDispatch};
}

async function runHdlWorkflow({args, projectRoot, stateDir, runId, signoffId = runId, agent, profiles = {}, agentReceipts = {}, contextHistory, recoverJobs = false, autoHost = false}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof agent !== 'function') {
    throw new TypeError('Workflow args and an explicitly supplied agent callback are required');
  }
  if (contextHistory != null && typeof contextHistory !== 'function') throw new TypeError('contextHistory must be a host callback');
  if (['evidenceGateScript','moduleOrderScript','workflowFile','workflowAction','workflowContext','profiles','agentReceipts','contextHistory','host'].some(key => Object.hasOwn(args,key))) {
    throw new Error('Project arguments cannot select executable bindings');
  }
  if (!path.isAbsolute(projectRoot) || (args.projectRoot && fs.realpathSync.native(args.projectRoot) !== fs.realpathSync.native(projectRoot))) {
    throw new Error('Workflow args must belong to the selected absolute project');
  }
  projectRoot = fs.realpathSync.native(projectRoot);
  if (typeof signoffId !== 'string' || !signoffId.trim()) throw new TypeError('A signoff ID cannot be empty');
  let autogenSummary = null;
  if (autoHost === true) {
    const {buildAutoHostConfig} = require('./hdl-host-autogen.cjs');
    const auto = buildAutoHostConfig({projectRoot, modules:args.modules, part:args.part || args.device});
    profiles = {
      ...auto.profiles,
      ...profiles,
      ...(auto.profiles.simulate || profiles.simulate
        ? {simulate:{...(auto.profiles.simulate || {}), ...(profiles.simulate || {})}}
        : {}),
    };
    agentReceipts = {...auto.agentReceipts, ...agentReceipts};
    autogenSummary = auto.summary;
  }
  const bound = createHdlWorkflowBindings({projectRoot, stateDir, runId, signoffId, profiles, recoverJobs});
  const workflowFile = resolvePackAsset('fpga', 'workflows', 'hdl-coding-dag-workflow.js');
  if (!workflowFile) throw new Error('HDL workflow requires the fpga pack to be enabled');
  const source = fs.readFileSync(workflowFile,'utf8');
  const workflowDigest = digest(source);
  const history = createDispatchHistory(bound.workflowContext,contextHistory,{projectRoot,runId,signoffId,workflowDigest},stateDir);
  const {confirmed, userConfirmed, acknowledged, confirmAllCheckpoints, resumeFromRunId, checkpoints, ...engineeringArgs} = args;
  // Confirmation of another checkpoint permits continuation. Contract digests
  // carried in a checkpoint, unlike the confirmation flag, invalidate reuse.
  const contracts = Object.fromEntries(Object.entries(checkpoints || {}).map(([name,value]) =>
    [name, Object.fromEntries(Object.entries(value || {}).filter(([key]) => key !== 'confirmed'))])
    .filter(([,value]) => Object.keys(value).length));
  const id = randomUUID();
  const eventPath = path.join(stateDir, 'workflow-' + id + '.jsonl');
  const usagePath = path.join(stateDir, 'usage-' + id + '.jsonl');
  for (const file of [eventPath, usagePath]) fs.writeFileSync(file, '', {mode:0o600, flag:'wx'});
  const context = new AsyncLocalStorage();
  const events = (type, data) => fs.appendFileSync(eventPath, JSON.stringify({type, runId, time:new Date().toISOString(), ...data})+'\n');
  if (autogenSummary) events('auto-host',{digest:autogenSummary.digest,boundSimulateModules:autogenSummary.boundSimulateModules,vivadoBound:autogenSummary.vivadoBound});
  const observations = [];
  const record = item => {
    observations.push(item);
    fs.appendFileSync(usagePath, JSON.stringify(item)+'\n');
  };
  let dispatches = 0, actions = 0, unreportedDispatches = 0;
  let reusedModelSteps = 0;
  const tierDispatches = {deep:0, standard:0, fast:0};
  const responses = new Map();

  async function dispatch(prompt, options = {}) {
    // Only preparatory artifact generation can be reused. Independent review,
    // functional repair and signed checkpoints always follow the DSL.
    const policy = Object.hasOwn(agentReceipts,options.label) ? agentReceipts[options.label] : null;
    let receiptPath, inputDigest;
    if (policy) {
      if (!isReusableStep(options.label) || !policy.version || typeof policy.verify !== 'function' ||
          ![policy.inputs,policy.outputs].every(list => Array.isArray(list) && list.length > 0)) {
        throw new Error('Incomplete trusted artifact receipt policy: '+options.label);
      }
      inputDigest = fileSetDigest(projectRoot,policy.inputs);
      if (!inputDigest) throw new Error('Missing approved artifact input: '+options.label);
      const key = digest(JSON.stringify([workflowDigest, projectRoot, signoffId, options, prompt,
        engineeringArgs, contracts, policy.version, policy.inputs, policy.outputs, inputDigest]));
      receiptPath = path.join(stateDir,'hdl-artifact-'+key+'.json');
      if (fs.existsSync(receiptPath)) {
        const stored = JSON.parse(fs.readFileSync(receiptPath,'utf8'));
        if (stored.outputs && stored.outputs === fileSetDigest(projectRoot,policy.outputs) &&
            await policy.verify({projectRoot,result:stored.result}) === true) {
          events('accepted-artifact-reuse',{label:options.label,receiptPath});
          reusedModelSteps++;
          return stored.result;
        }
      }
    }
    const delivery = history.forDispatch(prompt,options);
    const dispatchId = id + '/' + (++dispatches);
    const acceptanceId = options.acceptanceId || runId;
    const phase = options.phase || context.getStore()?.phase || '';
    const executor = options.agentType || 'host';
    const modelTier = resolveWorkflowModelTier(options);
    options = {...options, modelTier};
    tierDispatches[modelTier] = (tierDispatches[modelTier] || 0) + 1;
    const estimatedInputTokens = Math.ceil(Buffer.byteLength(delivery.prompt)/3);
    const tags = {acceptanceId, dispatchId, phase, label:options.label || '', modelTier};
    events('agent-dispatch', {...tags, estimatedInputTokens, contextBudget:delivery.metrics ?? null});
    // Persist before entering an external service. A process lost mid-dispatch
    // leaves unknown coverage, which later response observations supersede.
    record({...tags, executor, callId:'unreported:'+dispatchId, estimatedInputTokens, provenance:'unreported-dispatch'});
    let observed = false, closed = false;
    function recordResponse(response) {
      if (closed) throw new Error('Record model usage before the agent callback settles');
      if (!response || typeof response.callId !== 'string' || !response.callId.trim()) throw new Error('A host response ID is required');
      const item = {...tags, executor:response.executor || executor, callId:response.callId,
        usage:response.usage, evidenceReads:response.evidenceReads ?? null};
      if (!observed) item.estimatedInputTokens = estimatedInputTokens;
      if (response.reason) item.reason = response.reason;
      const responseKey = JSON.stringify([acceptanceId,item.executor,item.callId]);
      const prior = responses.get(responseKey);
      summarizeWorkflowUsage(prior ? [prior,item] : [item]); // validate once per response, including duplicate reports
      record(item);
      observed = true;
      responses.set(responseKey,{...item,usage:item.usage ?? prior?.usage,evidenceReads:item.evidenceReads ?? prior?.evidenceReads,
        estimatedInputTokens:item.estimatedInputTokens ?? prior?.estimatedInputTokens});
    }
    try {
      const value = await agent(delivery.prompt, options, {runId, signoffId, projectRoot, ...tags, recordResponse,history:delivery.history});
      delivery.delivered?.();
      if (policy) {
        const outputs = fileSetDigest(projectRoot,policy.outputs);
        if (!outputs || value === undefined || fileSetDigest(projectRoot,policy.inputs) !== inputDigest ||
            await policy.verify({projectRoot,result:value}) !== true) {
          throw new Error('Approved artifact verification failed: '+options.label);
        }
        atomicWriteJson(receiptPath,{result:value,outputs},{retryBusyRename:true});
      }
      return value;
    } finally {
      closed = true;
      if (!observed) {
        unreportedDispatches++;
      }
    }
  }

  async function action(request) {
    actions++;
    const tags = {label:request.label || '', action:request.kind, module:request.module};
    events('action-start',tags);
    try {
      const result = await bound.workflowAction(request);
      const disposition = result.disposition || (result.executed === true ? 'executed' : undefined);
      const evidencePath = result.evidencePath && fs.existsSync(result.evidencePath) ? result.evidencePath : null;
      events('action-end',{...tags, ok:result.ok, jobId:result.jobId, disposition, evidencePath, verified:result.verified === true});
      return result;
    } catch (err) {
      events('action-error',{...tags, message:String(err.message).slice(0,600)});
      throw err;
    }
  }
  action.supports = bound.workflowAction.supports;
  async function parallel(tasks) {
    const rows = await Promise.allSettled(tasks.map(task => context.run({...context.getStore()}, async () => task())));
    const error = rows.find(r => r.status === 'rejected');
    if (error) throw error.reason;
    return rows.map(r => r.value);
  }
  const pipeline = (items,...stages) => parallel(items.map((item, index) => async () => {
    let previous = item;
    for (const stage of stages) previous = await stage(previous, item, index);
    return previous;
  }));
  const phase = name => { context.getStore().phase = name; events('phase',{phase:name}); };
  const log = text => events('log',{message:String(text).slice(0,2000)});
  let status, result, error, checkpoint;
  try {
    // Only the package-owned DSL is compiled. The CLI and project cannot select a workflow file.
    const run = new AsyncFunction('args','agent','parallel','pipeline','phase','log','workflowAction','workflowContext',
      source.replace(/export\s+const\s+meta\s*=/,'const meta ='));
    result = await context.run({phase:'preflight'}, () => run({...args, projectRoot},dispatch,parallel,pipeline,phase,log,action,history.prepare));
    status = 'completed';
  } catch (err) {
    error = String(err.message);
    checkpoint = /^\[WorkflowCheckpoint:([\w-]+)\]/.exec(error)?.[1];
    status = checkpoint ? 'checkpoint' : 'failed';
  }
  events('finished',{status,checkpoint,error});
  return {status,runId,signoffId,checkpoint,error,result,eventPath,usagePath,actions,reusedModelSteps,agentDispatches:dispatches,
    tierDispatches,unreportedDispatches,reportedModelResponses:responses.size, modelResponses:unreportedDispatches ? null : responses.size,
    usage:summarizeWorkflowUsage(observations)};
}

async function main() {
  const {values} = parseArgs({options:{help:{type:'boolean'},recover:{type:'boolean'},'auto-host':{type:'boolean'},host:{type:'string'},args:{type:'string'},
    project:{type:'string'},'state-dir':{type:'string'},'run-id':{type:'string'},'signoff-id':{type:'string'}}});
  if (values.help) { console.log(usageText); return; }
  if (!values.host || !path.isAbsolute(values.host) || !values.host.endsWith('.cjs') ||
      !values.args || !values.project || !values['state-dir'] || !values['run-id']) throw new Error(usageText);
  const args = JSON.parse(fs.readFileSync(values.args,'utf8').replace(/^\uFEFF/,''));
  const host = require(fs.realpathSync(values.host));
  const report = await runHdlWorkflow({args, projectRoot:values.project, stateDir:values['state-dir'], runId:values['run-id'],
    signoffId:values['signoff-id'], agent:host.agent, profiles:host.profiles, agentReceipts:host.agentReceipts,
    contextHistory:host.contextHistory, recoverJobs:Boolean(values.recover || host.recoverJobs),
    autoHost:Boolean(values['auto-host'] || host.autoHost)});
  console.log(JSON.stringify(report,null,2));
  process.exitCode = report.status === 'completed' ? 0 : report.status === 'checkpoint' ? 2 : 1;
}

module.exports = {runHdlWorkflow,createDispatchHistory};
if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1; });
