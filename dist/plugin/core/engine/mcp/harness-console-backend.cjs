'use strict';

/**
 * core/engine/mcp/harness-console-backend.cjs — Harness MCP App 控制台后端（M4）
 *
 * 为 Antigravity 侧边栏 MCP App（ui://harness/console.html）提供只读状态聚合
 * 与人类专属操作（通过 SEP-1865 `_meta.ui.visibility = ["app"]` 对模型完全隐藏）。
 *
 * 安全铁律：
 *   - 绝不读取、回显或序列化 settings.json / settings.local.json / .env 中的任何密钥；
 *   - 所有人类签核/重置/维护写入均落盘至 var/audit/mcp-app-actions.jsonl 审计账本。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('../scripts/lib/harness-root.cjs');
const { STATE_ROOT, varPath } = require('../scripts/lib/harness-state.cjs');
const { atomicWriteJson } = require('../scripts/lib/project-scope.cjs');
const { openDb } = require('../sqlite/index.cjs');
const { buildHealthReport } = require('../scripts/memory-health-check.cjs');
const acl = require('../scripts/lib/plugin-acl.cjs');

const APP_URI = 'ui://harness/console.html';

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendAudit(action, details = {}, opts = {}) {
  const auditPath = opts.auditFile || varPath('audit', 'mcp-app-actions.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    actor: 'mcp-app-human',
    action,
    ...details,
  };
  fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

function verifyGateFile(opts = {}) {
  return opts.verifyGateFile || process.env.HARNESS_VERIFY_GATE_STATE_FILE || varPath('verify-gate.json');
}

function readVerifyGate(opts = {}) {
  const file = verifyGateFile(opts);
  const raw = readJsonSafe(file, { version: 4, pending: {}, risk: {} }) || { version: 4, pending: {}, risk: {} };
  const pendingObj = raw.pending && typeof raw.pending === 'object' ? raw.pending : {};
  const riskPrimary = raw.risk && typeof raw.risk === 'object' ? raw.risk : {};
  const riskLegacy = raw.risks && typeof raw.risks === 'object' ? raw.risks : {};
  const riskMerged = { ...riskLegacy, ...riskPrimary };
  const pending = Object.entries(pendingObj).map(([key, item]) => ({
    key,
    projectRoot: item?.projectRoot || key.split('::')[0],
    sessionId: item?.sessionId || key.split('::')[1] || '',
    editCount: Number(item?.editCount || 0),
    lastEditedAt: item?.lastEditedAt || item?.updatedAt || null,
    tools: Array.isArray(item?.tools) ? item.tools : [],
  }));
  const risks = Object.entries(riskMerged).map(([key, item]) => ({
    key,
    level: item?.effectiveRiskLevel || item?.level || 'R1',
    humanSignoff: Boolean(item?.humanSignoff || item?.requiresHumanSignoff || item?.effectiveRiskLevel === 'R3'),
    verificationStatus: item?.verificationStatus || null,
    reasons: Array.isArray(item?.riskReasons) ? item.riskReasons : [],
    targets: Array.isArray(item?.targets) ? item.targets : [],
    updatedAt: item?.lastUpdatedAt || item?.updatedAt || null,
  }));
  return { file, pending, risks, pendingCount: pending.length, riskCount: risks.length };
}

function readHealthSnapshot(opts = {}) {
  let handle = null;
  try {
    handle = openDb(opts.dbPath ? { path: opts.dbPath } : {});
    const report = buildHealthReport({ db: handle.db || handle, home: opts.home || HARNESS_ROOT });
    return {
      status: report.status,
      score: report.score,
      issues: (report.issues || []).map((i) => ({
        code: i.code,
        severity: i.severity,
        penalty: i.penalty,
        message: i.message,
      })),
      consumers: (report.metrics?.events?.consumers || []).map((c) => ({
        consumer: c.consumer,
        pending: c.pending,
        status: c.heartbeat?.status || 'never-run',
        lastCompletedAt: c.heartbeat?.lastCompletedAt || null,
      })),
      maintenance: {
        due: Boolean(report.metrics?.maintenance?.due),
        ageDays: report.metrics?.maintenance?.ageDays ?? null,
        lastExecutedAt: report.metrics?.maintenance?.lastExecutedAt || null,
      },
      facts: {
        active: report.metrics?.facts?.active ?? 0,
        neverHit: report.metrics?.facts?.neverHit ?? 0,
        expired: report.metrics?.facts?.expired ?? 0,
      },
    };
  } catch (error) {
    return { status: 'error', score: 0, error: error.message, issues: [], consumers: [] };
  } finally {
    try { if (handle) handle.close(); } catch { /* ignore */ }
  }
}

function readPluginStatus(opts = {}) {
  const pluginDir = opts.pluginDir || path.join(os.homedir(), '.gemini', 'config', 'plugins', 'logical-paradox');
  const exists = fs.existsSync(pluginDir);
  const manifest = exists ? readJsonSafe(path.join(pluginDir, 'plugin.json'), null) : null;
  const pointer = exists ? readJsonSafe(path.join(pluginDir, '.source-root.json'), null) : null;
  return {
    installed: exists,
    pluginDir,
    version: manifest?.version || null,
    mode: pointer?.mode || (exists && fs.existsSync(path.join(pluginDir, 'core', 'engine')) ? 'portable' : 'thin-link'),
    sealed: exists ? acl.isSealed(pluginDir) : false,
    harnessRoot: HARNESS_ROOT,
    stateRoot: STATE_ROOT,
  };
}

function buildConsoleSnapshot(opts = {}) {
  const gate = readVerifyGate(opts);
  const health = readHealthSnapshot(opts);
  const plugin = readPluginStatus(opts);
  return {
    generatedAt: new Date().toISOString(),
    gate,
    health,
    plugin,
  };
}

