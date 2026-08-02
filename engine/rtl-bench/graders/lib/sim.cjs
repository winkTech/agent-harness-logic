'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureDir } = require('./common.cjs');

// ModelSim 编译 + 批处理仿真,解析 RESULT 判卷契约。
// 返回 { status: 'pass'|'fail'|'compile_error'|'timeout'|'invalid', log }
// - RESULT 取 stdout 最后一次出现的 "RESULT: PASS|FAIL"
// - 无 RESULT 但有 Fatal/$fatal 痕迹 → fail
// - 仿真超时(看门狗都没兜住) → timeout
function runSim({ workDir, sources, top, timeoutMs = 180000 }) {
  ensureDir(workDir);

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

  let last = null;
  const re = /RESULT:\s*(PASS|FAIL)/g;
  let m;
  while ((m = re.exec(log)) !== null) last = m[1];
  if (last === 'PASS') return { status: 'pass', log };
  if (last === 'FAIL') return { status: 'fail', log };
  if (/\*\*\s*Fatal|Fatal error/i.test(log)) return { status: 'fail', log };
  return { status: 'invalid', log };
}

module.exports = { runSim };
