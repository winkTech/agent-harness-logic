#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const {
  payloadCwd,
  payloadFilePath,
} = require('../lib/project-scope.cjs');

function toolNameFrom(payload) {
  if (typeof payload?.tool === 'string') return payload.tool;
  return payload?.tool?.name || payload?.tool_name || payload?.name || '';
}

function eventNameFrom(payload) {
  return payload?.hook_event_name || payload?.event || '';
}

function toolInputFrom(payload) {
  return payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
}

/**
 * 取"这次操作之后文件将是什么内容"。
 *
 * Write 直接给全文；Edit/MultiEdit 只给片段，必须先读磁盘再把替换应用上去，
 * 否则本 oracle 对 Edit 一律拿到空串而 skip —— 那意味着**新建 RTL 过不了红线，
 * 但往已有 RTL 里插一个 latch 或组合直出却畅通无阻**，与"违反红线的代码过不了
 * 审查门禁"的承诺直接冲突。红线检查是全文语义分析（要看 always 块结构、端口
 * 驱动关系），只拿片段判不了，所以必须重建全文。
 */
function contentFrom(payload, runtime = {}) {
  const input = toolInputFrom(payload);
  const direct = String(input.content || payload?.content || '');
  if (direct) return direct;

  const edits = Array.isArray(input.edits) ? input.edits
    : (input.old_string !== undefined ? [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }] : []);
  if (edits.length === 0) return '';

  const fp = payloadFilePath(payload, payloadCwd(payload));
  let text;
  try {
    const readFileSync = runtime.readFileSync || fs.readFileSync.bind(fs);
    text = readFileSync(fp, 'utf8');
  } catch {
    return ''; // 读不到磁盘就没法重建, 保持 skip 而不是误判
  }
  for (const e of edits) {
    const oldS = String(e?.old_string ?? '');
    const newS = String(e?.new_string ?? '');
    if (!oldS) continue;
    text = e?.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, newS);
  }
  return text;
}

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function isRtlSource(filePath) {
  return /\.(sv|v)$/i.test(filePath || '');
}

function isTestbenchOrSimulation(filePath) {
  const rel = String(filePath || '').replace(/\\/g, '/').toLowerCase();
  return /(?:^|\/)02_sim(?:\/|$)/.test(rel) || /(?:^|\/)(tb_|test_)[^/]*\.(sv|v)$/.test(rel);
}

function collectRoOutputs(code) {
  const outputs = new Set();
  const outputDecl = /\boutput\b([^;,\)]*)(ro_[A-Za-z_][A-Za-z0-9_$]*)/gi;
  let match;
  while ((match = outputDecl.exec(code))) outputs.add(match[2]);
  return [...outputs];
}

// 时序块 = always_ff 或 Verilog-2001 的 always @(posedge/negedge ...)。
// 早期版本只认 always_ff, 导致所有 Verilog-2001 风格 RTL 被判为"没有时序块"。
const CLOCKED_BLOCK_RE =
  /\b(?:always_ff\b|always\s*@\s*\([^)]*\b(?:posedge|negedge)\b[^)]*\))[\s\S]*?\bend\b/g;

function hasClockedBlock(code) {
  return /\balways_ff\b|\bposedge\b|\bnegedge\b/.test(code);
}

function collectAlwaysFfRoAssignments(code) {
  const assigned = new Set();
  const blocks = code.match(CLOCKED_BLOCK_RE) || [];
  for (const block of blocks) {
    const lhs = /\b(ro_[A-Za-z_][A-Za-z0-9_$]*)\b\s*(?:<=|=)/g;
    let match;
    while ((match = lhs.exec(block))) assigned.add(match[1]);
  }
  return [...assigned];
}

/**
 * Testbench 分析 —— 只查"这个 TB 能不能如实报告失败", 不查 RTL 编码规范。
 *
 * 动机: `$finish` 的参数在 IEEE 1364/1800 里是**诊断信息详细程度** (0/1/2),
 * 不是退出码, 且缺省就是 1。所以用 `$finish(1)` 表示失败的 TB 依然 exit 0,
 * 上游只要按退出码判读就是假绿。只有 `$fatal` 才会返回非零退出码。
 * 与 verification-gate 的"必须有正面通过证据"判据配套: 一个管进程退出码,
 * 一个管日志结论, 两侧都堵上, 静默失败才无处可逃。
 */
