#!/usr/bin/env node
/**
 * engine/scripts/bench-refactor.cjs — 重构基准薄壳 (Phase 0 步骤 0.6)
 *
 * 按 Phase 配置顺序执行既有 bench 命令, 汇总 pass/fail 写 verdict.json。
 * 只做编排: 命令引用各工具既有输出 (--json stdout / 工具落盘的 JSON / 退出码),
 * 不新造解析器; 指标经 quality-regression-dashboard 的 record CLI 入账。
 *
 * 用法:
 *   node engine/scripts/bench-refactor.cjs --phase 0            # 执行 phase 0
 *   node engine/scripts/bench-refactor.cjs --phase 0 --dry-run  # 只列将跑的命令
 *
 * 输出: var/bench-refactor/verdict.json (overall=pass|fail)
 * 退出码: 0=pass, 1=fail
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { varPath } = require('./lib/harness-state.cjs');

const R = (p) => path.join(HARNESS_ROOT, p);
const displayCmd = (cmd) => cmd.map((part) => (part === process.execPath ? 'node' : (path.relative(HARNESS_ROOT, part) || part))).join(' ');
const VERDICT_FILE = varPath('bench-refactor', 'verdict.json');

// json 字段声明机器可读结论的来源:
//   'stdout' → 工具自身 --json 输出 (bench-hooks);
//   'file'   → 工具运行后落盘的 JSON (gate-runner 的 gate-results.json);
//   null     → 工具无 --json (run-all-tests/asset-audit/evidence-snapshot),
//              只按退出码判 pass/fail。
const PHASES = {
  0: [
    {
      id: 'C-2', desc: 'run-all-tests --no-persist (全量回归套件)',
      cmd: [process.execPath, R('engine/scripts/test-hooks/run-all-tests.cjs'), '--no-persist'],
      json: null, timeoutMs: 420000,
    },
    {
      id: 'C-3', desc: 'bench-hooks --json --sla (diagnostics --bench 的数据源)',
      cmd: [process.execPath, R('engine/scripts/lib/bench-hooks.cjs'), '--json', '--sla'],
      json: 'stdout', timeoutMs: 180000,
    },
    {
      id: 'P-1a', desc: 'asset-audit (工程资产目录体检)',
      cmd: [process.execPath, R('engineering-assets/tools/asset-audit.cjs'), '--root', R('engineering-assets')],
      json: null, timeoutMs: 60000,
    },
    {
      id: 'P-1b', desc: 'evidence-snapshot --verify-all (证据封存全量校验)',
      cmd: [process.execPath, R('engineering-assets/tools/evidence-snapshot.cjs'), '--verify-all', '--root', R('engineering-assets')],
      json: null, timeoutMs: 60000,
    },
    {
      id: 'P-2', desc: 'gate-runner 抽样: cdc_sync',
      cmd: [process.execPath, R('engineering-assets/tools/gate-runner.cjs'), R('engineering-assets/cbb/cdc_sync'), '--repo-root', HARNESS_ROOT],
      json: 'file',
      jsonFile: R('engineering-assets/var/gates/pg/cdc_sync/gate-results.json'),
      timeoutMs: 60000,
    },
  ],
};

function record(metric, value, note) {
  // quality-regression-dashboard.cjs 未导出 recordMetric 且 require 即执行 main,
  // 复用其既有 CLI record 接口 (指标名 bench_* 为新名, 仪表盘会提示未知但仍入账)。
  spawnSync(process.execPath, [
    R('engine/scripts/quality-regression-dashboard.cjs'), 'record',
    `--metric=${metric}`, `--value=${value}`, '--project=bench-refactor', `--note=${note}`,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
}

function runEntry(entry) {
  const startedAt = Date.now();
  const result = spawnSync(entry.cmd[0], entry.cmd.slice(1), {
    encoding: 'utf8',
    timeout: entry.timeoutMs,
    windowsHide: true,
    env: { ...process.env, CLAUDE_HARNESS_NO_PERSIST: '1' },
  });
  const durationMs = Date.now() - startedAt;
  const exitOk = result.status === 0 && !result.error && !result.signal;

  let verdict = exitOk ? 'pass' : 'fail';
  let parsed = null;
  if (exitOk && entry.json === 'stdout') {
    try {
      parsed = JSON.parse(result.stdout || '');
      if (parsed && parsed.error) verdict = 'fail';
      if (parsed?.sla && parsed.sla.pass === false) verdict = 'fail';
    } catch (e) {
      verdict = 'fail';
      parsed = { error: `--json 输出解析失败: ${e.message}` };
    }
  }
  if (exitOk && entry.json === 'file') {
    try {
      parsed = JSON.parse(fs.readFileSync(entry.jsonFile, 'utf8'));
    } catch (e) {
      verdict = 'fail';
      parsed = { error: `读取 ${entry.jsonFile} 失败: ${e.message}` };
    }
  }

  return {
    id: entry.id,
    desc: entry.desc,
    cmd: displayCmd(entry.cmd),
    exitCode: result.status,
    signal: result.signal || null,
    verdict,
    durationMs,
    parsedSummary: parsed
      ? { error: parsed.error || null, slaPass: parsed.sla ? parsed.sla.pass : undefined,
          clearedLevel: parsed.cleared_level, gateCount: parsed.gate_count }
      : null,
  };
}

function main() {
  const phaseIdx = process.argv.indexOf('--phase');
  const phase = phaseIdx >= 0 ? Number(process.argv[phaseIdx + 1]) : NaN;
  const dryRun = process.argv.includes('--dry-run');
  const entries = PHASES[phase];

  if (!entries) {
    console.error(`[bench-refactor] 未知或缺失 phase。可用: ${Object.keys(PHASES).join(', ')}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[bench-refactor] --dry-run: phase ${phase} 将执行 ${entries.length} 条命令:`);
    for (const e of entries) {
      console.log(`  [${e.id}] ${e.desc}`);
      console.log(`        ${displayCmd(e.cmd)}`);
    }
    process.exit(0);
  }

  const results = [];
  for (const entry of entries) {
    console.log(`[bench-refactor] ▶ [${entry.id}] ${entry.desc} ...`);
    const r = runEntry(entry);
    results.push(r);
    record(`bench_${entry.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      r.verdict === 'pass' ? 1 : 0, `phase${phase} ${r.verdict} ${r.durationMs}ms`);
    console.log(`[bench-refactor]   ${r.verdict === 'pass' ? '✅' : '❌'} [${r.id}] exit=${r.exitCode} ${r.durationMs}ms`);
  }

  const overall = results.every((r) => r.verdict === 'pass') ? 'pass' : 'fail';
  const verdict = {
    phase,
    timestamp: new Date().toISOString(),
    overall,
    results,
  };
  fs.mkdirSync(path.dirname(VERDICT_FILE), { recursive: true });
  fs.writeFileSync(VERDICT_FILE, JSON.stringify(verdict, null, 2), 'utf8');
  console.log(`[bench-refactor] overall=${overall} → ${path.relative(HARNESS_ROOT, VERDICT_FILE)}`);
  process.exit(overall === 'pass' ? 0 : 1);
}

if (require.main === module) main();

module.exports = { PHASES, runEntry };
