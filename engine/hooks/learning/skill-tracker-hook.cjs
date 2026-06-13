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

/**
 * 从 stdin 解析工具调用信息。
 *
 * Claude Code PostToolUse stdin 格式:
 *   Line 1: 工具名 (如 "Skill")
 *   Line 2+: JSON 工具输入
 * 部分 hook runner 也可能直接传纯 JSON。
 */
function parseToolCall(input) {
  try {
    const trimmed = input.trim();
    // 尝试整段解析（纯 JSON 格式）
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      // 多行格式: 第一行是工具名，剩余行是 JSON
      const lines = trimmed.split('\n');
      const toolName = lines[0].trim();
      const rest = lines.slice(1).join('\n').trim();
      if (rest) {
        data = JSON.parse(rest);
        data.tool = data.tool || toolName;
      } else {
        return null;
      }
    }

    const name = data?.tool || data?.toolName || '';
    // 多行格式: skill 在顶层; 纯 JSON 格式: 嵌套在 input/arguments 下
    const skillInput = data?.input || data?.arguments || {};
    const skillName = skillInput?.skill || data?.skill || '';
    const skillArgs = skillInput?.args || data?.args || '';
    return { toolName: name, skillName, skillArgs };
  } catch {
    return null;
  }
}

/** 从环境变量获取工具调用信息（备选路径） */
function parseToolCallFromEnv() {
  const toolName = process.env.CLAUDE_TOOL_NAME || '';
  const toolInput = process.env.CLAUDE_TOOL_INPUT || '';
  if (!toolName) return null;
  try {
    const data = JSON.parse(toolInput);
    const skillInput = data?.arguments || data?.input || {};
    return {
      toolName,
      skillName: skillInput?.skill || data?.skill || '',
      skillArgs: skillInput?.args || data?.args || '',
    };
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

    const call = parseToolCall(input) || parseToolCallFromEnv();
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
