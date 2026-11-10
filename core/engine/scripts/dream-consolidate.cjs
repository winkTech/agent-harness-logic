#!/usr/bin/env node

/**
 * engine/scripts/dream-consolidate.cjs — Dream 提炼器。
 *
 * 分析运行时事件, 识别重复模式, 输出低置信、待人工审查的候选。
 * runtime events → pattern detection → review-only candidates.
 *
 * 用法:
 *   node engine/scripts/dream-consolidate.cjs              # 全量运行
 *   node engine/scripts/dream-consolidate.cjs --dry-run    # 试运行, 不写文件
 *   node engine/scripts/dream-consolidate.cjs --force      # 忽略水印, 重扫所有
 */

'use strict';

const crypto = require('node:crypto');

const { openDb } = require('../sqlite/index.cjs');
const {
  sinceWatermark,
  countSinceWatermark,
  getWatermark,
  setWatermark,
  countByType,
} = require('../sqlite/store-events.cjs');
const { writeMemory } = require('../sqlite/store-memory.cjs');
const { decayCandidates, setTier } = require('../sqlite/store-skills.cjs');

// ── 模式检测 ──────────────────────────────────────────────────────────────

/**
 * 检测事件中的模式。v2.0 升级:
 *   - 跨类型关联（tool_fail → drift_stuck 转移概率）
 *   - 时间序列模式（事件链重复）
 *   - 代码错误聚类（相同错误消息跨 session 出现）
 *   - 6 种新事件类型支持
 *
 * @param {Array} events - RuntimeEventRow[]
 * @param {number} sessionCount - 涉及的 session 数
 * @returns {Array<{ signal: string, count: number, examples: string[], suggestion: string, severity: string }>}
 */
