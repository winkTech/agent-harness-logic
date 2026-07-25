#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const {
  payloadCwd,
  payloadFilePath,
} = require('../lib/project-scope.cjs');

function toolNameFrom(payload) {
  if (typeof payload?.tool === 'string') return payload.tool;
  return payload?.tool?.name || payload?.tool_name || payload?.name || '';
}

function eventNameFrom(payload) {
  return payload?.hook_event_name || payload?.event || '';
}

function toolInputFrom(payload) {
  return payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
}

function contentFrom(payload) {
  const input = toolInputFrom(payload);
  return String(input.content || payload?.content || '');
}

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function isRtlSource(filePath) {
  return /\.(sv|v)$/i.test(filePath || '');
}

function isTestbenchOrSimulation(filePath) {
  const rel = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return /(?:^|\/)02_sim(?:\/|$)/.test(rel) || /(?:^|\/)(tb_|test_)[^/]*\.(sv|v)$/.test(rel);
}

function collectRoOutputs(code) {
  const outputs = new Set();
  const outputDecl = /\boutput\b([^;,\)]*)(ro_[A-Za-z_][A-Za-z0-9_$]*)/gi;
  let match;
  while ((match = outputDecl.exec(code))) outputs.add(match[2]);
  return [...outputs];
}

function collectAlwaysFfRoAssignments(code) {
  const assigned = new Set();
  const blocks = code.match(/\balways_ff\b[\s\S]*?\bend\b/g) || [];
  for (const block of blocks) {
    const lhs = /\b(ro_[A-Za-z_][A-Za-z0-9_$]*)\b\s*(?:<=|=)/g;
    let match;
    while ((match = lhs.exec(block))) assigned.add(match[1]);
  }
  return [...assigned];
}

function analyzeRtl(content, filePath = '') {
  const code = stripComments(content);
  const findings = [];
  const add = (severity, rule, message) => findings.push({ severity, rule, message });

  if (!/\bmodule\s+[A-Za-z_][A-Za-z0-9_$]*\b/.test(code)) {
    add('error', 'module-required', 'RTL source must contain a module declaration.');
  }

  if (/\binitial\b/.test(code)) {
    add('error', 'no-initial-in-rtl', 'Production RTL source must not contain initial blocks.');
  }
  if (/(^|[^A-Za-z0-9_$])#\s*\d/.test(code)) {
    add('error', 'no-delay-in-rtl', 'Production RTL source must not contain delay controls.');
  }
  if (/\b(force|release)\b/.test(code)) {
    add('error', 'no-force-release', 'Production RTL source must not use force/release.');
  }

  const roOutputs = collectRoOutputs(code);
  const roAssignedInAlwaysFf = collectAlwaysFfRoAssignments(code);
  const roAssignedSet = new Set(roAssignedInAlwaysFf);
  const directAssign = /\bassign\s+(ro_[A-Za-z_][A-Za-z0-9_$]*)(?:\s|\[|=)/gi;
  let directMatch;
  while ((directMatch = directAssign.exec(code))) {
    add('error', 'ro-output-register', `Output ${directMatch[1]} is driven by continuous assign; ro_ outputs must be registered.`);
  }
  if (roOutputs.length > 0 && roAssignedInAlwaysFf.length === 0) {
    add('error', 'ro-output-register', 'No ro_ output assignment was found inside always_ff.');
  }
  for (const signal of roOutputs) {
    if (!roAssignedSet.has(signal)) {
      add('warning', 'ro-output-coverage', `Could not prove ${signal} is assigned inside always_ff.`);
    }
  }

  const hasClockedLogic = /\balways_ff\b|\bposedge\b|\bnegedge\b/.test(code);
  if (hasClockedLogic && !/\b(rst|reset|ri_rst|ri_reset|ri_rst_n|ri_reset_n)\b/i.test(code)) {
    add('warning', 'reset-audit', 'Clocked RTL did not expose an obvious reset signal.');
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    filePath,
    findings,
  };
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function block(report) {
  console.error('[rtl-semantic-oracle] BLOCKED');
  console.error(`file: ${report.filePath}`);
  for (const finding of report.findings) {
    if (finding.severity === 'error') {
      console.error(`- ${finding.rule}: ${finding.message}`);
    }
  }
  process.exit(2);
}

function run(payload) {
  if (toolNameFrom(payload) !== 'Write') return { ok: true, skipped: true };
  if ((eventNameFrom(payload) || '') && eventNameFrom(payload) !== 'PreToolUse') return { ok: true, skipped: true };
  const cwd = payloadCwd(payload);
  const filePath = payloadFilePath(payload, cwd);
  if (!isRtlSource(filePath) || isTestbenchOrSimulation(filePath)) return { ok: true, skipped: true };
  const content = contentFrom(payload);
  if (!content) return { ok: true, skipped: true };
  const report = analyzeRtl(content, filePath);
  if (!report.ok) block(report);
  return { ok: true, skipped: false, report };
}

function main() {
  if (process.env.CLAUDE_RTL_SEMANTIC_ORACLE_DISABLED === '1') process.exit(0);
  try {
    run(parsePayload(readStdin()));
    process.exit(0);
  } catch (error) {
    console.error(`[rtl-semantic-oracle] internal error: ${error.stack || error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  analyzeRtl,
  run,
};
