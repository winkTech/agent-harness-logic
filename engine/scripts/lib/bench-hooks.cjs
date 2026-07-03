#!/usr/bin/env node
/**
 * engine/scripts/lib/bench-hooks.cjs — Hook 延迟基准库。
 *
 * 测量 settings.local.json 中注册的所有 hook 的启动和执行时间。
 * 由 diagnostics.cjs --bench 调用，也可独立运行。
 *
 * 用法:
 *   node engine/scripts/lib/bench-hooks.cjs              # 全量基准
 *   node engine/scripts/lib/bench-hooks.cjs --quick      # 快速（只测 PreToolUse）
 *   node engine/scripts/lib/bench-hooks.cjs --json       # JSON 输出（供 diagnostics 消费）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { collectHookEntries } = require('./hook-registry.cjs');

const HOME = path.join(os.homedir(), '.claude');
const SETTINGS_FILES = [
  path.join(HOME, 'settings.json'),
  path.join(HOME, 'settings.local.json'),
];

// ── 工具 ───────────────────────────────────────────────────────────────────

function now() { return Date.now(); }

function parseCommandLine(cmd) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(cmd)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function expandPathArg(arg) {
  if (!arg || typeof arg !== 'string') return arg;
  return arg
    .replace(/\$HOME/g, os.homedir().replace(/\\/g, '/'))
    .replace(/^~(?=\/|\\|$)/, os.homedir().replace(/\\/g, '/'));
}

function mergeHookConfigs(base, next) {
  const merged = { ...(base || {}) };
  const hooks = { ...(merged.hooks || {}) };
  for (const [point, entries] of Object.entries(next?.hooks || {})) {
    hooks[point] = [...(hooks[point] || []), ...(Array.isArray(entries) ? entries : [])];
  }
  merged.hooks = hooks;
  return merged;
}

function readSettings() {
  let config = {};
  for (const file of SETTINGS_FILES) {
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    config = mergeHookConfigs(config, parsed);
  }
  return config;
}

/**
 * 执行一条 hook 命令并测量耗时。
 * @returns {{ ok: boolean, elapsed: number, script: string, id: string, isAsync: boolean }}
 */
function benchHook(cmd, id, isAsync) {
  const parts = parseCommandLine(cmd).map(expandPathArg);
  if (parts.length === 0) return { ok: false, elapsed: 0, script: 'empty', id, isAsync };

  const executable = parts[0];
  const args = parts.slice(1);

  if (executable !== 'node' && executable !== 'bash') {
    return { ok: false, elapsed: 0, script: cmd.slice(0, 60), id, isAsync };
  }

  const start = now();
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: { ...process.env, CLAUDE_BENCH: '1' },
    input: JSON.stringify({ tool: 'Bash', input: { command: 'git status' } }),
  });
  const elapsed = now() - start;

  return {
    ok: !result.error && !result.signal,
    elapsed,
    script: cmd.slice(0, 60),
    id: id || 'unknown',
    isAsync,
    status: result.status,
    error: result.error?.message || null,
  };
}

/**
 * 收集所有 hook 命令。
 * @returns {Array<{ point: string, cmd: string, id: string, isAsync: boolean }>}
 */
