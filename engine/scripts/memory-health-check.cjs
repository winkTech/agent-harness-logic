#!/usr/bin/env node

/**
 * engine/scripts/memory-health-check.cjs — 记忆系统健康检查。
 *
 * 用法:
 *   node engine/scripts/memory-health-check.cjs         # 全量检查
 *   node engine/scripts/memory-health-check.cjs --fix    # 修复可自动修复的问题
 */

'use strict';

const { openDb } = require('../sqlite/index.cjs');
const { memoryStats, purgeExpired } = require('../sqlite/store-memory.cjs');
const { countByType } = require('../sqlite/store-events.cjs');
const { report } = require('../sqlite/store-skills.cjs');

async function main() {
  const args = process.argv.slice(2);
  const shouldFix = args.includes('--fix');

  console.log('🏥 记忆系统健康检查\n');

  const wDb = openDb();
  const db = wDb.db;

  // 1. 事实统计
  console.log('1. 事实表:');
  const st = memoryStats({ db });
  console.log(`   总记录: ${st.total}`);
  console.log(`   已确认 (≥0.8): ${st.confirmed}`);
  console.log(`   待定 (0.3-0.8): ${st.tentative}`);
  console.log(`   低置信 (<0.3): ${st.low}`);
  console.log(`   命名空间: ${st.namespaces}`);

  // 按命名空间分布
  const nsDist = db.prepare('SELECT namespace, COUNT(*) AS c FROM facts GROUP BY namespace ORDER BY c DESC').all();
  for (const n of nsDist) {
    console.log(`     ${n.namespace}: ${n.c} 条`);
  }

  // 2. FTS5 完整性
  console.log('\n2. FTS5 完整性:');
  const mainCount = db.prepare('SELECT COUNT(*) AS c FROM facts').get().c;
  const ftsCount = db.prepare('SELECT COUNT(*) AS c FROM facts_fts').get().c;
  const ftsOk = mainCount === ftsCount;
  console.log(`   facts: ${mainCount} | facts_fts: ${ftsCount} | ${ftsOk ? '✅' : '❌ 不匹配'}`);

  if (!ftsOk && shouldFix) {
    console.log('   正在重建 FTS5 索引...');
    db.exec("INSERT INTO facts_fts (facts_fts) VALUES ('rebuild')");
    const newFtsCount = db.prepare('SELECT COUNT(*) AS c FROM facts_fts').get().c;
    console.log(`   重建后: ${newFtsCount} ${mainCount === newFtsCount ? '✅' : '⚠️'}`);
  }

  // 3. 链接完整性
  console.log('\n3. 链接完整性:');
  const linkCount = db.prepare('SELECT COUNT(*) AS c FROM fact_links').get().c;
  const brokenLinks = db.prepare(`
    SELECT COUNT(*) AS c FROM fact_links l
    LEFT JOIN facts f1 ON l.from_id = f1.id
    LEFT JOIN facts f2 ON l.to_id = f2.id
    WHERE f1.id IS NULL OR f2.id IS NULL
  `).get().c;
  console.log(`   总链接: ${linkCount}`);
  console.log(`   断裂链接: ${brokenLinks} ${brokenLinks === 0 ? '✅' : '⚠️'}`);

  if (brokenLinks > 0 && shouldFix) {
    db.prepare(`
      DELETE FROM fact_links WHERE from_id NOT IN (SELECT id FROM facts)
      OR to_id NOT IN (SELECT id FROM facts)
    `).run();
    console.log('   已清理断裂链接');
  }

  // 4. 过期数据
  console.log('\n4. 过期数据:');
  const expired = db.prepare('SELECT COUNT(*) AS c FROM facts WHERE ttl_until IS NOT NULL AND ttl_until < ?').get(Date.now()).c;
  console.log(`   过期待清理: ${expired}`);

  if (expired > 0 && shouldFix) {
    const purged = purgeExpired({ db });
    console.log(`   已清理: ${purged} 条`);
  }

  // 5. 事件存储
  console.log('\n5. 事件存储:');
  const eventCount = db.prepare('SELECT COUNT(*) AS c FROM runtime_events').get().c;
  const eventTypes = countByType({ db });
  console.log(`   总事件: ${eventCount}`);
  for (const t of eventTypes) {
    console.log(`     ${t.type}: ${t.count}`);
  }

  // 6. 技能健康
  console.log('\n6. 技能健康:');
  const skills = report({ db });
  const tiers = { core: 0, 'on-demand': 0, quarantine: 0, tombstone: 0 };
  for (const s of skills) {
    tiers[s.tier] = (tiers[s.tier] || 0) + 1;
  }
  console.log(`   core: ${tiers.core} | on-demand: ${tiers['on-demand']} | quarantine: ${tiers.quarantine || 0} | tombstone: ${tiers.tombstone || 0}`);
  for (const s of skills) {
    if (s.tier === 'quarantine') console.log(`     ⚠️ ${s.name} (triggers=${s.triggers}, lastUsed=${s.lastUsed || 'never'})`);
  }

  // 7. 整体评分
  console.log('\n7. 健康评分:');
  let score = 100;
  if (!ftsOk) score -= 15;
  if (brokenLinks > 0) score -= 10;
  if (expired > 5) score -= 5;
  if (tiers.quarantine > 5) score -= 5;
  if (st.confirmed < st.total * 0.3) score -= 5; // 太少已确认事实
  score = Math.max(0, score);

  console.log(`   ${score >= 90 ? '🟢' : score >= 70 ? '🟡' : '🔴'} ${score}/100`);

  if (score >= 90) {
    console.log('\n✅ 记忆系统健康');
  } else if (score >= 70) {
    console.log('\n⚠️ 记忆系统一般, 建议运行 --fix');
  } else {
    console.log('\n🔴 记忆系统需要维护');
  }

  wDb.close();
}

main().catch(err => {
  console.error('健康检查失败:', err.message);
  process.exit(1);
});
