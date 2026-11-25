#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/consumer-scheduler.cjs — 事件消费者到期调度器（层 2 激活）。
 *
 * 挂 SessionStart（与 memory-knowledge-maintenance --auto 同机制）：
 *   - `--auto`：读各消费者 runtime_consumer_heartbeats.next_due_at，
 *     到期（或无心跳/上次失败）才 spawn 对应 runner；未到期立即退出（<100ms）。
 *   - 超时保护：dream 12s / skill-evolve 30s（与 manifest timeoutSeconds 同口径），
 *     超时记 fail 不阻塞会话启动。
 *   - runner 自带 begin/completeConsumerRun 心跳落库，本调度器只判到期与守护。
 *
 * 设计边界：不做重试风暴（到期失败→下个 SessionStart 自然再试）；
 * 不改消费者逻辑（零侵入——dream-consolidate / skill-evolve 原样跑）。
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const eventStore = require('../sqlite/store-events.cjs');

const MAX_CATCHUP_BATCHES = 3;
const BACKLOG_COOLDOWN_MS = 60_000;

const CONSUMERS = [
  {
    id: 'dream',
    runner: path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'dream-consolidate.cjs'),
    // 到期节奏：成功后 24h 再跑（dream 蒸馏不需要高频）
    reDueAfterSuccessMs: 24 * 3600_000,
    maxBatch: 100,
    timeoutMs: 12_000,
  },
  {
    id: 'skill-evolve',
    runner: path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'skill-evolve.cjs'),
    reDueAfterSuccessMs: 24 * 3600_000,
    maxBatch: 100,
    timeoutMs: 30_000,
  },
  {
    // fp-rate 挂 Stop 事件消费门禁拦截评估；runner 需 auto-record 子命令
    id: 'fp-rate',
    runner: null,
    runnerArgs: ['auto-record'],
    script: path.join(HARNESS_ROOT, 'core', 'engine', 'scripts', 'fp-rate-tracker.cjs'),
    reDueAfterSuccessMs: 12 * 3600_000,
    maxBatch: 100,
    timeoutMs: 15_000,
  },
];

function isDue(run, reDueMs, now = Date.now(), opts = {}) {
  if (!run) return true; // 无心跳——从未跑过，到期
  if (run.status === 'running') {
    // 卡死态：上次 started 超 10 分钟视为僵死，允许重跑
    const startedAt = Date.parse(run.lastStartedAt || '');
    return Number.isFinite(startedAt) ? now - startedAt > 10 * 60_000 : true;
  }
  if (run.status === 'failed') return true;
  const maxBatch = Number(opts.maxBatch || 100);
  const completedAt = Date.parse(run.lastCompletedAt || '');
  const pendingCount = Math.max(Number(run.pending || 0), Number(opts.livePending || 0));
  // 积压追赶：若实时未消费事件或上次残余 >= maxBatch，不硬睡 24h，允许短冷却后继续追赶
  if (pendingCount >= maxBatch) {
    if (!Number.isFinite(completedAt) || now - completedAt >= BACKLOG_COOLDOWN_MS) return true;
  }
  const nextDue = Date.parse(run.nextDueAt || '');
  if (Number.isFinite(nextDue)) return now >= nextDue;
  // 无 next_due_at：按 lastCompletedAt + reDue 判
  if (!Number.isFinite(completedAt)) return true;
  return now - completedAt >= reDueMs;
}

function runConsumer(consumer) {
  return new Promise((resolve) => {
    const script = consumer.runner || consumer.script;
    if (!script) return resolve({ id: consumer.id, verdict: 'no-runner' });
    const child = spawn(process.execPath, [script, ...(consumer.runnerArgs || [])], {
      cwd: HARNESS_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'], // 守护进程不抢会话输出
      env: { ...process.env },
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ id: consumer.id, verdict: 'timeout' });
    }, consumer.timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ id: consumer.id, verdict: 'error' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ id: consumer.id, verdict: code === 0 ? 'ran' : `exit:${code}` });
    });
  });
}

function livePendingFor(consumerId) {
  try {
    const wm = eventStore.getWatermark({ consumer: consumerId });
    return Number(eventStore.countSinceWatermark(wm) || 0);
  } catch {
    return 0;
  }
}

async function main() {
  const auto = process.argv.includes('--auto');
  if (!auto) {
    // 手动模式：列出各消费者到期状态
    for (const c of CONSUMERS) {
      const run = eventStore.getConsumerRun(c.id);
      const livePending = livePendingFor(c.id);
      const due = isDue(run, c.reDueAfterSuccessMs, Date.now(), { maxBatch: c.maxBatch, livePending });
      console.log(`[consumer-scheduler] ${c.id}: ${due ? 'DUE' : 'not-due'} (${run ? `next=${run.nextDueAt || 'n/a'} status=${run.status} pending=${livePending}` : `无心跳 pending=${livePending}`})`);
    }
    return;
  }
  const results = [];
  for (const c of CONSUMERS) {
    let run = null;
    try { run = eventStore.getConsumerRun(c.id); } catch { /* 心跳表不可用视为到期 */ }
    const initialPending = livePendingFor(c.id);
    if (!isDue(run, c.reDueAfterSuccessMs, Date.now(), { maxBatch: c.maxBatch, livePending: initialPending })) continue;
    for (let batch = 0; batch < MAX_CATCHUP_BATCHES; batch += 1) {
      const prevThrough = Number(run?.processedThrough || 0);
      const outcome = await runConsumer(c);
      results.push(outcome);
      if (outcome.verdict !== 'ran') break;
      try { run = eventStore.getConsumerRun(c.id); } catch { break; }
      const nextThrough = Number(run?.processedThrough || 0);
      const remaining = Math.max(Number(run?.pending || 0), livePendingFor(c.id));
      // 仅在水位真实前进且仍有 >= maxBatch 积压时继续有界追赶，防止空转风暴
      if (nextThrough <= prevThrough || remaining < (c.maxBatch || 100)) break;
    }
  }
  if (results.length > 0) {
    console.error(`[consumer-scheduler] ${results.map((r) => `${r.id}:${r.verdict}`).join(' ')}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[consumer-scheduler] 失败: ${err.message}`);
    process.exit(0); // 调度器永不阻塞会话启动
  });
}

module.exports = { CONSUMERS, isDue };
