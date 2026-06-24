#!/usr/bin/env node
/**
 * engine/scripts/hooks/hdl-gate.cjs — HDL 编码规则硬门禁 (P0)
 *
 * 强制执行 rules/01-hdl.md 和 skills/hdl-coding/SKILL.md 中的关键规则:
 *
 *   1. Testbench-First: 新建 RTL 模块前必须有对应的 Testbench
 *   2. No initial in RTL: 综合代码禁止使用 initial 语句
 *   3. 命名规范: 输入/输出信号前后缀检查 (ri_/ro_)
 *
 * 注册:
 *   PreToolUse(Write)   — Testbench-First 检查
 *   PostToolUse(Write)  — 代码规范扫描
 *
 * 退出码:
 *   0 — 合规
 *   2 — 违规拦截
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const logicAnalyzer = require('../hdl-lint/logic-analyzer.cjs');

/** Git Bash → Windows 原生路径转换 */
function toNativePath(p) {
  if (process.platform !== 'win32' || !p) return p;
  const m = p.match(/^\/([a-zA-Z])\/(.+)$/);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  if (p.startsWith('/tmp/')) {
    return path.join(os.tmpdir(), p.slice(5)).replace(/\//g, '\\');
  }
  return p.replace(/\//g, '\\');
}

const MAX_STDIN = 64 * 1024;

// ── 模式定义 ────────────────────────────────────────────────────────────────

/** 源码路径模式 — 匹配 RTL 源文件写入 */
const SRC_PATTERNS = [
  /01_src[\\/]00_hdl/i,
  /src[\\/]hdl/i,
  /rtl/i,
];

/** 仿真路径模式 — 匹配对应的 TB 目录 */
const SIM_PATTERNS = [
  /02_sim/i,
  /sim/i,
  /testbench/i,
  /tb/i,
];

/** TB 文件模式 — 识别 TB 文件 */
const TB_FILE_PATTERNS = [
  /tb_/i,
  /_tb\./i,
  /testbench/i,
  /test\.sv/i,
];

/** 综合禁止的模式 (exit 2) */
const SYNTHESIS_VIOLATIONS = [
  { pattern: /\binitial\b/,          message: '禁止使用 initial 语句（不可综合）' },
  { pattern: /\bdisable\b/,          message: '禁止使用 disable 语句（不可综合）' },
  { pattern: /\bwait\s+[^;]*;/,     message: '禁止在综合代码中使用 wait（不可综合）' },
  { pattern: /\bassign\s+ri_/,      message: '输入信号(ri_)不应被 assign 驱动' },
  { pattern: /#\d+\s/,              message: '禁止使用延时 #delay（不可综合）' },
  { pattern: /\bforce\b/,           message: '禁止使用 force 语句（不可综合）' },
];

/** 命名规范检查 */
const NAMING_CHECKS = [
  {
    check: (line, fname) => {
      // 检查 output reg 或 output logic 是否以 ro_ 开头
      const m = line.match(/^\s*(output)\s+(reg|logic|wire)\s+(\[.*?\]\s+)?(\w+)/);
      if (m && !m[4].startsWith('ro_') && !fname.includes('_tb') && !fname.includes('TB_')) {
        return `输出信号 "${m[4]}" 应以 ro_ 开头 (line: ${line.trim().slice(0, 40)})`;
      }
      return null;
    },
  },
  {
    check: (line, fname) => {
      // 检查 input 是否以 ri_ 开头
      const m = line.match(/^\s*(input)\s+(reg|logic|wire)?\s*(\[.*?\]\s+)?(\w+)/);
      if (m && !m[4].startsWith('ri_') && !fname.includes('_tb') && !fname.includes('TB_')) {
        return `输入信号 "${m[4]}" 应以 ri_ 开头 (line: ${line.trim().slice(0, 40)})`;
      }
      return null;
    },
  },
];

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { if (raw.length < MAX_STDIN) raw += c; });
    process.stdin.on('end', () => resolve(raw));
  });
}

