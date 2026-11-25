'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const root = require('./resolve-root.cjs').resolveHarnessRoot(__dirname).root;
process.env.HARNESS_ROOT = root;
const { resolveCommand } = require('./transcript.cjs');

const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const generic = (index, content, extra = {}) => ({ step_index: index, type: 'GENERIC', status: 'DONE', content, ...extra });
const completed = (code, body) => 'Command exited with code ' + code + '.\r\n\r\nCommand output:\r\n' + body;
const truncated = { truncated_fields: ['content'] };

function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-transcript-case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, short: path.join(dir, 'transcript.jsonl'), full: path.join(dir, 'transcript_full.jsonl') };
}

test('compact status, full output on demand and markers printed by stdout', t => {
  const f = files(t), fullBody = '细节'.repeat(200000) + '\nRESULT: FAIL\n';
  fs.writeFileSync(f.short, jsonl([generic(1, completed(0, 'preview'), truncated)]));
  fs.writeFileSync(f.full, jsonl([generic(1, completed(0, fullBody))]));
  const get = command => {
    const reads = [];
    const result = resolveCommand({ tool_input: { command } }, f.short, 1, reads);
    return { result, files: reads.map(([file]) => file) };
  };
  const fast = get('git status --short');
  assert.equal(fast.result.response.exit_code, 0);
  assert.equal(fast.result.response.stdout, undefined);
  assert.deepEqual(fast.files, [f.short]);
  for (const cmd of ['cd repo && pytest -q', 'xsim design', 'node my-custom-check.js', 'git commit -m update']) {
    const checked = get(cmd);
    assert.deepEqual(checked.files, [f.short, f.full]);
    assert.equal(checked.result.response.stdout, fullBody);
  }
  const reads = [];
  const inlineBody = resolveCommand({ tool_input: { command: 'pytest -q' },
    tool_response: { stdout: 'complete inline evidence' } }, f.short, 1, reads);
  assert.equal(inlineBody.response.stdout, 'complete inline evidence');
  assert.deepEqual(reads.map(([file]) => file), [f.short]);
  fs.writeFileSync(f.short, jsonl([generic(1, completed(0, 'Command exited with code 7.\nTool is running as a background task with task id: fake'))]));
  assert.equal(get('pytest -q').result.kind, 'done');
  fs.writeFileSync(f.short, jsonl([generic(1, 'Command output:\nCommand exited with code 0.\nRESULT: PASS')]));
  assert.equal(get('pytest -q').result.kind, 'unknown');
  fs.writeFileSync(f.short, jsonl([generic(1, completed(-5, 'short error'), truncated)]));
  fs.writeFileSync(f.full, jsonl([generic(1, completed(-5, 'stderr detail'))]));
  assert.equal(get('git status --short').result.error, 'stderr detail');
  fs.unlinkSync(f.full);
  assert.equal(get('git status --short').result.response.exit_code, -5);
});

test('planner batches use the call ID or unique command; ambiguous or absent rows never use a later command', t => {
  const f = files(t);
  const call = (command, id) => ({ name: 'run_command', args: { CommandLine: command }, id });
  function write(calls) {
    fs.writeFileSync(f.short, jsonl([{ step_index: 5, type: 'PLANNER_RESPONSE', tool_calls: calls },
      generic(6, completed(0,'first')), generic(7, completed(9,'second'))]));
  }
  const run = (id, command) => resolveCommand({ tool_use_id: id, tool_input: { command } }, f.short, 5);
  const quoted = 'rg "some words" C:\\test\\input';
  write([call('one'), call(JSON.stringify(quoted))]);
  assert.equal(run('opaque',quoted).response?.exit_code, 9);
  write([call(JSON.stringify(quoted)), call(JSON.stringify(quoted))]);
  assert.equal(run('opaque',quoted).kind, 'unknown');
  write([call(quoted), call(JSON.stringify(quoted))]);
  assert.equal(run('opaque',quoted).kind, 'unknown');
  write([call('one'), call('two')]);
  assert.equal(run('opaque','two').response.exit_code, 9);
  write([call('same'), call('same')]);
  assert.equal(run('opaque','same').kind, 'unknown');
  write([call('same'), call('same','id2')]);
  assert.equal(run('id2','same').response.exit_code, 9);
  fs.writeFileSync(f.short, jsonl([generic(6, completed(0,'not this call'))]));
  assert.equal(run('opaque','one').kind, 'unknown');
});

