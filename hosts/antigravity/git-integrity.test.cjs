'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const source = require('./resolve-root.cjs').resolveHarnessRoot(__dirname).root;

// Instrument process boundaries only. The production guard still uses real Git.
function traceProcess() {
  if (!require('node:worker_threads').isMainThread) return;
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = process.env.HARNESS_STATE_DIR;
  const script = path.basename(process.argv[1]);
  const job = script === 'background.cjs' ? process.argv[2] : script;
  const trace = (phase) => fs.appendFileSync(path.join(dir, 'trace'),
    JSON.stringify({ job, phase, pid: process.pid, id: process.env.HARNESS_SESSION_ID }) + '\n');
  trace('start');
  process.on('exit', () => trace('exit'));
  if (script === 'git-integrity-guard.cjs' && fs.existsSync(path.join(dir, 'hold'))) {
    const deadline = Date.now() + 6000;
    while (fs.existsSync(path.join(dir, 'hold'))) {
      if (Date.now() > deadline) throw new Error('Foreground hook waited for held Git guard');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
}

async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-git-check-'));
  const repo = path.join(dir, 'harness');
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.cpSync(path.join(source, 'core'), path.join(repo, 'core'), { recursive: true });
  fs.copyFileSync(path.join(source, 'package.json'), path.join(repo, 'package.json'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'gc.auto', '0');
  for (const revision of ['one', 'two']) {
    fs.writeFileSync(path.join(repo, 'tracked'), revision);
    git('add', 'tracked');
    git('commit', '-qm', revision);
    if (revision === 'one') git('pack-refs', '--all');
  }
  const head = git('rev-parse', 'HEAD');
  const ref = path.join(repo, '.git/refs/heads/main');
  const observer = path.join(dir, 'observe.cjs');
  fs.writeFileSync(observer, '(' + traceProcess.toString() + ')();');
  const env = { ...process.env, HARNESS_ROOT: repo, HARNESS_PLUGIN_ROOT: repo, HARNESS_STATE_DIR: state,
    HARNESS_SQLITE_PATH: path.join(state, 'fixture.db'), HARNESS_TELEMETRY_SPOOL_DIR: path.join(state, 'spool'),
    NODE_OPTIONS: '--require="' + observer.split(path.sep).join('/') + '"' };
  let pendingSchedulers = 0;
  function events() {
    const file = path.join(state, 'trace');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  const count = (job, phase) => events().filter(e => e.job === job && e.phase === phase).length;
  const hold = path.join(state, 'hold');
  const release = () => fs.rmSync(hold, { force: true });
  t.after(async () => {
    release();
    await until(() => count('consumers', 'exit') >= pendingSchedulers, 'scheduler did not finish');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 80 });
  });
  function hook(event, sessionId, extra = {}, extraEnv = {}) {
    if (event === 'SessionStart' && !extraEnv.HARNESS_NO_PERSIST) pendingSchedulers++;
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['--no-warnings', path.join(__dirname, 'bridge.cjs'), event],
        { cwd: dir, env: { ...env, ...extraEnv }, timeout: 20000, windowsHide: true }, (error, stdout, stderr) => {
          if (error) return reject(error);
          try {
            assert.doesNotMatch(stderr, /unhandled error|bridge:background/);
            const result = JSON.parse(stdout);
            const system = (result.injectSteps || []).map(s => s.systemMessage.systemMessage).join('\n');
            assert.doesNotMatch(system, /CRITICAL|静默回退|Cannot find module/);
            const reference = system.match(/ File: (.+)$/m);
            const context = reference ? JSON.parse(fs.readFileSync(JSON.parse(reference[1]), 'utf8')).text : system;
            resolve({ result, stderr, context });
          } catch (err) { reject(err); }
        });
      child.stdin.end(JSON.stringify({ conversationId: sessionId, cwd: dir, ...extra }));
    });
  }
  return { repo, state, ref, head, git, hold, release, hook, count, events };
}

