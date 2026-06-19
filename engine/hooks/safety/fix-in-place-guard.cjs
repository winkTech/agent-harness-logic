#!/usr/bin/env node
/**
 * Hook: fix-in-place-guard.cjs
 *
 * PreToolUse hook: 阻断 agent 创建文件变体。
 *
 * 检测 Write 操作中文件名是否匹配"重复变体"模式，以及 Bash 重定向中
 * 是否写入变体文件。匹配时输出 JSON 错误到 stderr 提醒用户，但不阻断执行。
 *
 * 拒绝模式:
 *   1. /_v\d+\.(sv|v)$/i         — scrambler_v2.sv
 *   2. /_\d+\.(sv|v)$/i          — freq_recovery_2.sv, tb_coarse_3.sv
 *   3. /_(new|final|basic|clk|stim|fast)\d*\.(sv|v)$/i  — tb_coarse_basic.sv
 *   4. /^check_rtl_\w+\d+\.sv$/i — check_rtl_freq_recovery21.sv
 *   5. /^run_debug\d+\.do$/i     — run_debug5.do
 *
 * 注册 (hook-config.json):
 *   "safety/fix-in-place-guard.cjs": { enabled: true, frequency: "high", ... }
 */

'use strict';

const p = require('node:path');

/**
 * 从文件路径中提取基本文件名。
 * @param {string} filePath
 * @returns {string}
 */
function extractFilename(filePath) {
  return p.basename(filePath);
}

/**
 * 从 Bash 命令中提取所有重定向目标文件名。
 * @param {string} command
 * @returns {string[]}
 */
function extractRedirectTargets(command) {
  const targets = [];
  // 匹配 > file 或 >> file（忽略 2>&1, >&2 等 fd 重定向）
  const redirectRe = /(?:\d*>|>)\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;
  let match;
  while ((match = redirectRe.exec(command)) !== null) {
    let target = match[1];
    // 去掉引号
    if ((target.startsWith('"') && target.endsWith('"')) ||
        (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1);
    }
    // 跳过文件描述符重定向 (2>&1, >&2)
    if (/^\d*>&\d*$/.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

/**
 * "重复变体"正则列表。
 * 每个条目: { name, re }
 */
const VARIANT_PATTERNS = [
  { name: 'versioned-sv', re: /_v\d+\.(sv|v)$/i },
  { name: 'numbered-sv',  re: /_\d+\.(sv|v)$/i },
  { name: 'keyword-sv',   re: /_(new|final|basic|clk|stim|fast)\d*\.(sv|v)$/i },
  { name: 'check-rtl',    re: /^check_rtl_\w+\d+\.sv$/i },
  { name: 'run-debug',    re: /^run_debug\d+\.do$/i },
];

/**
 * 检查文件名是否匹配变体模式。
 * @param {string} filename
 * @returns {{ matched: boolean, pattern?: string }}
 */
function checkVariant(filename) {
  for (const { name, re } of VARIANT_PATTERNS) {
    if (re.test(filename)) {
      return { matched: true, pattern: name };
    }
  }
  return { matched: false };
}

/**
 * 输出 JSON 错误到 stderr。
 * @param {object} info
 */
function reportViolation(info) {
  const msg = {
    source: 'fix-in-place-guard',
    type: 'violation',
    severity: 'ERROR',
    message: info.message,
    hint: info.hint || '原地修改已有文件',
    filename: info.filename,
    pattern: info.pattern,
  };
  console.error(JSON.stringify(msg));
}

/**
 * 主入口。
 * @param {object} [toolUse]
 * @param {object} [context]
 */
module.exports = function fixInPlaceGuard(toolUse, context) {
  if (!toolUse || !toolUse.name) return;

  // ---- Write 操作 ----
  if (toolUse.name === 'Write') {
    const input = toolUse.input || {};
    const filePath = input.filePath;
    if (!filePath || typeof filePath !== 'string') return;

    const filename = extractFilename(filePath);
    const result = checkVariant(filename);
    if (result.matched) {
      reportViolation({
        message: `检测到变体文件名: "${filename}"（匹配模式: ${result.pattern}）。不要创建文件变体，应原地修改已有文件。`,
        hint: '原地修改已有文件，不要创建带版本号/编号/关键字的变体',
        filename,
        pattern: result.pattern,
      });
    }
    return;
  }

  // ---- Bash 操作 ----
  if (toolUse.name === 'Bash') {
    const input = toolUse.input || {};
    const command = input.command;
    if (!command || typeof command !== 'string') return;

    const redirectTargets = extractRedirectTargets(command);
    for (const target of redirectTargets) {
      const filename = extractFilename(target);
      const result = checkVariant(filename);
      if (result.matched) {
        reportViolation({
          message: `检测到 Bash 重定向写入变体文件: "${filename}"（匹配模式: ${result.pattern}）。不要创建文件变体，应原地修改已有文件。`,
          hint: '原地修改已有文件，不要创建带版本号/编号/关键字的变体',
          filename,
          pattern: result.pattern,
        });
      }
    }
    return;
  }
};