// Observe real router input and decision; exercise the actual verification gate and state.
function observePostflight() {
  const fs = require('node:fs');
  const path = require('node:path');
  const router = require(path.join(process.env.HARNESS_ROOT, 'core/engine/scripts/hooks/postflight-router.cjs'));
  const route = router.route;
  router.route = async function (payload, ...rest) {
    const result = await route.call(this, payload, ...rest);
    const gate = result.results.find(r => r.source === 'verification-gate');
    fs.appendFileSync(path.join(process.env.HARNESS_STATE_DIR, 'routed'), JSON.stringify({
      id: payload.tool_use_id, event: payload.hook_event_name, code: payload.tool_response?.exit_code,
      verdict: gate?.verification?.ok, error: payload.error,
    }) + '\n');
    return result;
  };
}

function bridgeFixture(t, extraPreload) {
  const f = files(t), preload = path.join(f.dir,'observe.cjs');
  fs.writeFileSync(preload, '(' + observePostflight.toString() + ')();');
  if (extraPreload) fs.appendFileSync(preload, '\n(' + extraPreload.toString() + ')();');
  const env = { ...process.env, HARNESS_ROOT: root, HARNESS_STATE_DIR: f.dir, HARNESS_SQLITE_PATH: path.join(f.dir,'test.db'),
    NODE_OPTIONS: '--require="' + preload.split(path.sep).join('/') + '"' };
  const invoke = (event, fields) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--no-warnings',path.join(__dirname,'bridge.cjs'),event],
      { env, cwd: f.dir, windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        try { assert.doesNotMatch(stderr,/unhandled error|deferred-postflight/); resolve(JSON.parse(stdout)); }
        catch (error) { reject(error); }
      });
    child.stdin.end(JSON.stringify({ cwd: f.dir, conversationId: 'session', transcriptPath: f.short, ...fields }));
  });
  const post = (stepIdx, id, command, fields = {}) => invoke('PostToolUse',
    { stepIdx, toolCall: { name:'run_command', id, args:{ CommandLine:command } }, ...fields });
  function records() {
    const file = path.join(f.dir,'routed');
    return fs.existsSync(file) ? fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse) : [];
  }
  const stateFile = path.join(f.dir,'var','antigravity-bridge.json');
  const pending = () => JSON.parse(fs.readFileSync(stateFile)).sessions.session.pendingSettlements;
  return { ...f, invoke, post, replay: () => invoke('PreInvocation', {}), records, pending, stateFile };
}

test('background completion correlates the system task and waits for full verification evidence', async t => {
  const f = bridgeFixture(t);
  const logs = path.join(f.dir, 'logs'), tasks = path.join(f.dir, 'tasks');
  fs.mkdirSync(logs); fs.mkdirSync(tasks);
  const transcriptPath = path.join(logs, 'transcript.jsonl'), full = path.join(logs, 'transcript_full.jsonl');
  const running = generic(1, 'Tool is running as a background task with task id: session/task-1', {status:'RUNNING'});
  const finish = (step, task, result, extra = {}) => ({ step_index:step, type:'SYSTEM_MESSAGE', source:'SYSTEM',
    status:'DONE', content:'Task id "' + task + '" finished with result:\n' + result, ...extra });
  fs.writeFileSync(transcriptPath, jsonl([running, finish(2,'other/task-1',completed(0,'RESULT: PASS'))]));
  await f.post(1,'task','pytest -q',{ transcriptPath });
  assert.equal(f.pending().length,1);
  const preview = "The tool's output was truncated due to being too long.\n" + completed(0,'RESULT: PASS');
  const old = JSON.parse(fs.readFileSync(f.stateFile));
  old.sessions.session.pendingSettlements[0].queuedAt -= 660000;
  fs.writeFileSync(f.stateFile,JSON.stringify(old));
  await f.replay();
  assert.equal(f.pending().length,1,'a named background task may still run after ten minutes');
  fs.appendFileSync(transcriptPath,jsonl([finish(3,'session/task-1',preview,truncated)]));
  fs.writeFileSync(full,jsonl([finish(3,'session/task-1',preview)]));
  await f.replay();
  assert.equal(f.pending().length,1);
  fs.writeFileSync(path.join(tasks,'task-1.log'),'RESULT: FAIL\n');
  await Promise.all([f.replay(),f.replay()]);
  await f.replay();
  assert.deepEqual(f.pending(),[]);
  assert.deepEqual(f.records().map(r=>[r.id,r.event,r.code,r.verdict]),[['task','PostToolUse',0,false]]);
  const second = generic(4, 'Tool is running as a background task with task id: session/task-4', {status:'RUNNING'});
  fs.appendFileSync(transcriptPath,jsonl([second]));
  await f.post(4,'passing','pytest -q',{ transcriptPath });
  fs.appendFileSync(transcriptPath,jsonl([finish(5,'session/task-4',completed(0,'2 passed'))]));
  await f.replay();
  assert.deepEqual(f.pending(),[]);
  assert.equal(f.records().at(-1).verdict,true);
});

