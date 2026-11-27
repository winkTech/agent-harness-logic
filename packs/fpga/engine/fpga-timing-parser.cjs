#!/usr/bin/env node
/**
 * packs/fpga/engine/fpga-timing-parser.cjs — Vivado Timing Report 解析器。
 *
 * 解析 Vivado report_timing_summary (.rpt)，以全局 Design Timing Summary 为权威判据提取：
 *   - 全局 WNS / TNS / TNS Failing Endpoints (Setup)
 *   - 全局 WHS / THS / THS Failing Endpoints (Hold)
 *   - 全局 WPWS / TPWS / TPWS Failing Endpoints (Pulse Width)
 *   - Clock Summary / Intra-Clock / Inter-Clock / Other Path Groups 全表最差值交叉兜底
 *   - Fmax 与关键路径摘要
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

const NUM_OR_NA_RE = /^(?:-?\d+(?:\.\d+)?|NA)$/i;

const SECTION_HEADERS = [
  'Timer Settings',
  'Report Methodology',
  'check_timing report',
  'Design Timing Summary',
  'Clock Summary',
  'Intra Clock Table',
  'Inter Clock Table',
  'Other Path Groups Table',
  'User Ignored Paths Table',
  'Unconstrained Paths Table',
  'Timing Details',
];

function toNum(tok) {
  if (tok === undefined || tok === null) return null;
  const s = String(tok).trim();
  if (!s || /^N\/?A$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(tok) {
  if (tok === undefined || tok === null) return null;
  const s = String(tok).trim();
  if (!s || /^N\/?A$/i.test(s)) return null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionLines(lines, sectionTitle) {
  const titleRe = new RegExp(`^\\s*(?:\\|\\s*)?${escapeRe(sectionTitle)}\\s*$`, 'i');
  const anyHeaderRe = new RegExp(
    `^\\s*(?:\\|\\s*)?(?:${SECTION_HEADERS.map(escapeRe).join('|')})\\s*$`,
    'i',
  );
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (titleRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    if (anyHeaderRe.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function tokenizeRow(line) {
  const trimmed = line.trim();
  if (!trimmed || /^[-|+=\s]+$/.test(trimmed)) return [];
  if (trimmed.includes('|')) {
    return trimmed.replace(/^\|+|\|+$/g, '').split('|').map((s) => s.trim()).filter(Boolean);
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

function parseDesignTimingSummary(lines) {
  const sec = extractSectionLines(lines, 'Design Timing Summary');
  for (const line of sec) {
    const tokens = tokenizeRow(line);
    if ((tokens.length === 12 || tokens.length === 8) && tokens.every((t) => NUM_OR_NA_RE.test(t))) {
      const setup = {
        source: 'Design Timing Summary',
        wns: toNum(tokens[0]),
        tns: toNum(tokens[1]),
        failingEndpoints: toInt(tokens[2]),
        totalEndpoints: toInt(tokens[3]),
      };
      const hold = {
        source: 'Design Timing Summary',
        whs: toNum(tokens[4]),
        ths: toNum(tokens[5]),
        failingEndpoints: toInt(tokens[6]),
        totalEndpoints: toInt(tokens[7]),
      };
      const pulseWidth = tokens.length === 12
        ? {
            source: 'Design Timing Summary',
            wpws: toNum(tokens[8]),
            tpws: toNum(tokens[9]),
            failingEndpoints: toInt(tokens[10]),
            totalEndpoints: toInt(tokens[11]),
          }
        : null;
      return { setup, hold, pulseWidth };
    }
  }
  return null;
}

function parseClockSummary(lines, content) {
  const clocks = new Map();
  const sec = extractSectionLines(lines, 'Clock Summary');
  for (const line of sec) {
    const m = line.match(/^\s*(\S+)\s+\{[^}]*\}\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/);
    if (m) {
      clocks.set(m[1], {
        clock: m[1],
        periodNs: Number(m[2]),
        frequencyMhz: Number(m[3]),
      });
    }
  }
  // 兼容旧式竖线分隔摘要表
  if (clocks.size === 0) {
    const clkLines = content.match(/\|?\s*clk_\w+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|\s*[\d.]+\s*\|/gi);
    if (clkLines) {
      for (const line of clkLines) {
        const parts = line.split('|').map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 3) {
          clocks.set(parts[0], {
            clock: parts[0],
            wns: toNum(parts[1]),
            level: parts.slice(-1)[0],
          });
        }
      }
    }
  }
  return clocks;
}

function parseIntraClockRows(lines, clockMeta) {
  const rows = [];
  const sec = extractSectionLines(lines, 'Intra Clock Table');
  const sourceLines = sec.length > 0 ? sec : lines;
  for (const line of sourceLines) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:Clock|From|Path|[-|+=\s])/i.test(trimmed)) continue;
    if (sec.length === 0 && /^\d|^NA\b/i.test(trimmed)) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 6) continue;
    const clock = tokens[0];
    if (NUM_OR_NA_RE.test(clock)) continue;
    const vals = tokens.slice(1);
    if (![5, 8, 12].includes(vals.length) || !vals.every((t) => NUM_OR_NA_RE.test(t))) continue;
    const meta = clockMeta.get(clock) || null;
    const wns = toNum(vals[0]);
    const periodNs = meta?.periodNs ?? null;
    const achievedFmaxMhz = (Number.isFinite(periodNs) && Number.isFinite(wns) && (periodNs - wns) > 0)
      ? Number((1000 / (periodNs - wns)).toFixed(2))
      : null;
    rows.push({
      clock,
      periodNs,
      targetFmaxMhz: meta?.frequencyMhz ?? null,
      achievedFmaxMhz,
      wns,
      tns: toNum(vals[1]),
      failingEndpoints: toInt(vals[2]),
      totalEndpoints: toInt(vals[3]),
      whs: toNum(vals[4]),
      ths: vals.length >= 8 ? toNum(vals[5]) : null,
      failingHoldEndpoints: vals.length >= 8 ? toInt(vals[6]) : null,
      totalHoldEndpoints: vals.length >= 8 ? toInt(vals[7]) : null,
      wpws: vals.length === 12 ? toNum(vals[8]) : null,
      tpws: vals.length === 12 ? toNum(vals[9]) : null,
      failingPulseWidthEndpoints: vals.length === 12 ? toInt(vals[10]) : null,
      totalPulseWidthEndpoints: vals.length === 12 ? toInt(vals[11]) : null,
    });
  }
  return rows;
}

function parsePathGroupRows(lines, sectionTitle, labelCount) {
  const rows = [];
  const sec = extractSectionLines(lines, sectionTitle);
  for (const line of sec) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:From\s+Clock|Path\s+Group|[-|+=\s])/i.test(trimmed)) continue;
    const tokens = trimmed.split(/\s+/);
    // 尾部可能有 8 个数值/NA (Setup+Hold) 或 4 个数值/NA (仅 Setup, 如 datapath_only)
    for (const valCount of [8, 4]) {
      if (tokens.length < labelCount + valCount) continue;
      const vals = tokens.slice(tokens.length - valCount);
      if (!vals.every((t) => NUM_OR_NA_RE.test(t))) continue;
      const head = tokens.slice(0, tokens.length - valCount);
      rows.push({
        group: sectionTitle === 'Inter Clock Table'
          ? `${head[0]} -> ${head[1] || ''}`
          : head.join(' '),
        fromClock: labelCount === 2 ? head[0] : (head[head.length - 2] || null),
        toClock: labelCount === 2 ? head[1] : (head[head.length - 1] || null),
        wns: toNum(vals[0]),
        tns: toNum(vals[1]),
        failingEndpoints: toInt(vals[2]),
        totalEndpoints: toInt(vals[3]),
        whs: valCount === 8 ? toNum(vals[4]) : null,
        ths: valCount === 8 ? toNum(vals[5]) : null,
        failingHoldEndpoints: valCount === 8 ? toInt(vals[6]) : null,
        totalHoldEndpoints: valCount === 8 ? toInt(vals[7]) : null,
      });
      break;
    }
  }
  return rows;
}

function minFinite(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  return finite.length > 0 ? Math.min(...finite) : null;
}

function sumNegative(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const negSum = finite.reduce((acc, v) => acc + (v < 0 ? v : 0), 0);
  return Number(negSum.toFixed(3));
}

function sumInts(values) {
  const finite = values.filter((v) => Number.isInteger(v));
  return finite.length > 0 ? finite.reduce((a, b) => a + b, 0) : null;
}

/**
 * 解析 Vivado timing report。
 */
