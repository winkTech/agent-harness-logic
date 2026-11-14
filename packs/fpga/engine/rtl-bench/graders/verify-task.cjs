#!/usr/bin/env node
'use strict';

// 任务资产自检(入库/改动后必跑): 判卷链的地基证据
//   1. ref 必须通过隐藏 TB
//   2. 每个变异体必须被隐藏 TB 判 FAIL(kill 8/8)
//   3. seed(若存在)必须通过隐藏 TB(Track C 功能回归的前提)
//   4. ref 必须通过 public TB(agent 自测面不误伤)
// 用法: node verify-task.cjs --task <taskDir> --out <dir>
// 退出码: 0 全部通过 / 1 任一失败

const fs = require('node:fs');
const path = require('node:path');
const { loadTask, writeJson, argValue } = require('./lib/common.cjs');
const { runSim } = require('./lib/sim.cjs');

function main() {
  const args = process.argv.slice(2);
  const taskDir = path.resolve(argValue(args, '--task'));
  const outDir = path.resolve(argValue(args, '--out'));
  if (!taskDir || !outDir) {
    console.error('Usage: node verify-task.cjs --task <taskDir> --out <dir>');
    process.exit(2);
  }

  const manifest = loadTask(taskDir);
  const hiddenTb = path.join(taskDir, manifest.hiddenTb);
  const refRtl = path.join(taskDir, 'ref', `${manifest.top}.sv`);
  const results = [];
  const record = (name, expect, sim) => {
    const ok = sim.status === expect;
    results.push({ name, expect, actual: sim.status, ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: expect=${expect} actual=${sim.status}`);
    fs.writeFileSync(path.join(outDir, `${name}.log`), sim.log, 'utf8');
  };
  fs.mkdirSync(outDir, { recursive: true });

  // 1. ref × 隐藏 TB
  record('ref_hidden', 'pass',
    runSim({ workDir: path.join(outDir, 'ref_hidden'), sources: [refRtl, hiddenTb], top: 'tb_hidden' }));

  // 2. 变异体 × 隐藏 TB
  const mutantsDir = path.join(taskDir, 'hidden', 'mutants');
  if (fs.existsSync(mutantsDir)) {
    for (const m of fs.readdirSync(mutantsDir).filter((f) => /\.(sv|v)$/i.test(f)).sort()) {
      const name = path.basename(m, path.extname(m));
      record(`mutant_${name}`, 'fail',
        runSim({ workDir: path.join(outDir, `mut_${name}`), sources: [path.join(mutantsDir, m), hiddenTb], top: 'tb_hidden' }));
    }
  }

  // 3. seed × 隐藏 TB
  const seedRtl = path.join(taskDir, 'seed', `${manifest.top}.sv`);
  if (fs.existsSync(seedRtl)) {
    record('seed_hidden', 'pass',
      runSim({ workDir: path.join(outDir, 'seed_hidden'), sources: [seedRtl, hiddenTb], top: 'tb_hidden' }));
  }

  // 4. ref × public TB
  const pubDir = path.join(taskDir, 'public');
  if (fs.existsSync(pubDir)) {
    for (const t of fs.readdirSync(pubDir).filter((f) => /^tb_.*\.(sv|v)$/i.test(f))) {
      const top = path.basename(t, path.extname(t));
      record(`ref_${top}`, 'pass',
        runSim({ workDir: path.join(outDir, `ref_${top}`), sources: [refRtl, path.join(pubDir, t)], top }));
    }
  }

  const allOk = results.every((r) => r.ok);
  writeJson(path.join(outDir, 'verify-task.json'), { task: manifest.id, allOk, results });
  console.log(allOk ? 'VERIFY: PASS' : 'VERIFY: FAIL');
  process.exit(allOk ? 0 : 1);
}

main();
