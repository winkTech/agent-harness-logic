#!/usr/bin/env node
/**
 * Hook: pre-compact.cjs
 *
 * PreToolUse hook: 在会话压缩/总结前保存关键上下文状态，
 * 确保压缩后关键决策、进行中的任务、FSM 状态不丢失。
 *
 * 保存的内容:
 *   - 当前正在进行的任务 (从 runtime-state.json 读取)
 *   - 最近的工具调用链 (最后 5 条)
 *   - 关键决策记录
 *
 * 恢复机制: 压缩后启动时读取 var/index/pre-compact-state.json
 * 自动注入到 system prompt 中恢复上下文。
 *
 * 注册 (hook-config.json):
 *   "session/pre-compact.cjs": { enabled: true, frequency: "low", ... }
 */

'use strict';

const p = require('node:path');
const f = require('node:fs');
const os = require('node:os');

const HOME = p.join(os.homedir(), '.claude');
const STATE_DIR = p.join(HOME, 'var', 'index');
const STATE_FILE = p.join(STATE_DIR, 'pre-compact-state.json');
const RUNTIME_FILE = p.join(STATE_DIR, 'runtime-state.json');

const MAX_BACKUPS = 3;

/**
 * 读取 runtime-state.json
 */
function readRuntimeState() {
  try {
    if (f.existsSync(RUNTIME_FILE)) {
      return JSON.parse(f.readFileSync(RUNTIME_FILE, 'utf8'));
    }
  } catch { /* 静默降级 */ }
  return null;
}

/**
 * 轮转备份旧状态文件，保留最近 MAX_BACKUPS 份。
 */
function rotateBackups() {
  try {
    for (let i = MAX_BACKUPS - 1; i >= 0; i--) {
      const oldFile = STATE_FILE + '.' + i;
      if (f.existsSync(oldFile)) {
        if (i === MAX_BACKUPS - 1) {
          f.unlinkSync(oldFile);
        } else {
          f.renameSync(oldFile, STATE_FILE + '.' + (i + 1));
        }
      }
    }
    if (f.existsSync(STATE_FILE)) {
      f.renameSync(STATE_FILE, STATE_FILE + '.0');
    }
  } catch { /* 静默降级 */ }
}

/**
 * 检测当前会话是否需要保存关键状态。
 * 判断条件：正在进行的任务或最近的工具调用有实质内容。
 */
function shouldSave(runtime) {
  return !!(runtime && (runtime.currentMode ||
    (runtime.cognitive && runtime.cognitive.currentHypothesis) ||
    (runtime.spawnedAgents && runtime.spawnedAgents.length > 0)));
}

/**
 * 主入口。
 * @param {object} [toolUse] — 当前工具调用信息（可选）
 * @param {object} [context] — 上下文对象（可选）
 */
function main(toolUse, context) {
  try {
    const runtime = readRuntimeState();
    if (!runtime) return; // 无运行时状态，无需保存

    if (!shouldSave(runtime)) return; // 无实质内容，跳过

    // 轮转备份
    rotateBackups();

    // 构建保存数据
    const snapshot = {
      savedAt: new Date().toISOString(),
      currentMode: runtime.currentMode || '',
      modeHistory: (runtime.modeHistory || []).slice(-5),
      spawnedAgents: (runtime.spawnedAgents || []).slice(-3),
      cognitive: runtime.cognitive || {},
      failureCount: runtime.failureCount || 0,
      pressureFlags: runtime.pressureFlags || [],
    };

    f.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2), 'utf8');

    // 向系统提示注入上下文恢复信息
    console.error(JSON.stringify({
      source: 'pre-compact',
      type: 'context-persist',
      message: '上下文状态已保存到 ' + STATE_FILE,
      snapshot: {
        mode: snapshot.currentMode,
        agents: snapshot.spawnedAgents.length,
        failures: snapshot.failureCount,
      },
    }));

    if (context && typeof context.injectSystemPrompt === 'function') {
      const modeInfo = snapshot.currentMode
        ? '当前推理模式: ' + snapshot.currentMode + '。'
        : '';
      const agentInfo = snapshot.spawnedAgents.length > 0
        ? '已生成 ' + snapshot.spawnedAgents.length + ' 个子 Agent。'
        : '';
      context.injectSystemPrompt(
        '[上下文恢复] 压缩前的会话状态已保存。' + modeInfo + agentInfo
      );
    }

  } catch { /* 静默降级 */ }
}

/**
 * 读取保存的状态（压缩后恢复用）。
 * @returns {object|null}
 */
function readSnapshot() {
  try {
    if (f.existsSync(STATE_FILE)) {
      return JSON.parse(f.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* 静默降级 */ }
  return null;
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'save') {
    main();
  } else if (cmd === 'read') {
    const snap = readSnapshot();
    console.log(JSON.stringify(snap, null, 2));
  } else if (cmd === 'clean') {
    for (let i = 0; i < MAX_BACKUPS; i++) {
      try { f.unlinkSync(STATE_FILE + '.' + i); } catch { /* ignore */ }
    }
    try { f.unlinkSync(STATE_FILE); } catch { /* ignore */ }
    console.error('pre-compact: 状态文件已清理');
  } else {
    console.error('用法: node pre-compact.cjs [save|read|clean]');
  }
}

module.exports = { main, readSnapshot };