function analyzeTestbench(content, filePath = '') {
  const code = stripComments(content);
  const findings = [];
  const add = (severity, rule, message) => findings.push({ severity, rule, message });

  if (!/\bmodule\b/.test(code)) return { ok: true, filePath, findings: [] };

  const hasFatal = /\$fatal\b/.test(code);
  // 自检 TB 的判据: 存在失败判定 (比较不一致 / 错误计数 / $error / 打印 FAIL)。
  const selfChecking =
    /\$error\b/.test(code) ||
    /\b(?:errors?|mismatch(?:es)?|fail(?:ures?)?)\b\s*(?:=|\+\+|<=)/i.test(code) ||
    /\$display\s*\(\s*"[^"]*\b(?:FAIL|ERROR|MISMATCH)\b/i.test(code);

  if (selfChecking && !hasFatal) {
    add('error', 'tb-no-failure-exit',
      'Self-checking testbench has failure detection but never calls $fatal, so a failing run still exits 0 '
      + 'and reads as a pass upstream. Use $fatal(1, "...") on the failure path.');
  }

  const finishArg = /\$finish\s*\(\s*([1-9]\d*)\s*\)/.exec(code);
  if (finishArg) {
    add(selfChecking ? 'warning' : 'warning', 'tb-finish-arg-not-exit-code',
      `$finish(${finishArg[1]}) does not set the process exit code — the argument is a diagnostic verbosity `
      + 'level (0/1/2, default 1) per IEEE 1364/1800, and the process still exits 0. '
      + 'Use $fatal(1, "...") to signal failure.');
  }

  const hasPassMarker =
    /\bRESULT:\s*PASS\b/i.test(code) ||
    /\b(?:ALL\s+)?(?:TESTS?|CHECKS?)\s+PASSED\b/i.test(code) ||
    /\bPASS(?:ED)?\b/.test(code) ||
    /\b0\s+(?:errors|failures|mismatches)\b/i.test(code);
  if (!hasPassMarker) {
    add('warning', 'tb-no-pass-marker',
      'Testbench never prints an explicit pass conclusion. verification-gate requires positive PASS evidence '
      + 'in the log, so a silent success will not clear the verification state. '
      + 'Print something like "RESULT: PASS" (or "0 errors") on the success path.');
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    filePath,
    findings,
  };
}

