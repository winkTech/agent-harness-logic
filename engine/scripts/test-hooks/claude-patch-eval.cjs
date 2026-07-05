#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = path.resolve(__dirname, '..', '..', '..');
const EXECUTOR = path.join(HOME, 'engine/scripts/test-hooks/claude-patch-executor.cjs');

const {
  extractAgentText,
  OLD_BLOCK,
  parsePlan,
  repairSpec,
} = require('./claude-patch-executor.cjs');
const {
  applyRepairSpec,
  evaluateRepairContent,
  normalizeRel,
  validateRepairSpec,
} = require('../lib/repair-contract.cjs');
const {
  commandEvidence,
  statusFromEvidence,
} = require('../lib/evidence-ledger.cjs');
const { classifyToolchainRun } = require('../lib/toolchain-health.cjs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text).replace(/\r\n/g, '\n'), 'utf8');
}

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-contract-fixture-'));
  const target = path.join(root, '01_src', '00_hdl', 'spi_fifo', 'spi_fifo.sv');
  writeText(target, [
    'module spi_fifo;',
    OLD_BLOCK,
    'endmodule',
    '',
  ].join('\n'));
  return { root, target };
}

function test(name, fn) {
  try {
    const detail = fn();
    return { name, status: 'passed', detail: detail || '' };
  } catch (error) {
    return { name, status: 'failed', detail: error.stack || error.message };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runAll() {
  const results = [];

  results.push(test('repair spec schema file is valid JSON', () => {
    const schemaPath = path.join(HOME, 'schemas/repair-spec.schema.json');
    JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    return 'schema parsed';
  }));

  results.push(test('RepairSpec rejects path escape', () => {
    const spec = {
      ...repairSpec(),
      allowedFiles: ['../escape.sv'],
      patches: [{ file: '../escape.sv', oldBlock: 'a', newBlock: 'b' }],
    };
    const result = validateRepairSpec(spec, { projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'repair-path-')) });
    assert(!result.ok, 'path escape should fail');
    assert(result.failures.some((failure) => /escapes project root|path escapes/.test(failure)), `unexpected failures: ${result.failures.join('|')}`);
    return result.failures.join('|');
  }));

  results.push(test('RepairSpec rejects readonly patch target', () => {
    const spec = {
      ...repairSpec(),
      readonlyFiles: [normalizeRel(path.join('01_src', '00_hdl', 'spi_fifo', 'spi_fifo.sv'))],
    };
    const result = validateRepairSpec(spec, { projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'repair-readonly-')) });
    assert(!result.ok, 'readonly target should fail');
    assert(result.failures.some((failure) => /readonly/.test(failure)), `unexpected failures: ${result.failures.join('|')}`);
    return result.failures.join('|');
  }));

  results.push(test('Exact replacement fails when oldBlock is absent', () => {
    const { root, target } = fixtureProject();
    writeText(target, fs.readFileSync(target, 'utf8').replace('ro_tx_valid <= i_pop && !i_fifo_empty;', 'ro_tx_valid <= 1\'b0;'));
    const result = applyRepairSpec(repairSpec(), { projectRoot: root });
    assert(!result.ok, 'oldBlock mismatch should fail');
    assert(result.failures.some((failure) => /matched 0/.test(failure)), `unexpected failures: ${result.failures.join('|')}`);
    return result.failures.join('|');
  }));

  results.push(test('RepairContentGate catches semantic drift', () => {
    const { root, target } = fixtureProject();
    const spec = repairSpec();
    writeText(target, [
      'module spi_fifo;',
      '  logic r_fwft_valid;',
      '  logic [7:0] r_fwft_data;',
      '  always_ff @(posedge i_clk) begin',
      '    ro_tx_valid <= i_pop && r_fwft_valid;',
      "    else begin",
      "      ro_tx_data <= '0;",
      '    end',
      '  end',
      'endmodule',
      '',
    ].join('\n'));
    const result = evaluateRepairContent(spec, { projectRoot: root });
    assert(!result.ok, 'semantic drift should fail');
    assert(result.failures.some((failure) => /required pattern|forbidden pattern/.test(failure)), `unexpected failures: ${result.failures.join('|')}`);
    return result.failures.join('|');
  }));

  results.push(test('EvidenceLedger requires command evidence, not model claims', () => {
    const status = statusFromEvidence([], ['node 03_verify/spi_fifo_contract.cjs']);
    assert(status.status === 'failed', 'missing command evidence should fail');
    assert(status.failures.some((failure) => /missing evidence/.test(failure)), `unexpected failures: ${status.failures.join('|')}`);
    const evidence = commandEvidence('node 03_verify/spi_fifo_contract.cjs', { status: 0, stdout: '{"status":"PASS"}', stderr: '' });
    assert(evidence.status === 'passed', 'real command evidence with exit 0 should pass');
    return status.failures.join('|');
  }));

  results.push(test('Codex JSONL agent_message is parsed as patch plan', () => {
    const plan = {
      schemaVersion: 1,
      output: 'REPAIR_PHASE_COMPLETE',
      patches: repairSpec().patches,
    };
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: JSON.stringify(plan) } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');
    const text = extractAgentText(jsonl);
    const parsed = parsePlan(text);
    assert(parsed.output === 'REPAIR_PHASE_COMPLETE', `bad output: ${parsed.output}`);
    assert(parsed.patches?.[0]?.file === repairSpec().patches[0].file, 'patch file mismatch');
    return 'agent_message.text parsed';
  }));

  results.push(test('ToolchainHealth classifies Vivado Windows loader crash', () => {
    const result = classifyToolchainRun({ command: 'xvlog work/top.sv', status: -1073741515, stdout: '', stderr: '' });
    assert(result.status === 'toolchain_failure', `expected toolchain_failure, got ${result.status}`);
    return result.reason;
  }));

  results.push(test('toolchain-health-gate CLI blocks loader crash', () => {
    const gate = path.join(HOME, 'engine/scripts/hooks/toolchain-health-gate.cjs');
    const r = spawnSync('node', [gate, '--classify', '--command', 'xvlog work/top.sv', '--status', '-1073741515'], {
      cwd: HOME,
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    assert(r.status === 2, `expected exit 2, got ${r.status}: ${r.stderr || r.stdout}`);
    assert(/toolchain_failure/.test(r.stderr || r.stdout), 'expected toolchain_failure output');
    return `exit=${r.status}`;
  }));

  results.push(test('ClaudePatchExecutor dry-run passes exact patch workflow', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-patch-executor-'));
    fs.rmSync(outDir, { recursive: true, force: true });
    const r = spawnSync('node', [EXECUTOR, '--dry-run', '--out', outDir], {
      cwd: HOME,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    assert(r.status === 0, `executor failed exit=${r.status}: ${r.stderr || r.stdout}`);
    const manifestPath = path.join(outDir, 'claude-patch-executor.json');
    assert(fs.existsSync(manifestPath), 'manifest missing');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(manifest.status === 'passed', `manifest status=${manifest.status}`);
    assert(manifest.dimensions.protocolCompliance === 'passed', 'protocol did not pass');
    assert(manifest.dimensions.contentGate === 'passed', 'content gate did not pass');
    assert(manifest.dimensions.evidenceLedger === 'passed', 'evidence ledger did not pass');
    return JSON.stringify(manifest.dimensions);
  }));

  const failed = results.filter((result) => result.status !== 'passed');
  const manifest = {
    schemaVersion: 1,
    mode: 'claude-patch-eval',
    status: failed.length === 0 ? 'passed' : 'failed',
    results,
  };
  return manifest;
}

function main() {
  const manifest = runAll();
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(manifest.status === 'passed' ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  runAll,
};
