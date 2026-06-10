#!/usr/bin/env node

/**
 * engine/scripts/dream-consolidate.cjs — Dream 提炼器。
 *
 * 分析运行时事件, 识别重复模式, 输出结构化的 Lessons。
 * 仿 xihe Dream: runtime events → pattern detection → confidence upgrade → write learnings.
 *
 * 用法:
 *   node engine/scripts/dream-consolidate.cjs              # 全量运行
 *   node engine/scripts/dream-consolidate.cjs --dry-run    # 试运行, 不写文件
 *   node engine/scripts/dream-consolidate.cjs --force      # 忽略水印, 重扫所有
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('../sqlite/index.cjs');
const { sinceWatermark, getWatermark, setWatermark, countByType } = require('../sqlite/store-events.cjs');
const { writeMemory, retrieveMemory } = require('../sqlite/store-memory.cjs');
const { report, decayCandidates, setTier } = require('../sqlite/store-skills.cjs');

const HOME_DIR = path.resolve(__dirname, '..', '..');
const LEARNINGS_DIR = path.join(HOME_DIR, 'memory', 'learnings');

// ── 模式检测 ──────────────────────────────────────────────────────────────

/**
 * 检测事件中的重复模式。
 * @param {Array} events - RuntimeEventRow[]
 * @returns {Array<{ signal: string, count: number, examples: string[], suggestion: string }>}
 */
function detectPatterns(events) {
  const patterns = [];

  // 按类型聚合
  const byType = {};
  for (const ev of events) {
    if (!byType[ev.type]) byType[ev.type] = [];
    byType[ev.type].push(ev);
  }

  // 工具失败模式: 同一工具多次失败
  const toolFailures = byType['tool_fail'] || [];
  const byTool = {};
  for (const f of toolFailures) {
    const tool = f.payload?.tool || 'unknown';
    if (!byTool[tool]) byTool[tool] = [];
    byTool[tool].push(f);
  }
  for (const [tool, fails] of Object.entries(byTool)) {
    if (fails.length >= 3) {
      patterns.push({
        signal: `tool_fail(${tool})×${fails.length}`,
        count: fails.length,
        examples: fails.slice(0, 3).map(f => (f.payload?.error || '').slice(0, 80)),
        suggestion: `工具 ${tool} 频繁失败 (${fails.length}次)。建议: 检查配置或工作流中是否可添加预处理步骤。`,
        severity: fails.length >= 5 ? 'high' : 'medium',
      });
    }
  }

  // 卡住模式: 多次 drift_stuck
  const stuck = byType['drift_stuck'] || [];
  if (stuck.length >= 2) {
    patterns.push({
      signal: `drift_stuck×${stuck.length}`,
      count: stuck.length,
      examples: stuck.slice(0, 3).map(f => f.payload?.extra || f.payload?.matchedPattern || '').filter(Boolean),
      suggestion: '检测到多次挫败信号。建议: 考虑切换到根因分析模式, 或查阅类似问题的记忆。',
      severity: stuck.length >= 4 ? 'high' : 'medium',
    });
  }

  // 用户纠正模式
  const corrections = byType['user_correct'] || [];
  if (corrections.length >= 2) {
    patterns.push({
      signal: `user_correct×${corrections.length}`,
      count: corrections.length,
      examples: corrections.slice(0, 3).map(f => (f.payload?.message || '').slice(0, 80)).filter(Boolean),
      suggestion: '用户多次纠正。建议: 审查工作流中是否遗漏了关键验证步骤。',
      severity: 'medium',
    });
  }

  // 记忆未命中
  const memMiss = byType['memory_miss'] || [];
  if (memMiss.length >= 2) {
    patterns.push({
      signal: `memory_miss×${memMiss.length}`,
      count: memMiss.length,
      examples: memMiss.slice(0, 3).map(f => (f.payload?.query || '').slice(0, 80)).filter(Boolean),
      suggestion: '记忆系统多次未命中。建议: 检查是否有常用知识未录入记忆库。',
      severity: 'low',
    });
  }

  return patterns;
}

// ── 置信度升级 ────────────────────────────────────────────────────────────

/**
 * 将跨 session 复现的 tentative 事实升级为 confirmed。
 */