test('clean hooks skip bridge writes and concurrent invocations deliver each risk advisory once per turn', async t => {
  const f = bridgeFixture(t, function stubPreflight() {
    const path = require('node:path');
    require(path.join(process.env.HARNESS_ROOT,'core/engine/scripts/hooks/preflight-router.cjs')).decide =
      async payload => {
        const name = payload.tool_input.file_path;
        const advisory = '[risk-policy] Risk R3: exact authorization';
        return {decision:'allow',additionalContext:name === 'risk' ? advisory :
          name === 'mixed' ? advisory + '\n\nFresh context' :
          name === 'changed' ? '[risk-policy] Risk R3: new requirement' : ''};
      };
  });
  const pre = name => f.invoke('PreToolUse',{toolCall:{name:'read_file',args:{Path:name}}});
  const prompt = (id) => f.invoke('PreInvocation',{lastUserInput:'same words',lastUserInputStepIndex:id});
  const hasRisk = r => referencedText(r).includes('[risk-policy] Risk R3:');
  await pre('clean');
  await f.replay();
  assert.equal(fs.existsSync(f.stateFile),false);
  await prompt(4);
  await pre('risk');
  assert.equal((await Promise.all([prompt(4),prompt(4)])).filter(hasRisk).length,1);
  await pre('risk');
  assert.equal(hasRisk(await prompt(4)),false);
  await pre('mixed');
  const mixed = await prompt(4);
  assert.doesNotMatch(JSON.stringify(mixed), /Fresh context|\[risk-policy\]/);
  assert.match(referencedText(mixed),/Fresh context/);
  assert.equal(hasRisk(mixed),false);
  await pre('changed');
  assert.match(referencedText(await prompt(4)),/new requirement/);
  const saved = fs.statSync(f.stateFile,{bigint:true});
  await Promise.all([pre('clean'),pre('clean'),f.replay()]);
  const idle = fs.statSync(f.stateFile,{bigint:true});
  assert.equal(idle.ino,saved.ino);
  assert.equal(idle.mtimeNs,saved.mtimeNs);
  await prompt(9);
  await pre('risk');
  assert.equal(hasRisk(await prompt(9)),true);
  // Native payloads can omit a user-input index. The transcript still distinguishes
  // identical text on a new user step from later invocations on that same turn.
  fs.writeFileSync(f.short,jsonl([{type:'USER_INPUT',source:'USER_EXPLICIT',step_index:12}]));
  const native = () => f.invoke('PreInvocation',{lastUserInput:'same words'});
  await native();
  await pre('risk');
  assert.equal(hasRisk(await native()),true);
  await pre('risk');
  assert.equal(hasRisk(await native()),false);
});

function referencedText(response) {
  const system = response.injectSteps?.[0]?.systemMessage.systemMessage || '';
  const match = system.match(/ File: (.+)$/m);
  if (!match) return '';
  const data = JSON.parse(fs.readFileSync(JSON.parse(match[1]), 'utf8'));
  assert.equal(data.kind, 'untrusted-reference');
  return data.text;
}