function analyzeRtl(content, filePath = '') {
  const code = stripComments(content);
  const findings = [];
  const add = (severity, rule, message) => findings.push({ severity, rule, message });

  // SystemVerilog package / interface 文件不是 RTL 模块, 模块级判据
  // (输出寄存 / 复位 / 时序块) 对它们没有意义 —— 直接放行。
  const hasModule = /\bmodule\s+[A-Za-z_][A-Za-z0-9_$]*\b/.test(code);
  const hasPackage = /\bpackage\s+[A-Za-z_][A-Za-z0-9_$]*[\s\S]*\bendpackage\b/.test(code);
  const hasInterface = /\binterface\s+[A-Za-z_][A-Za-z0-9_$]*[\s\S]*\bendinterface\b/.test(code);
  if (!hasModule && (hasPackage || hasInterface)) {
    return { ok: true, filePath, findings: [] };
  }

  if (!hasModule) {
    add('error', 'module-required', 'RTL source must contain a module declaration.');
  }

  if (/\binitial\b/.test(code)) {
    // 存储器初始化 ($readmemh/$readmemb) 是 Xilinx/Altera 流程里可综合的
    // 标准 ROM/BRAM 写法, 不应与仿真专用的 initial 激励一概而论。
    // 仿真专用写法 (#延时 / force) 由 no-delay-in-rtl / no-force-release 单独拦截。
    const isMemoryInit = /\$readmem[bh]\b/.test(code);
    add(
      isMemoryInit ? 'warning' : 'error',
      'no-initial-in-rtl',
      isMemoryInit
        ? 'initial block used for memory initialization ($readmemh/$readmemb); confirm your synthesis target supports it.'
        : 'Production RTL source must not contain initial blocks.',
    );
  }
  if (/(^|[^A-Za-z0-9_$])#\s*\d/.test(code)) {
    add('error', 'no-delay-in-rtl', 'Production RTL source must not contain delay controls.');
  }
  if (/\b(force|release)\b/.test(code)) {
    add('error', 'no-force-release', 'Production RTL source must not use force/release.');
  }

  const roOutputs = collectRoOutputs(code);
  const roAssignedInAlwaysFf = collectAlwaysFfRoAssignments(code);
  const roAssignedSet = new Set(roAssignedInAlwaysFf);
  const directAssign = /\bassign\s+(ro_[A-Za-z_][A-Za-z0-9_$]*)(?:\s|\[|=)/gi;
  let directMatch;
  while ((directMatch = directAssign.exec(code))) {
    add('error', 'ro-output-register', `Output ${directMatch[1]} is driven by continuous assign; ro_ outputs must be registered.`);
  }
  // docs/rules/01-hdl.md 红线 2 在正确命名下的等价检查:
  // 端口叫 o_, 内部寄存叫 ro_, 所以"输出由寄存器驱动"表现为
  //   assign o_x = ro_x;   或   o_x 直接在时序块里赋值。
  // 早期版本只匹配 `output ... ro_`, 那是建立在"端口须叫 ro_"这个**错误
  // 约定**之上的; 端口名改正后该检查对合规代码永不触发, 这里补回来。
  // 用 warning 而非 error: 组合直出在某些场合是有意为之(如低延迟旁路),
  // 硬拦会重蹈误报覆辙。
  if (hasClockedBlock(code)) {
    const oPorts = [];
    const oDecl = /\boutput\b([^;,)]*?)\b(o_[A-Za-z_][A-Za-z0-9_$]*)/gi;
    let m;
    while ((m = oDecl.exec(code))) oPorts.push(m[2]);

    const clockedBlocks = (code.match(CLOCKED_BLOCK_RE) || []).join('\n');
    for (const port of [...new Set(oPorts)]) {
      const assignedInClocked = new RegExp(`\\b${port}\\b\\s*<=`).test(clockedBlocks);
      const fromRegistered = new RegExp(`\\bassign\\s+${port}\\b[^;]*=\\s*[^;]*\\bro_`).test(code);
      if (!assignedInClocked && !fromRegistered) {
        add('warning', 'o-output-register',
          `Output ${port} is not driven by a register (expected assignment inside a clocked block, or "assign ${port} = ro_...").`);
      }
    }
  }

  // 纯组合模块 (无任何时序块) 不可能把输出在时序块里赋值 —— 那是合法设计,
  // 不是缺陷。只有当模块确实含时序逻辑时, "ro_ 输出未被寄存" 才是真问题。
  if (roOutputs.length > 0 && roAssignedInAlwaysFf.length === 0) {
    add(
      hasClockedBlock(code) ? 'error' : 'warning',
      'ro-output-register',
      hasClockedBlock(code)
        ? 'No ro_ output assignment was found inside a clocked block.'
        : 'Module has ro_ outputs but no clocked logic; treated as purely combinational.',
    );
  }
  for (const signal of roOutputs) {
    if (!roAssignedSet.has(signal)) {
      add('warning', 'ro-output-coverage', `Could not prove ${signal} is assigned inside always_ff.`);
    }
  }

  const hasClockedLogic = /\balways_ff\b|\bposedge\b|\bnegedge\b/.test(code);
  if (hasClockedLogic && !/\b(rst|reset|ri_rst|ri_reset|ri_rst_n|ri_reset_n)\b/i.test(code)) {
    add('warning', 'reset-audit', 'Clocked RTL did not expose an obvious reset signal.');
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    filePath,
    findings,
  };
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function block(report) {
  console.error('[rtl-semantic-oracle] BLOCKED');
  console.error(`file: ${report.filePath}`);
  for (const finding of report.findings) {
    if (finding.severity === 'error') {
      console.error(`- ${finding.rule}: ${finding.message}`);
    }
  }
  process.exit(2);
}

function hookSuccessOutput(advisory, eventName = 'PreToolUse') {
  return {
    hookSpecificOutput: {
      hookEventName: eventName || 'PreToolUse',
      additionalContext: JSON.stringify(advisory),
    },
  };
}

const RTL_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function evaluate(payload, runtime = {}) {
  const source = 'rtl-semantic-oracle';
  if (process.env.CLAUDE_RTL_SEMANTIC_ORACLE_DISABLED === '1') {
    return { source, decision: 'allow', diagnostics: [], skipped: true };
  }
  if (!RTL_WRITE_TOOLS.has(toolNameFrom(payload))) {
    return { source, decision: 'allow', diagnostics: [] };
  }
  if ((eventNameFrom(payload) || '') && eventNameFrom(payload) !== 'PreToolUse') {
    return { source, decision: 'allow', diagnostics: [] };
  }
  const cwd = runtime.cwd || payloadCwd(payload);
  const filePath = runtime.filePath || payloadFilePath(payload, cwd);
  if (!isRtlSource(filePath)) return { source, decision: 'allow', diagnostics: [] };
  const content = runtime.content !== undefined ? runtime.content : contentFrom(payload, runtime);
  if (!content) return { source, decision: 'allow', diagnostics: [] };
  const report = isTestbenchOrSimulation(filePath)
    ? analyzeTestbench(content, filePath)
    : analyzeRtl(content, filePath);
  const errors = report.findings.filter((finding) => finding.severity === 'error');
  const warnings = report.findings.filter((finding) => finding.severity === 'warning');
  if (errors.length > 0) {
    return { source, decision: 'block', diagnostics: errors, advisories: warnings, report };
  }
  if (warnings.length > 0) {
    const advisory = {
      schemaVersion: 1,
      kind: 'harness-advisory',
      source,
      status: 'warning',
      blocking: false,
      target: filePath,
      summary: `${path.basename(filePath)} has ${warnings.length} non-blocking RTL semantic warning(s).`,
      findings: warnings,
    };
    return { source, decision: 'warn', diagnostics: warnings, advisories: [advisory], report };
  }
  return { source, decision: 'allow', diagnostics: [], report };
}

function run(payload) {
  if (!RTL_WRITE_TOOLS.has(toolNameFrom(payload))) return { ok: true, skipped: true };
  if ((eventNameFrom(payload) || '') && eventNameFrom(payload) !== 'PreToolUse') return { ok: true, skipped: true };
  const cwd = payloadCwd(payload);
  const filePath = payloadFilePath(payload, cwd);
  if (!isRtlSource(filePath)) return { ok: true, skipped: true };
  const content = contentFrom(payload);
  if (!content) return { ok: true, skipped: true };
  // TB 不适用 RTL 编码规范 (initial/延时/ro_ 寄存都是合法的), 但仍须能如实
  // 报告失败 —— 走独立的 TB 判据, 而不是像早期版本那样整体跳过不查。
  const report = isTestbenchOrSimulation(filePath)
    ? analyzeTestbench(content, filePath)
    : analyzeRtl(content, filePath);
  if (!report.ok) block(report);
  // warning 此前只在 block() 内部打印, 而 block() 只在有 error 时才调用 ——
  // 于是所有 warning 从来不可见。放行时也要把它们说出来, 否则等于没写。
  const warnings = report.findings.filter((finding) => finding.severity === 'warning');
  if (warnings.length > 0) {
    const advisory = {
      schemaVersion: 1,
      kind: 'harness-advisory',
      source: 'rtl-semantic-oracle',
      status: 'warning',
      blocking: false,
      target: filePath,
      summary: `${path.basename(filePath)} has ${warnings.length} non-blocking RTL semantic warning(s).`,
      findings: warnings,
    };
    process.stdout.write(JSON.stringify(hookSuccessOutput(advisory, payload?.hook_event_name)));
    return { ok: true, skipped: false, report, advisory };
  }
  return { ok: true, skipped: false, report };
}

function main() {
  if (process.env.CLAUDE_RTL_SEMANTIC_ORACLE_DISABLED === '1') process.exit(0);
  try {
    run(parsePayload(readStdin()));
    process.exit(0);
  } catch (error) {
    console.error(`[rtl-semantic-oracle] internal error: ${error.stack || error.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  analyzeRtl,
  analyzeTestbench,
  contentFrom,
  evaluate,
  run,
};
