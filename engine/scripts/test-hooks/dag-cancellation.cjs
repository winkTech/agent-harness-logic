'use strict';

const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-cancellation-'));
const previousDbPath = process.env.CLAUDE_SQLITE_PATH;
process.env.CLAUDE_SQLITE_PATH = path.join(tempRoot, 'events.db');
const dag = require(path.join(root, 'engine', 'dag-engine.cjs'));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function testCooperativeTimeoutDoesNotOverlapRetries() {
  let active = 0;
  let maxActive = 0;
  let attempts = 0;
  let aborts = 0;

  const result = await dag.runNode('cooperative-timeout', async (_ctx, control) => {
    assert(control.signal instanceof AbortSignal, 'node control must expose an AbortSignal');
    attempts += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        active -= 1;
        resolve();
      }, 500);
      control.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        aborts += 1;
        active -= 1;
        reject(control.signal.reason || new Error('aborted'));
      }, { once: true });
    });
  }, {}, {
    timeoutMs: 20,
    cancelGraceMs: 100,
    retryCount: 1,
    maxLoopRetries: 99,
  });

  assert.equal(result.status, 'fail');
  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
  assert.equal(aborts, 2);
  assert.equal(maxActive, 1, 'a retry must not overlap the timed-out attempt');
}

async function testUncooperativeTimeoutIsNotRetried() {
  let attempts = 0;
  const release = deferred();
  const finished = deferred();

  const resultPromise = dag.runNode('uncooperative-timeout', async () => {
    attempts += 1;
    await release.promise;
    finished.resolve();
  }, {}, {
    timeoutMs: 20,
    cancelGraceMs: 30,
    retryCount: 1,
    maxLoopRetries: 99,
  });

  const outcome = await Promise.race([
    resultPromise.then((result) => ({ kind: 'result', result })),
    wait(250).then(() => ({ kind: 'deadline' })),
  ]);
  release.resolve();
  await Promise.race([finished.promise, wait(250)]);

  assert.equal(outcome.kind, 'result', 'caller must return after the cancellation grace period');
  const { result } = outcome;

  assert.equal(result.status, 'fail');
  assert.equal(result.errorCode, 'DAG_CANCEL_TIMEOUT');
  assert.equal(result.cancelled, false);
  assert.equal(result.attempts, 1);
  assert.equal(attempts, 1, 'an attempt that ignores cancellation must not be retried');
}

async function testFailFastCancelsSiblingNodes() {
  let siblingAborted = false;
  let failure;
  try {
    await dag.execute({
      fail: {
        deps: [],
        run: async () => {
          await wait(15);
          throw new Error('expected failure');
        },
      },
      sibling: {
        deps: [],
        run: async (_ctx, control) => {
          assert(control.signal instanceof AbortSignal, 'sibling must receive an AbortSignal');
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            control.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              siblingAborted = true;
              reject(control.signal.reason || new Error('aborted'));
            }, { once: true });
          });
        },
      },
    }, {
      failFast: true,
      timeoutMs: 1000,
      cancelGraceMs: 100,
      maxLoopRetries: 99,
    });
  } catch (error) {
    failure = error;
  }

  assert(failure, 'fail-fast execution must reject');
  assert.match(failure.message, /fail/);
  assert.equal(siblingAborted, true, 'fail-fast must cancel sibling nodes in the same layer');
  assert.deepEqual(failure.failedNodes, ['fail']);
  assert.deepEqual(failure.cancelledNodes, ['sibling']);
}

async function testPreCancelledNodeDoesNotStart() {
  const controller = new AbortController();
  controller.abort(new Error('cancel before start'));
  let started = false;

  const result = await dag.runNode('pre-cancelled', async () => {
    started = true;
  }, {}, { signal: controller.signal });

  assert.equal(started, false, 'a pre-cancelled node must not start');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.errorCode, 'DAG_ABORTED');
  assert.equal(result.cancelled, true);
  assert.equal(result.attempts, 0);
}

