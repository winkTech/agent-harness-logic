#!/usr/bin/env node
'use strict';

// Track B 判卷: agent TB 的变异测试计分
//   - 对参考实现必须 RESULT: PASS(误报直接 fail)
//   - 对每个变异体 RESULT: FAIL 记一次 kill;超时/无 RESULT 不计 kill(TB 契约要求看门狗)
// 用法: node grade-track-b.cjs --task <taskDir> --tb <tbFile> --out <dir>
// 退出码: 0 pass / 1 fail / 2 用法或资产完整性错误

const fs = require('node:fs');
const path = require('node:path');
const { loadTask, verifyLocks, writeJson, argValue } = require('./lib/common.cjs');
const { runSim } = require('./lib/sim.cjs');

function main() {
  const args = process.argv.slice(2);
  const taskDir = path.resolve(argValue(args, '--task'));
  const tbFile = argValue(args, '--tb');
  const outDir = path.resolve(argValue(args, '--out'));
  if (!taskDir || !tbFile || !outDir) {
    console.error('Usage: node grade-track-b.cjs --task <taskDir> --tb <tbFile> --out <dir>');
    process.exit(2);
  }

  const manifest = loadTask(taskDir);
  const track = manifest.tracks.B;
  const lockErrors = verifyLocks(taskDir, manifest);
  if (lockErrors.length) {
    writeJson(path.join(outDir, 'grade.json'), { task: manifest.id, track: 'B', verdict: 'invalid_assets', lockErrors });
    console.error('RESULT: INVALID (asset locks)\n' + lockErrors.join('\n'));
    process.exit(2);
  }

  const tb = path.resolve(tbFile);
  const refRtl = path.join(taskDir, 'ref', `${manifest.top}.sv`);
  const mutantsDir = path.join(taskDir, track.mutantsDir);
  const mutants = fs.readdirSync(mutantsDir).filter((f) => /\.(sv|v)$/i.test(f)).sort();

  const grade = {
    task: manifest.id, track: 'B', tb,
    ref: null, mutants: [], score: 0, scoreMin: track.scoreMin, verdict: 'fail',
  };

  // 1) 对参考实现: 必须 PASS(否则误报,直接 fail,不再跑变异体)
  const refSim = runSim({ workDir: path.join(outDir, 'sim_ref'), sources: [refRtl, tb], top: track.tbTop });
  fs.writeFileSync(path.join(outDir, 'sim_ref.log'), refSim.log, 'utf8');
  grade.ref = { status: refSim.status, pass: refSim.status === 'pass' };

  if (grade.ref.pass) {
    // 2) 变异体逐一计 kill
    for (const m of mutants) {
      const name = path.basename(m, path.extname(m));
      const r = runSim({ workDir: path.join(outDir, `sim_${name}`), sources: [path.join(mutantsDir, m), tb], top: track.tbTop });
      fs.writeFileSync(path.join(outDir, `sim_${name}.log`), r.log, 'utf8');
      grade.mutants.push({ mutant: name, status: r.status, killed: r.status === 'fail' });
    }
    const kills = grade.mutants.filter((x) => x.killed).length;
    grade.score = mutants.length ? kills / mutants.length : 0;
    grade.verdict = grade.score >= track.scoreMin ? 'pass' : 'fail';
  }

  writeJson(path.join(outDir, 'grade.json'), grade);
  const kills = grade.mutants.filter((x) => x.killed).length;
  console.log(`RESULT: ${grade.verdict.toUpperCase()} (ref=${grade.ref.status}, kills=${kills}/${grade.mutants.length}, score=${grade.score.toFixed(2)}, min=${track.scoreMin})`);
  process.exit(grade.verdict === 'pass' ? 0 : 1);
}

main();