test('contended invocation returns prompt context promptly and preserves queued delivery for retry', async t => {
  const f = bridgeFixture(t, function stubPrompt() {
    const path = require('node:path');
    require(path.join(process.env.HARNESS_ROOT,'core/engine/scripts/hooks/prompt-context.cjs')).combinePromptContext =
      () => ({hookSpecificOutput:{additionalContext:'prompt reference fixture'}});
  });
  await f.invoke('PreInvocation', { lastUserInput:'first' });
  const state = JSON.parse(fs.readFileSync(f.stateFile));
  state.sessions.session.pendingContexts.push('queued reference fixture');
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  fs.writeFileSync(f.stateFile + '.lock', JSON.stringify({token:'fixture',pid:process.pid}), {flag:'wx'});
  const start = Date.now();
  const response = await f.invoke('PreInvocation', {lastUserInput:'second'});
  const elapsed = Date.now() - start;
  t.diagnostic('contended PreInvocation wall time: ' + elapsed + ' ms');
  assert.ok(elapsed < 2000);
  assert.match(JSON.stringify(response), /remains queued/);
  assert.doesNotMatch(JSON.stringify(response), /reference fixture/);
  assert.match(referencedText(response), /prompt reference fixture/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).sessions.session.pendingContexts, ['queued reference fixture']);
  fs.unlinkSync(f.stateFile + '.lock');
  assert.match(referencedText(await f.invoke('PreInvocation', {lastUserInput:'second'})), /queued reference fixture/);
  assert.deepEqual(await f.invoke('PreInvocation', {lastUserInput:'second'}), {});
});

test('loss of the commit lock after postflight preserves the diagnostic without rerouting', async t => {
  const f = bridgeFixture(t, function contendAfterRouting() {
    const fs = require('node:fs');
    const path = require('node:path');
    const router = require(path.join(process.env.HARNESS_ROOT,'core/engine/scripts/hooks/postflight-router.cjs'));
    const route = router.route;
    router.route = async (...args) => {
      const result = await route(...args);
      fs.writeFileSync(path.join(process.env.HARNESS_STATE_DIR,'var','antigravity-bridge.json.lock'), '{}', {flag:'wx'});
      return {...result, additionalContext:'settled diagnostic fixture'};
    };
  });
  fs.writeFileSync(f.short, '');
  await f.post(1, 'one-outcome', 'git status');
  fs.appendFileSync(f.short, jsonl([generic(1, completed(1,'detail'))]));
  assert.match(JSON.stringify(await f.replay()), /remains queued/);
  assert.equal(f.records().length, 1);
  assert.equal(f.pending().length, 1);
  fs.unlinkSync(f.stateFile + '.lock');
  const results = await Promise.all([f.replay(), f.replay()]);
  assert.equal(results.filter(r => referencedText(r).includes('settled diagnostic fixture')).length, 1);
  assert.deepEqual(f.pending(), []);
  assert.deepEqual(await f.replay(), {});
  assert.equal(f.records().length, 1);
  assert.deepEqual(fs.readdirSync(path.join(path.dirname(f.stateFile),'antigravity-settlement-receipts')), []);
});

test('concurrent deferred registrations merge by call ID and replay each outcome once', async t => {
  const f = bridgeFixture(t, function observeLockFlush() {
    const fs = require('node:fs');
    const path = require('node:path');
    const lock = path.join(process.env.HARNESS_STATE_DIR, 'var', 'antigravity-bridge.json.lock');
    const flush = fs.fsyncSync;
    fs.fsyncSync = function (fd) {
      const owner = fs.statSync(lock, { bigint: true, throwIfNoEntry: false });
      if (owner && fs.fstatSync(fd, { bigint: true }).ino === owner.ino) {
        fs.appendFileSync(path.join(process.env.HARNESS_STATE_DIR, 'token-flush'), '1\n');
      }
      return flush.call(this, fd);
    };
  });
  const steps = [1, 2, 3, 4, 5, 6, 7, 8];
  const id = step => 'pending-' + step;
  fs.writeFileSync(f.short, '');
  await Promise.all([...steps, 4].map(step => f.post(step, id(step), 'git status')));
  assert.deepEqual(f.pending().map(item => item.payload.tool_use_id).sort(), steps.map(id));
  assert.deepEqual(f.records(), []);
  fs.appendFileSync(f.short, jsonl(steps.map(step => generic(step, completed(step % 2, 'detail')))));
  await Promise.all([f.replay(), f.replay(), f.replay()]);
  await f.replay();
  assert.deepEqual(f.pending(), []);
  assert.deepEqual(f.records().map(r => [r.id, r.event, r.code]).sort(), steps.map(step =>
    [id(step), step % 2 ? 'PostToolUseFailure' : 'PostToolUse', step % 2]));
  assert.equal(fs.existsSync(path.join(f.dir, 'token-flush')), false,
    'a bridge queue transaction must not flush its temporary lock token');
});

