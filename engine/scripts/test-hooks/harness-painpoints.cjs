#!/usr/bin/env node
/**
 * Regression tests for harness failure modes found during the audit.
 *
 * These are intentionally behavior-focused:
 * - rules must be loaded deterministically, not by agent self-memory
 * - stale gate state must not unlock unrelated future work
 * - cleanup commands must not count as functional verification
 * - workflow evidence checks must not be delegated to agent self-report
 * - context compression must preserve hard constraints
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = path.join(os.homedir(), '.claude');

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function runNode(scriptPath, stdin, env = {}) {
  return spawnSync('node', [scriptPath], {
    input: stdin || '',
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function withFileBackup(filePath, fn) {
  const existed = fs.existsSync(filePath);
  const original = existed ? fs.readFileSync(filePath) : null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return fn();
  } finally {
    if (existed) {
      fs.writeFileSync(filePath, original);
    } else {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
}

test('rule loader injects core gates plus HDL/Python file rules', () => {
  const loader = require(path.join(HOME, 'engine/scripts/rule-loader.cjs'));
  loader.invalidateRuleIndex();

  const hdl = loader.evaluate('write RTL module and verify it', { openFiles: ['src/top.sv'] });
  assert(hdl, 'HDL evaluation returned no rules');
  const hdlFiles = new Set([...(hdl.matches || []), ...(hdl.allMatches || [])].map(item => (
    typeof item === 'string' ? item.replace(/\[.*$/, '') : item.file
  )));
  assert(hdlFiles.has('00-core.md'), '00-core.md was not loaded for HDL work');
  assert(hdlFiles.has('01-hdl.md'), '01-hdl.md was not loaded for .sv work');
  assert(hdlFiles.has('03-gates.md'), '03-gates.md was not loaded for HDL work');

  const py = loader.evaluate('modify code and run tests', { openFiles: ['tools/analyze.py'] });
  assert(py, 'Python evaluation returned no rules');
  const pyFiles = new Set([...(py.matches || []), ...(py.allMatches || [])].map(item => (
    typeof item === 'string' ? item.replace(/\[.*$/, '') : item.file
  )));
  assert(pyFiles.has('00-core.md'), '00-core.md was not loaded for Python work');
  assert(pyFiles.has('02-python.md'), '02-python.md was not loaded for .py work');
  assert(pyFiles.has('03-gates.md'), '03-gates.md was not loaded for Python work');
});

test('requirements gate rejects completed state scoped to another project', () => {
  const stateFile = path.join(HOME, 'var/gates/requirements-gate.json');
  const guard = path.join(HOME, 'engine/scripts/hooks/requirements-gate-guard.cjs');
  const target = path.join(os.tmpdir(), `harness-unrelated-${Date.now()}`, 'new_module.py');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'completed',
      task: 'old unrelated FPGA task',
      projectRoot: path.join(os.tmpdir(), 'old-project'),
      completedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
    });
    const r = runNode(guard, payload);
    assert(r.status === 2, `stale requirements state allowed a new unrelated file, exit=${r.status}`);
  });
});

test('verification quality gate rejects completed state scoped to another project', () => {
  const stateFile = path.join(HOME, 'var/gates/verification-quality.json');
  const guard = path.join(HOME, 'engine/scripts/hooks/verification-quality-guard.cjs');
  const target = path.join(os.tmpdir(), `harness-unrelated-${Date.now()}`, 'tb_new_module.sv');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'completed',
      module: 'old_module',
      projectRoot: path.join(os.tmpdir(), 'old-project'),
      completedAt: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target },
    });
    const r = runNode(guard, payload);
    assert(r.status === 2, `stale verification-quality state allowed a new unrelated TB, exit=${r.status}`);
  });
});

test('verification gate does not treat make clean as functional verification', () => {
  const stateFile = path.join(HOME, 'var/verify-gate.json');
  const gate = path.join(HOME, 'engine/scripts/hooks/verification-gate.cjs');

  withFileBackup(stateFile, () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      edited: true,
      verified: false,
      editCount: 1,
      lastEditTime: '2026-01-01T00:00:00.000Z',
    }, null, 2));

    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'make clean' },
    });
    const r = runNode(gate, payload);
    const state = readJson(stateFile, {});
    assert(r.status === 2, `make clean should be blocked while verification is pending, exit=${r.status}`);
    assert(state.edited === true && state.verified !== true, 'make clean cleared the pending verification state');
  });
});

test('context compression preserves constitution and dynamic rules', () => {
  const budget = require(path.join(HOME, 'engine/scripts/agent-context-budget.cjs'));
  const prompt = [
    '## Agent Constitution',
    'Hard rule: obey user constraints before efficiency.',
    '',
    '## Dynamic behaviour rules',
    'Ask for clarification when project requirements are ambiguous.',
    '',
    '## Memory Context (Auto-Loaded)',
    'x'.repeat(26000),
    '',
    '## AVAILABLE_SKILLS',
    'y'.repeat(6000),
  ].join('\n');

  const result = budget.compressPrompt(prompt, 'developer', { tier: 'normal' });
  assert(result.prompt.includes('## Agent Constitution'), 'constitution was removed during compression');
  assert(result.prompt.includes('## Dynamic behaviour rules'), 'dynamic behaviour rules were removed during compression');
});

test('workflow evidence gates are not based on agent self-report or catch-and-continue', () => {
  const workflowPath = path.join(HOME, 'workflows/hdl-coding-dag-workflow.js');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert(!workflow.includes('Does file exist:'), 'workflow still delegates file existence checks to agent self-report');
  assert(!workflow.includes('Read file:'), 'workflow still delegates file reads to agent self-report');
  assert(!workflow.includes('List .json files'), 'workflow still delegates directory listing to agent self-report');
  assert(!workflow.includes('06_doct'), 'workflow still contains the drifted 06_doct path');
  assert(
    !/catch\s*\(\s*e\s*\)\s*\{\s*results\s*\[\s*name\s*\]\s*=\s*\{\s*status:\s*'error'/s.test(workflow),
    'DAG executor still catches node errors and continues'
  );
});

function main() {
  let passed = 0;
  let failed = 0;

  console.log('\nHarness painpoint regression tests\n');
  for (const t of tests) {
    process.stdout.write(`  ${t.name.padEnd(82)} `);
    try {
      t.fn();
      passed += 1;
      console.log('PASS');
    } catch (e) {
      failed += 1;
      console.log('FAIL');
      console.log(`    ${e.message}`);
    }
  }

  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