function parseTimingReport(content, filePath) {
  const text = String(content || '');
  const lines = text.split(/\r?\n/);
  const result = {
    file: filePath || '(stdin)',
    setup: null,
    hold: null,
    pulseWidth: null,
    clockSummary: [],
    interClockSummary: [],
    otherPathGroups: [],
    constraintsMetBanner: null,
  };

  if (/All user specified timing constraints are met\./i.test(text)) {
    result.constraintsMetBanner = true;
  } else if (/Timing constraints are not met\./i.test(text)) {
    result.constraintsMetBanner = false;
  }

  const clockMeta = parseClockSummary(lines, text);
  const intraRows = parseIntraClockRows(lines, clockMeta);
  const interRows = parsePathGroupRows(lines, 'Inter Clock Table', 2);
  const otherRows = parsePathGroupRows(lines, 'Other Path Groups Table', 3);

  result.clockSummary = intraRows.length > 0
    ? intraRows
    : [...clockMeta.values()].filter((c) => Number.isFinite(c.wns));
  result.interClockSummary = interRows;
  result.otherPathGroups = otherRows;

  // 1. 最高优先级: Vivado 全局 Design Timing Summary
  const dts = parseDesignTimingSummary(lines);
  if (dts) {
    if (dts.setup.wns !== null || dts.setup.tns !== null || dts.setup.failingEndpoints !== null) {
      result.setup = dts.setup;
    }
    if (dts.hold.whs !== null || dts.hold.ths !== null || dts.hold.failingEndpoints !== null) {
      result.hold = dts.hold;
    }
    if (dts.pulseWidth && (dts.pulseWidth.wpws !== null || dts.pulseWidth.tpws !== null || dts.pulseWidth.failingEndpoints !== null)) {
      result.pulseWidth = dts.pulseWidth;
    }
  }

  // 2. 次优先级: Markdown/竖线格式表头或键值摘要 ("WNS(ns)= -0.123")
  if (!result.setup) {
    const setupHeader = text.match(/\|.*WNS.*TNS.*Fmax/i);
    if (setupHeader) {
      const tableStart = text.indexOf(setupHeader[0]);
      if (tableStart >= 0) {
        const afterHeader = text.slice(tableStart + setupHeader[0].length);
        const dataLine = afterHeader.match(/\|?\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*\|/);
        if (dataLine) {
          result.setup = { wns: parseFloat(dataLine[1]), tns: parseFloat(dataLine[2]) };
        }
      }
    }
  }
  if (!result.setup) {
    const wnsMatch = text.match(/WNS\(?ns\)?\s*[=:]\s*(-?\d+(?:\.\d+)?)/i);
    const tnsMatch = text.match(/TNS\(?ns\)?\s*[=:]\s*(-?\d+(?:\.\d+)?)/i);
    if (wnsMatch) {
      result.setup = { wns: parseFloat(wnsMatch[1]), tns: tnsMatch ? parseFloat(tnsMatch[1]) : null };
    }
  }

  if (!result.hold) {
    const holdHeader = text.match(/\|.*WHS.*THS/i);
    if (holdHeader) {
      const idx = text.indexOf(holdHeader[0]);
      if (idx >= 0) {
        const after = text.slice(idx + holdHeader[0].length);
        const d = after.match(/\|?\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*\|/);
        if (d) result.hold = { whs: parseFloat(d[1]), ths: parseFloat(d[2]) };
      }
    }
  }
  if (!result.hold) {
    const whs = text.match(/WHS\(?ns\)?\s*[=:]\s*(-?\d+(?:\.\d+)?)/i);
    const ths = text.match(/THS\(?ns\)?\s*[=:]\s*(-?\d+(?:\.\d+)?)/i);
    if (whs) result.hold = { whs: parseFloat(whs[1]), ths: ths ? parseFloat(ths[1]) : null };
  }

  // 3. 全表聚合与交叉下界兜底 (覆盖 Intra + Inter + Other 全部行，绝不只看第一行)
  const allTableRows = [...intraRows, ...interRows, ...otherRows];
  if (allTableRows.length > 0) {
    const worstWns = minFinite(allTableRows.map((r) => r.wns));
    const totalNegTns = sumNegative(allTableRows.map((r) => r.tns));
    const totalSetupFailEp = sumInts(allTableRows.map((r) => r.failingEndpoints));
    const worstSetupRow = allTableRows.find((r) => r.wns === worstWns);

    if (!result.setup && worstWns !== null) {
      result.setup = {
        source: 'Aggregated Path Tables',
        ...(worstSetupRow?.clock ? { clock: worstSetupRow.clock } : {}),
        ...(worstSetupRow?.group ? { group: worstSetupRow.group } : {}),
        wns: worstWns,
        tns: totalNegTns,
        failingEndpoints: totalSetupFailEp,
      };
    } else if (result.setup && worstWns !== null) {
      if (!Number.isFinite(result.setup.wns) || worstWns < result.setup.wns) {
        result.setup.wns = worstWns;
      }
      if (totalNegTns !== null && (!Number.isFinite(result.setup.tns) || totalNegTns < result.setup.tns)) {
        result.setup.tns = totalNegTns;
      }
      if (totalSetupFailEp !== null && (!Number.isInteger(result.setup.failingEndpoints) || totalSetupFailEp > result.setup.failingEndpoints)) {
        result.setup.failingEndpoints = totalSetupFailEp;
      }
    }

    const worstWhs = minFinite(allTableRows.map((r) => r.whs));
    const totalNegThs = sumNegative(allTableRows.map((r) => r.ths));
    const totalHoldFailEp = sumInts(allTableRows.map((r) => r.failingHoldEndpoints));
    const worstHoldRow = allTableRows.find((r) => r.whs === worstWhs);

    if (!result.hold && worstWhs !== null) {
      result.hold = {
        source: 'Aggregated Path Tables',
        ...(worstHoldRow?.clock ? { clock: worstHoldRow.clock } : {}),
        ...(worstHoldRow?.group ? { group: worstHoldRow.group } : {}),
        whs: worstWhs,
        ths: totalNegThs,
        failingEndpoints: totalHoldFailEp,
      };
    } else if (result.hold && worstWhs !== null) {
      if (!Number.isFinite(result.hold.whs) || worstWhs < result.hold.whs) {
        result.hold.whs = worstWhs;
      }
      if (totalNegThs !== null && (!Number.isFinite(result.hold.ths) || totalNegThs < result.hold.ths)) {
        result.hold.ths = totalNegThs;
      }
      if (totalHoldFailEp !== null && (!Number.isInteger(result.hold.failingEndpoints) || totalHoldFailEp > result.hold.failingEndpoints)) {
        result.hold.failingEndpoints = totalHoldFailEp;
      }
    }

    const worstWpws = minFinite(intraRows.map((r) => r.wpws));
    const totalNegTpws = sumNegative(intraRows.map((r) => r.tpws));
    const totalPwFailEp = sumInts(intraRows.map((r) => r.failingPulseWidthEndpoints));
    if (!result.pulseWidth && worstWpws !== null) {
      result.pulseWidth = {
        source: 'Aggregated Path Tables',
        wpws: worstWpws,
        tpws: totalNegTpws,
        failingEndpoints: totalPwFailEp,
      };
    } else if (result.pulseWidth && worstWpws !== null) {
      if (!Number.isFinite(result.pulseWidth.wpws) || worstWpws < result.pulseWidth.wpws) {
        result.pulseWidth.wpws = worstWpws;
      }
      if (totalNegTpws !== null && (!Number.isFinite(result.pulseWidth.tpws) || totalNegTpws < result.pulseWidth.tpws)) {
        result.pulseWidth.tpws = totalNegTpws;
      }
      if (totalPwFailEp !== null && (!Number.isInteger(result.pulseWidth.failingEndpoints) || totalPwFailEp > result.pulseWidth.failingEndpoints)) {
        result.pulseWidth.failingEndpoints = totalPwFailEp;
      }
    }
  }

  // ── Fmax ───────────────────────────────────────────────────────────────
  const fmaxMatch = text.match(/(?:Fmax|Maximum\s+Frequency)\s*[=:]\s*(\d+(?:\.\d+)?)\s*MHz/i);
  if (fmaxMatch) {
    if (!result.setup) result.setup = {};
    result.setup.fmax = parseFloat(fmaxMatch[1]);
  } else if (result.setup && result.setup.fmax === undefined && intraRows.length === 1 && Number.isFinite(intraRows[0].achievedFmaxMhz)) {
    result.setup.fmax = intraRows[0].achievedFmaxMhz;
  }

  // ── 定时路径摘要 ──────────────────────────────────────────────────────
  const pathLines = text.match(/(?:Worst\s+Slack|Slack|slack)\s*[:=]?\s*(-?\d+(?:\.\d+)?)ns?/gi);
  if (pathLines && pathLines.length > 0) {
    result.worstPaths = pathLines.slice(0, 3).map((p) => {
      const v = p.match(/-?\d+(?:\.\d+)?/);
      return v ? parseFloat(v[0]) : null;
    }).filter((v) => v !== null);
  }

  return result;
}

