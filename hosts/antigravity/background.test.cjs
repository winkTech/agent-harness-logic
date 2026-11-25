'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = require('./resolve-root.cjs').resolveHarnessRoot(__dirname).root;
const bridge = process.env.AG_TEST_BRIDGE || path.join(__dirname, 'bridge.cjs');

// Loaded only by the fixture processes. Hold the actual work until its
// triggering hook has returned; record which real executables ran to completion.
function observe() {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = process.env.HARNESS_STATE_DIR;
  const script = path.basename(process.argv[1] || '');
  const job = script === 'background.cjs' ? process.argv[2] : script;
  const log = (phase) => fs.appendFileSync(path.join(dir, 'trace'), JSON.stringify({ job, phase }) + '\n');
  const pause = () => {
    const limit = Date.now() + 12000;
    fs.writeFileSync(path.join(dir, 'waiting'), '');
    while (fs.existsSync(path.join(dir, 'hold'))) {
      if (Date.now() > limit) throw Error('Hook waited for its background work');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  };
  log('start');
  process.on('exit', () => log('exit'));
  if (script === 'bridge.cjs') {
    const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = function (command, args, options) {
      if (args.some(arg => path.basename(arg) === 'background.cjs')) log('dispatch');
      return spawn(command, args, options);
    };
  }
  if (script === 'consumer-scheduler.cjs') pause();
  if (job === 'index-file' && fs.existsSync(path.join(dir, 'hold'))) {
    const hook = require(path.join(process.env.HARNESS_ROOT, 'core/engine/scripts/hooks/codegraph-sync.cjs'));
    const sync = hook.runFileSync;
    hook.runFileSync = (...args) => { log('index-enter'); pause(); return sync(...args); };
  }
}

async function until(predicate, detail) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(detail);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-background-'));
  const project = path.join(dir, 'project with spaces');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const preload = path.join(dir, 'observe.cjs');
  fs.writeFileSync(preload, '(' + observe.toString() + ')();');
  const dbFile = path.join(dir, 'test.db');
  const db = require(path.join(root, 'core/engine/sqlite/index.cjs')).openDb({ path: dbFile });
  const env = { ...process.env, HARNESS_ROOT: root, HARNESS_STATE_DIR: dir, HARNESS_SQLITE_PATH: dbFile,
    NODE_OPTIONS: '--require="' + preload.split(path.sep).join('/') + '"', HARNESS_TELEMETRY_SPOOL_DIR: path.join(dir, 'spool') };
  const hold = path.join(dir, 'hold');
  fs.writeFileSync(hold, '');
  function release() { fs.rmSync(hold, { force: true }); }
  t.after(() => {
    release();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  function count(job, phase) {
    const trace = path.join(dir, 'trace');
    if (!fs.existsSync(trace)) return 0;
    return fs.readFileSync(trace, 'utf8').split('\n').filter(line => {
      try { const e = JSON.parse(line); return e.job === job && e.phase === phase; } catch { return false; }
    }).length;
  }
  function hook(event, id, toolCall, extraEnv = {}, extra = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['--no-warnings', bridge, event], {
        cwd: project, env: { ...env, ...extraEnv }, windowsHide: true, timeout: 20000,
      }, (err, stdout, stderr) => {
        if (err) return reject(err);
        try {
          assert.doesNotMatch(stderr, /unhandled error|bridge:background|bridge:codegraph-sync|stale or not running/);
          resolve(JSON.parse(stdout));
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify({ conversationId: id, cwd: project, toolCall, ...extra }));
    });
  }
  return { dir, project, db: db.db, count, hook, hold, release };
}

test('two starts return while due consumers are paused; each consumer runs once', async t => {
  const f = fixture(t);
  const ids = ['session-a', 'session-b'];
  const dir = path.join(f.dir, 'var', 'antigravity-context');
  fs.mkdirSync(dir, {recursive:true});
  const expired = path.join(dir, '2000-01-01.' + 'a'.repeat(64) + '.json');
  const unrelated = path.join(dir, 'user-file.json');
  fs.writeFileSync(expired, '{}');
  fs.writeFileSync(unrelated, '{}');
  await Promise.all(ids.map(id => f.hook('SessionStart', id)));
  await until(() => fs.existsSync(path.join(f.dir, 'waiting')), 'real scheduler did not start');
  await until(() => f.count('consumers', 'exit') >= 1, 'overlapping scheduler was not coalesced');
  assert.equal(f.count('consumer-scheduler.cjs', 'exit'), 0);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(unrelated), true);
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'var/antigravity-bridge.json')));
  assert.deepEqual(Object.keys(state.sessions).sort(), ids);
  // Bootstrap also updates Dream's heartbeat. Make all three consumers due
  // at the precise point where the paused scheduler will read the table.
  const due = f.db.prepare("UPDATE runtime_consumer_heartbeats SET next_due_at=? WHERE consumer='dream'")
    .run(new Date(Date.now() - 60000).toISOString());
  assert.equal(due.changes, 1);
  f.release();
  await until(() => f.count('consumers', 'exit') === 2, 'scheduler workers did not finish');
  for (const script of ['consumer-scheduler.cjs', 'dream-consolidate.cjs', 'skill-evolve.cjs', 'fp-rate-tracker.cjs']) {
    assert.equal(f.count(script, 'start'), 1, script);
    assert.equal(f.count(script, 'exit'), 1, script);
  }
  const rows = f.db.prepare('SELECT consumer,status FROM runtime_consumer_heartbeats ORDER BY consumer').all();
  for (const id of ['dream', 'fp-rate', 'skill-evolve']) {
    assert.match(rows.find(row => row.consumer === id)?.status || 'missing', /^(success|skipped)$/);
  }
});

