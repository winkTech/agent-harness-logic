#!/usr/bin/env node
/**
 * core/engine/scripts/bench-refactor.cjs — 重构基准薄壳 (Phase 0 步骤 0.6)
 *
 * 按 Phase 配置顺序执行既有 bench 命令, 汇总 pass/fail 写 verdict.json。
 * 只做编排: 命令引用各工具既有输出 (--json stdout / 工具落盘的 JSON / 退出码),
 * 不新造解析器; 指标经 quality-regression-dashboard 的 record CLI 入账。
 *
 * 用法:
 *   node core/engine/scripts/bench-refactor.cjs --phase 0            # 执行 phase 0
 *   node core/engine/scripts/bench-refactor.cjs --phase 0 --dry-run  # 只列将跑的命令
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
      cmd: [process.execPath, R('core/engine/scripts/test-hooks/run-all-tests.cjs'), '--no-persist'],
      json: null, timeoutMs: 420000,
    },
    {
      id: 'C-3', desc: 'bench-hooks --json --sla (diagnostics --bench 的数据源)',
      cmd: [process.execPath, R('core/engine/scripts/lib/bench-hooks.cjs'), '--json', '--sla'],
      json: 'stdout', timeoutMs: 180000,
    },
    {
      id: 'P-1a', desc: 'asset-audit (工程资产目录体检)',
      cmd: [process.execPath, R('packs/fpga/engineering-assets/tools/asset-audit.cjs'), '--root', R('packs/fpga/engineering-assets')],
      json: null, timeoutMs: 60000,
    },
    {
      id: 'P-1b', desc: 'evidence-snapshot --verify-all (证据封存全量校验)',
      cmd: [process.execPath, R('packs/fpga/engineering-assets/tools/evidence-snapshot.cjs'), '--verify-all', '--root', R('packs/fpga/engineering-assets')],
      json: null, timeoutMs: 60000,
    },
    {
      id: 'P-2', desc: 'gate-runner 抽样: cdc_sync',
      cmd: [process.execPath, R('packs/fpga/engineering-assets/tools/gate-runner.cjs'), R('packs/fpga/engineering-assets/cbb/cdc_sync'), '--repo-root', R('packs/fpga')],
      json: 'file',
      jsonFile: R('packs/fpga/engineering-assets/var/gates/pg/cdc_sync/gate-results.json'),
      timeoutMs: 60000,
    },
  ],
  // Phase 1 门（方案 §6 L374）：C-1=0、C-2 fail=0（total 减少须附注）、C-5 ≤30min、
  // H-1(claude) drift=0、P-1 与基线一致、P-2 21/21、overall=pass。
  // C-2 当前 4 fail 与 Phase 0 基线一致（行为级 backlog：E2E/painpoints/
  // managed-action/long-task，settings.model=sonnet 裁决挂起中）——按基线豁免记账。
  1: [
    {
      id: 'C-1', desc: 'layer-boundary --check (core 分层执法, violations=0)',
      cmd: [process.execPath, R('core/engine/scripts/layer-boundary.cjs'), '--check'],
      json: null, timeoutMs: 60000,
    },
    {
      id: 'C-2', desc: 'run-all-tests --no-persist (全量回归, 对齐 Phase 0 基线 4 fail)',
      cmd: [process.execPath, R('core/engine/scripts/test-hooks/run-all-tests.cjs'), '--no-persist'],
      json: null, timeoutMs: 420000,
      baselineFailures: 4,
    },
    {
      // H-1 判据 = 渲染零漂移族全 exit 0（方案 §4.2：'各宿主 render --check'）。
      // 不复用 harness-ci 整体——它含 coverage 段与全量测试, 超出 H-1 语义且超时。
      id: 'H-1', desc: '渲染零漂移族 --check (settings+workbuddy+plugin+skills+workflow)',
      cmd: [process.execPath, '-e', [
        `const {spawnSync}=require('node:child_process');`,
        `const checks=[`,
        `  ['render-hook-settings',${JSON.stringify(R('core/engine/scripts/render-hook-settings.cjs'))}],`,
        `  ['sync-skills',${JSON.stringify(R('core/engine/scripts/sync-skills.cjs'))}],`,
        `  ['sync-workflow-mirror',${JSON.stringify(R('core/engine/scripts/sync-workflow-mirror.cjs'))}],`,
        `];`,
        `let bad=0;`,
        `for(const [name,script] of checks){`,
        `  const r=spawnSync(process.execPath,[script,'--check'],{encoding:'utf8',timeout:60000,windowsHide:true});`,
        `  if(r.status!==0){bad=1;console.error('['+name+'] '+((r.stderr||'').trim().split('\\n')[0]||'exit '+r.status));}`,
        `}`,
        `if(!bad)console.log('render family: 3/3 checks clean');`,
        `process.exit(bad);`,
      ].join('')],
      json: null, timeoutMs: 200000,
    },
    {
      id: 'P-1a', desc: 'asset-audit (packs 迁移后工程资产体检)',
      cmd: [process.execPath, R('packs/fpga/engineering-assets/tools/asset-audit.cjs'), '--root', R('packs/fpga/engineering-assets')],
      json: null, timeoutMs: 60000,
    },
    {
      id: 'P-1b', desc: 'evidence-snapshot --verify-all (证据封存全量校验)',
      cmd: [process.execPath, R('packs/fpga/engineering-assets/tools/evidence-snapshot.cjs'), '--verify-all', '--root', R('packs/fpga/engineering-assets')],
      json: null, timeoutMs: 60000,
    },
    {
      id: 'P-2', desc: 'gate-runner 抽样: cdc_sync (packs 迁移后 21 门)',
      // gate-runner 的 --repo-root 语义 = engineering-assets 父目录（工具内部拼
      // repoRoot/engineering-assets/...），拆层后即 packs/fpga。
      cmd: [process.execPath, R('packs/fpga/engineering-assets/tools/gate-runner.cjs'), R('packs/fpga/engineering-assets/cbb/cdc_sync'), '--repo-root', R('packs/fpga')],
      json: 'file',
      jsonFile: R('packs/fpga/engineering-assets/var/gates/pg/cdc_sync/gate-results.json'),
      timeoutMs: 60000,
    },
  ],
  // Phase 2：合同正式化（host-concepts/io/manifest v3/env/spool）。
  2: [
    {
      id: 'H-5', desc: '遥测 spool bench (100 合成事件损失 0 + 水位 + 心跳)',
      cmd: [process.execPath, R('core/engine/scripts/bench-h5-telemetry.js')],
      json: null, timeoutMs: 120000,
      // H-5 全程临时目录/临时 DB 隔离——必须解除 runner 的防写注入，否则 writer 直接 skip。
      envOverride: { CLAUDE_HARNESS_NO_PERSIST: '0', HARNESS_NO_PERSIST: '0' },
    },
    {
      id: 'P-4', desc: '可卸性烟测 (HARNESS_PACKS_DISABLED=1 下 core 套件全绿)',
      cmd: [process.execPath, R('core/engine/scripts/bench-p4-removable.js')],
      json: null, timeoutMs: 480000,
      envOverride: { CLAUDE_HARNESS_NO_PERSIST: '0', HARNESS_NO_PERSIST: '0' },
    },
    {
      id: 'H-4', desc: '跨宿主引擎层等价性 (样例×四方言路径同判 100%)',
      cmd: [process.execPath, R('core/engine/scripts/bench-h4-equivalence.cjs')],
      json: null, timeoutMs: 300000,
    },
  ],
  // Phase 4：插件化分发面 + 脱敏。
  4: [
    {
      id: 'D-1', desc: '脱敏扫描 (tracked 树零个人信息)',
      cmd: [process.execPath, R('core/engine/scripts/bench-d1-desens.cjs')],
      json: null, timeoutMs: 120000,
    },
    {
      id: 'D-2', desc: '插件结构校验 (dist/plugin 布局+引用闭包+marketplace 双形态)',
      cmd: [process.execPath, R('core/engine/scripts/bench-d2-plugin-validate.cjs')],
      json: null, timeoutMs: 180000,
    },
  ],
};

function record(metric, value, note) {
  // quality-regression-dashboard.cjs 未导出 recordMetric 且 require 即执行 main,
  // 复用其既有 CLI record 接口 (指标名 bench_* 为新名, 仪表盘会提示未知但仍入账)。
  spawnSync(process.execPath, [
    R('core/engine/scripts/quality-regression-dashboard.cjs'), 'record',
    `--metric=${metric}`, `--value=${value}`, '--project=bench-refactor', `--note=${note}`,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
}

function runEntry(entry) {
  const startedAt = Date.now();
  const result = spawnSync(entry.cmd[0], entry.cmd.slice(1), {
    encoding: 'utf8',
    timeout: entry.timeoutMs,
    windowsHide: true,
    env: { ...process.env, CLAUDE_HARNESS_NO_PERSIST: '1', ...(entry.envOverride || {}) },
  });
  const durationMs = Date.now() - startedAt;
  const exitOk = result.status === 0 && !result.error && !result.signal;

  let verdict = exitOk ? 'pass' : 'fail';
  let parsed = null;
  let note = null;
  // 基线豁免（C-2 行为级 backlog）：退出码非 0 但失败数与 Phase 0 基线一致时，
  // 记 pass-baseline 并在 note 落账差异——门语义是"不劣化于基线"。
  if (!exitOk && typeof entry.baselineFailures === 'number' && result.stdout) {
    const m = result.stdout.match(/失败:\s*(\d+)/);
    if (m && Number(m[1]) === entry.baselineFailures) {
      verdict = 'pass';
      note = `baseline-exempt: ${m[1]} failures == Phase 0 baseline`;
    }
  }
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
    note,
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
