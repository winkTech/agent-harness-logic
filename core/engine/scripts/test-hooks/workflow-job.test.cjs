'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const runner = require.resolve('../lib/workflow-job.cjs');
const {submitJob, readJob, waitJob, cancelJob} = require(runner);
const node = promisify(execFile);

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-job-'));
  t.after(() => fs.rmSync(cwd, {recursive:true, force:true, maxRetries:6, retryDelay:100}));
  const stateDir = path.join(cwd, 'jobs');
  const script = path.join(cwd, 'tool.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs');
fs.appendFileSync('starts.txt', 'start\\n');
console.log('observed',process.argv[2] || 'done',process.env.WORKFLOW_SAMPLE || 'unset');
setTimeout(() => process.exit(Number(process.argv[4] || 0)), Number(process.argv[3] || 0));
`);
  const spec = {stateDir, cwd, action:'offline-check', executable:process.execPath, args:[script,'sample', '350'],
    env:{WORKFLOW_SAMPLE:'fixture'}, inputDigest:crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex')};
  return {cwd,stateDir,spec};
}

test('independent callers attach to one offline job and receive the same durable result', {timeout:20000}, async t => {
  const {cwd,stateDir,spec} = fixture(t);
  const submit = 'const {submitJob}=require(process.argv[1]); console.log(submitJob(JSON.parse(process.argv[2])).jobId);';
  const calls = await Promise.all(Array.from({length:5}, () => node(process.execPath,['-e',submit,runner,JSON.stringify(spec)])));
  const ids = calls.map(call => call.stdout.trim());
  assert.equal(new Set(ids).size,1);
  const receipt = await waitJob(stateDir,ids[0]);
  assert.equal(receipt.status,'succeeded');
  assert.equal(receipt.exitCode,0);
  assert.match(fs.readFileSync(receipt.logPath,'utf8'),/observed sample fixture/);
  assert.equal(submitJob(spec).jobId,ids[0]);
  assert.equal(readJob(stateDir,ids[0]).finishedAt,receipt.finishedAt);
  assert.equal(fs.readFileSync(path.join(cwd,'starts.txt'),'utf8'),'start\n');
  const again = submitJob({...spec, attempt:2});
  assert.notEqual(again.jobId,ids[0]);
  await waitJob(stateDir,again.jobId);
  assert.equal(fs.readFileSync(path.join(cwd,'starts.txt'),'utf8'),'start\nstart\n');
});

test('nonzero, launch failure, timeout and cancellation cannot become passing receipts', {timeout:20000}, async t => {
  const {stateDir,spec,cwd} = fixture(t);
  const run = async changes => waitJob(stateDir,submitJob({...spec,...changes}).jobId);
  const bad = await run({args:[spec.args[0],'bad','10','7']});
  assert.equal(bad.status,'failed');
  assert.equal(bad.exitCode,7);
  const missing = await run({executable:path.join(cwd,'missing-program')});
  assert.equal(missing.status,'failed');
  const timed = await run({args:[spec.args[0],'timeout','8000'],timeoutMs:100});
  assert.equal(timed.status,'timed_out');
  const cancelled = submitJob({...spec,args:[spec.args[0],'cancel','8000']});
  cancelJob(stateDir,cancelled.jobId);
  assert.equal((await waitJob(stateDir,cancelled.jobId)).status,'cancelled');
  assert.equal(readJob(stateDir,bad.jobId).status,'failed');
  assert.throws(()=>readJob(stateDir,'../not-a-job'));
});

test('loss of the detached owner leaves unfinished work unverified and does not relaunch', {timeout:12000}, async t => {
  const {cwd,stateDir,spec} = fixture(t);
  const script = "const fs=require('node:fs'); fs.writeFileSync('started','yes');setTimeout(()=>fs.writeFileSync('orphan-finished','yes'),400)";
  const job = {...spec,args:['-e',script]};
  const {jobId} = submitJob(job);
  while (!fs.existsSync(path.join(cwd,'started'))) await new Promise(r => setTimeout(r,15));
  const running = readJob(stateDir,jobId);
  assert.equal(running.status,'running');
  process.kill(running.workerPid); // Only this fixture's supervisor. The short tool can exit on its own.
  const lost = await waitJob(stateDir,jobId);
  assert.equal(lost.status,'lost');
  assert.equal(lost.exitCode,null);
  assert.equal(submitJob(job).status,'lost');
  await new Promise(r=>setTimeout(r,500));
  assert.equal(readJob(stateDir,jobId).status,'lost');
});

test('explicit recoverDead archives interrupted jobs under the same identity without re-running deterministic failures', {timeout:15000}, async t => {
  const {cwd,stateDir,spec} = fixture(t);
  const flagFile = path.join(cwd,'recover-mode.txt');
  fs.writeFileSync(flagFile,'hang');
  const runnerScript = path.join(cwd,'recover-tool.cjs');
  fs.writeFileSync(runnerScript, [
    "const fs=require('node:fs');",
    "const mode=fs.readFileSync('recover-mode.txt','utf8').trim();",
    "fs.appendFileSync('recover-runs.txt',mode+'\\n');",
    "if (mode==='hang') { fs.writeFileSync('recover-started','1'); setTimeout(()=>{},5000); }",
    "else process.exit(0);",
  ].join('\n'));
  const job = {...spec,args:[runnerScript]};
  const first = submitJob(job);
  while (!fs.existsSync(path.join(cwd,'recover-started'))) await new Promise(r => setTimeout(r,15));
  process.kill(readJob(stateDir,first.jobId).workerPid);
  assert.equal((await waitJob(stateDir,first.jobId)).status,'lost');
  assert.equal(submitJob(job).status,'lost');

  fs.writeFileSync(flagFile,'ok');
  const recovered = submitJob({...job,recoverDead:true});
  assert.equal(recovered.jobId,first.jobId);
  assert.equal(recovered.reused,false);
  const done = await waitJob(stateDir,recovered.jobId);
  assert.equal(done.status,'succeeded');
  assert.ok(fs.readdirSync(stateDir).some(name => name.startsWith('dead-'+first.jobId.slice(0,16))));

  const failedJob = {...spec,args:[spec.args[0],'det-fail','10','5']};
  const failed = await waitJob(stateDir,submitJob(failedJob).jobId);
  assert.equal(failed.status,'failed');
  const notRerun = submitJob({...failedJob,recoverDead:true});
  assert.equal(notRerun.status,'failed');
  assert.equal(notRerun.reused,true);
});

test('the launched tool gets only approved environment and never reuses another identity', {timeout:12000}, async t => {
  const {stateDir,spec} = fixture(t);
  const script = 'console.log(JSON.stringify([process.env.WORKFLOW_PRIVATE || null,process.argv[1]]));';
  const options = {...spec,args:['-e',script,'literal ; & | argument']};
  const previous = process.env.WORKFLOW_PRIVATE;
  process.env.WORKFLOW_PRIVATE = 'must-not-propagate';
  try {
    const old = submitJob(options);
    const first = await waitJob(stateDir,old.jobId);
    assert.deepEqual(JSON.parse(fs.readFileSync(first.logPath,'utf8')),[null,options.args[2]]);
    const changed = submitJob({...options,env:{WORKFLOW_PRIVATE:'explicit'}});
    assert.notEqual(old.jobId,changed.jobId);
    const second = await waitJob(stateDir,changed.jobId);
    assert.deepEqual(JSON.parse(fs.readFileSync(second.logPath,'utf8')),['explicit',options.args[2]]);
    assert.equal(fs.readFileSync(path.join(stateDir,changed.jobId,'request.json'),'utf8').includes('explicit'),false);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_PRIVATE;
    else process.env.WORKFLOW_PRIVATE = previous;
  }
});

test('a final receipt wins a supervisor-exit race and inconsistent green evidence is rejected', t => {
  const {stateDir,spec} = fixture(t);
  const directory = path.join(stateDir,spec.inputDigest);
  fs.mkdirSync(directory,{recursive:true});
  const file = path.join(directory,'receipt.json'), timestamp = new Date().toISOString();
  const running = {jobId:spec.inputDigest,status:'running',submittedAt:timestamp,heartbeatAt:timestamp,workerPid:process.pid};
  const done = {...running,status:'succeeded',finishedAt:timestamp,exitCode:0};
  fs.writeFileSync(file,JSON.stringify(running));
  t.mock.method(process,'kill',(pid,signal) => {
    assert.equal(pid,process.pid);
    assert.equal(signal,0);
    fs.writeFileSync(file,JSON.stringify(done));
    throw Object.assign(new Error('worker has exited'),{code:'ESRCH'});
  });
  assert.equal(readJob(stateDir,spec.inputDigest).status,'succeeded');
  fs.writeFileSync(file,JSON.stringify({...done,exitCode:2}));
  assert.throws(()=>readJob(stateDir,spec.inputDigest),/Invalid workflow receipt/);
});
