#!/usr/bin/env node
'use strict';

/**
 * cost-usage-contract.cjs — 成本遥测行为契约 (D6 升级)。
 *
 * 覆盖:
 *   1. transcript 解析: 按 message.id 去重、坏行容错、<synthetic> 跳过、日期后缀模型前缀匹配
 *   2. 定价计算: 与定价表手算值一致 (期望值在测试里硬编码, 不复用被测代码)
 *   3. upsert 幂等: 重复 record 不叠加, 每 (session, model) 恒一行
 *   4. 文件缺失抛错 (observer 回退 estimate 的前提)
 *   5. 定价表完整性: 当前模型家族齐全、fallback 存在、系数合理
 *   6. 健康检查断流闭环: 有消费者心跳无成本行 → RED; 写入 usage 行 → GREEN
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openDb } = require(path.join(ROOT, 'engine/sqlite/index.cjs'));
const costs = require(path.join(ROOT, 'engine/sqlite/store-costs.cjs'));
const { buildHealthReport } = require(path.join(ROOT, 'engine/scripts/memory-health-check.cjs'));

function writeFixtureTranscript(dir) {
  const lines = [
    // fable: 两条消息, 第一条出现两次 (更新后取最后一次)
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', model: 'claude-fable-5', usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', model: 'claude-fable-5', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 } } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_b', model: 'claude-fable-5', usage: { input_tokens: 200, output_tokens: 300, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } }),
    // haiku: 带日期后缀的完整 ID, 应前缀匹配到 claude-haiku-4-5 定价
    JSON.stringify({ type: 'assistant', message: { id: 'msg_c', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 10000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
    // 应忽略的行
    JSON.stringify({ type: 'assistant', message: { id: 'msg_d', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    '{ not valid json',
    '',
  ];
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-usage-contract-'));
  const dbHandle = openDb({ path: path.join(tmp, 'memory.db') });
  const db = dbHandle.db;
  try {
    const transcript = writeFixtureTranscript(tmp);

    // ── 1+2: 解析与定价 ──
    const parsed = costs.parseTranscriptUsage(transcript);
    assert.equal(parsed.length, 2, `expect 2 models, got ${JSON.stringify(parsed)}`);
    const fable = parsed.find((u) => u.model === 'claude-fable-5');
    const haiku = parsed.find((u) => u.model === 'claude-haiku-4-5-20251001');
    // msg_a 取第二次: in 1000/out 500/read 2000/write 100; + msg_b: in 200/out 300/read 1000
    assert.deepEqual(
      { in: fable.inputTokens, out: fable.outputTokens, read: fable.cacheReadTokens, write: fable.cacheWriteTokens, req: fable.requests },
      { in: 1200, out: 800, read: 3000, write: 100, req: 2 },
    );
    assert.deepEqual(
      { in: haiku.inputTokens, out: haiku.outputTokens, req: haiku.requests },
      { in: 10000, out: 2000, req: 1 },
    );

    const pricing = costs.loadPricing();
    // fable $10/$50: (1200*10 + 100*10*1.25 + 3000*10*0.1 + 800*50)/1e6 = 0.05625
    assert.ok(Math.abs(costs.costUsd(fable, pricing) - 0.05625) < 1e-9,
      `fable usd = ${costs.costUsd(fable, pricing)}`);
    // haiku $1/$5 (前缀匹配): (10000*1 + 2000*5)/1e6 = 0.02
    assert.ok(Math.abs(costs.costUsd(haiku, pricing) - 0.02) < 1e-9,
      `haiku usd = ${costs.costUsd(haiku, pricing)}`);
    // 未知模型走 fallback, 不抛错
    assert.equal(costs.priceFor('claude-unknown-99', pricing), pricing.fallback);

    // ── 3: upsert 幂等 ──
    const first = costs.recordTranscriptUsage({ sessionId: 's1', transcriptPath: transcript }, { db });
    assert.equal(first.recorded, 2);
    assert.ok(Math.abs(first.totalUsd - 0.07625) < 1e-9, `totalUsd = ${first.totalUsd}`);
    const second = costs.recordTranscriptUsage({ sessionId: 's1', transcriptPath: transcript }, { db });
    assert.equal(second.recorded, 2);
    const rows = db.prepare(
      "SELECT model, tokens_in, cost_usd FROM cost_ledger WHERE session_id = 's1' AND phase = 'usage' ORDER BY model",
    ).all();
    assert.equal(rows.length, 2, 'repeat record must not duplicate rows');
    assert.equal(rows.find((r) => r.model === 'claude-fable-5').tokens_in, 1200, 'repeat record must not accumulate');

    // ── 4: 文件缺失抛错 ──
    assert.throws(() => costs.recordTranscriptUsage(
      { sessionId: 's1', transcriptPath: path.join(tmp, 'nope.jsonl') }, { db },
    ));

    // ── 5: 定价表完整性 ──
    for (const family of ['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      assert.ok(pricing.models[family], `pricing missing ${family}`);
      assert.ok(pricing.models[family].input > 0 && pricing.models[family].output > 0);
    }
    assert.ok(pricing.fallback && pricing.fallback.input > 0);
    assert.ok(pricing.cacheReadMultiplier > 0 && pricing.cacheReadMultiplier < 1);
    assert.ok(pricing.cacheWriteMultiplier >= 1);

    // ── 6: 健康检查断流闭环 (RED → GREEN) ──
    const redDb = openDb({ path: path.join(tmp, 'red.db') });
    try {
      const now = Date.now();
      const iso = new Date(now - 3600000).toISOString();
      redDb.db.prepare(`
        INSERT INTO runtime_consumer_heartbeats
          (consumer, run_id, status, last_started_at, last_completed_at, processed_through, updated_at)
        VALUES ('dream', 'r1', 'success', ?, ?, 0, ?)
      `).run(iso, iso, iso);
      const red = buildHealthReport({ db: redDb.db, home: ROOT, now });
      assert.ok(red.issues.some((i) => i.code === 'cost_telemetry_dead'),
        `expected cost_telemetry_dead, got ${JSON.stringify(red.issues.map((i) => i.code))}`);

      costs.recordTranscriptUsage({ sessionId: 's-red', transcriptPath: transcript }, { db: redDb.db });
      const green = buildHealthReport({ db: redDb.db, home: ROOT, now });
      assert.ok(!green.issues.some((i) => i.code === 'cost_telemetry_dead' || i.code === 'cost_usage_stale'),
        `cost issues must clear after usage row, got ${JSON.stringify(green.issues.map((i) => i.code))}`);
      assert.equal(green.metrics.costs.usageRows, 2);
    } finally {
      try { redDb.close(); } catch { /* test cleanup */ }
    }

    console.log('cost-usage-contract: all assertions passed');
  } finally {
    try { dbHandle.close(); } catch { /* test cleanup */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* test cleanup */ }
  }
}

main();
