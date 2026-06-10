'use strict';

/**
 * engine/sqlite/store-skills.cjs — 技能注册表 (生命周期 + 使用统计 + 自动退役)。
 *
 * 用法:
 *   const skills = require('./store-skills.cjs');
 *   skills.register('hdl-coding', 'core', 'HDL 编码规范');
 *   skills.touch('hdl-coding', { success: true });
 *   skills.report();
 */

const { openDb } = require('./index.cjs');

/** 规范化 opts.db 为 DatabaseSync 实例 */
function resolveDb(opts = {}) {
  if (!opts.db) return openDb().db;
  if (opts.db.db && typeof opts.db.prepare === 'undefined') return opts.db.db;
  return opts.db;
}

/**
 * 注册或更新一个技能。
 * 幂等: 同名技能更新描述/tier, 保留 use_count 等运行时字段。
 *
 * @param {string} id        — 'sk_hdl_coding'
 * @param {string} name      — 'hdl-coding'
 * @param {string} tier      — 'core'|'on-demand'|'quarantine'|'tombstone'
 * @param {string} [description]
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 */
function register(id, name, tier, description, opts = {}) {
  const db = resolveDb(opts);
  const now = Date.now();
  const desc = description || '';

  const existing = db.prepare('SELECT id FROM skills WHERE name = ?').get(name);
  if (existing) {
    db.prepare('UPDATE skills SET description = ?, tier = ? WHERE name = ?').run(desc, tier, name);
  } else {
    db.prepare(
      'INSERT INTO skills (id, name, description, tier, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, desc, tier, now);
  }
}

/**
 * 标记技能被触发: trigger_count++ + last_triggered_at 更新。
 *
 * @param {string} name      — 'hdl-coding'
 * @param {object} [trigger]
 * @param {boolean} [trigger.success]
 * @param {number} [trigger.durationMs]
 * @param {string} [trigger.query]       — 匹配到技能的查询词
 * @param {object} [opts]
 * @param {import('node:sqlite').DatabaseSync} [opts.db]
 */
function touch(name, trigger = {}, opts = {}) {
  const db = resolveDb(opts);
  const now = Date.now();

  // 更新主表
  db.prepare('UPDATE skills SET trigger_count = trigger_count + 1, last_triggered_at = ? WHERE name = ?')
    .run(now, name);

  // 写入触发日志 (id = skills.id, 不是 name)
  if (trigger.query) {
    const skill = db.prepare('SELECT id FROM skills WHERE name = ?').get(name);
    if (!skill) return;
    db.prepare(
      'INSERT INTO skill_triggers (skill_id, matched_query, success, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      skill.id,
      trigger.query,
      trigger.success === undefined ? null : (trigger.success ? 1 : 0),
      trigger.durationMs || null,
      now,
    );
  }
}

/**
 * 标记技能执行结果 (更新成功率)。
 *
 * @param {string} name
 * @param {boolean} success
 * @param {object} [opts]
 */
function recordOutcome(name, success, opts = {}) {
  const db = resolveDb(opts);
  const field = success ? 'success_count' : null;
  if (field) {
    db.prepare('UPDATE skills SET success_count = success_count + 1 WHERE name = ?').run(name);
  }
  // 更新 trigger 表
  db.prepare(
    `UPDATE skill_triggers SET success = ? WHERE skill_id = ? AND success IS NULL ORDER BY created_at DESC LIMIT 1`,
  ).run(success ? 1 : 0, name);
}

/**
 * 技能完整报告 (含使用统计)。
 * @returns {Array<{ id: string; name: string; tier: string; triggers: number; successRate: number; lastUsed: string|null }>}
 */
function report(opts = {}) {
  const db = resolveDb(opts);
  const rows = db.prepare(`
    SELECT name, id, tier, trigger_count, success_count, last_triggered_at, description
    FROM skills
    WHERE tier != 'tombstone'
    ORDER BY trigger_count DESC
  `).all();

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    tier: r.tier,
    triggers: r.trigger_count,
    successRate: r.trigger_count > 0 ? Math.round((r.success_count / r.trigger_count) * 100) : 0,
    lastUsed: r.last_triggered_at ? new Date(r.last_triggered_at).toISOString() : null,
  }));
}

/**
 * 查询单个技能。
 */
function get(name, opts = {}) {
  const db = resolveDb(opts);
  return db.prepare('SELECT * FROM skills WHERE name = ?').get(name) || null;
}

/**
 * 查找退役候选 (90 天未使用且非 core)。
 *
 * @param {number} [staleDays]  — 默认 90
 * @returns {Array<{ name: string; last_triggered_at: number|null; trigger_count: number }>}
 */
function decayCandidates(staleDays = 90, opts = {}) {
  const db = resolveDb(opts);
  const cutoff = Date.now() - staleDays * 86_400_000;

  return db.prepare(`
    SELECT name, last_triggered_at, trigger_count
    FROM skills
    WHERE tier NOT IN ('core')
      AND (last_triggered_at IS NULL OR last_triggered_at < ?)
      AND tier != 'tombstone'
    ORDER BY last_triggered_at ASC NULLS FIRST
  `).all(cutoff);
}

/**
 * 修改技能 tier。
 */
function setTier(name, tier, opts = {}) {
  const db = resolveDb(opts);
  db.prepare('UPDATE skills SET tier = ? WHERE name = ?').run(tier, name);
}

module.exports = {
  register,
  touch,
  recordOutcome,
  report,
  get,
  decayCandidates,
  setTier,
};