function detectPatterns(events, sessionCount) {
  const patterns = [];

  // 按类型聚合
  const byType = {};
  const bySession = {};
  for (const ev of events) {
    if (!byType[ev.type]) byType[ev.type] = [];
    byType[ev.type].push(ev);
    if (!bySession[ev.sessionId]) bySession[ev.sessionId] = [];
    bySession[ev.sessionId].push(ev);
  }

  // ── 1. 工具失败模式 (原有的，增强版) ──────────────────────
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

  // ── 2. 代码错误聚类 v2 ──────────────────────────────────
  // 将 tool_fail 中的错误消息按相似度聚类
  if (toolFailures.length >= 3) {
    const errorClusters = {};
    for (const f of toolFailures) {
      const errMsg = (f.payload?.error || f.payload?.stdinPreview || '').slice(0, 60);
      if (!errMsg) continue;
      // 取前 40 字符作为指纹（去除行号等易变信息）
      const fingerprint = errMsg.replace(/\d+/g, 'N').replace(/line \d+/gi, '').slice(0, 40);
      if (!errorClusters[fingerprint]) errorClusters[fingerprint] = { errors: [], sessions: new Set() };
      errorClusters[fingerprint].errors.push(errMsg);
      errorClusters[fingerprint].sessions.add(f.sessionId);
    }
    for (const [fingerprint, cluster] of Object.entries(errorClusters)) {
      if (cluster.errors.length >= 3 && cluster.sessions.size >= 2) {
        patterns.push({
          signal: `code_error×${cluster.errors.length} (${cluster.sessions.size} sessions)`,
          count: cluster.errors.length,
          examples: [...cluster.errors].slice(0, 3),
          suggestion: `相同错误 "` + cluster.errors[0].slice(0, 50) + `" 在 ${cluster.sessions.size} 个 session 中出现 ${cluster.errors.length} 次。建议: 创建 permanent learning 记录此错误模式及修复。`,
          severity: 'medium',
        });
      }
    }
  }

  // ── 3. 跨类型序列模式 v2 ──────────────────────────────────
  // 检测一个 session 中事件类型的转移序列
  if (sessionCount >= 2) {
    const transitions = {}; // "A→B" → count
    for (const [sid, sEvents] of Object.entries(bySession)) {
      const types = sEvents.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).map(e => e.type);
      for (let i = 1; i < types.length; i++) {
        const key = `${types[i-1]}→${types[i]}`;
        transitions[key] = (transitions[key] || 0) + 1;
      }
    }
    // 找高频跨类型转移: 不同类型的转移且出现 ≥2 次
    for (const [trans, count] of Object.entries(transitions)) {
      const [from, to] = trans.split('→');
      if (from !== to && count >= 2) {
        patterns.push({
          signal: `transition:${trans}×${count}`,
          count,
          examples: [`${from} 后常跟随 ${to}`],
          suggestion: `事件序列 "${from} → ${to}" 出现 ${count} 次。${from === 'tool_fail' ? '工具失败后切换模式可能减少后续挫败。' : '建议关注此事件链对应的工作流环节。'}`,
          severity: count >= 3 ? 'medium' : 'low',
        });
      }
    }
  }

  // ── 4. 上下文压力模式 v2 (新增) ──────────────────────────
  const pressure = byType['context_pressure'] || [];
  const redPressure = pressure.filter(p => p.payload?.level === 'RED');
  if (redPressure.length >= 2) {
    patterns.push({
      signal: `context_pressure(RED)×${redPressure.length}`,
      count: redPressure.length,
      examples: redPressure.slice(0, 3).map(p => `${p.payload?.estimatedRatio || '?'}%`),
      suggestion: `上下文达到 RED 红线 ${redPressure.length} 次。建议: 在 workflow 关键阶段后自动 /compact。`,
      severity: 'high',
    });
  }

  // ── 5. 模式切换模式 (新增) ──────────────────────────────
  const modeSwitches = byType['mode_switch'] || [];
  const forcedSwitches = modeSwitches.filter(m => m.payload?.forceModeSwitch);
  if (forcedSwitches.length >= 3) {
    const switchModes = forcedSwitches.map(m => m.payload?.mode).filter(Boolean);
    const uniqueModes = [...new Set(switchModes)];
    patterns.push({
      signal: `mode_switch×${forcedSwitches.length}`,
      count: forcedSwitches.length,
      examples: uniqueModes.slice(0, 3),
      suggestion: `强制模式切换 ${forcedSwitches.length} 次 (${uniqueModes.join(', ')})。建议: 审查工作流是否在让 AI 反复碰壁后才切换方向。`,
      severity: forcedSwitches.length >= 5 ? 'high' : 'medium',
    });
  }

  // ── 6. 循环跳过模式 (新增) ──────────────────────────────
  const loopSkips = byType['loop_skip'] || [];
  if (loopSkips.length >= 2) {
    const loopNodes = [...new Set(loopSkips.map(l => l.payload?.nodeName).filter(Boolean))];
    patterns.push({
      signal: `loop_skip×${loopSkips.length}`,
      count: loopSkips.length,
      examples: loopNodes.slice(0, 5),
      suggestion: `DAG 循环跳过 ${loopSkips.length} 次${loopNodes.length > 0 ? ` (节点: ${loopNodes.join(', ')})` : ''}。建议: 检查这些节点的前置依赖和输入条件。`,
      severity: loopSkips.length >= 3 ? 'high' : 'medium',
    });
  }

  // ── 7. 已有类型: 卡住/挫败 ──────────────────────────────
  const stuck = byType['drift_stuck'] || [];
  if (stuck.length >= 2) {
    patterns.push({
      signal: `drift_stuck×${stuck.length}`,
      count: stuck.length,
      examples: stuck.slice(0, 3).map(f => f.payload?.extra || f.payload?.matchedPattern || '').filter(Boolean),
      suggestion: `检测到多次挫败信号 (${stuck.length}次)。${modeSwitches.length > 0 ? '部分触发了模式切换。' : '建议考虑切换到根因分析模式。'}`,
      severity: stuck.length >= 4 ? 'high' : 'medium',
    });
  }

  // ── 8. 已有类型: 用户纠正 ──────────────────────────────
  const corrections = byType['user_correct'] || [];
  if (corrections.length >= 1) {
    // 用户纠正是最有价值的信号 — 即使只有1次也提炼
    const msgs = corrections.map(f => (f.payload?.message || '').slice(0, 120)).filter(Boolean);
    patterns.push({
      signal: `user_correct×${corrections.length}`,
      count: corrections.length,
      examples: msgs.slice(0, 5),
      suggestion: msgs.length > 0
        ? `用户纠正: "${msgs[0]}". 建议: 将此纠正提炼为规则或记忆, 防止同类错误重现。`
        : '用户多次纠正。建议: 审查工作流中是否遗漏了关键验证步骤。',
      severity: 'high', // 用户纠正始终是高严重度
    });
  }

  // ── 8.5 已验证解决链: 失败 → 根因/修复 → 验证通过 ─────────────
  const resolutions = byType['resolution'] || [];
  for (const resolution of resolutions) {
    const sessionEvents = bySession[resolution.sessionId] || [];
    const verification = sessionEvents.find(event => (
      event.type === 'verification_pass' && event.eventId > resolution.eventId
    ));
    const rootCause = String(resolution.payload?.rootCause || '').trim();
    const fix = String(resolution.payload?.fix || '').trim();
    const evidence = String(
      verification?.payload?.evidence || verification?.payload?.command || '',
    ).trim();
    if (!verification || !rootCause || !fix || !evidence) continue;
    const failure = sessionEvents.find(event => event.type === 'tool_fail');
    const subject = String(failure?.payload?.tool || 'workflow').slice(0, 60);
    patterns.push({
      signal: `verified_resolution:${subject}`,
      count: 1,
      examples: [
        `root cause: ${rootCause.slice(0, 200)}`,
        `fix: ${fix.slice(0, 200)}`,
        `verification: ${evidence.slice(0, 200)}`,
      ],
      suggestion: `已验证解决链。根因: ${rootCause.slice(0, 200)}；修复: ${fix.slice(0, 200)}；证据: ${evidence.slice(0, 200)}。`,
      severity: 'high',
    });
  }

  // ── 9. 难题模式 (新增) ──────────────────────────────────
  const hardProblems = byType['hard_problem'] || [];
  if (hardProblems.length >= 1) {
    const descs = hardProblems.map(f => (f.payload?.description || f.payload?.message || '').slice(0, 120)).filter(Boolean);
    patterns.push({
      signal: `hard_problem×${hardProblems.length}`,
      count: hardProblems.length,
      examples: descs.slice(0, 3),
      suggestion: descs.length > 0
        ? `难题: "${descs[0]}". 建议: 分析根因并记录解决方案。`
        : '检测到难题。建议: 复盘分析是否需要新工具或流程。',
      severity: 'high',
    });
  }

  // ── 9. 已有类型: 记忆未命中 ──────────────────────────────
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
 * 置信度升级模型 v2.0:
 *
 *    confidence = base + 0.15 × hit_count - 0.05 × days_since_last_hit + 0.2 × cross_session_confirmed
 *
 *   - hit_count 奖励: 每命中一次 +0.15 (比原来 +0.1 更有区分度)
 *   - 时间衰减: 每天 -0.05 (长期不命中的事实自动降级)
 *   - 跨 session 确认: 在 ≥2 个不同 session 中命中的事实 +0.2
 *
 *  最终值 clamped 到 [0, 1]。
 */
