#!/usr/bin/env node
/**
 * engine/scripts/dream-startup-inject.cjs — P3+P4: Dream 调度修复 + 闭环注入
 *
 * 在 SessionStart 时执行:
 *   1. 检查是否有未处理的事件（since watermark）
 *   2. 如果事件数 ≥ 阈值，自动运行 dream-consolidate （dry-run 模式展示检测到的模式）
 *   3. 检索最近 90 天内的 Dream 产出 learning
 *   4. 输出摘要注入到当前 session 上下文
 *
 * 这替代了 cron-only 的 dream-consolidate-daily 调度。
 * 优点是: 不需要等到凌晨 4:23，每次 Claude 启动时自动检查 + 注入。
 *
 * 注册:
 *   settings.local.json SessionStart
 *
 * 输出格式 (JSON 行):
 *   { source: "dream-startup-inject", type: "dream-check", ... }
 *
 * 无新事件 + 无近期产出 → 无输出 (0 token 开销)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const HARNESS = HARNESS_ROOT;
const DREAM_SCRIPT = path.join(HARNESS, 'engine', 'scripts', 'dream-consolidate.cjs');
const EVENTS_STORE = path.join(HARNESS, 'engine', 'sqlite', 'store-events.cjs');
const DB_INDEX = path.join(HARNESS, 'engine', 'sqlite', 'index.cjs');

// 最少事件数才触发 Dream 运行 (v2: 10→5, 日均 ~5 条事件的节奏下每 session 都有机会触发)
const MIN_EVENTS_THRESHOLD = 5;

// ── 检查未处理事件数 ─────────────────────────────────────────────────────────

function getUnprocessedEventCount() {
  try {
    const { openDb } = require(DB_INDEX);
    const { sinceWatermark, getWatermark } = require(EVENTS_STORE);
    const wDb = openDb();
    const watermark = getWatermark({ db: wDb.db });
    const events = sinceWatermark(watermark, 1, { db: wDb.db });
    wDb.close();
    return { count: events.length, watermark };
  } catch {
    return { count: 0, watermark: 0 };
  }
}

// ── 获取近期 Dream 学习产出 ──────────────────────────────────────────────────

function getRecentDreamLearnings(daysBack = 90) {
  try {
    const { openDb } = require(DB_INDEX);
    const { retrieveMemory } = require(HARNESS + '/engine/sqlite/store-memory.cjs');
    const wDb = openDb();

    // 从 facts 表中检索高置信度记忆（Dream + 用户写入 + 手动记录），不限 source
    const rows = wDb.db.prepare(`
      SELECT id, name, description, confidence, created_at, source
      FROM facts
      WHERE confidence >= 0.4
        AND (ttl_until IS NULL OR ttl_until > datetime('now'))
      ORDER BY confidence DESC, created_at DESC
      LIMIT 5
    `).all();

    wDb.close();
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      confidence: r.confidence,
      source: r.source,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

function main() {
  // 1. 检查未处理事件
  const { count: pendingEvents, watermark } = getUnprocessedEventCount();

  // 2. 获取近期 Dream 产出
  const recentLearnings = getRecentDreamLearnings();

  // 无新事件 + 无近期产出 → 静默跳过 (0 token)
  if (pendingEvents < MIN_EVENTS_THRESHOLD && recentLearnings.length === 0) {
    return;
  }

  const result = {
    source: 'dream-startup-inject',
    type: 'dream-check',
    pendingEvents,
    watermark,
  };

  // 3. 如果有足够事件，运行 Dream dry-run 检测模式
  if (pendingEvents >= MIN_EVENTS_THRESHOLD) {
    try {
      const dream = spawnSync('node', [DREAM_SCRIPT, '--dry-run'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      if (dream.status === 0 && dream.stdout) {
        // 提取模式行
        const lines = dream.stdout.split('\n').filter(l => l.includes('🔴') || l.includes('🟡') || l.includes('🟢'));
        result.dryRunOutput = dream.stdout.slice(0, 1000);
        result.patternLines = lines.slice(0, 5);
        result.dreamTriggered = true;
      } else {
        result.dryRunError = (dream.stderr || '').slice(0, 200);
        result.dreamTriggered = false;
      }
    } catch (e) {
      result.dryRunError = e.message;
      result.dreamTriggered = false;
    }
  }

  // 4. 注入近期 Dream 学习
  if (recentLearnings.length > 0) {
    result.recentDreamLearnings = recentLearnings.map(l => ({
      name: l.name,
      desc: (l.description || '').replace(/^Dream 自动: /, ''),
      confidence: l.confidence,
    }));
  }

  // 5. 生成人类可读简报
  const briefParts = [];
  if (pendingEvents >= MIN_EVENTS_THRESHOLD) {
    briefParts.push(`📊 ${pendingEvents} 个新事件待 Dream 分析`);
  }
  if (recentLearnings.length > 0) {
    briefParts.push(`💡 ${recentLearnings.length} 条近期 Dream 学习经验可用`);
  }
  result.brief = briefParts.join(' · ');

  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main();
}
