#!/usr/bin/env node
/**
 * engine/scripts/hooks/hdl-gate.cjs — HDL 编码规则硬门禁 (P0)
 *
 * 强制执行 docs/rules/01-hdl.md 和 skills/hdl-coding/SKILL.md 中的关键规则:
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
const SRC_SEGMENT_PATTERNS = [
  /(?:^|\/)01_src\/00_hdl(?:\/|$)/i,
  /(?:^|\/)src\/hdl(?:\/|$)/i,
  /(?:^|\/)rtl(?:\/|$)/i,
];

/** 仿真路径模式 — 匹配对应的 TB 目录 */
const SIM_SEGMENT_PATTERN = /(?:^|\/)(?:02_sim|sim|testbench|tb|05_vip)(?:\/|$)/i;

/** TB 文件模式 — 识别 TB 文件 */
const PORT_DECL_KEYWORDS = new Set([
  'input', 'output', 'inout', 'wire', 'reg', 'logic', 'signed', 'unsigned',
  'tri', 'var',
]);

/** 综合禁止的模式 (exit 2) */
const SYNTHESIS_VIOLATIONS = [
  { pattern: /\binitial\b/,          message: '禁止使用 initial 语句（不可综合）' },
  { pattern: /\bdisable\b/,          message: '禁止使用 disable 语句（不可综合）' },
  { pattern: /\bwait\s+[^;]*;/,     message: '禁止在综合代码中使用 wait（不可综合）' },
  { pattern: /\bassign\s+ri_/,      message: '输入信号(ri_)不应被 assign 驱动' },
  { pattern: /#\d+\s/,              message: '禁止使用延时 #delay（不可综合）' },
  { pattern: /\bforce\b/,           message: '禁止使用 force 语句（不可综合）' },
];

/** 命名规范检查 — check(line, fileName, filePath) 签名 */
function normalizedForMatch(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isSimulationPath(filePath) {
  return SIM_SEGMENT_PATTERN.test(normalizedForMatch(filePath));
}

function isSourcePath(filePath) {
  const normalized = normalizedForMatch(filePath);
  return !isSimulationPath(normalized) && SRC_SEGMENT_PATTERNS.some(p => p.test(normalized));
}

function isTbFileName(fileName) {
  return /(?:^tb_|_tb\.|testbench|test\.sv)/i.test(fileName || '');
}

// 标准总线协议信号豁免 ri_/ro_ 前缀
// 依据 docs/rules/01-hdl.md §命名例外 / SKILL.md §2: AXI/Wishbone/JTAG 保持协议原名。
const BUS_SIGNAL_RE = /^[sm]_axi(s)?_|_axi(s)?_|^wb_|_wb_|^(tck|tms|tdi|tdo|trst)$/i;
const CLK_RST_RE = /^(i_)?(clk|rst|clock|reset)/i;
function isBusSignal(name) { return BUS_SIGNAL_RE.test(String(name || '')); }
function isClkRstName(name) { return CLK_RST_RE.test(String(name || '')); }
// 端口豁免 ri_ (输入): 时钟/复位 + 标准总线协议
function isExemptInputPort(name) { return isClkRstName(name) || isBusSignal(name); }

// 去除 function/task 体, 避免其形参被误当作模块端口
function stripFunctionTaskBodies(text) {
  return String(text || '')
    .replace(/\bfunction\b[\s\S]*?\bendfunction\b/g, ' ')
    .replace(/\btask\b[\s\S]*?\bendtask\b/g, ' ');
}

// [已移除] NAMING_CHECKS —— 定义后从未被调用的死代码, 且沿用了错误的
// "端口须以 ri_/ro_ 开头" 判据。判据的唯一权威实现是 checkNamingViolations。

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

  // engineering-assets CBB 包布局: <asset>/rtl/<file>.sv 的 TB 在 <asset>/tb/ 或同级
  {
    const dir = path.dirname(fp);
    const base = path.basename(fp).replace(/\.(sv|v)$/i, '');
    for (const c of [
      path.join(dir, `tb_${base}.sv`), path.join(dir, `${base}_tb.sv`),
      path.join(dir, '..', 'tb', `tb_${base}.sv`), path.join(dir, '..', 'tb', `${base}_tb.sv`),
    ]) { if (fs.existsSync(c)) return c; }
  }

  // 匹配 src 目录中的模块路径: .../01_src/00_hdl/<module>/<file>.sv
  const srcMatch = normalized.match(/(?:^|\/)(?:01_src\/00_hdl|src\/hdl|rtl)\/([^/]+)\/([^/]+)\.(sv|v)$/i);
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

// 端口命名判据 —— 依据 docs/rules/01-hdl.md §命名规范:
//   i_/o_  = 模块端口 (输入/输出)
//   ri_/ro_ = 模块**内部**对输入/输出做寄存的信号, 不是端口名
// 早期版本在此要求端口本身以 ri_/ro_ 开头, 与上述规范相反, 导致合规模块被 exit 2 拦死。
function checkNamingViolations(content, fileName, filePath) {
  if (!isSourcePath(filePath) || isTbFileName(fileName)) return [];

  const violations = [];
  for (const port of extractDirectedPorts(content)) {
    if (isBusSignal(port.name)) continue; // 标准总线保持协议原名
    if (port.direction === 'input') {
      if (isClkRstName(port.name)) continue; // 时钟/复位允许 clk/rst/i_clk 等写法
      if (!port.name.startsWith('i_')) {
        violations.push(`输入端口 "${port.name}" 应以 i_ 开头 (declaration: ${port.declaration})`);
      }
    }
    if (port.direction === 'output' && !port.name.startsWith('o_')) {
      violations.push(`输出端口 "${port.name}" 应以 o_ 开头 (declaration: ${port.declaration})`);
    }
  }
  return violations;
}

function stripComments(content) {
  return String(content || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

function nextBoundary(text, start, nextDirectionIndex) {
  const semicolon = text.indexOf(';', start);
  const paren = text.indexOf(')', start);
  return Math.min(
    nextDirectionIndex >= 0 ? nextDirectionIndex : Infinity,
    semicolon >= 0 ? semicolon : Infinity,
    paren >= 0 ? paren : Infinity,
  );
}

function namesFromPortTail(tail) {
  const withoutRanges = String(tail || '').replace(/\[[^\]]+\]/g, ' ');
  const names = [];
  for (const part of withoutRanges.split(',')) {
    const cleaned = part.replace(/=.*$/g, ' ').trim();
    const words = cleaned.match(/[A-Za-z_]\w*/g) || [];
    const candidates = words.filter(w => !PORT_DECL_KEYWORDS.has(w.toLowerCase()));
    if (candidates.length) names.push(candidates[candidates.length - 1]);
  }
  return names;
}

function extractDirectedPorts(content) {
  const text = stripFunctionTaskBodies(stripComments(content));
  const matches = [...text.matchAll(/\b(input|output)\b/g)];
  const ports = [];

  for (let i = 0; i < matches.length; i++) {
    const direction = matches[i][1].toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const nextDirectionIndex = i + 1 < matches.length ? matches[i + 1].index : -1;
    const end = nextBoundary(text, start, nextDirectionIndex);
    const tail = text.slice(start, Number.isFinite(end) ? end : text.length);
    const declaration = `${direction}${tail}`.replace(/\s+/g, ' ').trim().slice(0, 80);
    for (const name of namesFromPortTail(tail)) ports.push({ direction, name, declaration });
  }

  return ports;
}

/**
 * 自动修复 HDL 命名违规: 将 output signal → ro_signal, input signal → ri_signal
 * @param {string} fp 文件路径
 * @returns {number} 修复处数
 */
// [已移除] autoFixNaming —— 曾在 PostToolUse 静默改写用户源文件, 三重破坏:
//   1. 把合规端口 i_data / o_data 重命名为 ri_i_data / ro_o_data (判据本身就是错的);
//   2. 正则只保留匹配段, **丢弃行尾逗号**, 直接产生语法错误;
//   3. 只改端口声明行, 不更新模块内部对该信号的引用, 模块必然编译失败。
// Hook 不得在用户不知情的前提下改写源码。命名问题由 PreToolUse 的
// checkNamingViolations 提示, 交由人/模型显式修改。

function checkSynthesisViolations(content) {
  const violations = [];
  const scanContent = stripComments(content);
  for (const v of SYNTHESIS_VIOLATIONS) {
    if (v.pattern.test(scanContent)) {
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

// ── 写入类工具矩阵 ───────────────────────────────────────────────────────────
// settings.json 把本门禁注册在 Write 上, 但红线是对"文件最终内容"的约束, 与用
// 哪个工具写无关。只认 Write 等于给 Edit 开了后门。
const HDL_WRITE_TOOLS = new Set(['write', 'edit', 'multiedit']);

/** 还原「本次操作完成后」的文件全文。Write 直接给, Edit/MultiEdit 需叠加替换。 */
function postEditContent(payload, filePath) {
  const input = payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
  const direct = input.content || payload?.content || '';
  if (direct) return String(direct);

  const edits = Array.isArray(input.edits) ? input.edits
    : (input.old_string !== undefined
      ? [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }]
      : []);
  if (edits.length === 0) return '';

  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
  for (const e of edits) {
    const oldS = String(e?.old_string ?? '');
    if (!oldS) continue;
    const newS = String(e?.new_string ?? '');
    text = e?.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, newS);
  }
  return text;
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

async function main() {
  // 逃生开关: CLAUDE_GATES_DISABLED=true 跳过所有门禁
  if (process.env.CLAUDE_GATES_DISABLED === 'true') process.exit(0);

  const raw = await readStdin();
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
  // 综合/命名规则仅对 01_src/00_hdl/ 生效，VIP/TB 目录豁免
  if ((!eventName || eventName === 'PreToolUse') && HDL_WRITE_TOOLS.has(toolName) && filePath) {
    const isHdl = /\.(sv|v)$/i.test(filePath);
    if (!isHdl) process.exit(0);

    // 路径分类
    const isSrcPath = isSourcePath(filePath);

    // 取「这次操作之后文件将是什么内容」。
    // Write 给全文；Edit/MultiEdit 只给片段，需读磁盘再套用替换 —— 否则本门禁
    // 只能拦住新建文件，往已有 .sv 里插 latch / 组合直出反而畅通无阻。
    const content = postEditContent(payload, fp);
    if (!content) process.exit(0);

    const fileName = path.basename(fp);
    const violations = [];

    // 综合违规检查 — 仅 01_src/ 路径
    if (isSrcPath) {
      const synthVios = checkSynthesisViolations(content);
      violations.push(...synthVios.map(v => `[综合违规] ${v}`));
    }

    // 命名规范检查 — 仅 01_src/ 路径
    if (isSrcPath) {
      const namingVios = checkNamingViolations(content, fileName, filePath);
      violations.push(...namingVios.map(v => `[命名规范] ${v}`));
    }

    // Testbench-First 检查（仅限 01_src/ 下新模块）
    if (isSrcPath) {
      const isTb = !!(fileName.match(/tb_|_tb|testbench/i));
      if (!isTb) {
        const tbPath = findTbForModule(fp);
        if (!tbPath && isNewModuleFile(fp)) {
          const moduleName = fileName.replace(/\.(sv|v)$/i, '');
          violations.push(`[Testbench-First] 新建 RTL 模块需先编写 Testbench (tb_${moduleName}.sv 或 ${moduleName}_tb.sv)`);
        }
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

  // ── PostToolUse(Write): 自动修复 + 后检查（非阻断，仅警告）───────────────
  // PreToolUse 已做硬拦截，此处仅自动修复命名 + 输出分析报告
  if ((!eventName || eventName === 'PostToolUse') && HDL_WRITE_TOOLS.has(toolName) && filePath) {
    const isHdl = /\.(sv|v)$/i.test(filePath);
    if (!isHdl) process.exit(0);

    const isSrcPath = isSourcePath(filePath);

    // [已移除] 命名自动修复: Hook 不改写用户源码, 见 autoFixNaming 处的说明。

    // 逻辑分析报告 — 仅 01_src/ 路径，不阻断
    if (isSrcPath) {
      const r = logicAnalyzer.analyzeFile(fp);
      if (r && r.violations && r.violations.length > 0) {
        for (const v of r.violations) {
          console.error(`[HDL-Gate] 逻辑分析: ${v.type} — ${v.detail}`);
        }
      }
    }
  }

  process.exit(0);
}

main();