function formatConsoleSummary(snapshot) {
  const lines = [
    `## Harness Maintenance Console`,
    `- **Memory Health**: \`${snapshot.health.status}\` (score **${snapshot.health.score}/100**, issues: ${snapshot.health.issues?.length || 0})`,
    `- **Verify Gate**: ${snapshot.gate.pendingCount} pending project(s), ${snapshot.gate.riskCount} active risk entry(s)`,
    `- **Antigravity Plugin**: ${snapshot.plugin.installed ? `installed (${snapshot.plugin.mode}, v${snapshot.plugin.version || '?'}, OS ACL sealed=${snapshot.plugin.sealed})` : 'not installed'}`,
  ];
  if (snapshot.health.issues?.length) {
    lines.push(`- **Active Issues**: ${snapshot.health.issues.map((i) => `${i.code}(-${i.penalty})`).join(', ')}`);
  }
  return lines.join('\n');
}

function resetGate(args = {}, opts = {}) {
  const scopeKey = String(args.scopeKey || '*').trim();
  const reason = String(args.reason || 'Human reset via Harness MCP App console').trim().slice(0, 240);
  const file = verifyGateFile(opts);
  const raw = readJsonSafe(file, { version: 4, pending: {}, risk: {} }) || { version: 4, pending: {}, risk: {} };
  const removed = [];

  if (scopeKey === '*' || scopeKey === 'all') {
    for (const k of Object.keys(raw.pending || {})) removed.push(`pending:${k}`);
    for (const k of Object.keys(raw.risk || {})) removed.push(`risk:${k}`);
    for (const k of Object.keys(raw.risks || {})) removed.push(`risk:${k}`);
    raw.pending = {};
    raw.risk = {};
    if (raw.risks) delete raw.risks;
  } else {
    if (raw.pending && Object.prototype.hasOwnProperty.call(raw.pending, scopeKey)) {
      delete raw.pending[scopeKey];
      removed.push(`pending:${scopeKey}`);
    }
    if (raw.risk && Object.prototype.hasOwnProperty.call(raw.risk, scopeKey)) {
      delete raw.risk[scopeKey];
      removed.push(`risk:${scopeKey}`);
    }
    if (raw.risks && Object.prototype.hasOwnProperty.call(raw.risks, scopeKey)) {
      delete raw.risks[scopeKey];
      removed.push(`risk:${scopeKey}`);
    }
  }
  raw.updatedAt = new Date().toISOString();
  atomicWriteJson(file, raw, { retryBusyRename: true });
  const audit = appendAudit('reset-gate', { scopeKey, reason, removed }, opts);
  return { ok: true, removed, audit, snapshot: buildConsoleSnapshot(opts) };
}

function signoffRisk(args = {}, opts = {}) {
  const scopeKey = String(args.scopeKey || '').trim();
  const reason = String(args.reason || 'Human R3 signoff via Harness MCP App console').trim().slice(0, 240);
  if (!scopeKey) {
    return { ok: false, error: 'scopeKey is required for human R3 signoff' };
  }
  const file = verifyGateFile(opts);
  const raw = readJsonSafe(file, { version: 4, pending: {}, risk: {} }) || { version: 4, pending: {}, risk: {} };
  const signedAt = new Date().toISOString();
  let cleared = false;

  if (raw.risk && Object.prototype.hasOwnProperty.call(raw.risk, scopeKey)) {
    delete raw.risk[scopeKey];
    cleared = true;
  }
  if (raw.risks && Object.prototype.hasOwnProperty.call(raw.risks, scopeKey)) {
    delete raw.risks[scopeKey];
    cleared = true;
  }
  if (raw.pending && Object.prototype.hasOwnProperty.call(raw.pending, scopeKey)) {
    delete raw.pending[scopeKey];
    cleared = true;
  }
  raw.signoffs = Array.isArray(raw.signoffs) ? raw.signoffs.slice(-49) : [];
  raw.signoffs.push({ scopeKey, signedBy: 'mcp-app-human', reason, signedAt });
  raw.updatedAt = signedAt;
  atomicWriteJson(file, raw, { retryBusyRename: true });
  const audit = appendAudit('human-signoff', { scopeKey, reason, cleared }, opts);
  return { ok: true, cleared, audit, snapshot: buildConsoleSnapshot(opts) };
}

function runMaintenance(args = {}, opts = {}) {
  const mode = args.mode === 'execute' ? 'execute' : 'dry-run';
  const script = path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'memory-knowledge-maintenance.cjs');
  const cliArgs = [script, mode === 'execute' ? '--execute' : '--dry-run', '--json'];
  if (args.force) cliArgs.push('--force');
  const res = spawnSync(process.execPath, cliArgs, {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000,
  });
  let parsed = null;
  try { parsed = JSON.parse((res.stdout || '').trim()); } catch { parsed = { raw: (res.stdout || '').slice(0, 800) }; }
  if (mode === 'execute') {
    appendAudit('run-maintenance', { mode, exitCode: res.status }, opts);
  }
  return {
    ok: res.status === 0,
    mode,
    exitCode: res.status,
    result: parsed,
    stderr: (res.stderr || '').slice(0, 400),
    snapshot: buildConsoleSnapshot(opts),
  };
}

function loadConsoleHtml() {
  const override = process.env.HARNESS_CONSOLE_HTML;
  const htmlPath = override && fs.existsSync(override)
    ? override
    : path.join(__dirname, 'ui', 'harness-console.html');
  return fs.readFileSync(htmlPath, 'utf8');
}

module.exports = {
  APP_URI,
  buildConsoleSnapshot,
  formatConsoleSummary,
  resetGate,
  signoffRisk,
  runMaintenance,
  loadConsoleHtml,
};
