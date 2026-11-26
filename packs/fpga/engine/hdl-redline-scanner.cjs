#!/usr/bin/env node
'use strict';

/**
 * packs/fpga/engine/hdl-redline-scanner.cjs — FPGA 专项实战红线毫秒级静态扫描器
 *
 * 将 packs/fpga/rules/01-hdl.md 中的硬核实战教训左移到毫秒级静态检查：
 *   1. nba-lhs-function-index (error):
 *      always_ff / 时序块内非阻塞赋值左值下标直接调用函数（如 r_mem[f_addr(r_cnt)] <= din），
 *      在 ModelSim 10.6c 下按 active 区自增后求值导致整表错位 1 拍，与 Vivado 综合静默不一致。
 *      （排除 $clog2 / $bits 等编译期常量系统函数）。
 *   2. gated-clock-expression (error):
 *      敏感列表边沿表达式含门控逻辑（如 posedge (clk & en)），必须改用 BUFGCE 或时钟使能。
 *   3. async-or-active-low-reset (error):
 *      非同步器模块在敏感列表中使用 negedge 异步低有效复位（红线 3 要求同步高有效 i_rst，
 *      除非模块名为 *rst_sync* / *reset_sync* 或显式标注 [CDC同步释放] / [复位同步释放]）。
 *   4. control-reg-missing-reset (warning):
 *      控制路径寄存器（*valid* / *state* / *fsm*）在时序块中赋值却无复位分支且无 [复位豁免] 注释。
 */

const fs = require('node:fs');
const path = require('node:path');

const ELAB_SYSTEM_FUNCS = new Set([
  '$clog2', '$bits', '$size', '$dimensions', '$unpacked_dimensions',
  '$left', '$right', '$low', '$high', '$increment',
]);

function maskCommentsAndStrings(src) {
  // 保持等长与换行符不变，确保行号和偏移量完全对齐原文件
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '))
    .replace(/\/\/[^\r\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\\r\n])*"/g, (m) => `"${' '.repeat(Math.max(0, m.length - 2))}"`);
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function extractClockedBlocks(masked) {
  const blocks = [];
  const headerRe = /\b(always_ff|always)\s*@\s*\(/g;
  let match;
  while ((match = headerRe.exec(masked)) !== null) {
    const kw = match[1];
    const headerStart = match.index;
    const sensStart = headerRe.lastIndex;
    let pDepth = 1;
    let cursor = sensStart;
    while (cursor < masked.length && pDepth > 0) {
      const ch = masked[cursor];
      if (ch === '(') pDepth += 1;
      else if (ch === ')') pDepth -= 1;
      cursor += 1;
    }
    if (pDepth !== 0) break;
    const sens = masked.slice(sensStart, cursor - 1);
    headerRe.lastIndex = cursor;
    if (kw !== 'always_ff' && !/\b(?:posedge|negedge)\b/.test(sens)) continue;
    const bodyStart = cursor;

    // 定位对应的语句或 begin...end 块
    const after = masked.slice(bodyStart);
    const beginMatch = /^\s*begin(?:\s*:\s*[A-Za-z_][A-Za-z0-9_$]*)?\b/.exec(after);
    if (!beginMatch) {
      const semi = masked.indexOf(';', bodyStart);
      const endIdx = semi >= 0 ? semi + 1 : masked.length;
      blocks.push({ headerStart, bodyStart, endIdx, sensitivity: sens, body: masked.slice(bodyStart, endIdx) });
      continue;
    }

    let depth = 0;
    const tokenRe = /\b(begin|end)\b/g;
    tokenRe.lastIndex = bodyStart;
    let tok;
    let endIdx = masked.length;
    while ((tok = tokenRe.exec(masked)) !== null) {
      if (tok[1] === 'begin') depth += 1;
      else {
        depth -= 1;
        if (depth === 0) {
          endIdx = tokenRe.lastIndex;
          break;
        }
      }
    }
    blocks.push({ headerStart, bodyStart, endIdx, sensitivity: sens, body: masked.slice(bodyStart, endIdx) });
  }
  return blocks;
}

function extractSubscripts(lhs) {
  const subs = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < lhs.length; i += 1) {
    const ch = lhs[i];
    if (ch === '[') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        subs.push(lhs.slice(start, i));
        start = -1;
      }
    }
  }
  return subs;
}

