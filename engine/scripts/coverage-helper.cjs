#!/usr/bin/env node
/**
 * engine/scripts/coverage-helper.cjs — 覆盖率报告解析器。
 *
 * 解析 ModelSim/Vivado 的覆盖率报告，提取结构化指标。
 * 用于工作流 Phase 6 (回归覆盖率) 的自动化评估。
 *
 * 用法:
 *   node coverage-helper.cjs <coverage_report.txt>       # 解析报告
 *   node coverage-helper.cjs --dir <ucdb_dir>            # 扫描目录
 *   node coverage-helper.cjs --merge <file1> <file2>     # 合并报告
 *
 * 输出 JSON:
 *   {
 *     source: "coverage-helper",
 *     file: "<path>",
 *     parsed: true,
 *     summary: { line, condition, fsm, toggle, branch, total },
 *     details: { ... },
 *   }
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── ModelSim 覆盖率报告解析 ────────────────────────────────────────

/**
 * 解析 ModelSim vcover report 文本输出。
 * @param {string} text - 报告全文
 * @returns {object} 结构化覆盖率数据
 */
function parseVcoverReport(text) {
  const result = {
    line: null, condition: null, fsm: null,
    toggle: null, branch: null, assertion: null,
    total: null,
    byScope: [],
  };

  const lines = text.split('\n');

  // 匹配覆盖率摘要行: "Coverage: 78.5%  Line: 85.2%  Condition: 72.1%  FSM: 90.0%  Toggle: 66.7%"
  const summaryRegex = /(?:Coverage|Total)\s*coverage\s*(?:by\s*instance)?[:\s]*([\d.]+)%/i;
  const lineRegex = /(?:Line|Statement)\s*coverage[:\s]*([\d.]+)%/i;
  const condRegex = /(?:Condition|Expression)\s*coverage[:\s]*([\d.]+)%/i;
  const fsmRegex = /FSM\s*coverage[:\s]*([\d.]+)%/i;
  const toggleRegex = /Toggle\s*coverage[:\s]*([\d.]+)%/i;
  const branchRegex = /Branch\s*coverage[:\s]*([\d.]+)%/i;

  for (const line of lines) {
    let m;

    if ((m = summaryRegex.exec(line))) {
      result.total = parseFloat(m[1]);
    }
    if ((m = lineRegex.exec(line))) {
      result.line = parseFloat(m[1]);
    }
    if ((m = condRegex.exec(line))) {
      result.condition = parseFloat(m[1]);
    }
    if ((m = fsmRegex.exec(line))) {
      result.fsm = parseFloat(m[1]);
    }
    if ((m = toggleRegex.exec(line))) {
      result.toggle = parseFloat(m[1]);
    }
    if ((m = branchRegex.exec(line))) {
      result.branch = parseFloat(m[1]);
    }
  }

  // 如果 total 未单独解析，从各维度平均
  if (result.total === null) {
    const vals = [result.line, result.condition, result.fsm, result.toggle, result.branch]
      .filter(v => v !== null);
    result.total = vals.length > 0
      ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10
      : null;
  }

  return result;
}

/**
 * 解析 Vivado xsim 覆盖率报告。
 * Vivado 格式不同: "COVERAGE: 85.25% (LINE: 90.12%, COND: 82.34%, FSM: 88.50%, TOGGLE: 80.00%)"
 * @param {string} text - 报告全文
 * @returns {object}
 */
function parseXsimReport(text) {
  const result = {
    line: null, condition: null, fsm: null,
    toggle: null, branch: null, total: null,
  };

  const coverageRegex = /COVERAGE[:\s]*([\d.]+)%/i;
  const lineRegex = /LINE[:\s]*([\d.]+)%/i;
  const condRegex = /COND(?:ITION)?[:\s]*([\d.]+)%/i;
  const fsmRegex = /FSM[:\s]*([\d.]+)%/i;
  const toggleRegex = /TOGGLE[:\s]*([\d.]+)%/i;

  for (const line of text.split('\n')) {
    let m;
    if ((m = lineRegex.exec(line))) result.line = parseFloat(m[1]);
    if ((m = condRegex.exec(line))) result.condition = parseFloat(m[1]);
    if ((m = fsmRegex.exec(line))) result.fsm = parseFloat(m[1]);
    if ((m = toggleRegex.exec(line))) result.toggle = parseFloat(m[1]);
    if ((m = coverageRegex.exec(line))) result.total = parseFloat(m[1]);
  }

  if (result.total === null) {
    const vals = [result.line, result.condition, result.fsm, result.toggle]
      .filter(v => v !== null);
    result.total = vals.length > 0
      ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10
      : null;
  }

  return result;
}

