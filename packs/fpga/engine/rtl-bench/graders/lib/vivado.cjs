'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureDir } = require('./common.cjs');

const HOME = path.resolve(__dirname, '..', '..', '..', '..');
const FLOW_TCL = path.join(HOME, 'skills', 'vivado-flow', 'scripts', 'vivado_flow.tcl');

// vivado-flow OOC synth,判定读 <outDir>/rpt/flow_summary.json(不碰 .rpt)
// 返回 { ran, exitCode, summary|null, log }
function runOocSynth({ rtlDir, xdcDir, top, part, outDir, timeoutMs = 1500000 }) {
  ensureDir(outDir);
  const args = [
    '-mode', 'batch', '-nojournal', '-nolog',
    '-source', FLOW_TCL,
    '-tclargs',
    '-top', top, '-part', part,
    '-src', rtlDir, '-xdc', xdcDir, '-out', outDir,
    '-mode', 'ooc', '-to', 'synth',
  ];
  const r = spawnSync('vivado', args, {
    encoding: 'utf8', windowsHide: true, shell: true, timeout: timeoutMs,
    cwd: outDir,
  });
  const log = (r.stdout || '') + (r.stderr || '');
  const summaryPath = path.join(outDir, 'rpt', 'flow_summary.json');
  let summary = null;
  if (fs.existsSync(summaryPath)) {
    try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch { summary = null; }
  }
  return { ran: !r.error, exitCode: r.status, summary, log };
}

// QoR 判定: flow_summary.synth 对照预算。返回 { pass, checks: [...] }
function checkQor(summary, qor) {
  const checks = [];
  const push = (name, pass, actual, limit) => checks.push({ name, pass, actual, limit });
  if (!summary || !summary.synth) {
    return { pass: false, checks: [{ name: 'flow_summary', pass: false, actual: 'missing', limit: 'required' }] };
  }
  const s = summary.synth;
  push('flow_ok', summary.ok === true, summary.ok, true);
  if (typeof qor.wnsMin === 'number') push('wns', typeof s.wns === 'number' && s.wns >= qor.wnsMin, s.wns, `>= ${qor.wnsMin}`);
  if (Number.isInteger(qor.ffMax))   push('ff',   s.ff   <= qor.ffMax,   s.ff,   `<= ${qor.ffMax}`);
  if (Number.isInteger(qor.lutMax))  push('lut',  s.lut  <= qor.lutMax,  s.lut,  `<= ${qor.lutMax}`);
  if (Number.isInteger(qor.bramMax)) push('bram', s.bram <= qor.bramMax, s.bram, `<= ${qor.bramMax}`);
  if (Number.isInteger(qor.dspMax))  push('dsp',  s.dsp  <= qor.dspMax,  s.dsp,  `<= ${qor.dspMax}`);
  // 推断核查下限: 该用宏没用上 = 推断静默失败(UG949 Know What You Infer)
  if (Number.isInteger(qor.dspMin))  push('dsp_inferred',  s.dsp  >= qor.dspMin,  s.dsp,  `>= ${qor.dspMin}`);
  if (Number.isInteger(qor.bramMin)) push('bram_inferred', s.bram >= qor.bramMin, s.bram, `>= ${qor.bramMin}`);
  if (Number.isInteger(qor.srlMin))  push('srl_inferred',  s.srl  >= qor.srlMin,  s.srl,  `>= ${qor.srlMin}`);
  return { pass: checks.every((c) => c.pass), checks };
}

module.exports = { runOocSynth, checkQor };
