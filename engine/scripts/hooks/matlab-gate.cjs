#!/usr/bin/env node
/**
 * engine/scripts/hooks/matlab-gate.cjs — MATLAB 专用门禁 (P0)
 *
 * PreToolUse(Bash) + PreToolUse(Write) Hook:
 *   1. 检测命令行 MATLAB 操作试图绕过 golden model 保护
 *   2. 检测 Python MATLAB 引擎调用写入 golden 路径
 *   3. .m 文件函数名/文件名一致性检查
 *
 * 退出码:
 *   0 — 安全，放行
 *   2 — 危险，拦截
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── 危险模式定义 (Bash 命令扫描) ───────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  // ===== 1. MATLAB CLI 写 golden 路径 =====
  {
    category: 'matlab-golden-write',
    severity: 'CRITICAL',
    patterns: [
      // matlab -batch/r with save/write operations
      /matlab.*-batch.*save\([^)]*(?:matlab|golden|fixed_point)/i,
      /matlab.*-r\s+.*save\([^)]*(?:matlab|golden|fixed_point)/i,
      /matlab.*-batch.*fopen\([^)]*(?:matlab|golden|fixed_point)/i,
      /matlab.*-batch.*fwrite/i,
      /matlab.*-batch.*writetable/i,
      /matlab.*-batch.*xlswrite/i,
      // MATLAB redirect output
      /matlab.*[>&]{2,}\s*.*(?:matlab|golden)/i,
    ],
    message: 'MATLAB 操作试图写入受保护的 Golden Model 路径',
  },

  // ===== 2. Python MATLAB 引擎绕过 =====
  {
    category: 'matlab-python-engine',
    severity: 'CRITICAL',
    patterns: [
      // Python calling MATLAB engine
      /python.*matlab\.engine/i,
      /python.*eng\.(?:eval|feval|workspace)/i,
      /python.*import\s+matlab/i,
    ],
    message: 'Python MATLAB 引擎调用 — 可能绕过文件保护',
  },

  // ===== 3. MATLAB 脚本写入受保护路径 =====
  {
    category: 'matlab-script-write',
    severity: 'HIGH',
    patterns: [
      // Running .m scripts that may write to golden paths
      /matlab.*-batch\s+.*(?:save|write|gen|export|report)/i,
      /matlab.*-r\s+.*run\(/i,
      // Direct save to matlab/ path
      /save\([^)]*['\"][^'\"]*(?:matlab|golden)[^'\"]*['\"]/i,
    ],
    message: 'MATLAB 脚本执行可能写入受保护路径',
  },
];

// ── MATLAB 文件写入检查 ────────────────────────────────────────────────────────

/**
 * 检查 .m 文件写入时的命名规范:
 * - 函数名必须与文件名一致
 * - 函数文件不得有全局 clear/close
 */
function checkMatlabWrite(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.m') return null;

  const basename = path.basename(filePath);
  const expectedFuncName = basename.replace(/\.m$/, '');

  // 类定义文件、脚本文件不做函数名检查
  if (basename.startsWith('classdef_')) return null;
  if (basename === 'run.m' || basename === 'main.m') return null;

  // 文件不存在时不做内容检查
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // 检查函数声明是否匹配文件名
    const funcMatch = content.match(/^function\s+(?:\[.*?\]|[\w_]+)\s*=\s*(\w+)|^function\s+(\w+)\s*\(/m);
    if (funcMatch) {
      const funcName = funcMatch[1] || funcMatch[2];
      if (funcName && funcName !== expectedFuncName) {
        return `MATLAB 命名违规: 文件名 "${basename}" 与函数名 "${funcName}" 不一致`;
      }
    }

    // 检查非脚本文件中的 clear all / close all
    if (funcMatch && /^clear\s+all/m.test(content)) {
      return 'MATLAB 规范: 函数文件中不应使用 "clear all" (应使用 clear 指定变量)';
    }
    if (funcMatch && /^close\s+all/m.test(content)) {
      return 'MATLAB 规范: 函数文件中不应使用 "close all" (应使用 close 指定句柄)';
    }
  } catch {
    // 读取失败跳过内容检查
  }

  return null;
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
  });
}

function block(info, detail) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║      📐  MATLAB GATE — 操作被阻断                           ║');
  console.error('╠══════════════════════════════════════════════════════════════╣');
  console.error(`║  风险等级: ${(info.severity || 'HIGH').padEnd(40)}║`);
  console.error(`║  类别:     ${(info.category || 'matlab-violation').padEnd(40)}║`);
  console.error(`║  原因:     ${(info.message || detail || '').padEnd(40)}║`);
  console.error('║                                                              ║');
  console.error('║  此操作被 MATLAB 门禁止执行。                                   ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error(`[MatlabGate] BLOCKED: ${info.message || detail}`);
}

function scanCommand(command) {
  if (!command || command.length === 0) {
    return { matched: false, info: null };
  }

  for (const group of DANGEROUS_PATTERNS) {
    for (const regex of group.patterns) {
      if (regex.test(command)) {
        return { matched: true, info: group };
      }
    }
  }

  return { matched: false, info: null };
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) process.exit(0);

    const payload = JSON.parse(raw);
    const eventName = payload?.hook_event_name || '';
    const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();

    // ── PreToolUse(Bash): 扫描危险 MATLAB 命令 ──
    if (eventName === 'PreToolUse' && toolName === 'bash') {
      const command = (payload?.tool_input?.command
        || payload?.tool?.input?.command
        || payload?.input?.command
        || payload?.command
        || '').trim();

      if (!command) process.exit(0);

      // 仅检查包含 matlab/save/fopen/writetable/xlswrite 的命令
      if (!/matlab|\.m\b|save\(|fopen|writetable|xlswrite|fwrite/i.test(command)) process.exit(0);

      const { matched, info } = scanCommand(command);
      if (matched) {
        block(info, command);
        process.exit(2);
      }
      process.exit(0);
    }

    // ── PreToolUse(Write): MATLAB 文件检查 ──
    if (eventName === 'PreToolUse' && (toolName === 'edit' || toolName === 'write')) {
      const filePath = (payload?.tool_input?.file_path
        || payload?.tool?.input?.file_path
        || payload?.input?.file_path
        || payload?.arguments?.file_path
        || '').trim();

      if (!filePath) process.exit(0);

      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.m') process.exit(0);

      const error = checkMatlabWrite(filePath);
      if (error) {
        block({ category: 'matlab-naming', severity: 'LOW', message: error });
        process.exit(2);
      }

      process.exit(0);
    }

    // ── 其他事件/工具 — 放行 ──
    process.exit(0);

  } catch (e) {
    console.error(`[MatlabGate] 解析错误(放行): ${e.message}`);
    process.exit(0);
  }
}

main();