function upgradeConfidence(db) {
  // 找到可升级的事实 (tentative 区间 0.3~0.8，且命中 ≥2)
  const candidates = db.prepare(`
    SELECT id, name, hit_count, confidence, last_hit_at FROM facts
    WHERE confidence >= 0.3 AND confidence < 0.8 AND hit_count >= 2
    ORDER BY hit_count DESC, last_hit_at DESC
  `).all();

  let upgraded = 0;
  const now = Date.now();

  for (const c of candidates) {
    let newConf = c.confidence;

    // hit_count 奖励
    newConf += 0.15 * c.hit_count;

    // 时间衰减 (每 24 小时 -0.05)
    if (c.last_hit_at) {
      const daysSince = (now - new Date(c.last_hit_at).getTime()) / 86400000;
      newConf -= 0.05 * Math.max(0, daysSince - 7); // 前 7 天免衰减
    }

    // 跨 session 确认: 在 ≥2 session 中出现过
    const sessionCount = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as cnt FROM runtime_events
      WHERE payload LIKE ?
    `).get(`%${c.name}%`);
    if (sessionCount && sessionCount.cnt >= 2) {
      newConf += 0.2;
    }

    newConf = Math.max(0, Math.min(1.0, newConf));

    if (Math.abs(newConf - c.confidence) > 0.01) {
      db.prepare('UPDATE facts SET confidence = ? WHERE id = ?').run(newConf, c.id);
      upgraded++;
    }
  }

  return upgraded;
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
 * 将检测到的模式写为待审候选 (非 dry-run 时)。
 */
function candidateSourceKey(pattern) {
  const family = String(pattern.signal || '').replace(/×\d+(?:\s*\([^)]*\))?/g, '').trim();
  const example = String(pattern.examples?.[0] || pattern.suggestion || '')
    .replace(/\d+/g, 'N')
    .slice(0, 200);
  const digest = crypto.createHash('sha256').update(`${family}|${example}`).digest('hex').slice(0, 20);
  return `dream:${digest}`;
}

function writeCandidates(patterns, db, isDryRun) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  let written = 0;

  for (const p of patterns) {
    // 高严重度始终写，中严重度需 count>=3，低严重度需 count>=5
    const shouldWrite = p.severity === 'high' ||
      (p.severity === 'medium' && p.count >= 3) ||
      (p.severity === 'low' && p.count >= 5);
    if (!shouldWrite) continue;

    // 生成可检索的 description (不只是信号名)
    const descText = p.examples.length > 0
      ? `Dream candidate: ${p.signal} — ${p.examples[0].slice(0, 80)}`
      : `Dream candidate: ${p.signal} — ${p.suggestion.slice(0, 80)}`;
      const content = [
        `# Dream 候选: ${p.signal}`,
        '',
        'status: review_required',
        `> 自动检测于 ${dateStr}。来源: dream-consolidate v3.0`,
        '',
        '## 模式',
        `- 信号: ${p.signal}`,
        `- 出现次数: ${p.count}`,
        p.examples.length > 0 ? `- 示例: ${p.examples.join('; ')}` : '',
        '',
        '## 建议',
        p.suggestion,
        '',
        '## 严重度',
        p.severity === 'high' ? '**高** — 建议审视工作流' : p.severity,
        '',
        '## 候选约束',
        '此条仅是待审候选，不是 Harness 规则，也不会自动晋升。',
        '需补齐根因、修复、验证证据、适用条件和反例后再人工审查。',
        '如果此模式不再出现，将在 180 天后过期。',
      ].filter(Boolean).join('\n');

      if (!isDryRun) {
        const baseConfidence = p.severity === 'high' ? 0.4 : (p.severity === 'medium' ? 0.3 : 0.25);
        writeMemory({
          namespace: 'learnings',
          name: `dream-${dateStr}-${p.signal.replace(/[^a-zA-Z0-9一-鿿]/g, '-').slice(0, 40)}`,
          content,
          description: descText,
          source: 'script:dream',
          sourceKey: candidateSourceKey(p),
          confidence: baseConfidence,
          ttlDays: 180,
        }, { db });
        written++;
      }
  }

  return written;
}

