#!/usr/bin/env node
/**
 * engine/scripts/fpga-xdc-parser.cjs — XDC 约束文件解析器。
 *
 * 解析 Vivado .xdc 文件，提取：
 *   - create_clock（时钟名 / 周期 / 端口）
 *   - set_input_delay / set_output_delay
 *   - set_false_path / set_clock_groups
 *
 * 用法:
 *   node fpga-xdc-parser.cjs <path/to/constraints.xdc>
 *   node fpga-xdc-parser.cjs <path/to/project/> --scan   # 扫描目录
 *   node fpga-xdc-parser.cjs <path/to/file.xdc> --json   # JSON 输出
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── 正则模式 ────────────────────────────────────────────────────────────────

const PATTERNS = {
  // create_clock -name <name> -period <period> [get_ports <port>]
  createClock: /create_clock\s+(?:-name\s+(\S+))?\s+-period\s+([\d.]+)(?:\s+-waveform\s+\{[\d.\s]+\})?(?:\s*\[get_ports\s+(\S+)\])?/gi,

  // create_generated_clock
  createGeneratedClock: /create_generated_clock\s+(?:-name\s+(\S+))?\s+(?:-source\s+\S+)?\s+(?:-divide_by\s+(\d+)|-multiply_by\s+(\d+))/gi,

  // set_input_delay -clock <clk> -max <val> [get_ports <port>]
  setInputDelay: /set_input_delay\s+(?:-clock\s+(\S+))?\s+(?:-max\s+([\d.]+)|-min\s+([\d.]+))\s*\[get_ports\s+(\S+)\]/gi,

  // set_output_delay
  setOutputDelay: /set_output_delay\s+(?:-clock\s+(\S+))?\s+(?:-max\s+([\d.]+)|-min\s+([\d.]+))\s*\[get_ports\s+(\S+)\]/gi,

  // set_false_path
  setFalsePath: /set_false_path\s+(?:-from\s+\[\S+\s+(\S+)\])?\s*(?:-to\s+\[\S+\s+(\S+)\])?/gi,

  // set_clock_groups
  setClockGroups: /set_clock_groups\s+(?:-asynchronous|-physically_exclusive|-logically_exclusive)\s+(?:-group\s+\[get_clocks\s+(\S+)\]\s*)+/gi,

  // set_multicycle_path
  setMulticyclePath: /set_multicycle_path\s+(\d+)\s+(?:-setup|-hold)/gi,
};

// ── 解析 ────────────────────────────────────────────────────────────────────

function parseXdc(content, filePath) {
  const result = {
    file: filePath || '(stdin)',
    clocks: [],
    generatedClocks: [],
    inputDelays: [],
    outputDelays: [],
    falsePaths: [],
    clockGroups: [],
    multicyclePaths: [],
  };

  // create_clock
  let m;
  while ((m = PATTERNS.createClock.exec(content)) !== null) {
    result.clocks.push({ name: m[1] || `clk_${result.clocks.length}`, period: parseFloat(m[2]), port: m[3] || null });
  }

  // create_generated_clock
  PATTERNS.createGeneratedClock.lastIndex = 0;
  while ((m = PATTERNS.createGeneratedClock.exec(content)) !== null) {
    result.generatedClocks.push({ name: m[1] || null, divideBy: m[2] ? parseInt(m[2]) : null, multiplyBy: m[3] ? parseInt(m[3]) : null });
  }

  // set_input_delay
  PATTERNS.setInputDelay.lastIndex = 0;
  while ((m = PATTERNS.setInputDelay.exec(content)) !== null) {
    result.inputDelays.push({ clock: m[1], max: m[2] ? parseFloat(m[2]) : null, min: m[3] ? parseFloat(m[3]) : null, port: m[4] });
  }

  // set_output_delay
  PATTERNS.setOutputDelay.lastIndex = 0;
  while ((m = PATTERNS.setOutputDelay.exec(content)) !== null) {
    result.outputDelays.push({ clock: m[1], max: m[2] ? parseFloat(m[2]) : null, min: m[3] ? parseFloat(m[3]) : null, port: m[4] });
  }

  // set_false_path
  PATTERNS.setFalsePath.lastIndex = 0;
  while ((m = PATTERNS.setFalsePath.exec(content)) !== null) {
    result.falsePaths.push({ from: m[1] || null, to: m[2] || null });
  }

  // set_clock_groups
  PATTERNS.setClockGroups.lastIndex = 0;
  while ((m = PATTERNS.setClockGroups.exec(content)) !== null) {
    result.clockGroups.push({ type: 'asynchronous', clocks: m.slice(1).filter(Boolean) });
  }

  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('用法: node fpga-xdc-parser.cjs <file.xdc> [--json]');
    console.log('       node fpga-xdc-parser.cjs <dir> --scan');
    process.exit(1);
  }

  const target = args[0];
  const isJson = args.includes('--json');
  const isScan = args.includes('--scan');

  if (isScan) {
    const dir = target;
    if (!fs.existsSync(dir)) { console.error(`目录不存在: ${dir}`); process.exit(1); }
    const xdcFiles = fs.readdirSync(dir).filter(f => f.endsWith('.xdc'));
    if (xdcFiles.length === 0) { console.log(`未找到 .xdc 文件`); return; }
    for (const f of xdcFiles) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const parsed = parseXdc(content, f);
      if (isJson) {
        console.log(JSON.stringify(parsed, null, 2));
      } else {
        console.log(`\n[${f}]`);
        console.log(`  时钟: ${parsed.clocks.length} | 衍生时钟: ${parsed.generatedClocks.length}`);
        console.log(`  IO延迟: ${parsed.inputDelays.length + parsed.outputDelays.length} 条`);
        console.log(`  例外: ${parsed.falsePaths.length} false_path + ${parsed.clockGroups.length} clock_groups`);
        for (const clk of parsed.clocks) {
          console.log(`    📐 ${clk.name}: ${clk.period}ns${clk.port ? ` → ${clk.port}` : ''}`);
        }
      }
    }
    return;
  }

  // 单文件
  const filePath = target;
  if (!fs.existsSync(filePath)) { console.error(`文件不存在: ${filePath}`); process.exit(1); }
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseXdc(content, filePath);

  if (isJson) {
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.log(`\nXDC 解析: ${filePath}`);
    console.log(`  主时钟: ${parsed.clocks.length}`);
    for (const c of parsed.clocks) {
      const freq = (1000 / c.period).toFixed(1);
      console.log(`    📐 ${c.name}: ${c.period}ns (${freq}MHz)${c.port ? ` port=${c.port}` : ''}`);
    }
    if (parsed.generatedClocks.length) console.log(`  衍生时钟: ${parsed.generatedClocks.length}`);
    if (parsed.inputDelays.length) console.log(`  输入延迟: ${parsed.inputDelays.length} 条`);
    if (parsed.outputDelays.length) console.log(`  输出延迟: ${parsed.outputDelays.length} 条`);
    if (parsed.falsePaths.length) console.log(`  虚假路径: ${parsed.falsePaths.length} 条`);
    if (parsed.clockGroups.length) console.log(`  时钟组: ${parsed.clockGroups.length} 组`);
  }
}

if (require.main === module) { main(); }

module.exports = { parseXdc, PATTERNS };
