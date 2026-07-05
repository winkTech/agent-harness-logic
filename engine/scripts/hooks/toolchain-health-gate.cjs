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

function payloadMode(payload) {
  if (!payload || payload.__invalid) process.exit(0);
  const eventName = String(payload.hook_event_name || '').toLowerCase();
  const toolName = String(payload.tool_name || payload.tool?.name || '').toLowerCase();
  if (eventName && eventName !== 'posttooluse') process.exit(0);
  if (toolName && toolName !== 'bash') process.exit(0);

  const command = payload?.tool_input?.command || payload?.tool?.input?.command || payload?.input?.command || '';
  if (!isToolchainCommand(command)) process.exit(0);

  const result = payload?.tool_response || payload?.tool_result || payload?.response || {};
  const status = result.status ?? result.exit_code ?? result.exitCode;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (status === undefined && !stdout && !stderr) process.exit(0);

  const enforce = process.env.TOOLCHAIN_HEALTH_GATE_ENFORCE === '1';
  const classification = classifyToolchainRun({ command, status, stdout, stderr, error: result.error || '' });
  finish(classification, enforce);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--classify')) return cliMode(args);
  return payloadMode(readPayload());
}

if (require.main === module) main();

module.exports = {
  cliMode,
  payloadMode,
};
