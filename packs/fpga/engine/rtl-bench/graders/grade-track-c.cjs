#!/usr/bin/env node
'use strict';

// Track C 判卷: 功能回归(隐藏 TB,硬门) + QoR 预算(vivado-flow OOC synth)
// 用法: node grade-track-c.cjs --task <taskDir> --rtl <fileOrDir> --out <dir> [--skip-synth]
// 退出码: 0 pass / 1 fail / 2 用法或资产完整性错误

const fs = require('node:fs');
const path = require('node:path');
const { loadTask, verifyLocks, writeJson, argValue, collectRtlSources, ensureDir } = require('./lib/common.cjs');
const { runSim } = require('./lib/sim.cjs');
const { runOocSynth, checkQor } = require('./lib/vivado.cjs');

function main() {
  const args = process.argv.slice(2);
  const taskDir = path.resolve(argValue(args, '--task'));
  const rtlArg = argValue(args, '--rtl');
  const outDir = path.resolve(argValue(args, '--out'));
  const skipSynth = args.includes('--skip-synth');
  if (!taskDir || !rtlArg || !outDir) {
    console.error('Usage: node grade-track-c.cjs --task <taskDir> --rtl <fileOrDir> --out <dir> [--skip-synth]');
    process.exit(2);
  }

  const manifest = loadTask(taskDir);
  const track = manifest.tracks.C;
  const lockErrors = verifyLocks(taskDir, manifest);
  if (lockErrors.length) {
    writeJson(path.join(outDir, 'grade.json'), { task: manifest.id, track: 'C', verdict: 'invalid_assets', lockErrors });
    console.error('RESULT: INVALID (asset locks)\n' + lockErrors.join('\n'));
    process.exit(2);
  }
  if (!Number.isInteger(track.qor.ffMax) && !Number.isInteger(track.qor.lutMax)) {
    console.error('Track C budgets (ffMax/lutMax) not set in task.json — measure baselines first');
    process.exit(2);
  }

  const rtlFiles = collectRtlSources(rtlArg);
  const grade = { task: manifest.id, track: 'C', rtl: rtlFiles, functional: null, qor: null, verdict: 'fail' };

  // 1) 功能回归硬门
  const sim = runSim({
    workDir: path.join(outDir, 'sim'),
    sources: [...rtlFiles, path.join(taskDir, manifest.hiddenTb)],
    top: 'tb_hidden',
  });
  fs.writeFileSync(path.join(outDir, 'sim.log'), sim.log, 'utf8');
  grade.functional = { status: sim.status, pass: sim.status === 'pass' };

  // 2) QoR 预算
  if (grade.functional.pass && !skipSynth) {
    let srcDir;
    if (rtlFiles.length === 1) {
      srcDir = path.join(outDir, 'synth_src');
      ensureDir(srcDir);
      fs.copyFileSync(rtlFiles[0], path.join(srcDir, path.basename(rtlFiles[0])));
    } else {
      srcDir = path.dirname(rtlFiles[0]);
    }
    const synth = runOocSynth({
      rtlDir: srcDir,
      xdcDir: path.join(taskDir, 'xdc'),
      top: manifest.top,
      part: manifest.part,
      outDir: path.join(outDir, 'vivado'),
    });
    fs.writeFileSync(path.join(outDir, 'vivado.log'), synth.log, 'utf8');
    const qor = checkQor(synth.summary, track.qor);
    grade.qor = { exitCode: synth.exitCode, pass: qor.pass, checks: qor.checks, summary: synth.summary && synth.summary.synth };
  }

  grade.verdict = grade.functional.pass && grade.qor && grade.qor.pass ? 'pass' : 'fail';
  writeJson(path.join(outDir, 'grade.json'), grade);
  console.log(`RESULT: ${grade.verdict.toUpperCase()} (functional=${grade.functional.status}, qor=${grade.qor ? (grade.qor.pass ? 'pass' : 'fail') : 'not-run'})`);
  process.exit(grade.verdict === 'pass' ? 0 : 1);
}

main();