// ── 主函数 ─────────────────────────────────────────────────────────────────

function runDream(opts = {}) {
  const isDryRun = opts.dryRun === true;
  const force = opts.force === true;
  const requestedLimit = Number(opts.maxEvents ?? 100);
  const maxEvents = Number.isFinite(requestedLimit)
    ? Math.min(500, Math.max(1, Math.trunc(requestedLimit)))
    : 100;
  const log = typeof opts.logger === 'function' ? opts.logger : console.log;
  const wDb = opts.db ? null : openDb(opts.dbPath ? { path: opts.dbPath } : {});
  const db = opts.db || wDb.db;

  try {
    log(`🧠 Dream 提炼${isDryRun ? ' (DRY RUN)' : ''}`);
    log('');

    // 1. 读取事件
    const committedWatermark = getWatermark({ db, consumer: 'dream' });
    const watermark = force ? 0 : committedWatermark;
    const events = sinceWatermark(watermark, maxEvents, { db });
    if (events.length === 0) {
      log('无新事件。跳过提炼。');
      return {
        inspected: 0,
        processed: 0,
        pending: countSinceWatermark(committedWatermark, { db }),
        patterns: 0,
        candidatesWritten: 0,
        watermarkBefore: committedWatermark,
        watermarkAfter: committedWatermark,
        dryRun: isDryRun,
      };
    }
    log(`读取 ${events.length} 个事件 (watermark=${watermark})`);

    // 2. 按 session 分组
    const bySession = {};
    for (const ev of events) {
      if (!bySession[ev.sessionId]) bySession[ev.sessionId] = [];
      bySession[ev.sessionId].push(ev);
    }
    const sessionCount = Object.keys(bySession).length;
    log(`涉及 ${sessionCount} 个 session`);

    // 3. 模式检测
    const patterns = detectPatterns(events, sessionCount);
    log(`检测到 ${patterns.length} 个模式 (${sessionCount} sessions)`);
    for (const [severity, label] of [['high', '🔴 高严重度'], ['medium', '🟡 中严重度'], ['low', '🟢 低严重度']]) {
      const matching = patterns.filter(pattern => pattern.severity === severity);
      if (matching.length === 0) continue;
      log(`  ${label}:`);
      for (const pattern of matching) log(`    ${pattern.signal} — ${pattern.suggestion.slice(0, 80)}`);
    }

    // 4. Candidate writes are read-only when isDryRun=true.
    const written = writeCandidates(patterns, db, isDryRun);
    log(`写入 ${written} 条待审候选`);

    let watermarkAfter = committedWatermark;
    if (!isDryRun) {
      // 5. Advance only Dream's watermark after candidate writes succeed.
      if (events.length > 0) {
        const maxId = events[events.length - 1].eventId;
        watermarkAfter = Math.max(committedWatermark, maxId);
        setWatermark(watermarkAfter, { db, consumer: 'dream' });
        log(`Dream 水印更新至 ${watermarkAfter}`);
      }
    }

    // 8. 事件概要
    log('');
    log('事件类型分布:');
    const byType = countByType({ db });
    for (const item of byType) log(`  ${item.type}: ${item.count}`);
    log('\n✅ Dream 完成');
    return {
      inspected: events.length,
      processed: isDryRun ? 0 : events.length,
      pending: countSinceWatermark(watermarkAfter, { db }),
      patterns: patterns.length,
      candidatesWritten: written,
      watermarkBefore: committedWatermark,
      watermarkAfter,
      dryRun: isDryRun,
    };
  } finally {
    if (wDb) wDb.close();
  }
}

function main() {
  const args = process.argv.slice(2);
  const maxEventsArg = args.find(arg => arg.startsWith('--max-events='));
  return runDream({
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    maxEvents: maxEventsArg ? Number(maxEventsArg.slice('--max-events='.length)) : undefined,
  });
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Dream 失败:', err.message);
    process.exit(1);
  }
}

module.exports = {
  runDream,
  detectPatterns,
  writeCandidates,
  writeLearnings: writeCandidates,
  candidateSourceKey,
  upgradeConfidence,
  checkSkillHealth,
};