async function testParentTimeoutCodeNeverRetriesOrLoopSkips() {
  for (const failFast of [true, false]) {
    const controller = new AbortController();
    const parentTimeout = new Error('parent deadline expired');
    parentTimeout.code = 'DAG_TIMEOUT';
    controller.abort(parentTimeout);
    let starts = 0;
    const nodeName = `dag-test-parent-cancel-${failFast}`;

    let cancellation;
    try {
      await dag.execute({
        [nodeName]: {
          deps: [],
          run: async () => { starts += 1; },
        },
      }, {
        signal: controller.signal,
        failFast,
        allowLoopSkip: true,
        retryCount: 4,
        maxLoopRetries: 2,
      });
    } catch (error) {
      cancellation = error;
    }

    assert(cancellation, `external cancellation must reject when failFast=${failFast}`);
    assert.equal(cancellation.code, 'DAG_ABORTED');
    assert.deepEqual(cancellation.failedNodes, []);
    assert.deepEqual(cancellation.cancelledNodes, [nodeName]);
    assert.equal(starts, 0, 'pre-cancelled external work must never start');
  }
}

async function testExternalCancellationWithFailFastDisabled() {
  const controller = new AbortController();
  const started = deferred();

  const execution = dag.execute({
    cancellable: {
      deps: [],
      run: async (_ctx, control) => {
        started.resolve();
        await new Promise((resolve, reject) => {
          control.signal.addEventListener('abort', () => {
            reject(control.signal.reason || new Error('aborted'));
          }, { once: true });
        });
      },
    },
  }, {
    signal: controller.signal,
    failFast: false,
    cancelGraceMs: 100,
  });

  await started.promise;
  controller.abort(new Error('user cancelled execution'));
  let cancellation;
  try {
    await execution;
  } catch (error) {
    cancellation = error;
  }
  assert(cancellation, 'external cancellation must reject even when failFast=false');
  assert.equal(cancellation.code, 'DAG_ABORTED');
  assert.deepEqual(cancellation.cancelledNodes, ['cancellable']);
}

async function testContextCompatibilityAndListenerCleanup() {
  const parent = new AbortController();
  const prototype = { inherited: true };
  const ctx = Object.assign(Object.create(prototype), { value: 7 });
  let successSignal;

  const success = await dag.runNode('ctx-identity', async (received, control) => {
    assert.equal(received, ctx, 'runNode must preserve the original ctx identity');
    assert.equal(received.inherited, true);
    received.writeBack = 'visible';
    successSignal = control.signal;
    return received;
  }, ctx, { signal: parent.signal });

  assert.equal(success.status, 'ok');
  assert.equal(success.data, ctx);
  assert.equal(ctx.writeBack, 'visible');
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  assert.equal(getEventListeners(successSignal, 'abort').length, 0);

  const failureSignals = [];
  const failure = await dag.runNode('string-rejection', async (_received, control) => {
    failureSignals.push(control.signal);
    return Promise.reject('string rejection');
  }, ctx, {
    signal: parent.signal,
    retryCount: 1,
    maxLoopRetries: 99,
  });

  assert.equal(failure.status, 'fail');
  assert.equal(failure.error, 'string rejection');
  assert.equal(failure.attempts, 2);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  for (const signal of failureSignals) {
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  }
}

async function testAllowedLoopSkipIsNotFailure() {
  const result = await dag.execute({
    'dag-test-allowed-loop-skip': {
      deps: [],
      run: async () => {
        throw new Error('same deterministic failure');
      },
    },
  }, {
    failFast: true,
    allowLoopSkip: true,
    retryCount: 4,
    maxLoopRetries: 2,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.failedNodes, []);
  assert.deepEqual(result.loopSkippedNodes, ['dag-test-allowed-loop-skip']);
}

(async () => {
  try {
    await testCooperativeTimeoutDoesNotOverlapRetries();
    await testUncooperativeTimeoutIsNotRetried();
    await testFailFastCancelsSiblingNodes();
    await testPreCancelledNodeDoesNotStart();
    await testParentTimeoutCodeNeverRetriesOrLoopSkips();
    await testExternalCancellationWithFailFastDisabled();
    await testContextCompatibilityAndListenerCleanup();
    await testAllowedLoopSkipIsNotFailure();
    process.stdout.write('DAG_CANCELLATION_RESULT: PASS\n');
  } finally {
    try {
      require(path.join(root, 'engine', 'sqlite', 'index.cjs')).closeAll();
    } catch { /* best-effort test cleanup */ }
    if (previousDbPath === undefined) delete process.env.CLAUDE_SQLITE_PATH;
    else process.env.CLAUDE_SQLITE_PATH = previousDbPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