test('deferred registration waits for a held lock and retries short transactions promptly', async t => {
  const f = bridgeFixture(t, function observeRetries() {
    const fs = require('node:fs');
    const path = require('node:path');
    const wait = Atomics.wait;
    Atomics.wait = function (...args) {
      fs.appendFileSync(path.join(process.env.HARNESS_STATE_DIR, 'waits'), args[3] + '\n');
      return wait.apply(this, args);
    };
  });
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  const lock = f.stateFile + '.lock';
  fs.writeFileSync(lock, JSON.stringify({ token: 'test-owner' }), { flag: 'wx' });
  const registration = f.post(1, 'held', 'git status');
  const log = path.join(f.dir, 'waits');
  let delays = [];
  try {
    const deadline = Date.now() + 3500;
    while (delays.length < 6 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (fs.existsSync(log)) delays = fs.readFileSync(log, 'utf8').trim().split('\n').map(Number);
    }
    assert.equal(fs.existsSync(f.stateFile), false);
  } finally {
    fs.unlinkSync(lock);
    await registration;
  }
  assert.deepEqual(f.pending().map(item => item.payload.tool_use_id), ['held']);
  assert.ok(delays.length >= 6);
  assert.ok(delays[0] > 0 && delays[0] < 25, 'short queue locks should retry before 25 ms');
  assert.equal(delays.at(-1), 25, 'sustained contention should back off to the normal interval');
});

test('a temporary Windows sharing violation preserves the pending entry and its replay claim',
  { skip: process.platform !== 'win32' }, async t => {
    const f = bridgeFixture(t, function simulateBusyDestination() {
      const fs = require('node:fs');
      const path = require('node:path');
      const dest = path.join(process.env.HARNESS_STATE_DIR, 'var', 'antigravity-bridge.json');
      const blocked = new Map();
      const rename = fs.renameSync;
      fs.renameSync = function (from, to) {
        if (to === dest && (blocked.get(from) || 0) < 2) {
          blocked.set(from, (blocked.get(from) || 0) + 1);
          throw Object.assign(new Error('fixture sharing violation'), { code: 'EPERM' });
        }
        return rename.call(this, from, to);
      };
    });
    fs.writeFileSync(f.short, '');
    await f.post(1, 'busy', 'git status');
    assert.deepEqual(f.pending().map(item => item.payload.tool_use_id), ['busy']);
    fs.appendFileSync(f.short, jsonl([generic(1, completed(7, 'late error'))]));
    await f.replay();
    await f.replay();
    assert.deepEqual(f.pending(), []);
    assert.deepEqual(f.records().map(r => [r.id, r.event, r.code]), [['busy', 'PostToolUseFailure', 7]]);
  });

test('a failed queue write reports the command as unsettled', async t => {
  const f = bridgeFixture(t, function failStateWrite() {
    const fs = require('node:fs');
    const path = require('node:path');
    const dest = path.join(process.env.HARNESS_STATE_DIR, 'var', 'antigravity-bridge.json');
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (to === dest) throw Object.assign(new Error('fixture write failure'), { code: 'EIO' });
      return rename.call(this, from, to);
    };
  });
  fs.writeFileSync(f.short, '');
  await f.post(1, 'write-failed', 'git status');
  const dir = path.join(f.dir, 'var', 'telemetry');
  const events = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).flatMap(name =>
    fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  assert.deepEqual(events.map(e => [e.type, e.reason]), [['tool.post.unsettled', 'state-write-failed']]);
  assert.deepEqual(f.records(), []);
});