function scanContent(rawContent, filePath = '') {
  const raw = String(rawContent || '');
  const lines = raw.split(/\r?\n/);
  const masked = maskCommentsAndStrings(raw);
  const findings = [];
  const baseName = path.basename(filePath || '').toLowerCase();
  if (/(?:^tb_|_tb\.|testbench)/i.test(baseName)) {
    return { ok: true, filePath, findings: [] };
  }

  const isResetSyncModule = /(?:rst_sync|reset_sync)/i.test(baseName)
    || /\bmodule\s+[A-Za-z0-9_]*(?:rst_sync|reset_sync)[A-Za-z0-9_]*\b/i.test(masked)
    || /\[(?:CDC同步释放|复位同步释放)\]/.test(raw);

  const blocks = extractClockedBlocks(masked);
  for (const blk of blocks) {
    const headerLine = lineNumberAt(masked, blk.headerStart);
    const rawHeaderContext = lines.slice(Math.max(0, headerLine - 2), headerLine + 1).join('\n');

    // 1. 门控时钟检查: posedge/negedge 后跟括号复合位/逻辑运算
    if (/\b(?:posedge|negedge)\s*\([^)]*[&|^~?+-][^)]*\)/.test(blk.sensitivity)
        || /\b(?:posedge|negedge)\s+[A-Za-z_][A-Za-z0-9_$]*\s*[&|^]/.test(blk.sensitivity)) {
      findings.push({
        severity: 'error',
        rule: 'gated-clock-expression',
        line: headerLine,
        snippet: (lines[headerLine - 1] || '').trim().slice(0, 100),
        message: `Line ${headerLine}: Gated clock expression in sensitivity list (${blk.sensitivity.trim()}) — use BUFGCE or synchronous clock enable (01-hdl.md).`,
      });
    }

    // 2. 异步低有效复位检查 (红线 3)
    if (/\bnegedge\s+[A-Za-z_][A-Za-z0-9_$]*/.test(blk.sensitivity)
        && /\b(?:rst|reset)/i.test(blk.sensitivity)
        && !isResetSyncModule
        && !/\[(?:CDC同步释放|复位同步释放)\]/.test(rawHeaderContext)) {
      findings.push({
        severity: 'error',
        rule: 'async-or-active-low-reset',
        line: headerLine,
        snippet: (lines[headerLine - 1] || '').trim().slice(0, 100),
        message: `Line ${headerLine}: Asynchronous/negedge reset (${blk.sensitivity.trim()}) violates Redline 3 — use synchronous active-high i_rst (or annotate reset synchronizers with // [CDC同步释放]).`,
      });
    }

    // 3. NBA 左值数组下标直接函数调用检查 (01-hdl.md §8: ModelSim 10.6c 错位 1 拍)
    const stmtRe = /([^;{}]+?)<=/g;
    let sm;
    while ((sm = stmtRe.exec(blk.body)) !== null) {
      const rawPrefix = sm[1];
      // 剥离 if (...) / else / case 分支标签，只保留真正的左值目标表达式
      let lhs = rawPrefix;
      // 反复剥离前导 begin / else / if (...) / )
      let prev;
      do {
        prev = lhs;
        lhs = lhs
          .replace(/^\s*\b(?:begin|else)\b(?:\s*:\s*[A-Za-z_][A-Za-z0-9_$]*)?\s*/, '')
          .replace(/^\s*\bif\s*\([^()]*\)\s*/, '');
      } while (lhs !== prev);
      const lastCloser = Math.max(lhs.lastIndexOf(')'), lhs.lastIndexOf(':'));
      if (lastCloser >= 0 && !lhs.slice(0, lastCloser).includes('[')) {
        lhs = lhs.slice(lastCloser + 1);
      }
      lhs = lhs.trim();
      if (!lhs.includes('[')) continue;

      const absOffset = blk.bodyStart + sm.index + (rawPrefix.length - lhs.length);
      const lineNum = lineNumberAt(masked, absOffset);
      for (const sub of extractSubscripts(lhs)) {
        const fnRe = /(\$?[A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
        let fm;
        while ((fm = fnRe.exec(sub)) !== null) {
          const fnName = fm[1];
          if (ELAB_SYSTEM_FUNCS.has(fnName.toLowerCase())) continue;
          findings.push({
            severity: 'error',
            rule: 'nba-lhs-function-index',
            line: lineNum,
            snippet: (lines[lineNum - 1] || '').trim().slice(0, 100),
            message: `Line ${lineNum}: Non-blocking assignment LHS subscript calls function "${fnName}(...)" — causes 1-cycle shift mismatch between ModelSim 10.6c and Vivado synthesis (01-hdl.md §8). Assign index to an intermediate wire first.`,
          });
        }
      }
    }

    // 4. 控制寄存器无复位且无 [复位豁免] 提示 (warning)
    const hasResetBranch = /\bif\s*\(\s*[!~]?\s*[A-Za-z_0-9$]*(?:rst|reset)[A-Za-z_0-9$]*\b/i.test(blk.body);
    const rawBlockText = raw.slice(blk.headerStart, blk.endIdx);
    if (!hasResetBranch && !/\[复位豁免\]/.test(rawBlockText)) {
      const ctrlMatch = /\b([A-Za-z_0-9$]*(?:valid|state|fsm)[A-Za-z_0-9$]*)\s*(?:\[[^\]]*\])?\s*<=/i.exec(blk.body);
      if (ctrlMatch) {
        const lineNum = lineNumberAt(masked, blk.bodyStart + ctrlMatch.index);
        findings.push({
          severity: 'warning',
          rule: 'control-reg-missing-reset',
          line: lineNum,
          snippet: (lines[lineNum - 1] || '').trim().slice(0, 100),
          message: `Line ${lineNum}: Control/state register "${ctrlMatch[1]}" has no reset branch in clocked block and no "// [复位豁免]" annotation (01-hdl.md §7).`,
        });
      }
    }
  }

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    filePath,
    findings,
  };
}

