'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFile } = require('node:child_process');

const source = require('./resolve-root.cjs').resolveHarnessRoot(__dirname).root;

test('Stop bounds unresolved work and hands off without changing verification or authorization', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-stop-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true, maxRetries:5 }));
  const sessionId = 'handoff-session';
  const gate = path.join(dir, 'gate.json');
  const preload = path.join(dir, 'stop-fixture.cjs');
  // Isolate the unrelated Git checker. The actual verification state reader,
  // Stop router, bridge locking and response rendering run in fresh processes.
  fs.writeFileSync(preload, `
    require(${JSON.stringify(path.join(__dirname,'git-integrity.cjs'))}).fullCheck = () => ({});
    const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = (cmd, args, options) => {
      if (args?.includes(${JSON.stringify(path.join(__dirname,'background.cjs'))}) && args.includes('git-integrity')) {
        const child = new (require('node:events').EventEmitter)();
        child.unref = () => {};
        return child;
      }
      return spawn(cmd, args, options);
    };`);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now()+3600000).toISOString();
  const entry = { sessionId, projectRoot:dir, minimumRiskLevel:'R3', effectiveRiskLevel:'R3',
    verificationStatus:'pending', lastUpdatedAt:now, expiresAt };
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# fixture');
  const args = ['--require',preload,path.join(__dirname, 'bridge.cjs'),'Stop'];
  function options(fields = {}, extraEnv = {}) {
    return {
      cwd:dir, encoding:'utf8', windowsHide:true, timeout:15000,
      input:JSON.stringify({conversationId:sessionId, cwd:dir, ...fields}),
      env:{...process.env, HARNESS_NO_PERSIST:'0', HARNESS_RISK_POLICY_MODE:'enforce',
        HARNESS_ROOT:source, HARNESS_STATE_DIR:dir, HARNESS_VERIFY_GATE_STATE_FILE:gate,
        HARNESS_SQLITE_PATH:path.join(dir,'fixture.db'), ...extraEnv},
    };
  }
  function stop(fields = {}, extraEnv = {}) {
    const res = spawnSync(process.execPath, args, options(fields,extraEnv));
    assert.equal(res.status,0,res.stderr);
    return JSON.parse(res.stdout);
  }
  for (const mode of ['r3', 'unavailable', 'pending']) {
    const pending = mode === 'r3' ? {} : {edit:{sessionId,projectRoot:dir,files:['a.js'],lastEditTime:now,expiresAt}};
    const risk = mode === 'pending' ? {} : {risk:{...entry, verificationStatus:mode === 'unavailable' ? 'unavailable' : 'pending'}};
    const saved = JSON.stringify({version:4, pending, risk});
    fs.writeFileSync(gate, saved);
    const first = stop({executionNum:0,continuationActive:false,lastUserInput:mode});
    assert.equal(first.decision,'continue');
    assert.match(first.reason, /unverified/i);
    if (mode === 'r3') assert.match(first.reason, /human/i);
    if (mode === 'unavailable') assert.match(first.reason, /unavailable/i);
    assert.equal(stop({continuationActive:true}).decision,'allow');
    assert.equal(stop({executionNum:1}).decision,'allow');
    assert.equal(stop({executionNum:1,continuationActive:false}).decision,'allow');
    assert.equal(stop({terminationReason:'max_steps_exceeded'}).decision,'allow');
    assert.equal(stop({terminationReason:'USER_CANCELED'}).decision,'allow');
    assert.equal(fs.readFileSync(gate,'utf8'),saved);
  }
  const saved = JSON.stringify({version:4, pending:{}, risk:{legacy:{...entry,projectRoot:path.parse(dir).root,targets:[]}}});
  fs.writeFileSync(gate, saved);
  assert.equal(stop({continuationActive:false}).decision,'allow','unrelated project must not inherit old whole-drive risk');
  assert.equal(stop({cwd:undefined, workspacePaths:[], lastUserInput:'legacy', continuationActive:false}).decision,'continue');
  assert.equal(stop({cwd:undefined, workspacePaths:[], lastUserInput:'legacy', continuationActive:true}).decision,'allow');
  assert.equal(stop({cwd:undefined, workspacePaths:[], conversationId:'other', continuationActive:false}).decision,'allow');
  assert.equal(fs.readFileSync(gate,'utf8'),saved);
  const unknown = {cwd:undefined,workspacePaths:[],lastUserInput:'test turn'};
  assert.equal(stop(unknown,{HARNESS_NO_PERSIST:'0'}).decision,'continue');
  assert.equal(stop(unknown,{HARNESS_NO_PERSIST:'0'}).decision,'allow');
  assert.equal(stop({...unknown,lastUserInput:'new turn'},{HARNESS_NO_PERSIST:'0'}).decision,'continue');
  for (const terminationReason of ['MAX_INVOCATIONS','MAX_FORCED_INVOCATIONS','MAX_TOKEN_BUDGET_EXCEEDED',
    'TERMINAL_STEP_TYPE','TERMINAL_CUSTOM_HOOK','INJECTED_RESPONSE']) {
    assert.equal(stop({...unknown,lastUserInput:terminationReason,terminationReason}).decision,'allow',terminationReason);
  }
  const fixed = {...unknown, lastUserInput:'same words', executionNum:0, continuationActive:false};
  const parallel = Array.from({length:8}, () => new Promise((resolve,reject) => {
    const opts = options({...fixed,lastUserInputStepIndex:20});
    const child = execFile(process.execPath,args,opts,(err,out) => err ? reject(err) : resolve(JSON.parse(out).decision));
    child.stdin.end(opts.input);
  }));
  assert.equal((await Promise.all(parallel)).filter(x => x === 'continue').length,1);
  assert.equal(stop({...fixed,lastUserInputStepIndex:22}).decision,'continue','a new explicit user turn can use a new continuation');
  assert.equal(stop({...fixed,lastUserInputStepIndex:20}).decision,'allow','late Stop cannot rewind the turn receipt');
  assert.equal(stop({...fixed,lastUserInputStepIndex:22}).decision,'allow');
  assert.equal(stop({...fixed,lastUserInputStepIndex:25},{HARNESS_NO_PERSIST:'1'}).decision,'allow');
  const transcriptPath = path.join(dir,'transcript.jsonl');
  const input = step => JSON.stringify({source:'USER_EXPLICIT',type:'USER_INPUT',step_index:step})+'\n';
  fs.writeFileSync(transcriptPath,input(30));
  assert.equal(stop({...fixed,transcriptPath}).decision,'continue');
  assert.equal(stop({...fixed,transcriptPath}).decision,'allow');
  fs.appendFileSync(transcriptPath,input(33));
  assert.equal(stop({...fixed,transcriptPath}).decision,'continue','same text on a later transcript turn');
  assert.equal(stop({...fixed,transcriptPath}).decision,'allow');
  const stateFile = path.join(dir,'var','antigravity-bridge.json');
  fs.writeFileSync(stateFile,'{');
  const unavailable = stop({...fixed,lastUserInputStepIndex:40});
  assert.equal(unavailable.decision,'allow');
  assert.match(unavailable.reason,/unverified/i);
  assert.equal(fs.readFileSync(stateFile,'utf8'),'{');
  assert.equal(fs.readFileSync(gate,'utf8'),saved);
});
