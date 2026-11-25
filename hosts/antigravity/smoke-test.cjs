#!/usr/bin/env node
'use strict';

/**
 * End-to-end 5-event smoke test for the Antigravity `logical-paradox` plugin.
 * Runs against an isolated temporary HARNESS_STATE_DIR so production state
 * (~/.logical-paradox) is NEVER modified.
 */

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_DIR = __dirname;
const CLAUDE_ROOT = require('./resolve-root.cjs').resolveHarnessRoot(__dirname).root;

function runBridge(eventName, stdinObj, env) {
  const t0 = Date.now();
  const res = cp.spawnSync(
    process.execPath,
    ['--no-warnings', '--require', __filename, path.join(PLUGIN_DIR, 'bridge.cjs'), eventName],
    {
      cwd: PLUGIN_DIR,
      input: JSON.stringify(stdinObj),
      env,
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    },
  );
  const ms = Date.now() - t0;
  assert.equal(res.status, 0, `${eventName} exited ${res.status}, stderr=${res.stderr}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch (e) {
    throw new Error(`${eventName} stdout is not valid JSON: ${JSON.stringify(res.stdout)} (stderr=${res.stderr})`);
  }
  return { parsed, ms, stderr: res.stderr };
}

// Preloaded only into the fixture bridge. Record the PID at dispatch, before
// even a slow-starting detached worker can open or recreate the state directory.
function trackBackgroundWorkers() {
  const spawn = cp.spawn;
  cp.spawn = function (command, args, ...rest) {
    const child = spawn.call(this, command, args, ...rest);
    if (child.pid && args?.includes(path.join(PLUGIN_DIR, 'background.cjs'))) {
      fs.appendFileSync(process.env.SMOKE_WORKER_PIDS, child.pid + '\n');
    }
    return child;
  };
}

async function waitForWorkers(file) {
  const pids = new Set(fs.readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
  const deadline = Date.now() + 90000;
  while (pids.size) {
    for (const pid of pids) {
      try { process.kill(pid, 0); } // Liveness query only.
      catch (error) {
        if (error.code !== 'ESRCH') throw error;
        pids.delete(pid);
      }
    }
    if (!pids.size) return;
    if (Date.now() >= deadline) throw new Error('Smoke workers still using ' + path.dirname(file) + ': ' + [...pids]);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-lp-smoke-'));
  const tmpState = path.join(tmpRoot, 'state');
  const tmpWork = path.join(tmpRoot, 'work');
  const transcriptPath = path.join(tmpRoot, 'transcript.jsonl');
  const workers = path.join(tmpRoot, 'worker-pids');
  fs.writeFileSync(workers, '');
  fs.mkdirSync(tmpState, { recursive: true });
  fs.mkdirSync(tmpWork, { recursive: true });
  fs.writeFileSync(transcriptPath, '', 'utf8');

  const env = {
    ...process.env,
    HARNESS_ROOT: CLAUDE_ROOT,
    HARNESS_STATE_DIR: tmpState,
    PLUGIN_ROOT: PLUGIN_DIR,
    PLUGIN_DATA: tmpState,
    SMOKE_WORKER_PIDS: workers,
  };

  const convId = 'ag-smoke-conv-001';
  const results = [];

  try {
    // 1. SessionStart
    const s1 = runBridge('SessionStart', {
      conversationId: convId,
      cwd: tmpWork,
      workspacePaths: [tmpWork],
      transcriptPath,
      hookEventName: 'SessionStart',
      modelName: 'gemini',
    }, env);
    assert.ok(typeof s1.parsed === 'object' && !Array.isArray(s1.parsed));
    results.push({ test: 'SessionStart', ms: s1.ms, injected: Boolean(s1.parsed.injectSteps?.length) });
    assert.match(s1.parsed.injectSteps[0].systemMessage.systemMessage, /Verify edits before reporting completion/);

    // 2. PreInvocation (first turn -> injects; second step same prompt -> deduped to {})
    const p1 = runBridge('PreInvocation', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      lastUserInput: '请帮我修改 rtl/fifo.sv 并运行 git commit',
      hookEventName: 'PreInvocation',
    }, env);
    const p2 = runBridge('PreInvocation', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      lastUserInput: '请帮我修改 rtl/fifo.sv 并运行 git commit',
      hookEventName: 'PreInvocation',
    }, env);
    assert.deepEqual(p2.parsed, {}, 'Duplicate PreInvocation for same prompt must return {}');
    results.push({
      test: 'PreInvocation(dedup)',
      firstMs: p1.ms,
      secondMs: p2.ms,
      firstInjected: Boolean(p1.parsed.injectSteps?.length),
      secondDeduped: Object.keys(p2.parsed).length === 0,
    });

    assert.doesNotMatch(JSON.stringify(s1.parsed), /out of sync|synchronization could not be verified/);
    // 3. PreToolUse: malicious command blocked -> { decision: "deny", reason }
    const b1 = runBridge('PreToolUse', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      hookEventName: 'PreToolUse',
      toolCall: { id: 'tc1', name: 'run_command', args: { CommandLine: 'rm -rf ~' } },
    }, env);
    assert.equal(b1.parsed.decision, 'deny', `Expected deny for rm -rf ~, got ${JSON.stringify(b1.parsed)}`);
    assert.ok(b1.parsed.reason && b1.parsed.reason.length > 5);
    results.push({ test: 'PreToolUse(block rm -rf ~)', ms: b1.ms, decision: b1.parsed.decision });

    // 4. PreToolUse: benign read_file allowed -> { decision: "allow" }
    const a1 = runBridge('PreToolUse', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      hookEventName: 'PreToolUse',
      toolCall: { id: 'tc2', name: 'read_file', args: { Path: path.join(tmpWork, 'README.md') } },
    }, env);
    assert.equal(a1.parsed.decision, 'allow');
    results.push({ test: 'PreToolUse(allow read_file)', ms: a1.ms, decision: a1.parsed.decision });

    // 5. Dual-phase verification-gate loop:
    //    5a. PostToolUse(write_file demo.py) marks pending verification
    const pyFile = path.join(tmpWork, 'demo.py');
    fs.writeFileSync(pyFile, 'def f(): return 1\n', 'utf8');
    const postWrite = runBridge('PostToolUse', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      stepIdx: 10,
      hookEventName: 'PostToolUse',
      toolCall: { id: 'tc3', name: 'write_file', args: { Path: pyFile, Content: 'def f(): return 1\n' } },
    }, env);
    assert.deepEqual(postWrite.parsed, {});

    //    5b. PreToolUse(run_command "python run_app.py") must be DENIED while verification is pending
    const blockedBeforeVerify = runBridge('PreToolUse', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      hookEventName: 'PreToolUse',
      toolCall: { id: 'tc4', name: 'run_command', args: { CommandLine: 'python run_app.py' } },
    }, env);
    assert.equal(blockedBeforeVerify.parsed.decision, 'deny', 'Must deny non-verify command while verification pending');

    // A second conversation sees the same pending project on its first Stop.
    const stop1 = runBridge('Stop', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      hookEventName: 'Stop',
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
    }, env);
    assert.equal(stop1.parsed.decision, 'continue');
    const stop2 = runBridge('Stop', {
      conversationId: convId + '-child',
      cwd: tmpWork,
      transcriptPath,
      hookEventName: 'Stop',
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
    }, env);
    assert.equal(stop2.parsed.decision, 'continue');

    //    5d. PreToolUse(run_command pytest, id='tc5') must be ALLOWED and records verification start
    const prePytest = runBridge('PreToolUse', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      hookEventName: 'PreToolUse',
      toolCall: { id: 'tc5', name: 'run_command', args: { CommandLine: 'pytest -q' } },
    }, env);
    assert.equal(prePytest.parsed.decision, 'allow', 'pytest verification command must be allowed');

    //    5e. PostToolUse(run_command pytest, id='tc5') BEFORE transcript is flushed -> deferred settlement
    const postPytest = runBridge('PostToolUse', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      stepIdx: 12,
      hookEventName: 'PostToolUse',
      toolCall: { id: 'tc5', name: 'run_command', args: { CommandLine: 'pytest -q' } },
    }, env);
    assert.deepEqual(postPytest.parsed, {});

    //    5e. Now Antigravity flushes step 12 with PASS evidence to transcript.jsonl!
    fs.appendFileSync(transcriptPath, `${JSON.stringify({
      step_index: 12,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created At: 2026-11-20\nCompleted At: 2026-11-20\nCommand exited with code 0.\n\nCommand output:\n1 passed in 0.05s\nRESULT: PASS\n',
    })}\n`, 'utf8');

    //    5f. Next PreToolUse(run_command "python run_app.py") drains deferred settlement -> clears pending -> ALLOW!
    const allowedAfterVerify = runBridge('PreToolUse', {
      conversationId: convId,
      cwd: tmpWork,
      transcriptPath,
      hookEventName: 'PreToolUse',
      toolCall: { id: 'tc6', name: 'run_command', args: { CommandLine: 'python run_app.py' } },
    }, env);
    assert.equal(
      allowedAfterVerify.parsed.decision,
      'allow',
      `Deferred transcript settlement failed to clear verification-gate: ${JSON.stringify(allowedAfterVerify)}`,
    );

    assert.equal(runBridge('Stop', {conversationId:convId+'-child', cwd:tmpWork,
      terminationReason:'NO_TOOL_CALL', continuationActive:true}, env).parsed.decision, 'allow');
    results.push({
      test: 'VerificationLoop(write->deny->stop->deferred-transcript-settle->allow)',
      blockedBeforeVerify: blockedBeforeVerify.parsed.decision,
      stopDecision: stop1.parsed.decision,
      stopInChild: stop2.parsed.decision,
      allowedAfterDeferredSettle: allowedAfterVerify.parsed.decision,
    });

  } finally {
    await waitForWorkers(workers);
    assert.equal(path.dirname(path.resolve(tmpRoot)), path.resolve(os.tmpdir()));
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
else if (process.env.SMOKE_WORKER_PIDS && require('node:worker_threads').isMainThread) trackBackgroundWorkers();
