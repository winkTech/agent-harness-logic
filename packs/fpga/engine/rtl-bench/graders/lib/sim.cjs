'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureDir } = require('./common.cjs');

// 仿真后端选择：env RTL_BENCH_SIM = modelsim（默认）| iverilog。
// - modelsim: vlib/vlog/vsim（原判卷链，pilot 2026-07-30 口径）；
// - iverilog: iverilog -g2012 编译 + vvp 运行（ModelSim 无 license 环境的替代后端；
//   2026-11-05 在 axis_skid_buffer hidden TB 上验证与 pilot 语义一致）。
// 两者共用 RESULT 判卷契约：
// 返回 { status: 'pass'|'fail'|'compile_error'|'timeout'|'invalid', log }
// - RESULT 取 stdout 最后一次出现的 "RESULT: PASS|FAIL"
// - 无 RESULT 但有 Fatal/$fatal 痕迹 → fail
// - 仿真超时(看门狗都没兜住) → timeout

function parseVerdict(log) {
  let last = null;
  const re = /RESULT:\s*(PASS|FAIL)/g;
  let m;
  while ((m = re.exec(log)) !== null) last = m[1];
  if (last === 'PASS') return 'pass';
  if (last === 'FAIL') return 'fail';
  if (/\*\*\s*Fatal|Fatal error/i.test(log)) return 'fail';
  return 'invalid';
}

function runSimModelSim({ workDir, sources, top, timeoutMs = 180000 }) {
  if (!fs.existsSync(path.join(workDir, 'work'))) {
    const lib = spawnSync('vlib', ['work'], { cwd: workDir, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (lib.status !== 0) {
      return { status: 'invalid', log: `vlib failed:\n${(lib.stdout || '') + (lib.stderr || '')}` };
    }
  }

  const compile = spawnSync('vlog', ['-sv', '-work', 'work', ...sources], {
    cwd: workDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  const compileLog = (compile.stdout || '') + (compile.stderr || '');
  if (compile.status !== 0) return { status: 'compile_error', log: compileLog };

  const sim = spawnSync('vsim', [
    '-c', '-onfinish', 'stop', '-work', 'work', top,
    '-do', 'onerror {quit -code 1 -f}; run -all; quit -f',
  ], { cwd: workDir, encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  const log = compileLog + '\n' + (sim.stdout || '') + (sim.stderr || '');

  if (sim.signal || (sim.error && sim.error.code === 'ETIMEDOUT')) return { status: 'timeout', log };
  const status = parseVerdict(log);
  return { status, log };
}

function runSimIcarus({ workDir, sources, timeoutMs = 180000 }) {
  const image = path.join(workDir, 'sim.vvp');
  const compile = spawnSync('iverilog', ['-g2012', '-o', image, ...sources], {
    cwd: workDir, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  const compileLog = (compile.stdout || '') + (compile.stderr || '');
  if (compile.status !== 0) return { status: 'compile_error', log: compileLog };

  const sim = spawnSync('vvp', [image], {
    cwd: workDir, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
  });
  const log = compileLog + '\n' + (sim.stdout || '') + (sim.stderr || '');

  if (sim.signal || (sim.error && sim.error.code === 'ETIMEDOUT')) return { status: 'timeout', log };
  const status = parseVerdict(log);
  return { status, log };
}

function runSim(opts) {
  ensureDir(opts.workDir);
  const backend = (process.env.RTL_BENCH_SIM || 'modelsim').toLowerCase();
  if (backend === 'iverilog') return runSimIcarus(opts);
  return runSimModelSim(opts);
}

module.exports = { runSim };