test('normal Stop returns before repair; overlapping Stop and SessionStart serialize full checks and report recovery once', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.ref);
  assert.notEqual(f.git('rev-parse', 'HEAD'), f.head, 'fixture must have a stale packed ref');
  fs.writeFileSync(f.hold, '');
  assert.equal((await f.hook('Stop', 'stop-a')).result.decision, 'allow');
  await until(() => f.count('git-integrity-guard.cjs', 'start') === 1, 'guard did not start');
  assert.notEqual(f.git('rev-parse', 'HEAD'), f.head, 'Stop waited for repair');
  assert.equal((await f.hook('Stop', 'stop-b')).result.decision, 'allow');
  const start = f.hook('SessionStart', 'start');
  await until(() => f.count('bridge.cjs', 'start') === 3, 'third hook did not start');
  f.release();
  const result = await start;
  await until(() => f.count('git-integrity', 'exit') === 2, 'Stop workers did not finish');
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  assert.equal(f.git('cat-file', '-t', f.head), 'commit');
  assert.match(result.context, /Previous Stop[\s\S]+静默回退[\s\S]+已恢复/);
  assert.match(result.stderr, /\[git-integrity-guard\] OK: HEAD=/);
  const phases = f.events().filter(e => e.job === 'git-integrity-guard.cjs').map(e => e.phase);
  assert.deepEqual(phases, ['start','exit','start','exit','start','exit']);
  assert.doesNotMatch((await f.hook('SessionStart', 'again')).context, /Previous Stop/);
});

test('startup repairs empty ref inline; missing HEAD object gets explicit Stop and startup diagnostics', async t => {
  const f = fixture(t);
  // With no older packed value an empty loose ref is rebuilt from the reflog.
  const skill = path.join(f.repo, 'packs/fixture/skills/fixture-drift');
  fs.mkdirSync(skill, { recursive:true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'fixture');
  fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'fixture rules');
  fs.unlinkSync(path.join(f.repo, '.git/packed-refs'));
  fs.writeFileSync(f.ref, '');
  const repaired = await f.hook('SessionStart', 'recover');
  assert.match(JSON.stringify(repaired.result), /out of sync/, repaired.stderr);
  assert.doesNotMatch(JSON.stringify(repaired.result), /fixture-drift/);
  assert.match(repaired.context, /fixture-drift/);
  assert.match(repaired.context, /HEAD ref .*恢复/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  const object = path.join(f.repo, '.git/objects', f.head.slice(0, 2), f.head.slice(2));
  fs.unlinkSync(object);
  await f.hook('Stop', 'broken');
  await until(() => f.count('git-integrity', 'exit') === 1, 'damaged Stop never finished');
  const broken = await f.hook('SessionStart', 'inspect');
  assert.match(broken.context, /Previous Stop[\s\S]+CRITICAL/);
  assert.match(broken.stderr, /CRITICAL:.*commit object/);
  assert.match(broken.context.split('\n').at(-1), /CRITICAL:.*commit object/);
  assert.equal(fs.existsSync(object), false);
  assert.equal(fs.readFileSync(f.ref, 'utf8').trim(), f.head);
});

test('cancellation / host errors skip checks; no-persist retains its synchronous check and startup exposes a failed guard process', async t => {
  const f = fixture(t);
  for (const reason of ['USER_CANCELED', 'ERROR']) {
    assert.equal((await f.hook('Stop', reason, { terminationReason: reason })).result.decision, 'allow');
  }
  const readonly = { HARNESS_NO_PERSIST: '1' };
  await f.hook('Stop', 'readonly', {}, readonly);
  assert.equal(f.count('git-integrity', 'start'), 0);
  assert.equal(f.count('git-integrity-guard.cjs', 'exit'), 1);
  fs.unlinkSync(path.join(f.repo, 'core/engine/hooks/git/git-integrity-guard.cjs'));
  const startup = await f.hook('SessionStart', 'unavailable', {}, readonly);
  assert.match(startup.context, /Git integrity check requires attention/);
  assert.match(startup.stderr, /Cannot find module/);
});

test('startup still checks and repairs when its Stop notice directory is inaccessible', async t => {
  const f = fixture(t);
  const stateVar = path.join(f.state, 'var');
  fs.mkdirSync(stateVar, { recursive: true });
  fs.writeFileSync(path.join(stateVar, 'antigravity-git'), 'directory unavailable');
  fs.unlinkSync(f.ref);
  const result = await f.hook('SessionStart', 'no-storage');
  assert.match(result.context, /Stop notice storage unavailable/);
  assert.match(result.context, /静默回退.*已恢复/);
  assert.equal(f.git('rev-parse', 'HEAD'), f.head);
});
