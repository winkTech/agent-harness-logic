#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function runNode(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      if (status === 0) return resolve({ status, signal, stdout, stderr });
      reject(new Error(`child failed status=${status} signal=${signal || ''}\n${stderr || stdout}`));
    });
  });
}

function runNodeResult(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function verifyRetryAfterHandoff(projectScope, tempRoot) {
  const { mock } = require('node:test');
  const file = path.join(tempRoot, 'handoff.json');
  const lock = file + '.lock';
  const delays = [];
  fs.writeFileSync(lock, 'first owner', { flag: 'wx' });
  const older = new Date(Date.now() - 2000);
  fs.utimesSync(lock, older, older);
  // Drive the exact sequence without depending on scheduler timing. Both
  // owners keep the exclusive path occupied until the designated release.
  const wait = mock.method(Atomics, 'wait', (_array, _index, _value, delay) => {
    delays.push(delay);
    if (delays.length === 5) {
      fs.writeFileSync(lock + '.next', 'second owner', { flag: 'wx' });
      fs.renameSync(lock + '.next', lock);
    }
    if (delays.length === 8) fs.unlinkSync(lock);
    return 'timed-out';
  });
  let entries = 0;
  try {
    projectScope.withFileLockSync(file, () => {
      assert.equal(delays.length, 8, 'a handoff must not let a waiter enter the occupied lock');
      entries++;
    }, { initialRetryMs: 5 });
  } finally {
    wait.mock.restore();
  }
  assert.equal(entries, 1);
  assert.deepEqual(delays, [5, 10, 15, 20, 25, 5, 10, 15],
    'after a handoff the next owner must get a fresh retry interval');
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-state-concurrency-'));
  const projectScopePath = path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'project-scope.cjs');
  const verificationPath = path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'verification-state.cjs');
  const evidencePath = path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'evidence-ledger.cjs');
  const runtimeStatePath = path.join(ROOT, 'core', 'engine', 'scripts', 'runtime-state.cjs');
  const preCompactPath = path.join(ROOT, 'core', 'engine', 'scripts', 'pre-compact.cjs');
  const isolationCheckPath = path.join(ROOT, 'core', 'engine', 'scripts', 'hooks', 'isolation-check.cjs');
  const frustrationPath = path.join(ROOT, 'core', 'engine', 'scripts', 'hooks', 'frustration-detector.cjs');
  const watchdogPath = path.join(ROOT, 'core', 'engine', 'hooks', 'session', 'progress-watchdog.cjs');
  const sqlitePath = path.join(ROOT, 'core', 'engine', 'sqlite', 'index.cjs');
  const workerPath = path.join(tempRoot, 'worker.cjs');

  const projectScope = require(projectScopePath);
  verifyRetryAfterHandoff(projectScope, tempRoot);
  assert.equal(
    typeof projectScope.updateJsonFileSync,
    'function',
    'project-scope must export a lock-protected JSON transaction helper',
  );

  fs.writeFileSync(workerPath, `
'use strict';
const mode = process.argv[2];
const target = process.argv[3];
const iterations = Number(process.argv[4] || 1);
if (mode === 'counter') {
  const { updateJsonFileSync } = require(${JSON.stringify(projectScopePath)});
  for (let i = 0; i < iterations; i += 1) {
    updateJsonFileSync(target, () => ({ count: 0 }), (state) => ({ count: state.count + 1 }));
  }
} else if (mode === 'verification') {
  process.env.HARNESS_VERIFY_GATE_STATE_FILE = target;
  const { markEdited } = require(${JSON.stringify(verificationPath)});
  markEdited({ cwd: process.argv[5], filePath: process.argv[6], sessionId: process.argv[7], toolName: 'Edit' });
} else if (mode === 'evidence') {
  const { writeEvidenceLedger } = require(${JSON.stringify(evidencePath)});
  for (let i = 0; i < iterations; i += 1) {
    writeEvidenceLedger(target, { command: process.argv[5] + ':' + i, exitCode: 0, status: 'passed' });
  }
} else if (mode === 'watchdog') {
  const { updateProgress } = require(${JSON.stringify(watchdogPath)});
  updateProgress({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    cwd: process.argv[5],
    session_id: process.argv[6],
  }, {
    stateFile: target,
    archiveDir: process.argv[7],
    lockTimeoutMs: Number(process.argv[8] || 5000),
    forceTrack: true,
  });
} else {
  throw new Error('unknown worker mode');
}
`, 'utf8');

  const counterFile = path.join(tempRoot, 'counter.json');
  const workers = 8;
  const iterations = 20;
  await Promise.all(Array.from({ length: workers }, () =>
    runNode([workerPath, 'counter', counterFile, String(iterations)])));
  assert.equal(JSON.parse(fs.readFileSync(counterFile, 'utf8')).count, workers * iterations);

  const verificationFile = path.join(tempRoot, 'verification.json');
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# test project\n', 'utf8');
  await Promise.all(Array.from({ length: workers }, (_, index) =>
    runNode([
      workerPath,
      'verification',
      verificationFile,
      '1',
      projectRoot,
      path.join(projectRoot, `file-${index}.txt`),
      `session-${index}`,
    ])));
  const verification = JSON.parse(fs.readFileSync(verificationFile, 'utf8'));
  assert.equal(Object.keys(verification.pending || {}).length, workers);
  const originalGateFile = process.env.HARNESS_VERIFY_GATE_STATE_FILE;
  process.env.HARNESS_VERIFY_GATE_STATE_FILE = verificationFile;
  const vs = require(verificationPath);
  if (originalGateFile === undefined) delete process.env.HARNESS_VERIFY_GATE_STATE_FILE;
  else process.env.HARNESS_VERIFY_GATE_STATE_FILE = originalGateFile;
  const visible = vs.pendingForCwd(verification, projectRoot, {sessionId:'verifier'});
  assert.equal(visible.length, workers, 'a fresh session must see every concurrent writer');
  assert.deepEqual(visible.flatMap(entry => entry.files).sort(),
    Array.from({length:workers}, (_,i) => path.join(projectRoot, 'file-' + i + '.txt')).sort());

  const run = {cwd:projectRoot, session_id:'verifier', tool_use_id:'first'};
  const command = 'pytest -q';
  vs.startVerification(run, command);
  await Promise.all(Array.from({length:4}, (_,i) => runNode([workerPath, 'verification', verificationFile,
    '1', projectRoot, path.join(projectRoot, 'next-' + i + '.py'), 'session-' + i])));
  const finish = () => vs.markVerifiedForCwd(projectRoot, {sessionId:run.session_id,
    runKey:vs.verificationRunKey(run, command), correlated:true, passed:true});
  const first = finish();
  assert.equal(first.cleared.length, 4);
  assert.equal(first.state.editCount, 8, 'four newer writer revisions must remain pending');
  assert.equal(finish().cleared.length, 0, 'replaying the first completion must not clear more edits');
  run.tool_use_id = 'second';
  vs.startVerification(run, command);
  assert.equal(finish().state.editCount, 0, 'a fresh verifier can settle all remaining revisions');

  const evidenceFile = path.join(tempRoot, 'evidence.json');
  await Promise.all(Array.from({ length: workers }, (_, index) =>
    runNode([workerPath, 'evidence', evidenceFile, String(iterations), `worker-${index}`])));
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(evidence.entries.length, workers * iterations);
  const { writeEvidenceLedger } = require(evidencePath);
  for (let index = 0; index < 400; index += 1) {
    writeEvidenceLedger(evidenceFile, { command: `retention:${index}`, exitCode: 0, status: 'passed' });
  }
  const retainedEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(retainedEvidence.entries.length, 500);
  assert.equal(retainedEvidence.droppedEntries, 60);

  const runtimeFile = path.join(tempRoot, 'runtime-state.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ marker: 'isolated', failureCount: 0, failureHistory: [] }), 'utf8');
  const runtimeEnv = { HARNESS_RUNTIME_STATE_FILE: runtimeFile };
  const runtimeRead = await runNode([runtimeStatePath, 'get'], { env: runtimeEnv });
  assert.equal(JSON.parse(runtimeRead.stdout).marker, 'isolated', 'runtime-state must honor its injected state path');
  await Promise.all(Array.from({ length: workers }, () =>
    runNode([runtimeStatePath, 'bump-failure'], { env: runtimeEnv })));
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  assert.equal(runtime.failureCount, workers);
  assert.equal(runtime.failureHistory.length, workers);

  const hookRuntimeFile = path.join(tempRoot, 'hook-runtime.json');
  const hookSqliteFile = path.join(tempRoot, 'hook-memory.db');
  fs.writeFileSync(hookRuntimeFile, JSON.stringify({ keep: true, failureCount: 0, failureHistory: [], toolCalls: [] }), 'utf8');
  const hookStateEnv = {
    HARNESS_RUNTIME_STATE_FILE: hookRuntimeFile,
    HARNESS_SQLITE_PATH: hookSqliteFile,
    // The parent audit suite is read-only, but this fixture is fully isolated
    // under tempRoot and explicitly verifies the CLI persistence contract.
    HARNESS_NO_PERSIST: '0',
    HARNESS_NO_PERSIST: '0',
    HARNESS_VERIFY_READONLY: '0',
    HARNESS_VERIFY_READONLY: '0',
    HARNESS_NO_DIAGNOSTIC_WRITES: '0',
    HARNESS_NO_DIAGNOSTIC_WRITES: '0',
    HARNESS_HOOK_NO_WRITE: '0',
    HARNESS_HOOK_NO_WRITE: '0',
  };
  await runNode([isolationCheckPath], { env: hookStateEnv });
  const isolatedState = JSON.parse(fs.readFileSync(hookRuntimeFile, 'utf8'));
  assert.equal(isolatedState.keep, true);
  assert.equal(typeof isolatedState.lastIsolationCheck?.isIsolated, 'boolean');
  await runNode([frustrationPath, '还是不行'], { env: hookStateEnv });
  const frustratedState = JSON.parse(fs.readFileSync(hookRuntimeFile, 'utf8'));
  assert.equal(frustratedState.keep, true);
  assert.equal(frustratedState.failureCount, 1);

  const compactRuntimeFile = path.join(tempRoot, 'compact-runtime.json');
  const compactLogFile = path.join(tempRoot, 'compaction.log');
  const compactSignalFile = path.join(tempRoot, 'compact-needed.json');
  fs.writeFileSync(compactRuntimeFile, JSON.stringify({ compactCount: 7, toolCalls: [] }), 'utf8');
  const compactEnv = {
    HARNESS_RUNTIME_STATE_FILE: compactRuntimeFile,
    HARNESS_COMPACTION_LOG_FILE: compactLogFile,
    HARNESS_COMPACT_SIGNAL_FILE: compactSignalFile,
  };
  const compactStatus = await runNode([preCompactPath, '--status'], { env: compactEnv });
  assert.match(compactStatus.stdout, /压缩次数:\s*7/);
  await Promise.all(Array.from({ length: workers }, () => runNode([preCompactPath], { env: compactEnv })));
  const compactRuntime = JSON.parse(fs.readFileSync(compactRuntimeFile, 'utf8'));
  assert.equal(compactRuntime.compactCount, 7 + workers);
  assert.equal(fs.readFileSync(compactLogFile, 'utf8').trim().split(/\r?\n/).length, workers);

  const watchdogFile = path.join(tempRoot, 'watchdog.json');
  const watchdogLock = `${watchdogFile}.lock`;
  const watchdogArchive = path.join(tempRoot, 'watchdog-archive');
  fs.writeFileSync(watchdogLock, JSON.stringify({ token: 'held-by-test', pid: process.pid }), 'utf8');
  const lockedWatchdog = await runNodeResult([
    workerPath, 'watchdog', watchdogFile, '1', projectRoot, 'locked-session', watchdogArchive, '50',
  ]);
  assert.notEqual(lockedWatchdog.status, 0, 'watchdog must not write through an active state lock');
  assert.match(lockedWatchdog.stderr, /state lock|STATE_LOCK_TIMEOUT|Timed out/i);
  fs.unlinkSync(watchdogLock);
  await Promise.all(Array.from({ length: workers }, (_, index) =>
    runNode([
      workerPath, 'watchdog', watchdogFile, '1', projectRoot, `watchdog-${index}`, watchdogArchive, '15000',
    ])));
  const watchdog = JSON.parse(fs.readFileSync(watchdogFile, 'utf8'));
  assert.equal(Object.keys(watchdog.sessions || {}).length, workers);
  const { updateProgress } = require(watchdogPath);
  const { mock } = require('node:test');
  const failureState = path.join(tempRoot, 'failed-command.json');
  let lockFlushes = 0;
  const flush = fs.fsyncSync;
  const spy = mock.method(fs, 'fsyncSync', (fd) => {
    const lock = fs.statSync(failureState + '.lock', { bigint: true, throwIfNoEntry: false });
    if (lock && fs.fstatSync(fd, { bigint: true }).ino === lock.ino) lockFlushes++;
    return flush(fd);
  });
  try {
    updateProgress({
      hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
      tool_input: { command: 'git status' }, tool_response: { exit_code: 7 },
      cwd: projectRoot, session_id: 'ordinary-failure',
    }, { stateFile: failureState });
  } finally {
    spy.mock.restore();
  }
  const [failedSession] = Object.values(JSON.parse(fs.readFileSync(failureState)).sessions);
  assert.equal(failedSession.history.at(-1).event, 'PostToolUseFailure');
  assert.equal(failedSession.trackingScope.kind, 'repair_loop');
  assert.equal(lockFlushes, 0, 'a watchdog update must not flush the temporary lock token to disk');
  for (let index = 0; index < 70; index += 1) {
    updateProgress({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      cwd: projectRoot,
      session_id: `retention-session-${index}`,
    }, { stateFile: watchdogFile, archiveDir: watchdogArchive, forceTrack: true });
  }
  const retainedWatchdog = JSON.parse(fs.readFileSync(watchdogFile, 'utf8'));
  assert.equal(Object.keys(retainedWatchdog.sessions || {}).length, 64);

  const archiveRetentionFile = path.join(tempRoot, 'watchdog-retention.json');
  const archiveRetentionDir = path.join(tempRoot, 'watchdog-retained-archives');
  for (let index = 0; index < 55; index += 1) {
    updateProgress({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'node tests/failing.test.cjs' },
      cwd: projectRoot,
      session_id: `frozen-session-${index}`,
      error: 'test failure',
    }, {
      stateFile: archiveRetentionFile,
      archiveDir: archiveRetentionDir,
      maxNoProgressTurns: 1,
      maxArchives: 50,
      mode: 'enforce',
      now: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
    });
  }
  assert.equal(fs.readdirSync(archiveRetentionDir).filter((name) => name.endsWith('.json')).length, 50);

  const { openDb } = require(sqlitePath);
  const dbPath = path.join(tempRoot, 'state.db');
  const wDb = openDb({ path: dbPath });
  const busyTimeout = Number(wDb.db.prepare('PRAGMA busy_timeout').get().timeout || 0);
  assert.ok(busyTimeout >= 5000, `SQLite busy_timeout must be >=5000ms, got ${busyTimeout}`);
  wDb.close();

  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.stdout.write('STATE_CONCURRENCY_RESULT: PASS\n');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
