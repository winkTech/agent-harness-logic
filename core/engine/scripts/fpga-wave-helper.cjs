#!/usr/bin/env node
/**
 * engine/scripts/fpga-wave-helper.cjs — 波形辅助工具。
 *
 * 在仿真失败时自动 dump VCD/FSDB 波形。
 * 自动检测仿真器并生成对应的波形 dump 命令。
 *
 * 用法:
 *   node fpga-wave-helper.cjs dump [dump_dir]        # dump 波形
 *   node fpga-wave-helper.cjs detect                  # 检测仿真器
 *   node fpga-wave-helper.cjs check <wave_file>       # 检查波形文件
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const eda = require('./eda-detect.cjs');
const { parseCommandLine } = require('./lib/hook-registry.cjs');

// ── 仿真器检测 (使用统一 eda-detect 结果) ──────────────────────────────────

const SIMULATOR_MAP = {
  xsim:       { label: 'Vivado Simulator',       dumpCmd: (dir) => `xsim --dump_all ${path.join(dir, 'dump.vcd')}` },
  vsim:       { label: 'Questa/ModelSim',        dumpCmd: (dir) => `vsim -wlf ${path.join(dir, 'dump.wlf')}` },
  iverilog:   { label: 'Icarus Verilog',         dumpCmd: (dir) => `vvp -n -l ${path.join(dir, 'dump.vcd')}` },
  verilator:  { label: 'Verilator',              dumpCmd: (dir) => undefined },
  xrun:       { label: 'Cadence Xcelium',        dumpCmd: (dir) => `xrun -input "${dir}/dump.tcl"` },
  vcs:        { label: 'Synopsys VCS',           dumpCmd: (dir) => undefined },
};

function detectSimulator() {
  const tools = eda.detect();
  for (const name of Object.keys(SIMULATOR_MAP)) {
    const tool = tools.find(t => t.name === name && t.available);
    if (tool) {
      return { cmd: name, label: SIMULATOR_MAP[name].label, dumpCmd: SIMULATOR_MAP[name].dumpCmd, available: true };
    }
  }
  return { cmd: null, label: '未检测到仿真器', available: false };
}

// ── 波形 Dump ───────────────────────────────────────────────────────────────

function dumpWaveforms(dumpDir) {
  const sim = detectSimulator();
  if (!sim.available) {
    console.error('未检测到仿真器');
    return { ok: false, error: '无仿真器' };
  }

  const dir = dumpDir || process.cwd();
  fs.mkdirSync(dir, { recursive: true });

  console.log(`使用仿真器: ${sim.label}`);
  const cmd = sim.dumpCmd(dir);

  if (!cmd) {
    console.log(`${sim.label} 需要 testbench 中手动添加 $dumpvars。`);
    return { ok: false, error: '需手动添加 dump' };
  }

  console.log(`执行: ${cmd}`);
  const parts = parseCommandLine(cmd);
  const result = spawnSync(parts[0], parts.slice(1), {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });

  if (result.status === 0) {
    // 查找生成的波形文件
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.vcd') || f.endsWith('.wlf') || f.endsWith('.fsdb'));
    console.log(`波形已生成: ${files.join(', ') || '(可能在不同目录)'}`);
    return { ok: true, files };
  }

  return { ok: false, error: result.stderr?.slice(0, 200) || 'dump 失败' };
}

// ── 波形检查 ────────────────────────────────────────────────────────────────

function checkWaveFile(wavePath) {
  if (!fs.existsSync(wavePath)) {
    return { ok: false, error: '文件不存在' };
  }

  const stat = fs.statSync(wavePath);
  const ext = path.extname(wavePath).toLowerCase();

  const info = {
    file: wavePath,
    size: stat.size,
    ext,
    format: ext === '.vcd' ? 'VCD' : ext === '.wlf' ? 'WLF (Questa)' : ext === '.fsdb' ? 'FSDB' : '未知',
    description: ext === '.vcd' ? '标准 VCD，可用 gtkwave 打开' :
                 ext === '.wlf' ? 'Questa WLF，可用 vsim -view 打开' :
                 ext === '.fsdb' ? 'Synopsys FSDB，可用 verdi 打开' : '未知格式',
  };

  return { ok: true, ...info };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'detect': {
      const sim = detectSimulator();
      console.log(`${sim.available ? '✅' : '❌'} ${sim.label}`);
      break;
    }
    case 'dump': {
      const result = dumpWaveforms(args[1]);
      console.log(result.ok ? '✅ 波形 dump 完成' : `❌ ${result.error}`);
      break;
    }
    case 'check': {
      if (!args[1]) { console.log('用法: node fpga-wave-helper.cjs check <wave_file>'); process.exit(1); }
      const result = checkWaveFile(args[1]);
      if (result.ok) console.log(`✅ ${result.format}: ${result.file} (${(result.size / 1024).toFixed(1)}KB) — ${result.description}`);
      else console.log(`❌ ${result.error}`);
      break;
    }
    default:
      console.log('用法:');
      console.log('  node fpga-wave-helper.cjs detect       — 检测仿真器');
      console.log('  node fpga-wave-helper.cjs dump [dir]   — dump 波形');
      console.log('  node fpga-wave-helper.cjs check <file> — 检查波形文件');
  }
}

if (require.main === module) { main(); }

module.exports = { detectSimulator, dumpWaveforms, checkWaveFile };
