'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.HARNESS_ROOT;
const guard = path.join(root, 'core/engine/hooks/git/git-integrity-guard.cjs');
const { varPath } = require(path.join(root, 'core/engine/scripts/lib/harness-state.cjs'));
const { atomicWriteJson, withFileLockSync } = require(path.join(root, 'core/engine/scripts/lib/project-scope.cjs'));
const { appendToSpool } = require(path.join(root, 'core/engine/scripts/io/telemetry-spool.cjs'));
const { createHash } = require('node:crypto');
const checkout = createHash('sha256').update(fs.realpathSync.native(root)).digest('hex').slice(0, 20);
const noticeFile = varPath('antigravity-git', checkout + '.json');

function fullCheck() {
  const result = spawnSync(process.execPath, ['--no-warnings', guard], {
    cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const lines = output.split(/\r?\n/).filter(line => line && !line.startsWith('[git-integrity-guard] OK:'));
  if (result.error || (result.status !== 0 && result.status !== 2) || (!lines.length && !output)) {
    lines.push('[git-integrity-guard] Check incomplete: ' +
      (result.error?.message || result.signal || 'exit ' + result.status + ' without a verdict'));
  }
  return { output, notice: lines.join('\n') };
}

function checkAtStop(sessionId) {
  withFileLockSync(noticeFile, () => {
    const { notice } = fullCheck();
    if (!notice) return;
    const event = { type: 'git.integrity.notice', host: 'antigravity', sessionId,
      checkedAt: new Date().toISOString(), message: notice };
    appendToSpool(event);
    // Keep the last anomaly until a startup can display it, even if later checks are healthy.
    atomicWriteJson(noticeFile, event);
  }, { timeoutMs: 15000, staleMs: 20000 });
}

function checkAndCollectNotice() {
  const current = fullCheck();
  try {
    const previous = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
    if (previous.message) {
      current.notice = ['[Previous Stop ' + previous.checkedAt + '] ' + previous.message,
        current.notice].filter(Boolean).join('\n');
    }
    fs.unlinkSync(noticeFile);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      current.notice += '\n[git-integrity-guard] Could not read or clear previous Stop notice: ' + error.message;
    }
  }
  return current;
}

function checkAtStart(persist) {
  if (!persist) return fullCheck();
  try {
    return withFileLockSync(noticeFile, checkAndCollectNotice, { timeoutMs: 11000, staleMs: 20000 });
  } catch (error) {
    // If the notice directory is unavailable, workers cannot acquire this lock
    // either. Keep the legacy synchronous startup check and report the degradation.
    if (!['ENOTDIR', 'EROFS', 'ENOENT', 'EACCES'].includes(error.code)) throw error;
    const current = fullCheck();
    current.notice = [current.notice, '[git-integrity-guard] Stop notice storage unavailable: ' + error.message]
      .filter(Boolean).join('\n');
    return current;
  }
}

module.exports = { fullCheck, checkAtStop, checkAtStart };
