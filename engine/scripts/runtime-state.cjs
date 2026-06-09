#!/usr/bin/env node
/**
 * Runtime State — L3 交接层：运行时状态管理器
 *
 * 双轨任务状态的"现场轨"：
 *   协议（YAML）= 意图 → 人类可读的"今天做什么、做到哪"
 *   状态（JSON）= 现场 → 机器测量的"工具调用轨迹、失败次数、推理模式"
 *
 * 用法:
 *   node runtime-state.cjs init          # 创建初始状态文件
 *   node runtime-state.cjs get           # 打印当前状态 (JSON)
 *   node runtime-state.cjs update <json> # 合并更新字段
 *   node runtime-state.cjs bump-failure  # 失败计数 +1
 *   node runtime-state.cjs set-mode <mode> # 设置推理模式
 *   node runtime-state.cjs record-tool <tool> <ok|err>  # 记录工具调用
 *   node runtime-state.cjs reset         # 重置当前会话状态
 *
 * 索引位置: var/index/runtime-state.json
 */

const p = require('path');
const f = require('fs');
const os = require('os');

const HOME = p.join(os.homedir(), '.claude');
const INDEX_DIR = p.join(HOME, 'var', 'index');
const STATE_FILE = p.join(INDEX_DIR, 'runtime-state.json');

const MODES = ['根因分析', '第一性原理', '减法', '搜索优先', '倒推', '证据驱动', '闭环'];

function defaultState() {
  return {
    version: 2,
    sessionId: process.env.CLAUDE_SESSION_ID || 'unknown',
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),

    // 推理模式
    currentMode: '',
    modeHistory: [],

    // 失败计数
    failureCount: 0,
    failureHistory: [],

    // 工具调用轨迹（只保留最近 50 条）
    toolCalls: [],

    // 压力标记（上下文紧张度）
    pressureFlags: [],

    // 当前任务认知摘要
    cognitive: {
      triedApproaches: [],
      currentHypothesis: '',
    },
  };
}

function read() {
  try {
    return JSON.parse(f.readFileSync(STATE_FILE, 'utf8'));
  } catch { return null; }
}

function write(state) {
  f.mkdirSync(INDEX_DIR, { recursive: true });
  state.lastActivityAt = new Date().toISOString();
  f.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Commands ──────────────────────────────────────────────────────────────

function cmdInit() {
  if (f.existsSync(STATE_FILE)) {
    console.error('Runtime state already exists. Use "reset" to clear.');
    process.exit(1);
  }
  const state = defaultState();
  write(state);
  console.error('Runtime state initialized at', STATE_FILE);
}

function cmdGet() {
  const state = read();
  if (!state) { console.log('{}'); process.exit(0); }
  console.log(JSON.stringify(state, null, 2));
}

function cmdUpdate(jsonStr) {
  let updates;
  try { updates = JSON.parse(jsonStr); } catch {
    console.error('Invalid JSON:', jsonStr);
    process.exit(1);
  }
  const state = read() || defaultState();
  Object.assign(state, updates);
  write(state);
  console.error('State updated.');
}

function cmdBumpFailure() {
  const state = read() || defaultState();
  state.failureCount = (state.failureCount || 0) + 1;
  state.failureHistory.push({
    count: state.failureCount,
    at: new Date().toISOString(),
    mode: state.currentMode,
  });
  write(state);
  console.error(`Failure count: ${state.failureCount}`);
}

function cmdSetMode(mode) {
  if (mode && !MODES.includes(mode)) {
    console.error(`Invalid mode. Valid modes: ${MODES.join(', ')}`);
    process.exit(1);
  }
  const state = read() || defaultState();
  if (state.currentMode) {
    state.modeHistory.push({ from: state.currentMode, to: mode, at: new Date().toISOString() });
  }
  state.currentMode = mode;
  write(state);
  console.error(`Mode set to: ${mode || '(none)'}`);
}

function cmdRecordTool(toolName, result) {
  const state = read() || defaultState();
  state.toolCalls.push({
    tool: toolName,
    result: result || 'ok',
    at: new Date().toISOString(),
    mode: state.currentMode,
  });
  // Keep last 50
  if (state.toolCalls.length > 50) {
    state.toolCalls = state.toolCalls.slice(-50);
  }
  write(state);
}

function cmdReset() {
  const state = defaultState();
  write(state);
  console.error('State reset.');
}

// ── Main ──────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
switch (cmd) {
  case 'init':       cmdInit(); break;
  case 'get':        cmdGet(); break;
  case 'update':     cmdUpdate(process.argv[3]); break;
  case 'bump-failure': cmdBumpFailure(); break;
  case 'set-mode':   cmdSetMode(process.argv[3]); break;
  case 'record-tool': cmdRecordTool(process.argv[3], process.argv[4]); break;
  case 'reset':      cmdReset(); break;
  default:
    console.error('Usage: node runtime-state.cjs <init|get|update|bump-failure|set-mode|record-tool|reset>');
    process.exit(1);
}
