#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const { classifyToolchainRun, isToolchainCommand } = require('../lib/toolchain-health.cjs');

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function readPayload() {
  try {
    if (process.stdin.isTTY) return null;
    const text = fs.readFileSync(0, 'utf8').trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    return { __invalid: error.message };
  }
}

function finish(classification, enforce) {
  const body = { source: 'toolchain-health-gate', classification };
  if (classification.status === 'toolchain_failure') {
    console.error(JSON.stringify({ ...body, type: 'toolchain_failure' }, null, 2));
    process.exit(enforce ? 2 : 0);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

function cliMode(args) {
  const command = argValue(args, '--command');
  const status = argValue(args, '--status', '');
  const stdout = argValue(args, '--stdout', '');
  const stderr = argValue(args, '--stderr', '');
  const error = argValue(args, '--error', '');
  const enforce = !args.includes('--no-enforce');
  const classification = classifyToolchainRun({ command, status, stdout, stderr, error });
  finish(classification, enforce);
}

function evaluatePayload(payload, opts = {}) {
  const allow = (classification = null) => ({
    source: 'toolchain-health-gate',
    decision: 'allow',
    diagnostics: [],
    classification,
  });
  if (!payload || payload.__invalid) return allow();
  const eventName = String(payload.hook_event_name || '').toLowerCase();
  const toolName = String(payload.tool_name || payload.tool?.name || '').toLowerCase();
  if (eventName && eventName !== 'posttooluse' && eventName !== 'posttoolusefailure') return allow();
  if (toolName && toolName !== 'bash') return allow();

  const command = payload?.tool_input?.command || payload?.tool?.input?.command || payload?.input?.command || '';
  if (!isToolchainCommand(command)) return allow();

  const result = payload?.tool_response || payload?.tool_result || payload?.response || {};
  const status = result.status ?? result.exit_code ?? result.exitCode;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const error = result.error || payload.error || payload.message || '';
  if (status === undefined && !stdout && !stderr && !error) return allow();

  const enforce = opts.enforce ?? process.env.TOOLCHAIN_HEALTH_GATE_ENFORCE === '1';
  const classification = classifyToolchainRun({ command, status, stdout, stderr, error });
  if (classification.status !== 'toolchain_failure') return allow(classification);
  return {
    source: 'toolchain-health-gate',
    decision: enforce ? 'block' : 'warn',
    diagnostics: [`toolchain_failure: ${classification.reason || 'toolchain execution failed'}`],
    classification,
  };
}

function payloadMode(payload) {
  const result = evaluatePayload(payload);
  if (!result.classification) process.exit(0);
  finish(result.classification, result.decision === 'block');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--classify')) return cliMode(args);
  return payloadMode(readPayload());
}

if (require.main === module) main();

module.exports = {
  cliMode,
  evaluatePayload,
  payloadMode,
};
