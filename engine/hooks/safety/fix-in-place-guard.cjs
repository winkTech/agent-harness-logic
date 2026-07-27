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
 * 注册源: settings.json hooks（由 engine/scripts/hooks/hook-registry.cjs 校验）
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
 * 「基名存在」才算变体。
 *
 * 光看文件名会大量误伤: `_\d+\.(sv|v)$` 命中的 `crc_32.sv`、`fifo_1024.sv`、
 * `adder_8.sv` 全是正常的位宽/深度命名, 不是变体。真正的变体信号是
 * **同目录下基名文件已经存在** —— `scrambler.sv` 在旁边时, `scrambler_v2.sv`
 * 才是"没有原地改而是另起一份"。这样既保住了检出率, 又让硬拦成为可能:
 * 一条会误伤正常命名的规则是不可能被允许阻断的, 只能退化成没人看的告警。
 *
 * check-rtl / run-debug 两类是一次性调试产物, 命名本身就说明问题, 不需要基名佐证。
 */
const NEEDS_BASE = new Set(['versioned-sv', 'numbered-sv', 'keyword-sv']);

function baseNameOf(filename, pattern) {
  const m = /^(.*?)(?:_v\d+|_\d+|_(?:new|final|basic|clk|stim|fast)\d*)(\.(?:sv|v))$/i.exec(filename);
  return m ? `${m[1]}${m[2]}` : null;
}

/**
 * 检查文件名是否匹配变体模式。
 * @param {string} filename
 * @param {string} [dir] 所在目录, 用于「基名是否已存在」判定
 * @returns {{ matched: boolean, pattern?: string, confident?: boolean, base?: string }}
 */
function checkVariant(filename, dir) {
  for (const { name, re } of VARIANT_PATTERNS) {
    if (!re.test(filename)) continue;
    if (!NEEDS_BASE.has(name)) return { matched: true, pattern: name, confident: true };

    const base = baseNameOf(filename, name);
    let baseExists = false;
    if (base && dir) {
      try { baseExists = require('node:fs').existsSync(p.join(dir, base)); } catch { /* 判不了就按不确定处理 */ }
    }
    return { matched: true, pattern: name, confident: baseExists, base: base || undefined };
  }
  return { matched: false };
}

/**
 * 输出 JSON 错误到 stderr。
 * @param {object} info
 */
const VIOLATIONS = [];

function reportViolation(info) {
  const msg = {
    source: 'fix-in-place-guard',
    type: 'violation',
    severity: info.confident ? 'ERROR' : 'WARN',
    message: info.message,
    hint: info.hint || '原地修改已有文件',
    filename: info.filename,
    pattern: info.pattern,
    ...(info.base ? { base: info.base } : {}),
  };
  VIOLATIONS.push(msg);
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
    // 平台传的是 file_path (snake_case)。旧代码只读 filePath, 于是即使被调用
    // 也永远拿不到路径 —— 这是它「三重失效」中的第二重。
    const filePath = input.file_path || input.filePath;
    if (!filePath || typeof filePath !== 'string') return;

    const filename = extractFilename(filePath);
    const result = checkVariant(filename, p.dirname(filePath));
    if (result.matched) {
      reportViolation({
        message: `检测到变体文件名: "${filename}"（匹配模式: ${result.pattern}）。不要创建文件变体，应原地修改已有文件。`,
        hint: '原地修改已有文件，不要创建带版本号/编号/关键字的变体',
        filename,
        pattern: result.pattern,
        confident: result.confident,
        base: result.base,
      });
    }
    return;
  }

  // ---- Bash / PowerShell 操作 ----
  if (toolUse.name === 'Bash' || toolUse.name === 'PowerShell') {
    const input = toolUse.input || {};
    const command = input.command;
    if (!command || typeof command !== 'string') return;

    const redirectTargets = extractRedirectTargets(command);
    // PowerShell 不用 > 重定向也能建文件, 单靠 extractRedirectTargets 会漏。
    for (const m of command.matchAll(/(?:Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item)[^\n]*?[-\s]((?:[A-Za-z]:)?[^\s"';|]+\.(?:sv|v|do))\b/gi)) {
      redirectTargets.push(m[1]);
    }
    for (const target of redirectTargets) {
      const filename = extractFilename(target);
      const result = checkVariant(filename, p.dirname(target));
      if (result.matched) {
        reportViolation({
          message: `检测到 shell 写入变体文件: "${filename}"（匹配模式: ${result.pattern}）。不要创建文件变体，应原地修改已有文件。`,
          hint: '原地修改已有文件，不要创建带版本号/编号/关键字的变体',
          filename,
          pattern: result.pattern,
          confident: result.confident,
          base: result.base,
        });
      }
    }
    return;
  }
};

// ── CLI 入口 ────────────────────────────────────────────────────────────────
//
// 这是本 guard「三重失效」的第一重: 以前整个文件只导出一个函数, 没有 stdin 读取、
// 没有退出码、没有 require.main —— 即使在 settings.json 里注册了也只会被当成一个
// 普通脚本执行一遍然后什么都不做。而 docs/rules/README.md 与三条 memory 记录都
// 声称它在 PreToolUse 阻断变体文件。文档说有、代码不跑, 比明说"没有"更糟。
//
// 分级: 基名已存在(或 check_rtl_/run_debug 这类一次性调试产物) → ERROR, 硬拦;
// 仅文件名像变体但基名不存在 → WARN, 放行。理由见 checkVariant 的注释。

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => resolve(raw));
  });
}

async function main() {
  if (process.env.CLAUDE_GATES_DISABLED === 'true') process.exit(0);
  if (process.env.FIX_IN_PLACE_GUARD_DISABLED === '1') process.exit(0);

  const raw = await readStdin();
  if (!raw) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const toolName = payload?.tool_name || payload?.tool?.name || payload?.name || '';
  const input = payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
  try {
    module.exports({ name: toolName, input });
  } catch (e) {
    console.error(`[fix-in-place-guard] 内部错误, 放行: ${e.message}`);
    process.exit(0);
  }

  const hard = VIOLATIONS.filter((v) => v.severity === 'ERROR');
  if (hard.length > 0) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('║    🛑 FIX-IN-PLACE GUARD — 禁止创建文件变体                  ║');
    console.error('╠══════════════════════════════════════════════════════════════╣');
    for (const v of hard) {
      console.error(`║  ${String(v.filename).slice(0, 58).padEnd(58)}║`);
      if (v.base) console.error(`║  基名 ${String(v.base).slice(0, 53).padEnd(53)}║`);
    }
    console.error('║                                                              ║');
    console.error('║  基名文件已存在 —— 请原地修改它, 不要另起一份变体。          ║');
    console.error('║  规则见 docs/rules-archive/14-fix-in-place.md                ║');
    console.error('╚══════════════════════════════════════════════════════════════╝');
    console.error('');
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) main();