function collectHooks() {
  return collectHookEntries().map(entry => ({
    point: entry.point,
    cmd: entry.command,
    id: entry.id,
    isAsync: entry.isAsync,
  }));
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isQuick = args.includes('--quick');
  const isJson = args.includes('--json');

  const entries = collectHooks();
  if (entries.length === 0) {
    if (isJson) { console.log(JSON.stringify({ error: '无 hook 条目' })); }
    else { console.log('无 hook 条目'); }
    process.exit(1);
  }

  const results = [];
  const startAll = now();

  let byteCount = 0;
  for (const entry of entries) {
    byteCount += JSON.stringify(entry).length;
  }

  for (const entry of entries) {
    // --quick 模式只测 PreToolUse
    if (isQuick && !entry.point.startsWith('PreToolUse')) {
      results.push({ ...entry, elapsed: -1, ok: true, skipped: true });
      continue;
    }

    const r = benchHook(entry.cmd, entry.id, entry.isAsync);
    results.push({ point: entry.point, ...r, skipped: false });
  }

  const totalElapsed = now() - startAll;

  // 统计
  const realRuns = results.filter(r => !r.skipped && !r.isAsync);
  const asyncRuns = results.filter(r => r.isAsync);
  const okRuns = realRuns.filter(r => r.ok);
  const failedRuns = realRuns.filter(r => !r.ok);
  const elapsedTimes = realRuns.map(r => r.elapsed).sort((a, b) => a - b);
  const p50 = elapsedTimes.length > 0 ? elapsedTimes[Math.floor(elapsedTimes.length * 0.5)] : 0;
  const p95 = elapsedTimes.length > 0 ? elapsedTimes[Math.floor(elapsedTimes.length * 0.95)] : 0;
  const avg = elapsedTimes.length > 0
    ? (elapsedTimes.reduce((a, b) => a + b, 0) / elapsedTimes.length).toFixed(1)
    : 0;

  if (isJson) {
    console.log(JSON.stringify({
      total: entries.length,
      tested: realRuns.length,
      async: asyncRuns.length,
      passed: okRuns.length,
      failed: failedRuns.length,
      p50_ms: p50,
      p95_ms: p95,
      avg_ms: parseFloat(avg),
      total_bench_ms: totalElapsed,
      results,
    }, null, 2));
    return;
  }

  // 详细输出
  console.log('\n━━━ Hook 延迟基准 ━━━\n');
  console.log(`总条目: ${entries.length} | 实测: ${realRuns.length} | 异步跳过: ${asyncRuns.length}`);
  console.log('');

  // 按触发点分组
  const byPoint = {};
  for (const r of results) {
    if (!byPoint[r.point]) byPoint[r.point] = [];
    byPoint[r.point].push(r);
  }

  for (const [point, rs] of Object.entries(byPoint)) {
    const tested = rs.filter(r => !r.skipped && !r.isAsync);
    const async_ = rs.filter(r => r.isAsync);
    const pointAvg = tested.length > 0
      ? (tested.reduce((s, r) => s + r.elapsed, 0) / tested.length).toFixed(1)
      : '-';

    console.log(`  ${point} (${tested.length} 实测 / ${async_.length} 异步)`);
    for (const r of rs) {
      if (r.skipped) continue;
      const status = r.isAsync ? '⏭' : r.ok ? '✅' : '❌';
      console.log(`    ${status} ${r.id.slice(0, 40).padEnd(42)} ${r.isAsync ? 'async' : `${r.elapsed}ms`}`);
    }
    console.log(`    均值: ${pointAvg}ms`);
    console.log('');
  }

  console.log(`━━━ 汇总 ━━━`);
  console.log(`  P50: ${p50}ms`);
  console.log(`  P95: ${p95}ms`);
  console.log(`  均值: ${avg}ms`);
  console.log(`  总耗时: ${totalElapsed}ms`);

  // SLA 检查
  const slaWarnings = [];
  if (p95 > 500) slaWarnings.push(`⚠ P95 ${p95}ms > 500ms 目标`);
  else if (p95 > 100) slaWarnings.push(`⚠ P95 ${p95}ms > 100ms 建议`);
  else slaWarnings.push(`✅ P95 ${p95}ms (目标 < 500ms)`);

  if (failedRuns.length > 0) slaWarnings.push(`❌ ${failedRuns.length} 条 hook 执行失败`);
  else slaWarnings.push(`✅ 全部 ${okRuns.length} 条 hook 通过`);

  for (const w of slaWarnings) console.log(`  ${w}`);

  return { total: entries.length, passed: okRuns.length, p50, p95, avg_ms: parseFloat(avg) };
}

if (require.main === module) {
  main();
}

module.exports = { benchHook, collectHooks, main };