test('ordinary inline, transcript-only failure, invalid calls and missing exit status', async t => {
  const f = bridgeFixture(t);
  fs.writeFileSync(f.short, jsonl([generic(3, completed(4,'ordinary failure')), generic(4,'Error invalid tool call', { status: 'INVALID' }),
    generic(5, 'No output from the command.')]));
  await f.post(1,'inline','git status',{exitCode:0});
  await f.post(2,'inline-fail','git status',{tool_response:{exit_code:17,stdout:'failed'}});
  await f.post(3,'transcript-fail','git status');
  await f.post(4,'invalid','git status');
  await f.post(5,'unknown','git status');
  await f.post(undefined,'no-locator','git status',{transcriptPath:undefined});
  assert.deepEqual(f.records().map(e=>[e.id,e.event,e.code]), [
    ['inline','PostToolUse',0],['inline-fail','PostToolUseFailure',17],['transcript-fail','PostToolUseFailure',4],
    ['invalid','PostToolUseFailure',undefined]]);
  assert.deepEqual(f.pending().map(e=>e.payload.tool_use_id),['unknown']);
});

test('running, partial flush, late full output and concurrent settlement against the real router', async t => {
  const f = bridgeFixture(t);
  fs.writeFileSync(f.short, jsonl([generic(1,'Tool is running as a background task with task id: 15',{status:'RUNNING'}),
    generic(2, completed(0,'RESULT: PASS'), truncated)]));
  await Promise.all([f.post(1,'background','git status'), f.post(2,'verify','pytest -q')]);
  assert.deepEqual(f.records(), []);
  assert.equal(f.pending().length, 2);
  // Already queued host retries and unrelated results cannot mark a pending command complete.
  await f.post(2,'verify','pytest -q');
  fs.appendFileSync(f.short, jsonl([generic(3,completed(0,'not the background command'))]));
  await f.replay();
  assert.deepEqual(f.records(), []);
  assert.equal(f.pending().length, 2);
  // Legacy saved items have no snapshot. A partial full record still gives no verdict.
  const state = JSON.parse(fs.readFileSync(f.stateFile));
  for(const item of state.sessions.session.pendingSettlements) delete item.snapshot;
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  const detail = jsonl([generic(2,completed(0,'RESULT: FAIL'))]);
  fs.writeFileSync(f.full, detail.slice(0,-4));
  await f.replay();
  assert.deepEqual(f.records(), []);
  fs.appendFileSync(f.full, detail.slice(-4));
  fs.writeFileSync(f.short, jsonl([generic(1,completed(3,'process stopped')),generic(2,completed(0,'RESULT: PASS'),truncated)]));
  await Promise.all([f.replay(), f.replay()]);
  assert.deepEqual(f.pending(), []);
  assert.deepEqual(f.records().map(r=>[r.id,r.event,r.code,r.verdict]).sort(),[
    ['background','PostToolUseFailure',3,undefined],['verify','PostToolUse',0,false]]);
  fs.writeFileSync(f.short,jsonl([generic(4,completed(0,'truncated'),truncated)]));
  fs.writeFileSync(f.full,jsonl([generic(4,completed(0,'2 passed\nRESULT: PASS'))]));
  await f.post(4,'verified','pytest -q');
  assert.equal(f.records().at(-1).verdict,true);
  // Only the full file changes. A cached miss in the compact file must not
  // suppress a newly flushed verification body.
  fs.writeFileSync(f.short,jsonl([generic(5,completed(0,'RESULT: PASS'),truncated)]));
  await f.post(5,'full-only','pytest -q');
  assert.equal(f.pending().length,1);
  fs.appendFileSync(f.full,jsonl([generic(5,completed(0,'RESULT: FAIL'))]));
  await f.replay();
  assert.equal(f.pending().length,0);
  assert.equal(f.records().at(-1).verdict,false);
  // No hook ran during the retention window. A now-visible exit still counts.
  await f.post(6,'late-exit','git status');
  const old = JSON.parse(fs.readFileSync(f.stateFile));
  old.sessions.session.pendingSettlements[0].queuedAt = Date.now() - 660000;
  fs.writeFileSync(f.stateFile, JSON.stringify(old));
  fs.appendFileSync(f.short,jsonl([generic(6,completed(13,'late failure'))]));
  await f.replay();
  assert.equal(f.records().at(-1).code,13);
  assert.equal(f.pending().length,0);
});