function projectRoot(p) {
  const normalized = p.replace(/\\/g, '/');

  // 策略1: 从路径模式推断项目根（优先于 .claude/.git 搜索）
  // 找 .../01_src/00_hdl/module/file.sv 中的 project_root
  const srcPattern = normalized.match(/^(.*?)\/?01_src[\/\\]00_hdl\//);
  if (srcPattern) return srcPattern[1] || '.';
  // 找 .../02_sim/module/file.sv 中的 project_root
  const simPattern = normalized.match(/^(.*?)\/?02_sim\//);
  if (simPattern) return simPattern[1] || '.';

  // 策略2: 向上查找 .claude 或 .git 作为项目根（兜底）
  let dir = path.dirname(path.resolve(p));
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }

  return '.'; // fallback: 当前目录
}

function findTbForModule(fp) {
  // 从文件路径推断模块名和对应的 TB 路径
  const normalized = fp.replace(/\\/g, '/');

  // 匹配 src 目录中的模块路径: .../01_src/00_hdl/<module>/<file>.sv
  const srcMatch = normalized.match(/(?:01_src\/00_hdl|src\/hdl|rtl)\/([^/]+)\/([^/]+)\.(sv|v)$/);
  if (!srcMatch) return null;

  const moduleDir = srcMatch[1]; // 模块名目录
  const fileName = srcMatch[2];  // 文件名(不含扩展名)
  const ext = srcMatch[3];       // sv 或 v

  // 可能的 TB 路径模式
  const projRoot = projectRoot(fp);
  if (!projRoot) return null;

  const candidates = [
    path.join(projRoot, '02_sim', moduleDir, `tb_${fileName}.${ext}`),
    path.join(projRoot, '02_sim', moduleDir, `tb_${fileName}.sv`),
    path.join(projRoot, '02_sim', moduleDir, `${fileName}_tb.${ext}`),
    path.join(projRoot, '02_sim', moduleDir, `${fileName}_tb.sv`),
    path.join(projRoot, 'sim', moduleDir, `tb_${fileName}.sv`),
    path.join(projRoot, 'testbench', moduleDir, `tb_${fileName}.sv`),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function isNewModuleFile(fp) {
  // 判断是否为新模块文件（目录中没有其他 .sv/.v 文件）
  const dir = path.dirname(fp);
  try {
    const existing = fs.readdirSync(dir).filter(f => /\.(sv|v)$/i.test(f));
    // 如果目录中只有当前文件（或没有文件），并且没有 TB，视为新模块
    const currentFile = path.basename(fp);
    const others = existing.filter(f => f !== currentFile);
    return others.length === 0;
  } catch { return true; }
}

function checkNamingViolations(content, fileName) {
  const violations = [];
  const lines = content.split('\n');

  for (const line of lines) {
    for (const nc of NAMING_CHECKS) {
      const msg = nc.check(line, fileName);
      if (msg) violations.push(msg);
    }
  }
  return violations;
}

/**
 * 自动修复 HDL 命名违规: 将 output signal → ro_signal, input signal → ri_signal
 * @param {string} fp 文件路径
 * @returns {number} 修复处数
 */
function autoFixNaming(fp) {
  try {
    let content = fs.readFileSync(fp, 'utf8');
    const lines = content.split('\n');
    let fixed = 0;
    const newLines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*')) return line;

      // 修复 output 缺 ro_
      let m = line.match(/^(\s*output\s+(reg|logic|wire)?\s*(\[.*?\]\s+)?)([a-z]\w*)/);
      if (m && !m[4].startsWith('ro_')) {
        fixed++;
        return m[1] + 'ro_' + m[4];
      }

      // 修复 input 缺 ri_
      m = line.match(/^(\s*input\s+(reg|logic|wire)?\s*(\[.*?\]\s+)?)([a-z]\w*)/);
      if (m && !m[4].startsWith('ri_')) {
        fixed++;
        return m[1] + 'ri_' + m[4];
      }

      return line;
    });

    if (fixed > 0) {
      fs.writeFileSync(fp, newLines.join('\n'), 'utf8');
    }
    return fixed;
  } catch { return 0; }
}

function checkSynthesisViolations(content) {
  const violations = [];
  for (const v of SYNTHESIS_VIOLATIONS) {
    if (v.pattern.test(content)) {
      violations.push(v.message);
    }
  }
  return violations;
}

function block(title, messages, command) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error(`║    🔒 HDL GATE — ${title.padEnd(44)}║`);
  console.error('╠══════════════════════════════════════════════════════════════╣');
  for (const msg of messages) {
    console.error(`║  ${msg.padEnd(70)}║`);
  }
  console.error('║                                                              ║');
  if (command) console.error(`║  ${command.slice(0, 70).padEnd(70)}║`);
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  try { require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'hgd.txt'), raw || '__EMPTY__'); } catch(e) {}
  if (!raw) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const eventName = payload?.hook_event_name || '';
  const toolName = (payload?.tool?.name || payload?.tool_name || payload?.name || '').toLowerCase();
  const filePath = (payload?.tool_input?.file_path || payload?.tool?.input?.file_path || payload?.input?.file_path || payload?.arguments?.file_path || '').trim();
  // Convert Git Bash paths (/c/...) to Windows native (C:\...) for fs operations
  const resolvedPath = toNativePath(filePath);
  const command = (payload?.tool_input?.command || payload?.tool?.input?.command || payload?.command || '').trim();

  // ── 所有文件操作统一使用 resolvedPath ──────────────────────────────────────
  const fp = resolvedPath || filePath;

  // ── PreToolUse(Write): 全方位拦截 ──────────────────────────────────────────
  // 任何 .sv/.v 写入前都检查违规，路径不限
  if ((!eventName || eventName === 'PreToolUse') && toolName === 'write' && filePath) {
    const isHdl = /\.(sv|v)$/i.test(filePath);
    if (!isHdl) process.exit(0);

    // 从 payload 提取待写入的内容（PreToolUse 时文件尚未写入磁盘）
    const content = payload?.tool_input?.content || payload?.tool?.input?.content || payload?.input?.content || payload?.arguments?.content || '';
    if (!content) process.exit(0);

    const fileName = path.basename(fp);
    const isTb = !!(fileName.match(/tb_|_tb|testbench/i));
    const violations = [];

    // 综合违规检查 (exit 2)
    if (!isTb) {
      const synthVios = checkSynthesisViolations(content);
      violations.push(...synthVios.map(v => `[综合违规] ${v}`));
    }

    // 命名规范检查 (exit 2) — PreToolUse 只报告不自动修复（文件尚未创建）
    if (!isTb) {
      const namingVios = checkNamingViolations(content, fileName);
      violations.push(...namingVios.map(v => `[命名规范] ${v}`));
    }

    // Testbench-First 检查（仅限正式项目目录 01_src/ 下）
    if (!isTb && SRC_PATTERNS.some(p => p.test(filePath))) {
      const tbPath = findTbForModule(fp);
      if (!tbPath && isNewModuleFile(fp)) {
        const moduleName = fileName.replace(/\.(sv|v)$/i, '');
        violations.push(`[Testbench-First] 新建 RTL 模块需先编写 Testbench (tb_${moduleName}.sv 或 ${moduleName}_tb.sv)`);
      }
    }

    if (violations.length > 0) {
      const isSynthViolation = violations.some(v => v.includes('[综合违规]'));
      block(
        isSynthViolation ? '综合编码违规' : '编码规范违规',
        violations,
        filePath
      );
      process.exit(2); // 硬拦截
    }
  }

  // ── PostToolUse(Write): 代码规范扫描 ──────────────────────────────────────
  if ((!eventName || eventName === 'PostToolUse') && toolName === 'write' && filePath) {
    const isHdl = /\.(sv|v)$/i.test(filePath);
    if (!isHdl) process.exit(0);

    let content;
    try { content = fs.readFileSync(fp, 'utf8'); } catch { process.exit(0); }

    const fileName = path.basename(fp);
    const violations = [];

    // 综合违规检查 (exit 2) — 这些必须拦截
    if (!fileName.match(/tb_|_tb|testbench/i)) {
      const synthVios = checkSynthesisViolations(content);
      violations.push(...synthVios.map(v => `[综合违规] ${v}`));
    }

    // 命名自动修复 — 自动纠正 ri_/ro_ 而非仅拦截
    if (!fileName.match(/tb_|_tb|testbench/i)) {
      const fixed = autoFixNaming(fp);
      if (fixed > 0) {
        console.error(`[HDL-Gate] 自动修复 ${fixed} 处命名违规 (ri_/ro_)`);
        // 修复后重新读取内容，确保后续检查使用修复后的版本
        try { content = fs.readFileSync(fp, 'utf8'); } catch { /* 读取失败不影响已有违规检查 */ }
      }
    }

    // 命名规范检查 (exit 2) — 自动修复后仍有违规才拦截
    if (!fileName.match(/tb_|_tb|testbench/i)) {
      const namingVios = checkNamingViolations(content, fileName);
      violations.push(...namingVios.map(v => `[命名规范] ${v}`));
    }

    // 逻辑级数/扇出/嵌套深度检查 (exit 2)
    if (!fileName.match(/tb_|_tb|testbench/i)) {
      const result = logicAnalyzer.analyzeFile(fp);
      if (result && result.violations && result.violations.length > 0) {
        for (const v of result.violations) {
          violations.push(`[逻辑分析] ${v.type}: ${v.detail}`);
        }
      }
    }

    if (violations.length > 0) {
      // 按严重程度：综合违规 > 命名规范
      const isSynthViolation = violations.some(v => v.includes('[综合违规]'));
      block(
        isSynthViolation ? '综合编码违规' : '编码规范违规',
        violations,
        filePath
      );
      process.exit(2); // 硬拦截
    }
  }

  process.exit(0);
}

main();
