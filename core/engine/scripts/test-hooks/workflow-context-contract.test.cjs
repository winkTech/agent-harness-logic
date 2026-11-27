'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWorkflowContext, summarizeWorkflowUsage } = require('../agent-context-budget.cjs');

const required = {
  interface: 'signed-v2', limit: 0, authorized: false, fail: 'sample 71 mismatch',
  stop: '未经签收禁止继续',
};
const entry = {id:'sim', ref:'reports/sim.json#sample71', summary:'actual=-1 expected=1'};
const packet = {kind:'repair', scope:'run7/receiver2/context1', required, evidence:[entry]};

test('workflow context never truncates required fields, including stops at the tail', () => {
  const constraints = {...required, interface:'接口'.repeat(4200)};
  const output = buildWorkflowContext({...packet, required:constraints}, {budgetTokens:12});
  const contents = JSON.parse(output.prompt);
  assert.deepEqual(contents.required, constraints);
  assert.deepEqual(contents.evidence, [{id:entry.id, ref:entry.ref}]);
  assert.equal(output.metrics.overBudget, true);
  assert.deepEqual(output.metrics.expansion,{reason:'required-fields-and-evidence-refs',
    effectiveBudgetTokens:output.metrics.estimatedInputTokens,additionalEstimatedTokens:output.metrics.estimatedInputTokens-12,
    requiredFields:Object.keys(constraints)});
  assert.equal(output.metrics.estimateMethod, 'ceil(utf8Bytes/3)');
  assert.equal(output.metrics.estimatedInputTokens, Math.ceil(Buffer.byteLength(output.prompt)/3));
  for (const [kind, limit] of Object.entries({handoff:1000, repair:4000, decision:8000})) {
    assert.equal(buildWorkflowContext({...packet, kind}).metrics.budgetTokens, limit);
  }
});

test('only summaries actually sent to the same continuous history are deduplicated', () => {
  const first = buildWorkflowContext(packet);
  assert.equal(first.metrics.expansion,null);
  const history = {historyAvailable:true, previous:first.receipt};
  const read = result => JSON.parse(result.prompt);
  assert.equal(read(first).evidence[0].summary, entry.summary);
  const repeat = buildWorkflowContext(packet, history);
  assert.deepEqual(read(repeat).required, required);
  assert.deepEqual(read(repeat).evidence, [{id:entry.id, ref:entry.ref}]);
  assert.equal(read(buildWorkflowContext(packet, {...history, previous:repeat.receipt})).evidence[0].summary, undefined);
  for (const changed of [{...packet, scope:'new-context'}, {...packet, kind:'decision'}]) {
    assert.equal(read(buildWorkflowContext(changed, history)).evidence[0].summary, entry.summary);
  }
  assert.equal(read(buildWorkflowContext(packet, {...history, historyAvailable:false})).evidence[0].summary, entry.summary);
  assert.equal(read(buildWorkflowContext({...packet, evidence:[{...entry, summary:'mismatch moved'}]}, history)).evidence[0].summary, 'mismatch moved');
  const omitted = buildWorkflowContext(packet, {budgetTokens:1});
  assert.equal(read(buildWorkflowContext(packet, {...history, previous:omitted.receipt})).evidence[0].summary, entry.summary);
});

test('conflicting evidence IDs and lossy required data fail before dispatch', () => {
  assert.throws(() => buildWorkflowContext({...packet, required:{limit:NaN}}));
  assert.throws(() => buildWorkflowContext({...packet, required:{limit:undefined}}));
  assert.throws(() => buildWorkflowContext({...packet, required:{flags:new Set(['restricted'])}}));
  assert.throws(() => buildWorkflowContext({...packet, evidence:[entry,{...entry, ref:'other.json'}]}));
  assert.throws(() => buildWorkflowContext(packet, {budgetTokens:-1}));
  const result = buildWorkflowContext({...packet, evidence:[entry,{...entry}]});
  assert.equal(JSON.parse(result.prompt).evidence.length, 1);
});

