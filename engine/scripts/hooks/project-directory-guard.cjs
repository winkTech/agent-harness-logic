#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  validateActionPath,
  CONTRACT_FILE,
} = require('../lib/project-directory-contract.cjs');

function readPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toolName(payload) {
  return String(payload?.tool?.name || payload?.tool_name || payload?.name || '').trim();
}

function toolInput(payload) {
  return payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
}

function cwdFromPayload(payload) {
  return payload?.cwd || payload?.session?.cwd || process.cwd();
}

function block(filePath, failures, details = {}) {
  console.error('');
  console.error('PROJECT DIRECTORY GUARD - BLOCKED');
  console.error(`File: ${filePath}`);
  if (details.projectRoot) console.error(`Project root: ${details.projectRoot}`);
  if (details.relPath) console.error(`Relative path: ${details.relPath}`);
  console.error(`Contract: ${CONTRACT_FILE}`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('');
  console.error('Use the canonical HDL layout:');
  console.error('- RTL: 01_src/00_hdl/<module>/<module>.sv');
  console.error('- TB:  02_sim/<module>/tb_<module>.sv');
  console.error('- XDC: 03_xdc/<name>.xdc');
  console.error('');
  process.exit(2);
}

function main() {
  if (process.env.CLAUDE_GATES_DISABLED === 'true') process.exit(0);
  const payload = readPayload();
  const name = toolName(payload).toLowerCase();
  if (!['write', 'edit', 'multiedit'].includes(name)) process.exit(0);

  const input = toolInput(payload);
  const filePath = String(input.file_path || input.path || '').trim();
  if (!filePath) process.exit(0);

  const result = validateActionPath(path.normalize(filePath), cwdFromPayload(payload));
  if (!result.ok) block(filePath, result.failures, result);
  process.exit(0);
}

main();
