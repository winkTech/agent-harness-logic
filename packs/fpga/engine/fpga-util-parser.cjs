#!/usr/bin/env node
/**
 * engine/scripts/fpga-util-parser.cjs — Vivado Utilization Report 解析器。
 *
 * 解析 Vivado 资源利用报告（utilization.rpt），提取：
 *   - LUT / FF / BRAM / DSP / IO 使用量
 *   - 可用量 vs 使用量 vs 百分比
 *   - 输出结构化 JSON（用于资源预算对比）
 *
 * 用法:
 *   node fpga-util-parser.cjs <util.rpt>              # 人类可读
 *   node fpga-util-parser.cjs <util.rpt> --json       # JSON 输出
 *   node fpga-util-parser.cjs <dir> --scan            # 扫描目录
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 关注的资源类型
const WATCHED_RESOURCES = [
  'Slice LUTs', 'Slice Registers', 'LUT as Logic', 'LUT as Memory',
  'Block RAM Tile', 'DSPs', 'IO', 'BUFG', 'MMCM', 'PLL',
];

/**
 * 解析 Vivado utilization report。
 */
function parseUtilReport(content, filePath) {
  const result = {
    file: filePath || '(stdin)',
    resources: {},
    total: null,
  };

  // 格式 1（Vivado 表格）: | Resource | Used | Available | Utilization %
  const tableRegex = /\|\s*([\w\s/]+)\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|\s*([\d.]+)%\s*\|/g;
  let m;
  while ((m = tableRegex.exec(content)) !== null) {
    const name = m[1].trim();
    const used = parseInt(m[2].replace(/,/g, ''), 10);
    const available = parseInt(m[3].replace(/,/g, ''), 10);
    result.resources[name] = { used, available, percent: parseFloat(m[4]) };
  }

  // 格式 2（简化版）: Slice LUTs: 1234 out of 5000 (24.68%)
  const simpleRegex = /([\w\s/]+):\s*([\d,]+)\s*out\s*of\s*([\d,]+)\s*\(([\d.]+)%\)/gi;
  let m2;
  while ((m2 = simpleRegex.exec(content)) !== null) {
    const name = m2[1].trim();
    const used = parseInt(m2[2].replace(/,/g, ''), 10);
    const available = parseInt(m2[3].replace(/,/g, ''), 10);
    result.resources[name] = { used, available, percent: parseFloat(m2[4]) };
  }

  // 汇总
  result.summary = {};
  for (const name of WATCHED_RESOURCES) {
    if (result.resources[name]) {
      result.summary[name] = result.resources[name];
    }
  }

  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) { console.log('用法: node fpga-util-parser.cjs <util.rpt> [--json]'); process.exit(1); }

  const target = args[0];
  const isJson = args.includes('--json');
  const isScan = args.includes('--scan');

  if (isScan) {
    const dir = target;
    if (!fs.existsSync(dir)) { console.error(`目录不存在: ${dir}`); process.exit(1); }
    const rptFiles = fs.readdirSync(dir).filter(f =>
      f.endsWith('.rpt') && (f.includes('util') || f.includes('resource'))
    );
    if (rptFiles.length === 0) { console.log('未找到 utilization .rpt 文件'); return; }
    for (const f of rptFiles) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const parsed = parseUtilReport(content, f);
      if (isJson) { console.log(JSON.stringify(parsed, null, 2)); }
      else {
        const s = parsed.summary;
        console.log(`[${f}] LUT=${s['Slice LUTs']?.used ?? 'N/A'} FF=${s['Slice Registers']?.used ?? 'N/A'} BRAM=${s['Block RAM Tile']?.used ?? 'N/A'} DSP=${s['DSPs']?.used ?? 'N/A'}`);
      }
    }
    return;
  }

  if (!fs.existsSync(target)) { console.error(`文件不存在: ${target}`); process.exit(1); }
  const content = fs.readFileSync(target, 'utf8');
  const parsed = parseUtilReport(content, target);

  if (isJson) { console.log(JSON.stringify(parsed, null, 2)); return; }

  console.log(`\nUtilization Report: ${target}`);
  const s = parsed.summary;
  if (s['Slice LUTs']) console.log(`  LUT:  ${s['Slice LUTs'].used} / ${s['Slice LUTs'].available} (${s['Slice LUTs'].percent}%)`);
  if (s['Slice Registers']) console.log(`  FF:   ${s['Slice Registers'].used} / ${s['Slice Registers'].available} (${s['Slice Registers'].percent}%)`);
  if (s['Block RAM Tile']) console.log(`  BRAM: ${s['Block RAM Tile'].used} / ${s['Block RAM Tile'].available} (${s['Block RAM Tile'].percent}%)`);
  if (s['DSPs']) console.log(`  DSP:  ${s['DSPs'].used} / ${s['DSPs'].available} (${s['DSPs'].percent}%)`);
  if (s['IO']) console.log(`  IO:   ${s['IO'].used} / ${s['IO'].available} (${s['IO'].percent}%)`);
  console.log(`\n  总资源类别: ${Object.keys(parsed.resources).length}`);
}

if (require.main === module) { main(); }

module.exports = { parseUtilReport, WATCHED_RESOURCES };
