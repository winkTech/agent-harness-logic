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

const { HARNESS_ROOT } = require('./harness-root.cjs');

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { collectHookEntries } = require('./hook-registry.cjs');

const HOME = HARNESS_ROOT;
const SETTINGS_FILES = [
  path.join(HOME, 'settings.json'),
  path.join(HOME, 'settings.local.json'),
];

function createBenchSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-bench-'));
  const root = path.join(base, '.claude');
  fs.mkdirSync(path.join(root, 'engine', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var'), { recursive: true });
  const agentsSource = path.join(HOME, 'AGENTS.md');
  const agentsTarget = path.join(root, 'AGENTS.md');
  if (fs.existsSync(agentsSource)) fs.copyFileSync(agentsSource, agentsTarget);
  else fs.writeFileSync(agentsTarget, '# Benchmark sandbox\n', 'utf8');

  let cleaned = false;
  return {
    base,
    root,
    env: {
      HOME: base,
      USERPROFILE: base,
      CLAUDE_HARNESS_ROOT: root,
      CLAUDE_BENCH: '1',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

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
function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function runSample(executable, args, opts = {}) {
  const payload = opts.payload || { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } };
  const start = now();
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 10000,
    windowsHide: true,
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}), CLAUDE_BENCH: '1' },
    input: JSON.stringify(payload),
  });
  return {
    ok: !result.error && !result.signal && result.status === 0,
    elapsed: now() - start,
    status: result.status,
    signal: result.signal || null,
    error: result.error?.message || null,
  };
}

function benchHook(cmd, id, isAsync, opts = {}) {
  const parts = parseCommandLine(cmd).map(expandPathArg);
  if (parts.length === 0) return { ok: false, elapsed: 0, script: 'empty', id, isAsync };

  const executable = parts[0];
  const args = parts.slice(1);

  if (executable !== 'node' && executable !== 'bash') {
    return { ok: false, elapsed: 0, script: cmd.slice(0, 60), id, isAsync };
  }

  const warmupRuns = Number.isInteger(opts.warmupRuns) ? Math.max(0, opts.warmupRuns) : 1;
  const sampleRuns = Number.isInteger(opts.sampleRuns) ? Math.max(1, opts.sampleRuns) : 3;
  const cold = runSample(executable, args, opts);
  for (let index = 0; index < warmupRuns; index += 1) runSample(executable, args, opts);
  const warmSamples = [];
  for (let index = 0; index < sampleRuns; index += 1) {
    warmSamples.push(runSample(executable, args, opts));
  }
  const measured = [cold, ...warmSamples];
  const firstFailure = measured.find(sample => !sample.ok);
  const warmElapsed = warmSamples.map(sample => sample.elapsed);

  return {
    ok: measured.every(sample => sample.ok),
    elapsed: percentile(warmElapsed, 0.5),
    script: cmd.slice(0, 60),
    id: id || 'unknown',
    isAsync,
    status: firstFailure ? firstFailure.status : 0,
    signal: firstFailure?.signal || null,
    error: firstFailure?.error || null,
    cold,
    warmupRuns,
    warmSamples,
    warm_p50_ms: percentile(warmElapsed, 0.5),
    warm_p95_ms: percentile(warmElapsed, 0.95),
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

function payloadForEntry(entry, cwd) {
  const point = String(entry.point || 'PreToolUse');
  const matcher = String(entry.matcher || '*');
  const session_id = 'hook-benchmark-session';
  const base = { hook_event_name: point, session_id, cwd };
  if (point === 'UserPromptSubmit') {
    return { ...base, prompt: 'Benchmark hook lifecycle latency.' };
  }
  if (point === 'SessionStart') {
    const source = matcher.split('|').find(value => ['startup', 'resume', 'clear', 'compact'].includes(value)) || 'startup';
    return { ...base, source };
  }
  if (point === 'Stop') {
    return { ...base, stop_hook_active: false, last_assistant_message: 'Benchmark sample response.' };
  }
  if (point === 'PreCompact') {
    return { ...base, trigger: 'manual' };
  }
  if (point === 'Notification') {
    return { ...base, notification_type: 'benchmark', message: 'Benchmark notification.' };
  }

  const toolName = matcher.split('|').find(value => value && value !== '*') || 'Bash';
  const toolInput = ['Bash', 'PowerShell'].includes(toolName)
    ? { command: 'git status' }
    : ['Write', 'Edit', 'MultiEdit'].includes(toolName)
      ? { file_path: path.join(cwd, 'benchmark.txt'), content: 'benchmark' }
      : {};
  const payload = { ...base, tool_name: toolName, tool_input: toolInput };
  if (point === 'PostToolUse') payload.tool_response = { status: 0, stdout: '', stderr: '' };
  if (point === 'PostToolUseFailure') payload.tool_response = { status: 1, stdout: '', stderr: 'benchmark failure' };
  return payload;
}

function benchmarkEntries(entries, opts = {}) {
  const sandbox = opts.sandbox || createBenchSandbox();
  const results = [];
  try {
    for (const entry of entries) {
      if ((opts.isQuick && !entry.point.startsWith('PreToolUse')) || entry.isAsync) {
        results.push({
          ...entry,
          elapsed: -1,
          ok: true,
          skipped: true,
          skipReason: entry.isAsync ? 'async-hook' : 'quick-mode',
        });
        continue;
      }

      const result = benchHook(entry.cmd, entry.id, entry.isAsync, {
        warmupRuns: opts.warmupRuns,
        sampleRuns: opts.sampleRuns,
        timeoutMs: opts.timeoutMs,
        payload: opts.payload || payloadForEntry(entry, sandbox.root),
        cwd: opts.cwd || sandbox.root,
        env: { ...sandbox.env, ...(opts.env || {}) },
      });
      results.push({ point: entry.point, ...result, skipped: false });
    }
    return { results, isolated: true };
  } finally {
    if (!opts.keepSandbox) sandbox.cleanup();
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isQuick = args.includes('--quick');
  const isJson = args.includes('--json');
  const valueAfter = (flag, fallback) => {
    const index = args.indexOf(flag);
    if (index < 0) return fallback;
    const value = Number.parseInt(args[index + 1] || '', 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const sampleRuns = Math.max(1, valueAfter('--samples', 3));
  const warmupRuns = valueAfter('--warmup', 1);

  const entries = collectHooks();
  if (entries.length === 0) {
    if (isJson) { console.log(JSON.stringify({ error: '无 hook 条目' })); }
    else { console.log('无 hook 条目'); }
    process.exit(1);
  }

  const startAll = now();

  let byteCount = 0;
  for (const entry of entries) {
    byteCount += JSON.stringify(entry).length;
  }

  const { results } = benchmarkEntries(entries, { isQuick, sampleRuns, warmupRuns });

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

module.exports = { benchHook, benchmarkEntries, collectHooks, createBenchSandbox, main, payloadForEntry };