function buildTimingEvidence(content, filePath, options = {}) {
  const parsed = parseTimingReport(content, filePath);
  const setupWns = parsed.setup?.wns;
  const setupTns = parsed.setup?.tns;
  const setupFailEp = parsed.setup?.failingEndpoints;
  const holdWhs = parsed.hold?.whs;
  const holdThs = parsed.hold?.ths;
  const holdFailEp = parsed.hold?.failingEndpoints;
  const pwWpws = parsed.pulseWidth?.wpws;
  const pwTpws = parsed.pulseWidth?.tpws;
  const pwFailEp = parsed.pulseWidth?.failingEndpoints;

  const setupViolated = (Number.isFinite(setupWns) && setupWns < 0)
    || (Number.isFinite(setupTns) && setupTns < 0)
    || (Number.isInteger(setupFailEp) && setupFailEp > 0);
  const holdViolated = (Number.isFinite(holdWhs) && holdWhs < 0)
    || (Number.isFinite(holdThs) && holdThs < 0)
    || (Number.isInteger(holdFailEp) && holdFailEp > 0);
  const pwViolated = (Number.isFinite(pwWpws) && pwWpws < 0)
    || (Number.isFinite(pwTpws) && pwTpws < 0)
    || (Number.isInteger(pwFailEp) && pwFailEp > 0);

  let failure = null;
  if (setupViolated) {
    failure = {
      code: 'negative_setup_slack',
      message: `Setup timing failed: WNS=${setupWns ?? 'N/A'} ns, TNS=${setupTns ?? 'N/A'} ns, failingEndpoints=${setupFailEp ?? 'N/A'}.`,
    };
  } else if (holdViolated) {
    failure = {
      code: 'negative_hold_slack',
      message: `Hold timing failed: WHS=${holdWhs ?? 'N/A'} ns, THS=${holdThs ?? 'N/A'} ns, failingEndpoints=${holdFailEp ?? 'N/A'}.`,
    };
  } else if (pwViolated) {
    failure = {
      code: 'negative_pulse_width_slack',
      message: `Pulse-width timing failed: WPWS=${pwWpws ?? 'N/A'} ns, TPWS=${pwTpws ?? 'N/A'} ns, failingEndpoints=${pwFailEp ?? 'N/A'}.`,
    };
  } else if (!Number.isFinite(setupWns)) {
    failure = {
      code: 'report_parse_failed',
      message: 'Timing report does not contain a parseable setup WNS value.',
    };
  } else if (parsed.constraintsMetBanner === false) {
    failure = {
      code: 'timing_constraints_not_met',
      message: 'Timing report explicitly states "Timing constraints are not met."',
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
      sha256: crypto.createHash('sha256').update(String(content || '')).digest('hex'),
      parsed: !failure || failure.code !== 'report_parse_failed',
    },
    synthesis: options.synthesis || { status: 'not_evaluated' },
    timing: {
      setup: parsed.setup ? { ...parsed.setup, met: Number.isFinite(setupWns) && !setupViolated } : null,
      hold: parsed.hold ? { ...parsed.hold, met: Number.isFinite(holdWhs) ? !holdViolated : null } : null,
      ...(parsed.pulseWidth ? { pulseWidth: { ...parsed.pulseWidth, met: Number.isFinite(pwWpws) ? !pwViolated : null } } : {}),
      clockSummary: parsed.clockSummary,
      ...(parsed.interClockSummary.length > 0 ? { interClockSummary: parsed.interClockSummary } : {}),
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
    const rptFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.rpt') && f.includes('timing'));
    if (rptFiles.length === 0) { console.log('未找到 timing .rpt 文件'); return; }
    let failed = false;
    for (const f of rptFiles) {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const evidence = buildTimingEvidence(content, path.join(dir, f));
      if (isJson) console.log(JSON.stringify(evidence, null, 2));
      else console.log(`[${f}] status=${evidence.status} WNS=${evidence.timing.setup?.wns ?? 'N/A'} WHS=${evidence.timing.hold?.whs ?? 'N/A'} Fmax=${evidence.timing.setup?.fmax ?? 'N/A'}`);
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
  if (parsed.worstPaths?.length) console.log(`  Worst paths: ${parsed.worstPaths.slice(0, 3).join(', ')}`);
  console.log(`  Status: ${evidence.status === 'passed' ? 'PASSED' : 'FAILED'} (timing report evidence only; not full EDA closure)`);
  if (evidence.failure) console.error(`  ${evidence.failure.code}: ${evidence.failure.message}`);
  if (evidence.status !== 'passed') process.exitCode = 2;
  console.log(`  Signed-off: ${evidence.status === 'passed' ? '✅ PASS' : '❌ FAIL'}`);
}

if (require.main === module) { main(); }

module.exports = { parseTimingReport, buildTimingEvidence };
