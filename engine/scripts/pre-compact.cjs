#!/usr/bin/env node
/**
 * engine/scripts/pre-compact.cjs — 压缩前状态保存 + 自动压缩触发 (P2)
 *
 * 功能:
 *   1. 在上下文压缩前保存 runtime state 检查点
 *   2. 记录压缩事件到 compaction-log
 *   3. 更新 context-monitor-gate 的压缩追踪标记
 *
 * 不依赖 ECC 插件，独立运行。
 * 注册: settings.local.json → pre:compact
 *
 * 用法:
 *   node pre-compact.cjs                    # 保存检查点（hook 模式）
 *   node pre-compact.cjs --status           # 查看压缩状态
 *   node pre-compact.cjs --trigger          # 强制触发压缩信号
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOMEDIR = os.homedir();
const HARNESS = path.join(HOMEDIR, '.claude');
const STATE_FILE = path.join(HARNESS, 'var', 'index', 'runtime-state.json');
const COMPACT_LOG = path.join(HARNESS, 'var', 'sessions', 'compaction-log.txt');
const PRESSURE_SIGNAL = path.join(HARNESS, 'var', 'sessions', '.compact-needed');

// ── 辅助 ─────────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── 核心功能 ──────────────────────────────────────────────────────────────────

/**
 * 保存压缩前检查点。
 * 读取当前 runtime state，写入 session checkpoint 字段。
 */
function saveCheckpoint() {
  const state = readJSON(STATE_FILE) || {};

  // 更新检查点标记
  state.lastCompactCheckpoint = new Date().toISOString();
  state.lastCompactToolCalls = (state.toolCalls || []).length;
  state.compactCount = (state.compactCount || 0) + 1;

  // 记录压缩事件
  const event = {
    timestamp: state.lastCompactCheckpoint,
    sessionId: process.env.CLAUDE_SESSION_ID || 'unknown',
    toolCallsAtCompact: state.lastCompactToolCalls,
    compactNumber: state.compactCount,
  };

  ensureDir(path.dirname(COMPACT_LOG));
  try {
    fs.appendFileSync(COMPACT_LOG, JSON.stringify(event) + '\n', 'utf8');
  } catch { /* ignore */ }

  writeJSON(STATE_FILE, state);
  return event;
}

/**
 * 获取压缩状态摘要。
 */
function getStatus() {
  const state = readJSON(STATE_FILE) || {};
  const logs = [];
  try {
    if (fs.existsSync(COMPACT_LOG)) {
      const content = fs.readFileSync(COMPACT_LOG, 'utf8');
      for (const line of content.trim().split('\n').filter(Boolean)) {
        try { logs.push(JSON.parse(line)); } catch { /* skip bad lines */ }
      }
    }
  } catch { /* ignore */ }

  return {
    compactCount: state.compactCount || 0,
    lastCompact: state.lastCompactCheckpoint || 'never',
    toolCallsAtCompact: state.lastCompactToolCalls || 0,
    totalToolCalls: (state.toolCalls || []).length,
    pressureFlags: state.pressureFlags || [],
    recentCompactions: logs.slice(-5),
  };
}

/**
 * 写入压缩信号文件。
 * 该文件由 context-monitor-gate 检查，触发自我紧缩行为。
 */
function signalCompact() {
  ensureDir(path.dirname(PRESSURE_SIGNAL));
  const signal = {
    timestamp: new Date().toISOString(),
    reason: process.argv[2] === '--trigger' ? 'manual-trigger' : 'auto-threshold',
    suggestedAction: 'compact',
  };
  fs.writeFileSync(PRESSURE_SIGNAL, JSON.stringify(signal, null, 2), 'utf8');
  saveCheckpoint();
  return signal;
}

/**
 * 清除压缩信号（压缩已执行或已处理）。
 */
function clearSignal() {
  try {
    if (fs.existsSync(PRESSURE_SIGNAL)) fs.unlinkSync(PRESSURE_SIGNAL);
  } catch { /* ignore */ }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    const s = getStatus();
    console.log(`压缩次数: ${s.compactCount}`);
    console.log(`上次压缩: ${s.lastCompact}`);
    console.log(`压缩时工具调用: ${s.toolCallsAtCompact}`);
    console.log(`当前总工具调用: ${s.totalToolCalls}`);
    if (s.recentCompactions.length > 0) {
      console.log(`最近压缩记录:`);
      for (const e of s.recentCompactions) {
        console.log(`  ${e.timestamp} | calls=${e.toolCallsAtCompact}`);
      }
    }
    if (fs.existsSync(PRESSURE_SIGNAL)) {
      console.log(`⚠️ 压缩信号文件存在 (.compact-needed)`);
    }
    return;
  }

  if (args.includes('--trigger')) {
    const s = signalCompact();
    console.log(`✅ 压缩信号已触发: ${s.timestamp}`);
    return;
  }

  if (args.includes('--clear')) {
    clearSignal();
    console.log('✅ 压缩信号已清除');
    return;
  }

  // 默认: hook 模式，保存检查点
  const event = saveCheckpoint();
  console.log(`[pre-compact] 检查点已保存: ${event.timestamp} (#${event.compactNumber})`);
}

if (require.main === module) {
  main();
}

module.exports = { saveCheckpoint, getStatus, signalCompact, clearSignal };
