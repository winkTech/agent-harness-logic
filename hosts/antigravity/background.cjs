'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = require('./resolve-root.cjs').resolveHarnessRoot(__dirname).root;
process.env.HARNESS_ROOT = root;
const scripts = path.join(root, 'core', 'engine', 'scripts');
const { varPath } = require(path.join(scripts, 'lib/harness-state.cjs'));
const { withFileLockSync } = require(path.join(scripts, 'lib/project-scope.cjs'));
const { appendToSpool } = require(path.join(scripts, 'io/telemetry-spool.cjs'));
const { envOf } = require(path.join(scripts, 'io/env.cjs'));

const [job, arg1, arg2] = process.argv.slice(2);

function persistenceDisabled() {
  const e = envOf(process.env);
  return e.noPersist || e.verifyReadonly || e.noDiagnosticWrites || process.env.HARNESS_HOOK_NO_WRITE === '1';
}

function runScheduler() {
  // The bridge only creates files for the current UTC day. Pruning older
  // generations cannot race a new reference to identical content.
  const dir = varPath('antigravity-context');
  try {
    if (fs.lstatSync(dir).isDirectory()) {
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.[a-f0-9]{64}\.json$/.test(entry.name) && entry.name.slice(0, 10) < cutoff) {
          fs.unlinkSync(path.join(dir, entry.name));
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') appendToSpool({ type: 'background.error', host: 'antigravity', job: 'context-cleanup', error: error.message });
  }
  // Consumers enforce their own deadlines (12 + 30 + 15 seconds).
  const result = spawnSync(process.execPath, [path.join(scripts, 'consumer-scheduler.cjs'), '--auto'], {
    cwd: root, encoding: 'utf8', timeout: 70000, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || /:(?:timeout|error|exit:\d+)|\[consumer-scheduler\] 失败/.test(result.stderr)) {
    throw new Error(result.stderr.trim() || `scheduler exited ${result.status}`);
  }
  // M2: Run periodic memory/knowledge maintenance when due (mirrors Claude Code SessionStart).
  if (!persistenceDisabled()) {
    const maint = spawnSync(
      process.execPath,
      [path.join(scripts, 'memory-knowledge-maintenance.cjs'), '--auto', '--execute', '--quiet'],
      { cwd: root, encoding: 'utf8', timeout: 90000, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    if (maint.error || maint.status !== 0) {
      appendToSpool({
        type: 'background.error',
        host: 'antigravity',
        job: 'memory-maintenance',
        error: maint.error?.message || maint.stderr?.trim() || `maintenance exited ${maint.status}`,
      });
    }
  }
}

function runStopHarvest(transcriptPath, modelName) {
  if (persistenceDisabled()) return;
  const sessionId = process.env.HARNESS_SESSION_ID || '';
  if (transcriptPath && sessionId && fs.existsSync(transcriptPath)) {
    try {
      const { recordTranscriptUsage } = require(path.join(root, 'core', 'engine', 'sqlite', 'store-costs.cjs'));
      recordTranscriptUsage({
        sessionId,
        transcriptPath,
        model: modelName || 'antigravity-model',
      });
    } catch (error) {
      appendToSpool({ type: 'background.error', host: 'antigravity', job: 'cost-usage', error: error.message });
    }
  }
  for (const [name, fn] of [
    ['plan-accuracy', () => require(path.join(scripts, 'plan-accuracy.cjs')).harvestPlanAccuracy({ sessionId: sessionId || undefined })],
    ['fp-rate', () => require(path.join(scripts, 'fp-rate-tracker.cjs')).harvestFpRate()],
    ['spool-drain', () => require(path.join(scripts, 'io/spool-drain-lib.cjs')).drainSpool({ consumerId: 'telemetry-spool-drain' })],
  ]) {
    try {
      fn();
    } catch (error) {
      appendToSpool({ type: 'background.error', host: 'antigravity', job: name, error: error.message });
    }
  }
}

try {
  if (job === 'consumers') {
    // Concurrent Antigravity starts share one due check and runner chain.
    withFileLockSync(varPath('antigravity-consumers'), runScheduler, { timeoutMs: 0, staleMs: 120000 });
  } else if (job === 'stop-harvest') {
    withFileLockSync(varPath('antigravity-stop-harvest'), () => runStopHarvest(arg1, arg2), { timeoutMs: 0, staleMs: 60000 });
  } else if (job === 'git-integrity') {
    require('./git-integrity.cjs').checkAtStop(process.env.HARNESS_SESSION_ID);
  } else if (job === 'index-file' && path.isAbsolute(arg1 || '')) {
    // Indexing also resolves cross-file edges. Serialize the read from disk
    // and the database update together, so a delayed worker sees the latest edit.
    const { runFileSync } = require(path.join(scripts, 'hooks/codegraph-sync.cjs'));
    withFileLockSync(varPath('antigravity-index'), () => {
      runFileSync({ file_path: arg1 }, { removeMissing: true });
    }, { timeoutMs: 60000, staleMs: 300000 });
  } else {
    throw new Error('Unknown background job or missing file path');
  }
} catch (error) {
  if (!['consumers', 'stop-harvest'].includes(job) || error.code !== 'STATE_LOCK_TIMEOUT') {
    appendToSpool({
      type: 'background.error',
      host: 'antigravity',
      job,
      sessionId: process.env.HARNESS_SESSION_ID,
      error: error.message,
    });
    process.exitCode = 1;
  }
}
