#!/usr/bin/env node
/**
 * Hook: skill-tracker-hook.cjs
 *
 * PostToolUse hook: 在 Skill 工具调用后，追踪技能触发到 SQLite。
 * 更新 store-skills 的 trigger_count / success_count / last_triggered_at，
 * 同时写入 runtime_events (skill_trigger 类型) 供 Dream 自学习使用。
 *
 * 注册 (settings.local.json):
 *   PostToolUse:
 *     node engine/hooks/learning/skill-tracker-hook.cjs
 */

'use strict';

const fs = require('node:fs');

/** 从 stdin 解析工具调用信息 */
function parseToolCall(input) {
  try {
    const data = JSON.parse(input);
    const name = data?.tool || data?.toolName || '';
    const skillInput = data?.input || data?.arguments || {};
    const skillName = skillInput?.skill || '';
    const skillArgs = skillInput?.args || '';
    return { toolName: name, skillName, skillArgs };
  } catch {
    return null;
  }
}

async function main() {
  try {
    // 读取 stdin (PostToolUse 注入工具调用信息)
    let input = '';
    try {
      input = fs.readFileSync(0, 'utf8');
    } catch { return; }
    if (!input) return;

    const call = parseToolCall(input);
    if (!call || call.toolName !== 'Skill') return; // 只关心 Skill 工具

    const sessionId = process.env.CLAUDE_SESSION_ID || `s-${Date.now()}`;

    // 动态 require (静默失败)
    let skills, events, openDb;
    try {
      skills = require('../../sqlite/store-skills.cjs');
      events = require('../../sqlite/store-events.cjs');
      openDb = require('../../sqlite/index.cjs').openDb;
    } catch { return; }

    const wDb = openDb();
    const db = wDb.db;

    // 1. 更新技能注册表
    if (call.skillName) {
      const existing = skills.get(call.skillName, { db });
      if (existing) {
        skills.touch(call.skillName, {
          success: true,
          query: call.skillArgs || call.skillName,
          durationMs: 0, // 无法在子进程中精确测量
        }, { db });
      }
    }

    // 2. 写入 runtime_events (供 Dream 消费)
    events.record({
      sessionId,
      type: 'skill_trigger',
      payload: { skill: call.skillName, args: (call.skillArgs || '').slice(0, 200) },
    }, null, { db });

    wDb.close();
  } catch { /* 静默失败，不阻塞 hook 链 */ }
}

main();
