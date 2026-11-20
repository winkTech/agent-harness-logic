#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/telemetry-spool-drain.cjs — spool→events 搬运消费者
 *（Phase 2.5 / §3.6）
 *
 * consumerRegistry 五件套：
 *   ① manifest 声明    — hooks/manifest.json consumerRegistry 条目 telemetry-spool-drain
 *   ② 真实调度         — SessionStart 维护路径(session-bootstrap)/Stop 观察路径
 *                        (postflight-observer) 各调用一次 drainSpool({ bounded: true })
 *   ③ watermark        — events 表 event_id 水位（搬运成功后 setWatermark）
 *   ④ heartbeat        — store-events beginConsumerRun/completeConsumerRun（失败 failConsumerRun）
 *   ⑤ 有界批量         — 单次至多 BATCH_LIMIT 条 + msBudget 超时即返回（不阻塞宿主事件）
 *
 * 行为：
 *   - spool 行 → events.record()（type=行.type 或 'spool.unknown'；sessionId 缺席
 *     用行.sessionId 或 'spool-anonymous'——spool 本就是匿名兜底通道）
 *   - 坏行（非法 JSON）计入 dropped 不搬运不重试
 *   - dry-run（--dry-run 或 envFlag NO_PERSIST）只读不推水位不截断
 */

const fs = require('node:fs');
const path = require('node:path');

const BATCH_LIMIT = 500;
const MS_BUDGET = 2000;
const CONSUMER_ID = 'telemetry-spool-drain';

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run')
    || ['1', 'true'].includes(String(process.env.HARNESS_NO_PERSIST || ''));
  const { drainSpool } = require('./io/spool-drain-lib.cjs');
  const result = drainSpool({
    consumerId: CONSUMER_ID,
    dryRun,
    batchLimit: BATCH_LIMIT,
    msBudget: MS_BUDGET,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = { CONSUMER_ID, BATCH_LIMIT, MS_BUDGET, main };
