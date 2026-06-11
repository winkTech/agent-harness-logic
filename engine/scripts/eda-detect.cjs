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
 *   - xvlog        → Vivado xvlog
 *   - xelab        → Vivado 仿真器
 *   - xsim         → Vivado 仿真器 (独立条)
 *   - verilator    → Verilator
 *   - iverilog     → Icarus Verilog
 *   - vivado       → Vivado 综合/实现
 *   - yosys        → Yosys 综合
 *   - quartus_map  → Intel Quartus
 *   - vcs          → Synopsys VCS
 *   - xrun         → Cadence Xcelium
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

// ── 跨平台命令解析 ───────────────────────────────────────────────────────────

/**
 * 在 win32 上，EDA 工具通常是 .bat 包装器而非原生可执行文件（如 Vivado 的 shebang 脚本）。
 * 这里检测命令是否存在，如果原始命令不在 PATH 中则尝试 .bat/.cmd 后缀。
 * @param {string} cmd
 * @returns {string} 可执行的命令名
 */
function resolveWin32Cmd(cmd) {
  if (process.platform !== 'win32') return cmd;
  if (/\.(bat|cmd|exe|com)$/i.test(cmd)) return cmd;

  // 用 where 定位真实路径，检查扩展名
  try {
    const r = spawnSync('where', [cmd], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const found = r.stdout.trim().split(/\r?\n/)[0];
      // 已有 Windows 可执行扩展名 → 直接用
      if (/\.(exe|com|bat|cmd)$/i.test(found)) return cmd;
    }
  } catch { /* fall through */ }

  // 原始命令无可执行扩展名（如 bash shebang 脚本）→ 尝试 .bat
  try {
    const r2 = spawnSync('where', [cmd + '.bat'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r2.status === 0 && r2.stdout && r2.stdout.trim()) return cmd + '.bat';
  } catch { /* try .cmd */ }

  try {
    const r3 = spawnSync('where', [cmd + '.cmd'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r3.status === 0 && r3.stdout && r3.stdout.trim()) return cmd + '.cmd';
  } catch { /* give up */ }

  return cmd;
}

/**
 * 在标准路径中搜索 Xilinx Vivado 安装目录，返回可用版本列表。
 * 基于环境变量 SystemDrive（通常 C:），不硬编码盘符。
 * 也检查 D:（常见安装盘）。
 * @returns {Array<{ dir: string, version: string }>}
 */
function findVivadoInstallDirs() {
  if (process.platform !== 'win32') return [];

  const drives = new Set();
  // SystemDrive → C: 或 D:
  const sysDrive = (process.env.SystemDrive || 'C:').replace(/\\$/, '');
  drives.add(sysDrive);
  // 也检查 D:（安装软件默认走 D 盘规则）
  drives.add('D:');

  const results = [];

  for (const drive of drives) {
    // shell:true 模式下 cmd.exe 需要反斜杠
    const searchPath = `${drive}\\Xilinx\\Vivado`;
    try {
      const ls = spawnSync(`dir /b "${searchPath}" 2>nul`, [], {
        encoding: 'utf8', timeout: 5000, shell: true, windowsHide: true,
      });
      if (!ls.stdout) {
        // 也试小写
        const ls2 = spawnSync(`dir /b "${drive}\\Xilinx\\vivado" 2>nul`, [], {
          encoding: 'utf8', timeout: 5000, shell: true, windowsHide: true,
        });
        if (ls2.stdout) ls.stdout = ls2.stdout;
      }
      if (!ls.stdout) continue;
      for (const line of ls.stdout.trim().split(/\r?\n/)) {
        const v = line.trim();
        if (/^\d{4}\.\d+$/.test(v)) {
          const absDir = `${drive}\\Xilinx\\Vivado\\${v}`;
          // 确认 bin/vivado.bat 存在
          const check = spawnSync(`if exist "${absDir}\\bin\\vivado.bat" (echo 1) else (echo 0)`, [], {
            encoding: 'utf8', timeout: 3000, shell: true, windowsHide: true,
          });
          if (check.stdout && check.stdout.trim() === '1') {
            results.push({ dir: absDir, version: v });
          }
        }
      }
    } catch { /* next drive */ }
  }
  return results;
}

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
    detectFallback: () => {
      const dirs = findVivadoInstallDirs();
      if (dirs.length > 0) return { version: dirs[0].version, source: 'dir' };
      return null;
    },
  },
  {
    name: 'xelab',
    label: 'Vivado Simulator (xelab)',
    cmd: 'xelab',
    args: ['-version'],
    versionRegex: /xelab\s+([\d.]+)/i,
    detectFallback: () => {
      const dirs = findVivadoInstallDirs();
      if (dirs.length > 0) return { version: dirs[0].version, source: 'dir' };
      return null;
    },
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
    // CLI 检测失败时从安装目录提取版本（通用方案，不限平台）
    detectFallback: () => {
      // 1. 优先走环境变量 XILINX_VIVADO
      const envPath = process.env.XILINX_VIVADO;
      if (envPath) {
        const m = envPath.match(/(\d{4}\.\d+)/);
        if (m) return { version: m[1], source: 'env' };
      }
      // 2. Windows 上扫描标准安装目录
      const dirs = findVivadoInstallDirs();
      if (dirs.length > 0) {
        return { version: dirs.map(d => d.version).join(', '), source: 'dir' };
      }
      return null;
    },
  },
  {
    name: 'xsim',
    label: 'Vivado Simulator (xsim)',
    cmd: 'xsim',
    args: ['--version'],
    versionRegex: /xsim\s+([\d.]+)/i,
    detectFallback: () => {
      const dirs = findVivadoInstallDirs();
      if (dirs.length > 0) return { version: dirs[0].version, source: 'dir' };
      return null;
    },
  },
  {
    name: 'quartus_map',
    label: 'Intel Quartus',
    cmd: 'quartus_map',
    args: ['--version'],
    versionRegex: /Quartus\s+(?:Prime\s+)?Version\s+([\d.]+)/i,
    lintCmd: (file) => ['--lint', '-source', file],
    lintLabel: 'quartus_map --lint',
  },
  {
    name: 'vcs',
    label: 'Synopsys VCS',
    cmd: 'vcs',
    args: ['-ID'],
    versionRegex: /VCS\s+([\d.]+)/i,
    lintCmd: (file) => ['-full64', '-lint', '-sverilog', file],
    lintLabel: 'vcs -lint -sverilog',
  },
  {
    name: 'xrun',
    label: 'Cadence Xcelium',
    cmd: 'xrun',
    args: ['-version'],
    versionRegex: /xrun.*\(v?([\d.]+)\)/i,
    lintCmd: (file) => ['-lmt', '-sv', file],
    lintLabel: 'xrun -lmt -sv',
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

    // 跨平台命令解析（win32 → .bat 回退）
    const effectiveCmd = resolveWin32Cmd(tool.cmd);

    try {
      const r = spawnSync(effectiveCmd, tool.args, {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });

      let version = null;
      let versionRaw = '';
      if (r.status === 0 && r.stdout) {
        versionRaw = r.stdout.slice(0, 200);
        const m = r.stdout.match(tool.versionRegex);
        if (m) version = m[1];
      }
      // 尝试 stderr
      if (!version && r.status === 0 && r.stderr) {
        versionRaw = r.stderr.slice(0, 200);
        const m = r.stderr.match(tool.versionRegex);
        if (m) version = m[1];
      }

      let available = r.status === 0 && !r.error && !r.signal;

      // CLI 检测失败 → 走 fallback（如 Vivado 目录扫描）
      let fallbackResult = null;
      if (!available && tool.detectFallback) {
        fallbackResult = tool.detectFallback();
        if (fallbackResult) {
          available = true;
          version = fallbackResult.version;
          versionRaw = `[${fallbackResult.source || 'fallback'}] ${fallbackResult.version}`;
        }
      }

      // 伴生检测
      let companion = null;
      if (tool.companionCheck && available) {
        companion = tool.companionCheck();
      }

      results.push({
        name: tool.name,
        label: tool.label,
        available,
        version,
        versionRaw,
        lintCmd: tool.lintCmd || null,
        lintLabel: tool.lintLabel || null,
        companion,
      });
    } catch {
      // catch 中也尝试 fallback
      let fallbackResult = null;
      if (tool.detectFallback) {
        fallbackResult = tool.detectFallback();
      }

      results.push({
        name: tool.name,
        label: tool.label,
        available: !!fallbackResult,
        version: fallbackResult ? fallbackResult.version : null,
        versionRaw: fallbackResult ? `[${fallbackResult.source || 'fallback'}] ${fallbackResult.version}` : '',
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
 * 优先级: xvlog (Vivado) > vlog (Questa) > quartus_map (Quartus) > vcs (VCS) > xrun (Xcelium) > verilator > iverilog
 *
 * @param {Array} tools — detect() 的返回值
 * @returns {{ name: string, lintCmd: Function, lintLabel: string } | null}
 */
function pickLintTool(tools) {
  const priority = ['xvlog', 'vlog', 'quartus_map', 'vcs', 'xrun', 'verilator', 'iverilog'];
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
    let ver = t.version ? ` v${t.version}` : '';
    if (t.versionRaw && t.versionRaw.startsWith('[')) {
      ver += ' (' + t.versionRaw.replace(/\[.*?\]\s*/, '').trim() + ')';
    }
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
