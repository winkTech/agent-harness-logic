#!/usr/bin/env node
/**
 * engine/scripts/eda-detect.cjs — EDA 工具链自动检测。
 *
 * 检测系统中可用的 HDL 工具链并返回版本号。
 * 被 lint-utils.cjs、hdl-coding-dag-workflow.js 和 harness-init.cjs 共用。
 *
 * 检测的工具:
 *   - vlog         → Questa/ModelSim
 *   - vsim         → Questa/ModelSim 仿真器
 *   - xvlog        → Vivado
 *   - xelab        → Vivado 仿真器
 *   - xsim         → Vivado 仿真器
 *   - verilator    → Verilator
 *   - iverilog     → Icarus Verilog
 *   - vivado       → Vivado 综合/实现
 *   - yosys        → Yosys 综合
 *
 * 用法:
 *   const eda = require('./eda-detect.cjs');
 *   const tools = eda.detect();        // 同步检测
 *   console.log(eda.report(tools));     // 人类可读报告
 *
 * CLI:
 *   node engine/scripts/eda-detect.cjs           # 完整报告
 *   node engine/scripts/eda-detect.cjs --json    # JSON 输出
 *   node engine/scripts/eda-detect.cjs --lint    # 仅 lint 工具
 */

'use strict';

const { spawnSync } = require('node:child_process');

// ── 工具检测定义 ────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'vlog',
    label: 'Questa/ModelSim',
    cmd: 'vlog',
    args: ['-version'],
    versionRegex: /vlog\s+([\d.]+)/i,
    lintCmd: (file) => ['-lint', file],
    lintLabel: 'vlog -lint',
  },
  {
    name: 'vsim',
    label: 'Questa/ModelSim Simulator',
    cmd: 'vsim',
    args: ['-version'],
    versionRegex: /vsim\s+([\d.]+)/i,
  },
  {
    name: 'xvlog',
    label: 'Vivado (xvlog)',
    cmd: 'xvlog',
    args: ['-version'],
    versionRegex: /xvlog\s+v([\d.]+)/i,
    lintCmd: (file) => ['-sv', '-lint', file],
    lintLabel: 'xvlog -sv -lint',
    // 同时检测 vivado
    companionCheck: () => {
      const r = spawnSync('vivado', ['-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (r.status === 0) {
        const m = r.stdout.match(/Vivado\s+v?([\d.]+)/i);
        return { version: m ? m[1] : 'unknown' };
      }
      return null;
    },
  },
  {
    name: 'xelab',
    label: 'Vivado Simulator (xelab)',
    cmd: 'xelab',
    args: ['-version'],
    versionRegex: /xelab\s+([\d.]+)/i,
  },
  {
    name: 'verilator',
    label: 'Verilator',
    cmd: 'verilator',
    args: ['--version'],
    versionRegex: /Verilator\s+([\d.]+)/i,
    lintCmd: (file) => ['--lint-only', '--sv', file],
    lintLabel: 'verilator --lint-only',
  },
  {
    name: 'iverilog',
    label: 'Icarus Verilog',
    cmd: 'iverilog',
    args: ['-V'],
    versionRegex: /Icarus Verilog version\s+([\d.]+)/i,
    lintCmd: (file) => ['-g2012', '-o', '/dev/null', '-s', file, file],
    lintLabel: 'iverilog -g2012',
  },
  {
    name: 'yosys',
    label: 'Yosys',
    cmd: 'yosys',
    args: ['-V'],
    versionRegex: /Yosys\s+([\d.]+)/i,
  },
  {
    name: 'vivado',
    label: 'Vivado',
    cmd: 'vivado',
    args: ['-version'],
    versionRegex: /Vivado\s+v?([\d.]+)/i,
  },
];

// ── 检测 ────────────────────────────────────────────────────────────────────

/**
 * 检测系统中可用的 EDA 工具链。
 * @param {object} [opts]
 * @param {boolean} [opts.quick] — 只检测 lint 工具（vlog/xvlog/verilator/iverilog）
 * @returns {Array<{ name: string, label: string, available: boolean, version: string|null,
 *                    lintCmd: Function|null, lintLabel: string|null }>}
 */
function detect(opts = {}) {
  const results = [];

  for (const tool of TOOLS) {
    // 快速模式：只检测 lint 工具
    if (opts.quick && !tool.lintCmd) continue;

    try {
      const r = spawnSync(tool.cmd, tool.args, {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });

      let version = null;
      if (r.status === 0 && r.stdout) {
        const m = r.stdout.match(tool.versionRegex);
        if (m) version = m[1];
      }
      // 尝试 stderr
      if (!version && r.status === 0 && r.stderr) {
        const m = r.stderr.match(tool.versionRegex);
        if (m) version = m[1];
      }

      const available = r.status === 0 && !r.error && !r.signal;

      // 伴生检测（如 xvlog → vivado）
      let companion = null;
      if (tool.companionCheck && available) {
        companion = tool.companionCheck();
      }

      results.push({
        name: tool.name,
        label: tool.label,
        available,
        version,
        lintCmd: tool.lintCmd || null,
        lintLabel: tool.lintLabel || null,
        companion,
      });
    } catch {
      results.push({
        name: tool.name,
        label: tool.label,
        available: false,
        version: null,
        lintCmd: tool.lintCmd || null,
        lintLabel: tool.lintLabel || null,
        companion: null,
      });
    }
  }

  return results;
}

// ── 选择首选 lint 工具 ─────────────────────────────────────────────────────

/**
 * 从已检测的工具中选择最佳 lint 工具链。
 * 优先级: xvlog (Vivado) > vlog (Questa) > verilator > iverilog
 *
 * @param {Array} tools — detect() 的返回值
 * @returns {{ name: string, lintCmd: Function, lintLabel: string } | null}
 */
function pickLintTool(tools) {
  const priority = ['xvlog', 'vlog', 'verilator', 'iverilog'];
  for (const name of priority) {
    const tool = tools.find(t => t.name === name && t.available && t.lintCmd);
    if (tool) {
      return { name: tool.name, lintCmd: tool.lintCmd, lintLabel: tool.lintLabel };
    }
  }
  return null; // 无可用 lint 工具
}

/**
 * 生成人类可读报告。
 */
function report(tools) {
  const lines = ['EDA 工具链检测报告:'];
  const available = tools.filter(t => t.available);
  const unavailable = tools.filter(t => !t.available);

  if (available.length === 0) {
    lines.push('  ⚠ 未检测到任何 EDA 工具');
    return lines.join('\n');
  }

  lines.push(`  可用: ${available.length} | 不可用: ${unavailable.length}`);
  for (const t of available) {
    const ver = t.version ? ` v${t.version}` : '';
    const companion = t.companion ? ` (+${t.companion.version || 'unknown'})` : '';
    lines.push(`  ✅ ${t.label}${ver}${companion}`);
  }

  const lintTool = pickLintTool(tools);
  if (lintTool) {
    lines.push(`  🔍 首选 lint: ${lintTool.lintLabel}`);
  }

  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const lintOnly = args.includes('--lint');

  const tools = detect({ quick: lintOnly });

  if (isJson) {
    console.log(JSON.stringify({ tools, lintTool: pickLintTool(tools) }, null, 2));
  } else {
    console.log(report(tools));
  }
}

if (require.main === module) {
  main();
}

module.exports = { detect, pickLintTool, report, TOOLS };
