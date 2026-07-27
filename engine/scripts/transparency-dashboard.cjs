#!/usr/bin/env node
'use strict';

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = HARNESS_ROOT;

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readEvents(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function runsDirFromArgs(args) {
  return path.resolve(argValue(args, '--runs-dir', process.env.CLAUDE_TRANSPARENCY_RUNS_DIR || path.join(HOME, 'var', 'runs')));
}

function collectRuns(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsDir, entry.name);
    const task = readJson(path.join(runDir, 'task-contract.json'), {});
    const skill = readJson(path.join(runDir, 'skill-plan.json'), {});
    const ledger = readJson(path.join(runDir, 'gate-ledger.json'), {});
    const toolContract = readJson(path.join(runDir, 'tool-action-contract.json'), {});
    const events = readEvents(path.join(runDir, 'events.ndjson'));
    const failures = (ledger.gates || []).filter((gate) => /required-not-completed|failed|blocked/i.test(gate.status || ''));
    rows.push({
      runId: task.runId || skill.runId || ledger.runId || entry.name,
      taskType: task.taskType || skill.taskType || 'unknown',
      instructionCaptured: Boolean(task.userInstruction || toolContract.match?.userInstructionQuote),
      matchStatus: toolContract.match?.status || 'not-captured',
      currentTool: ledger.summary?.currentTool || toolContract.tool || 'unknown',
      requiredSkills: skill.requiredSkills || [],
      loadedRules: skill.loadedRules || [],
      gateFailures: failures.map((gate) => `${gate.name}:${gate.status}`),
      events: events.length,
      updatedAt: ledger.updatedAt || toolContract.updatedAt || task.updatedAt || '',
      runDir,
    });
  }
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return rows;
}

function summarize(rows) {
  const captured = rows.filter((row) => row.instructionCaptured).length;
  const blocked = rows.filter((row) => row.gateFailures.length > 0).length;
  const skillCount = new Set(rows.flatMap((row) => row.requiredSkills)).size;
  return {
    totalRuns: rows.length,
    instructionCaptured: captured,
    gateFailureRuns: blocked,
    uniqueRequiredSkills: skillCount,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(report) {
  const rows = report.runs.map((run) => `
<tr>
  <td>${escapeHtml(run.runId)}</td>
  <td>${escapeHtml(run.taskType)}</td>
  <td>${escapeHtml(run.currentTool)}</td>
  <td>${run.instructionCaptured ? 'yes' : 'no'}</td>
  <td>${escapeHtml(run.matchStatus)}</td>
  <td>${escapeHtml(run.requiredSkills.join(', '))}</td>
  <td>${escapeHtml(run.gateFailures.join(', ') || 'none')}</td>
  <td>${escapeHtml(run.events)}</td>
</tr>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Transparency Dashboard</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;margin:24px;background:#111827;color:#e5e7eb}
h1{font-size:26px;margin:0 0 6px}
.sub{color:#9ca3af;margin-bottom:18px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:14px}
.kpi strong{display:block;font-size:26px}
table{width:100%;border-collapse:collapse;background:#1f2937;border:1px solid #374151}
th,td{padding:9px 10px;border-bottom:1px solid #374151;text-align:left;font-size:13px;vertical-align:top}
th{color:#93c5fd;font-weight:600}
tr:last-child td{border-bottom:0}
</style>
</head>
<body>
<h1>Agent Transparency Dashboard</h1>
<div class="sub">Generated ${escapeHtml(report.generatedAt)} from ${escapeHtml(report.runsDir)}</div>
<div class="kpis">
  <div class="kpi"><strong>${report.summary.totalRuns}</strong>Total runs</div>
  <div class="kpi"><strong>${report.summary.instructionCaptured}</strong>Instruction captured</div>
  <div class="kpi"><strong>${report.summary.gateFailureRuns}</strong>Runs with gate findings</div>
  <div class="kpi"><strong>${report.summary.uniqueRequiredSkills}</strong>Required skills</div>
</div>
<table>
<thead><tr><th>Run</th><th>Task</th><th>Tool</th><th>Instruction</th><th>Match</th><th>Skills</th><th>Gate findings</th><th>Events</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="8">No runs found</td></tr>'}
</tbody>
</table>
</body>
</html>`;
}

function buildReport(runsDir) {
  const runs = collectRuns(runsDir);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runsDir,
    summary: summarize(runs),
    runs,
  };
}

function main() {
  const args = process.argv.slice(2);
  const runsDir = runsDirFromArgs(args);
  const report = buildReport(runsDir);
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const outPath = path.resolve(argValue(args, '--out', path.join(HOME, 'var', 'agent-transparency-dashboard.html')));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderHtml(report), 'utf8');
  console.log(JSON.stringify({ outPath, summary: report.summary }, null, 2));
}

if (require.main === module) main();

module.exports = {
  buildReport,
  collectRuns,
  renderHtml,
  summarize,
};
