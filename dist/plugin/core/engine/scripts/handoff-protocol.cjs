#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/handoff-protocol.cjs — 跨宿主统一工程级会话交接协议
 *
 * 让 Claude Code、Codex、Antigravity、Grok、WorkBuddy 共享同一份结构化交接信封：
 *   - 自动采集当前工程 Git 分支/HEAD、最近一次通过的 verification-ledger 条目哈希
 *   - 记录 HDL/工作流连续性句柄（runId / signoffId / stateDir / checkpoint）
 *   - 供 /handoff 写入、供 state-resume.cjs 与 /start 在切换宿主时零摩擦恢复
 *
 * 用法：
 *   node core/engine/scripts/handoff-protocol.cjs write --project <dir> --host <host> --summary "..." [--next "step1;step2"] [--run-id X] [--signoff-id Y] [--checkpoint Z] [--state-dir D]
 *   node core/engine/scripts/handoff-protocol.cjs read [--project <dir>] [--json]
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const { varPath } = require('./lib/harness-state.cjs');
const scope = require('./lib/project-scope.cjs');
const { evidenceEntrySha256 } = require('./lib/evidence-ledger.cjs');

function projectKey(projectRoot) {
  const norm = scope.keyPath(path.resolve(projectRoot || '.'));
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function handoffDir(customDir) {
  return customDir ? path.resolve(customDir) : varPath('handoff');
}

function gitMetadata(projectRoot) {
  const run = (args) => {
    try {
      const r = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 4000 });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch { return null; }
  };
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    headSha: run(['rev-parse', '--short=12', 'HEAD']),
  };
}

function latestVerifiedLedgerEntry(projectRoot, ledgerFile = process.env.HARNESS_VERIFICATION_LEDGER_FILE || varPath('verification-ledger.json')) {
  try {
    if (!fs.existsSync(ledgerFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      if (e?.verification?.accepted === true && (!e.cwd || scope.isInsidePath(projectRoot, e.cwd) || scope.isInsidePath(e.cwd, projectRoot))) {
        return {
          command: e.command,
          recordedAt: e.recordedAt || e.completedAt || null,
          entrySha256: evidenceEntrySha256(e),
        };
      }
    }
  } catch { /* optional */ }
  return null;
}

function writeHandoff(input = {}, opts = {}) {
  const projectRoot = path.resolve(input.projectRoot || process.cwd());
  const dir = handoffDir(opts.handoffDir);
  fs.mkdirSync(dir, { recursive: true });
  const git = gitMetadata(projectRoot);
  const lastVerified = latestVerifiedLedgerEntry(projectRoot, opts.ledgerFile);
  const record = {
    schemaVersion: 1,
    updatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    fromHost: String(input.fromHost || process.env.HARNESS_HOST || 'unknown').trim(),
    sessionId: String(input.sessionId || process.env.HARNESS_SESSION_ID || '').trim() || null,
    projectRoot,
    git,
    workflow: (input.runId || input.signoffId || input.checkpoint || input.stateDir) ? {
      runId: input.runId || null,
      signoffId: input.signoffId || input.runId || null,
      checkpoint: input.checkpoint || null,
      stateDir: input.stateDir || null,
    } : null,
    lastVerified,
    summary: String(input.summary || '').trim(),
    nextSteps: Array.isArray(input.nextSteps) ? input.nextSteps.map((s) => String(s).trim()).filter(Boolean).slice(0, 5) : [],
    blockedOn: input.blockedOn ? String(input.blockedOn).trim() : null,
  };

  const perProjectFile = path.join(dir, `project-${projectKey(projectRoot)}.json`);
  const latestFile = path.join(dir, 'latest.json');
  for (const target of [perProjectFile, latestFile]) {
    scope.atomicWriteJson(target, record, { retryBusyRename: true });
  }
  return { file: perProjectFile, record };
}

function readHandoffForCwd(cwd = process.cwd(), opts = {}) {
  const dir = handoffDir(opts.handoffDir);
  const resolved = path.resolve(cwd);
  const candidates = [
    path.join(dir, `project-${projectKey(resolved)}.json`),
    path.join(dir, 'latest.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (rec?.schemaVersion !== 1 || !rec.projectRoot) continue;
      if (scope.isSamePath(resolved, rec.projectRoot) || scope.isInsidePath(resolved, rec.projectRoot)) {
        return rec;
      }
    } catch { /* next */ }
  }
  return null;
}

function formatHandoffCapsule(rec) {
  if (!rec) return '';
  const parts = [`[cross-host:${rec.fromHost}] ${rec.summary || 'prior session state'}`];
  if (rec.workflow?.runId) {
    parts.push(`workflow(runId=${rec.workflow.runId}, signoffId=${rec.workflow.signoffId || rec.workflow.runId}${rec.workflow.checkpoint ? `, cp=${rec.workflow.checkpoint}` : ''})`);
  }
  if (rec.nextSteps?.length) {
    parts.push(`next: ${rec.nextSteps.slice(0, 3).join(' -> ')}`);
  }
  return parts.join(' | ').slice(0, 360);
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      project: { type: 'string' },
      host: { type: 'string' },
      summary: { type: 'string' },
      next: { type: 'string' },
      'blocked-on': { type: 'string' },
      'run-id': { type: 'string' },
      'signoff-id': { type: 'string' },
      checkpoint: { type: 'string' },
      'state-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || !['write', 'read'].includes(cmd)) {
    console.log('Usage: handoff-protocol.cjs write --project <dir> --host <host> --summary "..." [--next "a;b"] [--run-id X] [--signoff-id Y]');
    console.log('       handoff-protocol.cjs read [--project <dir>] [--json]');
    return cmd ? 2 : 0;
  }

  if (cmd === 'write') {
    const written = writeHandoff({
      projectRoot: values.project || process.cwd(),
      fromHost: values.host,
      summary: values.summary,
      nextSteps: values.next ? values.next.split(/[;\n]/).map((s) => s.trim()).filter(Boolean) : [],
      blockedOn: values['blocked-on'],
      runId: values['run-id'],
      signoffId: values['signoff-id'],
      checkpoint: values.checkpoint,
      stateDir: values['state-dir'],
    });
    console.log(JSON.stringify(written, null, 2));
    return 0;
  }

  const found = readHandoffForCwd(values.project || process.cwd());
  if (values.json) console.log(JSON.stringify(found, null, 2));
  else console.log(found ? formatHandoffCapsule(found) : '(no cross-host handoff for project)');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (err) {
    console.error(`[handoff-protocol] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  projectKey,
  writeHandoff,
  readHandoffForCwd,
  formatHandoffCapsule,
  main,
};
