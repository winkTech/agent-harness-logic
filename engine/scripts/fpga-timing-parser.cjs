#!/usr/bin/env node
/**
 * engine/scripts/fpga-timing-parser.cjs — Vivado Timing Report 解析器。
 *
 * 解析 Vivado 时序报告（.rpt），提取：
 *   - WNS（Worst Negative Slack）
 *   - TNS（Total Negative Slack）
 *   - Fmax 报告
 *   - 关键路径摘要
 *
 * 用法:
 *   node fpga-timing-parser.cjs <timing.rpt>          # 人类可读
 *   node fpga-timing-parser.cjs <timing.rpt> --json   # JSON 输出
 *   node fpga-timing-parser.cjs <dir> --scan          # 扫描目录
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 解析 Vivado timing report。
 */
function parseTimingReport(content, filePath) {
  const result = {
    file: filePath || '(stdin)',
    setup: null,
    hold: null,
    pulseWidth: null,
    clockSummary: [],
  };

  // ── Setup ──────────────────────────────────────────────────────────────
  // 格式: | WNS(ns) | TNS(ns) | ... | Fmax(MHz) |
  const setupHeader = content.match(/\|.*WNS.*TNS.*Fmax/i);
  if (setupHeader) {
    // 找到表头后的第一行数据
    const tableStart = content.indexOf(setupHeader[0]);
    if (tableStart >= 0) {
      const afterHeader = content.slice(tableStart + setupHeader[0].length);
      const dataLine = afterHeader.match(/\|?\s*([\d.-]+)\s*\|\s*([\d.-]+)\s*\|/);
      if (dataLine) {
        result.setup = {
          wns: parseFloat(dataLine[1]),
          tns: parseFloat(dataLine[2]),
        };
      }
    }
  }
  // 备选: "WNS(ns)= -0.123"
  if (!result.setup) {
    const wnsMatch = content.match(/WNS\(?ns\)?\s*[=:]\s*(-?[\d.]+)/i);
    const tnsMatch = content.match(/TNS\(?ns\)?\s*[=:]\s*(-?[\d.]+)/i);
    if (wnsMatch) {
      result.setup = { wns: parseFloat(wnsMatch[1]), tns: tnsMatch ? parseFloat(tnsMatch[1]) : null };
    }
  }

  // ── Fmax ───────────────────────────────────────────────────────────────
  // "Fmax = 200.0 MHz" or "Maximum Frequency: 180.5 MHz"
  const fmaxMatch = content.match(/(?:Fmax|Maximum\s+Frequency)[=:]\s*([\d.]+)\s*MHz/i);
  if (fmaxMatch) {
    if (!result.setup) result.setup = {};
    result.setup.fmax = parseFloat(fmaxMatch[1]);
  }

  // ── Hold ───────────────────────────────────────────────────────────────
  const holdHeader = content.match(/\|.*WHS.*THS/i);
  if (holdHeader) {
    const idx = content.indexOf(holdHeader[0]);
    if (idx >= 0) {
      const after = content.slice(idx + holdHeader[0].length);
      const d = after.match(/\|?\s*([\d.-]+)\s*\|\s*([\d.-]+)\s*\|/);
      if (d) { result.hold = { whs: parseFloat(d[1]), ths: parseFloat(d[2]) }; }
    }
  }
  if (!result.hold) {
    const whs = content.match(/WHS\(?ns\)?\s*[=:]\s*(-?[\d.]+)/i);
    if (whs) result.hold = { whs: parseFloat(whs[1]), ths: null };
  }

  // ── 时钟摘要 ──────────────────────────────────────────────────────────
  const clkLines = content.match(/\|?\s*clk_\w+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|/gi);
  if (clkLines) {
    for (const line of clkLines) {
      const parts = line.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 3) {
        result.clockSummary.push({ clock: parts[0], wns: parseFloat(parts[1]), level: parts.slice(-1)[0] });
      }
    }
  }

  // ── 定时路径摘要 ──────────────────────────────────────────────────────
  const topPaths = [];
  const pathLines = content.match(/(?:Slack|slack)\s*[:=]\s*(-?[\d.]+)/g);
  if (pathLines && pathLines.length > 0) {
    result.worstPaths = pathLines.slice(0, 3).map(p => {
      const v = p.match(/-?[\d.]+/);
      return v ? parseFloat(v[0]) : null;
    }).filter(v => v !== null);
  }

  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) { console.log('用法: node fpga-timing-parser.cjs <timing.rpt> [--json]'); process.exit(1); }

  const target = args[0];
  const isJson = args.includes('--json');
  const isScan = args.includes('--scan');

  if (isScan) {
    const dir = target;
    if (!fs.existsSync(dir)) { console.error(`目录不存在: ${dir}`); process.exit(1); }
    const rptFiles = fs.readdirSync(dir).filter(f => f.endsWith('.rpt') && f.includes('timing'));
    if (rptFiles.length === 0) { console.log('未找到 timing .rpt 文件'); return; }
    for (const f of rptFiles) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const parsed = parseTimingReport(content, f);
      if (isJson) console.log(JSON.stringify(parsed, null, 2));
      else console.log(`[${f}] WNS=${parsed.setup?.wns ?? 'N/A'} Fmax=${parsed.setup?.fmax ?? 'N/A'}`);
    }
    return;
  }

  if (!fs.existsSync(target)) { console.error(`文件不存在: ${target}`); process.exit(1); }
  const content = fs.readFileSync(target, 'utf8');
  const parsed = parseTimingReport(content, target);

  if (isJson) { console.log(JSON.stringify(parsed, null, 2)); return; }

  console.log(`\nTiming Report: ${target}`);
  console.log(`  Setup:  WNS=${parsed.setup?.wns ?? 'N/A'}  TNS=${parsed.setup?.tns ?? 'N/A'}  Fmax=${parsed.setup?.fmax ?? 'N/A'}MHz`);
  console.log(`  Hold:   WHS=${parsed.hold?.whs ?? 'N/A'}  THS=${parsed.hold?.ths ?? 'N/A'}`);
  if (parsed.worstPaths) console.log(`  Worst paths: ${parsed.worstPaths.slice(0, 3).join(', ')}`);
  console.log(`  Signed-off: ${parsed.setup && parsed.setup.wns >= 0 ? '✅ PASS' : parsed.setup ? '❌ FAIL' : 'N/A'}`);
}

if (require.main === module) { main(); }

module.exports = { parseTimingReport };