test('per-acceptance usage joins observers without charging replay, cache or missing measurements twice', () => {
  const first = {acceptanceId:'a', executor:'planner', callId:'1', estimatedInputTokens:55};
  const usage = {uncachedInputTokens:10, cachedInputTokens:40, outputTokens:3};
  const worker = {...first, executor:'worker', estimatedInputTokens:70, reason:'unchanged-wait'};
  const events = [first, {...first, usage}, {...first, usage}, worker, {...worker, acceptanceId:'b'}];
  const [a,b] = summarizeWorkflowUsage(events);
  assert.equal(a.calls, 2);
  assert.equal(a.measuredCalls, 1);
  assert.equal(a.unchangedWaitCalls, 1);
  assert.deepEqual(a.measuredSubtotal, usage);
  assert.equal(a.measuredTotal, null);
  assert.equal(a.estimatedPromptSubtotal, 125);
  assert.equal(b.measuredSubtotal, null);
  assert.equal(b.measuredTotal, null);
  const complete = summarizeWorkflowUsage([...events, {...worker, usage}])[0];
  assert.deepEqual(complete.measuredTotal, {uncachedInputTokens:20, cachedInputTokens:80, outputTokens:6});
  assert.throws(() => summarizeWorkflowUsage([...events, {...first, usage:{...usage, outputTokens:999}}]));
  assert.throws(() => summarizeWorkflowUsage([{...first, usage:{outputTokens:7}}]));
});

test('actual evidence reads distinguish observed zero, incomplete coverage and duplicate observers', () => {
  const read = {acceptanceId:'a',executor:'worker',callId:'a',evidenceReads:0};
  const missing = {...read,callId:'b',evidenceReads:null,reason:'unchanged-wait'};
  assert.equal(summarizeWorkflowUsage([missing])[0].evidenceReadsTotal,null);
  assert.equal(summarizeWorkflowUsage([read])[0].evidenceReadsTotal,0);
  const mixed = summarizeWorkflowUsage([read,read,missing])[0];
  assert.equal(mixed.evidenceReadsReportedCalls,1);
  assert.equal(mixed.evidenceReadsSubtotal,0);
  assert.equal(mixed.evidenceReadsTotal,null);
  const updated = {...missing,evidenceReads:2};
  const full = summarizeWorkflowUsage([read,read,missing,updated,updated])[0];
  assert.equal(full.evidenceReadsTotal,2);
  assert.equal(full.unchangedWaitCalls,1);
  assert.throws(() => summarizeWorkflowUsage([read,{...read,evidenceReads:1}]),/conflicting/);
  assert.throws(() => summarizeWorkflowUsage([{...read,evidenceReads:-1}]),/evidenceReads/);
});

test('offline A/B preserves the verdicts from an existing synthesis report', t => {
  const ref = 'packs/fpga/engine/rtl-bench/tasks/axis_skid_buffer/seed/flow_summary.json';
  const report = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../..', ref), 'utf8'));
  const acceptance = {top:report.top, part:report.part, scope:'synth', minWns:0, minWhs:0};
  function project(r) {
    return {top:r.top, part:r.part, ok:r.ok, stages_run:r.stages_run, synth:{wns:r.synth?.wns ?? null, whs:r.synth?.whs ?? null}};
  }
  function accept(r, gate) {
    return r.ok === true && r.top === gate.top && r.part === gate.part && r.stages_run?.includes(gate.scope)
      && Number.isFinite(r.synth?.wns) && r.synth.wns >= gate.minWns && Number.isFinite(r.synth?.whs) && r.synth.whs >= gate.minWhs;
  }
  const mutations = [report, {...report, part:'other'}, {...report, synth:{...report.synth, wns:-0.01}},
    {...report, synth:{...report.synth, whs:null}}, {...report, stages_run:['rtlcheck']}];
  let sample;
  for (const [index, input] of mutations.entries()) {
    const old = JSON.stringify({required:acceptance, report:input});
    const packed = buildWorkflowContext({kind:'handoff', required:acceptance, evidence:[{id:'timing', ref, summary:project(input)}]});
    const baseline = JSON.parse(old), candidate = JSON.parse(packed.prompt);
    const a = accept(baseline.report, baseline.required);
    const b = accept(candidate.evidence[0].summary, candidate.required);
    assert.equal(a, index === 0);
    assert.equal(b, a);
    if (!index) sample = {baselineBytes:Buffer.byteLength(old), candidateBytes:packed.metrics.utf8Bytes,
      baselineEstimatedTokens:Math.ceil(Buffer.byteLength(old)/3), candidateEstimatedTokens:packed.metrics.estimatedInputTokens};
  }
  assert.ok(sample.candidateBytes < sample.baselineBytes);
  t.diagnostic(JSON.stringify({...sample, estimateMethod:'ceil(utf8Bytes/3)', cases:5, modelCalls:0}));
});