/**
 * 混合解析 (自动检测格式)。
 */
function parseReport(text) {
  // 尝试 Vivado 格式优先
  if (/COVERAGE/i.test(text) && /LINE/i.test(text)) {
    return { format: 'xsim', ...parseXsimReport(text) };
  }
  return { format: 'vcover', ...parseVcoverReport(text) };
}

// ── 文件/目录操作 ──────────────────────────────────────────────────

/**
 * 扫描目录查找覆盖率报告/数据库文件。
 * @param {string} dirPath - 目录路径
 * @returns {object[]} 文件列表
 */
function scanDirectory(dirPath) {
  const entries = [];
  if (!fs.existsSync(dirPath)) return entries;

  for (const f of fs.readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, f);
    const stat = fs.statSync(fullPath);
    const ext = path.extname(f).toLowerCase();

    if (stat.isFile() && ['.txt', '.ucdb', '.xml'].includes(ext)) {
      entries.push({
        file: f,
        path: fullPath,
        ext,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
  }
  return entries;
}

// ── 主入口 ─────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  node coverage-helper.cjs <report.txt>          Parse coverage report
  node coverage-helper.cjs --dir <path>           Scan directory for reports
  node coverage-helper.cjs --check <path>         Quick check: exists + parseable

Examples:
  node coverage-helper.cjs coverage_report.txt
  node coverage-helper.cjs --dir 02_sim/
  node coverage-helper.cjs --check coverage_report.txt
`);
    process.exit(0);
  }

  if (args[0] === '--dir') {
    const dir = args[1] || '.';
    const entries = scanDirectory(dir);
    const results = [];

    for (const entry of entries) {
      if (entry.ext === '.txt' || entry.ext === '.xml') {
        try {
          const text = fs.readFileSync(entry.path, 'utf8');
          const parsed = parseReport(text);
          results.push({
            file: entry.file,
            ...parsed,
          });
        } catch { /* skip unparseable */ }
      }
    }

    console.log(JSON.stringify({
      source: 'coverage-helper',
      directory: path.resolve(dir),
      filesFound: entries.length,
      reportsParsed: results.length,
      results,
    }, null, 2));
    return;
  }

  if (args[0] === '--check') {
    const reportFile = path.resolve(args[1]);
    if (!fs.existsSync(reportFile)) {
      console.log(JSON.stringify({
        source: 'coverage-helper',
        exists: false,
        file: reportFile,
        error: 'File not found',
      }));
      process.exit(1);
    }

    try {
      const text = fs.readFileSync(reportFile, 'utf8');
      const parsed = parseReport(text);
      console.log(JSON.stringify({
        source: 'coverage-helper',
        exists: true,
        file: reportFile,
        parseable: parsed.line !== null || parsed.total !== null,
        summary: {
          total: parsed.total,
          line: parsed.line,
          condition: parsed.condition,
          fsm: parsed.fsm,
        },
      }));
    } catch (e) {
      console.log(JSON.stringify({
        source: 'coverage-helper',
        exists: true,
        file: reportFile,
        parseable: false,
        error: e.message,
      }));
      process.exit(1);
    }
    return;
  }

  // 默认: 解析单个报告文件
  const reportFile = path.resolve(args[0]);
  if (!fs.existsSync(reportFile)) {
    console.error(`File not found: ${reportFile}`);
    process.exit(1);
  }

  const text = fs.readFileSync(reportFile, 'utf8');
  const parsed = parseReport(text);

  console.log(JSON.stringify({
    source: 'coverage-helper',
    file: reportFile,
    parsed: true,
    summary: {
      total: parsed.total,
      line: parsed.line,
      condition: parsed.condition,
      fsm: parsed.fsm,
      toggle: parsed.toggle,
      branch: parsed.branch,
    },
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseVcoverReport,
  parseXsimReport,
  parseReport,
  scanDirectory,
};
