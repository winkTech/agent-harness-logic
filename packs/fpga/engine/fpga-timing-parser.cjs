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
const crypto = require('node:crypto');

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

  // Vivado report_timing_summary Intra-Clock Table:
  // <clock> <WNS> <TNS> <failing setup endpoints> <total> <WHS> ...
  const intraClock = content.match(/^(\S+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(\d+)\s+(\d+)\s+(-?\d+\.\d+)/m);
  if (intraClock) {
    if (!result.setup) {
      result.setup = {
        clock: intraClock[1],
        wns: parseFloat(intraClock[2]),
        tns: parseFloat(intraClock[3]),
        failingEndpoints: parseInt(intraClock[4], 10),
      };
    }
    if (!result.hold) {
      result.hold = { clock: intraClock[1], whs: parseFloat(intraClock[6]), ths: null };
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

function buildTimingEvidence(content, filePath, options = {}) {
  const parsed = parseTimingReport(content, filePath);
  const setupWns = parsed.setup?.wns;
  const holdWhs = parsed.hold?.whs;
  let failure = null;

  if (!Number.isFinite(setupWns)) {
    failure = {
      code: 'report_parse_failed',
      message: 'Timing report does not contain a parseable setup WNS value.',
    };
  } else if (setupWns < 0 || (Number.isFinite(parsed.setup?.tns) && parsed.setup.tns < 0)) {
    failure = {
      code: 'negative_setup_slack',
      message: `Setup timing failed: WNS=${setupWns} ns, TNS=${parsed.setup?.tns ?? 'N/A'} ns.`,
    };
  } else if (Number.isFinite(holdWhs) && holdWhs < 0) {
    failure = {
      code: 'negative_hold_slack',
      message: `Hold timing failed: WHS=${holdWhs} ns, THS=${parsed.hold?.ths ?? 'N/A'} ns.`,
    };
  }

  return {
    schemaVersion: 1,
    kind: 'fpga-synthesis-timing-evidence',
    status: failure ? 'failed' : 'passed',
    scope: 'synthesis-timing-report',
    fullEdaClosure: false,
    generatedAt: new Date().toISOString(),
    report: {
      path: filePath || '(stdin)',
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      parsed: !failure || failure.code !== 'report_parse_failed',
    },
    synthesis: options.synthesis || { status: 'not_evaluated' },
    timing: {
      setup: parsed.setup ? { ...parsed.setup, met: Number.isFinite(setupWns) && setupWns >= 0 } : null,
      hold: parsed.hold ? { ...parsed.hold, met: Number.isFinite(holdWhs) ? holdWhs >= 0 : null } : null,
      clockSummary: parsed.clockSummary,
      worstPaths: parsed.worstPaths || [],
    },
    failure,
    limitations: [
      'Timing report evidence only; this is not full EDA or hardware closure.',
      'Implementation, route, CDC, bitstream, and board evidence are not implied unless separately supplied.',
    ],
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) { console.log('用法: node fpga-timing-parser.cjs <timing.rpt> [--json]'); process.exit(1); }

  const target = args[0];
  const isJson = args.includes('--json');
  const isScan = args.includes('--scan');
  const handoffIndex = args.indexOf('--handoff');
  const handoffPath = handoffIndex >= 0 ? args[handoffIndex + 1] : null;

  if (handoffIndex >= 0 && !handoffPath) {
    console.error('--handoff requires an output path');
    process.exit(1);
  }

  if (isScan) {
    const dir = target;
    if (!fs.existsSync(dir)) { console.error(`目录不存在: ${dir}`); process.exit(1); }
    const rptFiles = fs.readdirSync(dir).filter(f => f.endsWith('.rpt') && f.includes('timing'));
    if (rptFiles.length === 0) { console.log('未找到 timing .rpt 文件'); return; }
    let failed = false;
    for (const f of rptFiles) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const evidence = buildTimingEvidence(content, path.join(dir, f));
      if (isJson) console.log(JSON.stringify(evidence, null, 2));
      else console.log(`[${f}] status=${evidence.status} WNS=${evidence.timing.setup?.wns ?? 'N/A'} Fmax=${evidence.timing.setup?.fmax ?? 'N/A'}`);
      if (evidence.status !== 'passed') failed = true;
    }
    if (failed) process.exitCode = 2;
    return;
  }

  if (!fs.existsSync(target)) { console.error(`文件不存在: ${target}`); process.exit(1); }
  const content = fs.readFileSync(target, 'utf8');
  const evidence = buildTimingEvidence(content, target);
  const parsed = {
    setup: evidence.timing.setup,
    hold: evidence.timing.hold,
    worstPaths: evidence.timing.worstPaths,
  };

  if (handoffPath) {
    fs.mkdirSync(path.dirname(path.resolve(handoffPath)), { recursive: true });
    fs.writeFileSync(handoffPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  }

  if (isJson) {
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.status !== 'passed') process.exitCode = 2;
    return;
  }

  console.log(`\nTiming Report: ${target}`);
  console.log(`  Setup:  WNS=${parsed.setup?.wns ?? 'N/A'}  TNS=${parsed.setup?.tns ?? 'N/A'}  Fmax=${parsed.setup?.fmax ?? 'N/A'}MHz`);
  console.log(`  Hold:   WHS=${parsed.hold?.whs ?? 'N/A'}  THS=${parsed.hold?.ths ?? 'N/A'}`);
  if (parsed.worstPaths) console.log(`  Worst paths: ${parsed.worstPaths.slice(0, 3).join(', ')}`);
  console.log(`  Status: ${evidence.status === 'passed' ? 'PASSED' : 'FAILED'} (timing report evidence only; not full EDA closure)`);
  if (evidence.failure) console.error(`  ${evidence.failure.code}: ${evidence.failure.message}`);
  if (evidence.status !== 'passed') process.exitCode = 2;
  console.log(`  Signed-off: ${evidence.status === 'passed' ? '✅ PASS' : '❌ FAIL'}`);
}

if (require.main === module) { main(); }

module.exports = { parseTimingReport, buildTimingEvidence };