function upgradeConfidence(db) {
  // 找到被多次命中的 tentative 事实
  const candidates = db.prepare(`
    SELECT id, name, hit_count, confidence FROM facts
    WHERE confidence >= 0.3 AND confidence < 0.8 AND hit_count >= 3
    ORDER BY hit_count DESC
  `).all();

  for (const c of candidates) {
    db.prepare('UPDATE facts SET confidence = MIN(1.0, confidence + 0.1) WHERE id = ?').run(c.id);
  }

  return candidates.length;
}

// ── 技能退役 ──────────────────────────────────────────────────────────────

/**
 * 检查技能健康度, 标记退役候选。
 */
function checkSkillHealth(db) {
  const candidates = decayCandidates(90, { db });
  for (const c of candidates) {
    if (c.trigger_count === 0) {
      setTier(c.name, 'quarantine', { db });
    }
  }
  return candidates.length;
}

// ── 输出 ──────────────────────────────────────────────────────────────────

/**
 * 将检测到的模式写为 Learnings 事实 (非 dry-run 时)。
 */
function writeLearnings(patterns, db, isDryRun) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  let written = 0;

  for (const p of patterns) {
    if (p.severity === 'high' || p.count >= 3) {
      const content = [
        `# Dream 提炼: ${p.signal}`,
        '',
        `> 自动检测于 ${dateStr}`,
        '',
        '## 模式',
        `- 信号: ${p.signal}`,
        `- 出现次数: ${p.count}`,
        p.examples.length > 0 ? `- 示例: ${p.examples.join('; ')}` : '',
        '',
        '## 建议',
        p.suggestion,
        '',
        '## 相关事件',
        p.severity === 'high' ? `- 严重度: **高** — 建议审视工作流` : `- 严重度: ${p.severity}`,
      ].filter(Boolean).join('\n');

      if (!isDryRun) {
        writeMemory({
          namespace: 'learnings',
          name: `dream-${dateStr}-${p.signal.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40)}`,
          content,
          description: `Dream 自动: ${p.signal}`,
          source: 'script:dream',
          confidence: 0.5, // Dream 产出默认 tentative
          ttlDays: 180,
        }, { db });
        written++;
      }
    }
  }

  return written;
}

// ── 主函数 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  console.log(`🧠 Dream 提炼${isDryRun ? ' (DRY RUN)' : ''}`);
  console.log('');

  const wDb = openDb();

  // 1. 读取事件
  const watermark = force ? 0 : getWatermark({ db: wDb.db });
  const events = sinceWatermark(watermark, 200, { db: wDb.db });

  if (events.length === 0) {
    console.log('无新事件。跳过提炼。');
    if (!force) {
      wDb.close();
      return;
    }
  }

  console.log(`读取 ${events.length} 个事件 (watermark=${watermark})`);

  // 2. 按 session 分组
  const bySession = {};
  for (const ev of events) {
    if (!bySession[ev.sessionId]) bySession[ev.sessionId] = [];
    bySession[ev.sessionId].push(ev);
  }
  console.log(`涉及 ${Object.keys(bySession).length} 个 session`);

  // 3. 模式检测
  const patterns = detectPatterns(events);
  console.log(`检测到 ${patterns.length} 个模式`);
  for (const p of patterns) {
    const icon = p.severity === 'high' ? '🔴' : p.severity === 'medium' ? '🟡' : '🟢';
    console.log(`  ${icon} ${p.signal}: ${p.suggestion.slice(0, 80)}`);
  }

  // 4. 写入 Learnings
  const written = writeLearnings(patterns, wDb.db, isDryRun);
  console.log(`写入 ${written} 条 Learning 事实`);

  // 5. 置信度升级
  const upgraded = upgradeConfidence(wDb.db);
  if (upgraded > 0) console.log(`升级 ${upgraded} 条事实置信度`);

  // 6. 技能健康检查
  const quarantined = checkSkillHealth(wDb.db);
  if (quarantined > 0) console.log(`标记 ${quarantined} 个技能为 quarantine`);

  // 7. 更新水印
  if (!isDryRun && events.length > 0) {
    const maxId = events[events.length - 1].eventId;
    setWatermark(maxId, { db: wDb.db });
    console.log(`水印更新至 ${maxId}`);
  }

  // 8. 事件概要
  console.log('');
  console.log('事件类型分布:');
  const byType = countByType({ db: wDb.db });
  for (const t of byType) {
    console.log(`  ${t.type}: ${t.count}`);
  }

  wDb.close();
  console.log('\n✅ Dream 完成');
}

main().catch(err => {
  console.error('Dream 失败:', err.message);
  process.exit(1);
});
