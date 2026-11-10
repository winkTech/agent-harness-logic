#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LEDGER = path.join(ROOT, 'engine', 'scripts', 'hooks', 'agent-transparency-ledger.cjs');

function runLedger(payload, env) {
  return spawnSync(process.execPath, [LEDGER], {
    cwd: payload.cwd,
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
}

function allText(dir) {
  const chunks = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) chunks.push(allText(target));
    else chunks.push(fs.readFileSync(target, 'utf8'));
  }
  return chunks.join('\n');
}

function payload(root, instruction) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd: root,
    session_id: 'privacy-session',
    user_message: instruction,
    tool_input: {
      file_path: path.join(root, 'src', 'example.txt'),
      content: 'bounded fixture content\n',
    },
  };
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transparency-retention-'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# test project\n', 'utf8');
  const instruction = 'Private customer instruction unique-marker-7f41: prepare release without copying this sentence.';
  const instructionHash = crypto.createHash('sha256').update(instruction).digest('hex');
  const explicitRunDir = path.join(root, 'explicit-run');
  const first = runLedger(payload(root, instruction), {
    CLAUDE_TRANSPARENCY_RUN_DIR: explicitRunDir,
    CLAUDE_TOOL_ACTION_CONTRACT_MODE: 'all',
  });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const persisted = allText(explicitRunDir);
  assert.ok(!persisted.includes(instruction), 'transparency artifacts must not persist full user instructions');
  const contract = JSON.parse(fs.readFileSync(path.join(explicitRunDir, 'task-contract.json'), 'utf8'));
  assert.equal(contract.instructionSha256, instructionHash);
  assert.equal(contract.instructionCaptured, true);
  assert.equal(typeof contract.instructionBytes, 'number');
  const toolContract = JSON.parse(fs.readFileSync(path.join(explicitRunDir, 'tool-action-contract.json'), 'utf8'));
  assert.equal(toolContract.match.userInstructionSha256, instructionHash);
  assert.equal(toolContract.match.userInstructionQuote, undefined);

  const runsRoot = path.join(root, 'managed-runs');
  fs.mkdirSync(runsRoot, { recursive: true });
  for (let index = 0; index < 55; index += 1) {
    const oldDir = path.join(runsRoot, `old-${String(index).padStart(2, '0')}`);
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'task-contract.json'), '{}', 'utf8');
    const when = new Date(Date.UTC(2025, 0, 1, 0, 0, index));
    fs.utimesSync(oldDir, when, when);
  }
  const retained = runLedger(payload(root, 'retention instruction'), {
    CLAUDE_TRANSPARENCY_RUNS_DIR: runsRoot,
    CLAUDE_TRANSPARENCY_RUN_ID: 'new-run',
    CLAUDE_TRANSPARENCY_MAX_RUNS: '50',
    CLAUDE_TOOL_ACTION_CONTRACT_MODE: 'all',
  });
  assert.equal(retained.status, 0, retained.stderr || retained.stdout);
  assert.equal(fs.readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, 50);
  assert.ok(fs.existsSync(path.join(runsRoot, 'new-run')));

  const rotateRunDir = path.join(root, 'rotate-run');
  for (let index = 0; index < 7; index += 1) {
    const rotatePayload = {
      ...payload(root, `rotate instruction ${index}`),
      hook_event_name: 'PostToolUse',
      tool_response: { status: 0, stdout: `event-${index}` },
    };
    const rotated = runLedger(rotatePayload, {
      CLAUDE_TRANSPARENCY_RUN_DIR: rotateRunDir,
      CLAUDE_TRANSPARENCY_MAX_EVENTS_BYTES: '1',
      CLAUDE_TRANSPARENCY_MAX_ROTATED_EVENTS: '3',
    });
    assert.equal(rotated.status, 0, rotated.stderr || rotated.stdout);
  }
  const rotatedFiles = fs.readdirSync(rotateRunDir)
    .filter((name) => /^events\..+\.ndjson$/.test(name));
  assert.equal(rotatedFiles.length, 3);

  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write('TRANSPARENCY_RETENTION_RESULT: PASS\n');
}

main();
