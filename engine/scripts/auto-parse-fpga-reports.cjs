#!/usr/bin/env node
/**
 * auto-parse-fpga-reports.cjs — PostToolUse(Bash) hook
 * 检测 vivado/vsim 命令成功后，自动在常见位置查找报告并解析摘要。
 * 无报告 → 静默跳过 (exit 0)。不阻塞 hook 链。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildTimingEvidence } = require('./fpga-timing-parser.cjs');

function findReports(cwd) {
  const found = [];
  const searchDirs = [cwd, path.join(cwd, '02_sim'), path.join(cwd, '04_prj')];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const sub = path.join(dir, e.name);
          try {
            const subs = fs.readdirSync(sub);
            for (const f of subs) {
              if (/timing.*\.rpt$/i.test(f)) found.push({ type: 'timing', path: path.join(sub, f) });
              if (/(?:utilization|util).*\.rpt$/i.test(f)) found.push({ type: 'util', path: path.join(sub, f) });
            }
          } catch {}
        } else {
          if (/timing.*\.rpt$/i.test(e.name)) found.push({ type: 'timing', path: path.join(dir, e.name) });
          if (/(?:utilization|util).*\.rpt$/i.test(e.name)) found.push({ type: 'util', path: path.join(dir, e.name) });
          if (e.name.endsWith('.xdc')) found.push({ type: 'xdc', path: path.join(dir, e.name) });
        }
      }
    } catch {}
  }
  return found;
}

function main() {
  let stdinRaw = '';
  try { stdinRaw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  if (!stdinRaw) process.exit(0);

  // 检测是否是 FPGA 相关命令
  const isFpgaCmd = /vivado|vsim|xsim|xelab|synth|implement|place|route|bitstream/i.test(stdinRaw);
  if (!isFpgaCmd) process.exit(0);

  // 尝试获取工作目录
  let cwd = process.cwd();
  try {
    const data = JSON.parse(stdinRaw);
    cwd = data?.workspace?.current_dir || data?.cwd || cwd;
  } catch {}

  const reports = findReports(cwd);
  if (reports.length === 0) process.exit(0);

  // 解析找到的报告
  let failed = false;
  for (const r of reports) {
    try {
      if (r.type === 'timing') {
        const content = fs.readFileSync(r.path, 'utf8');
        const result = buildTimingEvidence(content, r.path, {
          synthesis: { status: 'command_completed', source: 'PostToolUse(Bash)' },
        });
        const handoffPath = path.join(path.dirname(r.path), 'synthesis-timing-evidence.json');
        fs.writeFileSync(handoffPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
        console.error(`[fpga-timing] ${path.basename(r.path)}: status=${result.status} WNS=${result.timing.setup?.wns ?? 'N/A'}ns TNS=${result.timing.setup?.tns ?? 'N/A'}ns evidence=${handoffPath}`);
        if (result.status !== 'passed') failed = true;
      } else if (r.type === 'util') {
        const { parseUtilReport } = require('./fpga-util-parser.cjs');
        const result = parseUtilReport(r.path);
        if (result) console.error(`[fpga-util] ${path.basename(r.path)}: LUT=${result.lut} FF=${result.ff} BRAM=${result.bram} DSP=${result.dsp}`);
      } else if (r.type === 'xdc') {
        const { parseXdc } = require('./fpga-xdc-parser.cjs');
        const clocks = parseXdc(r.path)?.clocks || [];
        if (clocks.length > 0) console.error(`[fpga-xdc] ${path.basename(r.path)}: ${clocks.length} clock(s) — ${clocks.map(c => c.name + '=' + c.period).join(', ')}`);
      }
    } catch { /* 解析失败静默 */ }
  }
  process.exit(failed ? 2 : 0);
}

main();