test('continuous edits converge to disk, delete removes old symbols, skipped events spawn no worker', async t => {
  const f = fixture(t);
  const edit = (name, options = {}, extra = {}) => f.hook('PostToolUse', 'editor', {
    name: 'edit_file', args: { Path: name, Replacement: 'changed' },
  }, options, extra);
  const name = 'leaf file.sv';
  const write = (file, symbol) => fs.writeFileSync(path.join(f.project, file), 'module ' + symbol + '; endmodule\n');
  const names = () => f.db.prepare("SELECT name FROM cg_nodes WHERE kind='module' ORDER BY name").all().map(r => r.name);
  write(name, 'initial');
  await edit(name);
  await until(() => fs.existsSync(path.join(f.dir, 'waiting')), 'index worker did not reach actual index call');
  for (let i = 1; i <= 5; i++) {
    write(name, 'leaf_rev_' + i);
    await edit(name);
  }
  const other = 'neighbor.sv';
  write(other, 'neighbor');
  await f.hook('PostToolUse', 'editor', { name: 'write_file', args: { Path: other } });
  await until(() => f.count('index-file', 'start') === 7, 'edit workers did not start');
  assert.equal(f.count('index-file', 'index-enter'), 1, 'index operations overlapped inside the lock');
  assert.deepEqual(names(), []);
  f.release();
  await until(() => f.count('index-file', 'exit') === 7, 'index workers did not drain');
  assert.deepEqual(names(), ['leaf_rev_5', 'neighbor']);
  fs.unlinkSync(path.join(f.project, name));
  await edit(name);
  await until(() => f.count('index-file', 'exit') === 8, 'delete worker did not finish');
  assert.deepEqual(names(), ['neighbor']);
  const noPersist = { HARNESS_NO_PERSIST: '1' };
  const dispatched = f.count('bridge.cjs', 'dispatch');
  assert.equal(dispatched, 8);
  await f.hook('SessionStart', 'readonly', undefined, noPersist);
  await edit(other, noPersist);
  await edit(other, {}, { error: 'edit failed' });
  assert.equal(f.count('bridge.cjs', 'dispatch'), dispatched);
  assert.equal(f.count('consumers', 'start'), 0);
  assert.equal(f.count('index-file', 'start'), 8);
});
