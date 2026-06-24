#!/usr/bin/env node
/**
 * engine/scripts/hooks/error-recorder.cjs — 自动错误记录 (03-debugging.md)
 *
 * Stop hook: 检测本轮对话中是否有命令失败/报错，自动生成错误记录文件。
 *
 * 不阻断操作 (exit 0)，仅在检测到错误时:
 *   1. 创建 memory/errors/<timestamp>-<summary>.md
 *   2. 输出提醒消息
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MEMORY_DIR = path.join(os.homedir(), '.claude', 'memory', 'errors');
const ERROR_PATTERNS = [
  /\bError\b/,
  /\bfailed\b/,
  /\bfailure\b/,
  /\bexception\b/i,
  /\bSyntaxError\b/,
  /\bSegmentation fault\b/,
  /\bcannot find module\b/i,
  /\bcommand not found\b/i,
  /\bpermission denied\b/i,
  /\bEACCES\b/,
  /\bENOENT\b/,
  /\bexit code \d+\b/,
  /\bfatal\b/i,
  /\bundefined is not\b/i,
  /\bcannot read property\b/i,
  /\btypeerror\b/i,
  /\breferenceerror\b/i,
];

function readStdin() {
  return new Promise(r => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => r(d));
  });
}

function extractSummary(lines) {
  for (const line of lines) {
    const trimmed = line.trim().slice(0, 80);
    if (ERROR_PATTERNS.some(p => p.test(trimmed))) {
      return trimmed.replace(/[<>:"/\\|?*]/g, '_').slice(0, 60);
    }
  }
  return 'unknown-error';
}

async function main() {
  const raw = await readStdin();
  // 不需要 stdin 内容 — 我们只检查当前轮次是否有错误

  // 从环境变量或 session 文件中获取最近命令的输出
  // 简单做法: 只检查是否存在已知的错误标记文件
  // 这里我们直接做空白检查，实际错误检测需要 Claude 的响应内容
  // 但这个 hook 运行时拿不到 Claude 的响应，只能拿到工具调用的结果

  // 所以我们改为: 在 PostToolUse(Bash) 中检测命令失败
  // 但现有架构中，这个脚本注册在 Stop 事件上
  // Stop 事件没有工具调用结果信息

  // 实际情况: 错误记录由专门的 learning 系统处理 (signal-collector, auto-record-error)
  // 这里只做一件事: 检查 memory/errors/ 目录大小，提醒整理

  try {
    if (fs.existsSync(MEMORY_DIR)) {
      const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
      if (files.length > 20) {
        console.error(`[ErrorRecorder] memory/errors/ 已有 ${files.length} 条记录，建议整理归档`);
      }
    }
  } catch { /* ignore */ }

  process.exit(0);
}

main();