function scanTarget(targetPath) {
  const abs = path.resolve(targetPath);
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    return [scanContent(fs.readFileSync(abs, 'utf8'), abs)];
  }
  const reports = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['work', '02_sim', 'sim', 'node_modules'].includes(entry.name)) continue;
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) reports.push(...scanTarget(child));
    else if (/\.(?:sv|v)$/i.test(entry.name) && !/(?:^tb_|_tb\.)/i.test(entry.name)) {
      reports.push(scanContent(fs.readFileSync(child, 'utf8'), child));
    }
  }
  return reports;
}

function main(argv = process.argv.slice(2)) {
  const isJson = argv.includes('--json');
  const targets = argv.filter((a) => !a.startsWith('--'));
  if (targets.length === 0) {
    console.error('Usage: node packs/fpga/engine/hdl-redline-scanner.cjs [--json] <file_or_dir...>');
    return 2;
  }
  const reports = targets.flatMap(scanTarget);
  const errors = reports.flatMap((r) => r.findings.filter((f) => f.severity === 'error'));
  const warnings = reports.flatMap((r) => r.findings.filter((f) => f.severity === 'warning'));
  const out = { ok: errors.length === 0, filesScanned: reports.length, errorCount: errors.length, warningCount: warnings.length, reports: reports.filter((r) => r.findings.length > 0) };
  if (isJson) console.log(JSON.stringify(out, null, 2));
  else {
    for (const r of out.reports) {
      for (const f of r.findings) console.log(`[${f.severity.toUpperCase()}] ${r.filePath}:${f.line} (${f.rule}) ${f.message}`);
    }
    console.log(out.ok ? `RESULT: PASS (${out.filesScanned} file(s), ${warnings.length} warning(s))` : `RESULT: FAIL (${errors.length} error(s))`);
  }
  return out.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (err) {
    console.error(`[hdl-redline-scanner] ${err.message}`);
    process.exitCode = 2;
  }
}

module.exports = { scanContent, scanTarget, maskCommentsAndStrings, extractClockedBlocks };
