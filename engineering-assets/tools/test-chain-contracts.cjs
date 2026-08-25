#!/usr/bin/env node
'use strict';
/**
 * test-chain-contracts.cjs — 把 integration/contracts/ 下的**跨包判据**接进门禁。
 *
 * 为什么需要它: 库里每个包的 TB 与自己的 RTL 用同一套约定互相印证, 两边一起错也照样
 * 全绿。2026-08-09 实测抓到两例: TX 与 RX 对导频值的约定相反 (负号 +21 vs +7), 以及
 * RX 完全不施加逐符号极性 —— 两件已认证资产串起来 CPE 估计直接失效, 而它们各自
 * 22 门全过。跨包判据就是补这个盲区的, 但它得真的被跑到才算数。
 *
 * MATLAB 缺席时**显式 SKIP 并计数**, 不当成通过: run-all-tests 的 childSkipNotice
 * 认 "N skipped" 与 SKIP 行, 会把跳过冒泡到门禁输出。静默通过等于把"没验"记成"验过了"。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EA = path.resolve(__dirname, '..');
const CONTRACT_DIR = path.join(EA, 'integration', 'contracts');

// 判据清单: 每条是一个返回 logical 的 MATLAB 函数, 失败即抛错
const CONTRACTS = [
  { name: 'chain_pilot_contract', why: 'TX->RX 导频约定 (值 + 逐符号极性) 的实跑 CPE 恢复' },
];

function matlabAvailable() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['matlab'],
    { encoding: 'utf8', windowsHide: true });
  return probe.status === 0 && String(probe.stdout || '').trim().length > 0;
}

let passed = 0;
let failed = 0;
let skipped = 0;

if (!fs.existsSync(CONTRACT_DIR)) {
  console.log(`SKIP 无 integration/contracts/ 目录`);
  skipped = CONTRACTS.length;
} else if (!matlabAvailable()) {
  for (const c of CONTRACTS) {
    console.log(`SKIP ${c.name} — 环境无 matlab, 跨包判据未执行`);
    console.log(`     ${c.why}`);
    skipped += 1;
  }
} else {
  for (const c of CONTRACTS) {
    const file = path.join(CONTRACT_DIR, `${c.name}.m`);
    if (!fs.existsSync(file)) {
      console.log(`FAIL ${c.name} — 清单里有但文件不存在: ${file}`);
      failed += 1;
      continue;
    }
    const r = spawnSync('matlab', ['-batch',
      `addpath('${CONTRACT_DIR.replace(/\\/g, '/')}'); ${c.name}`],
    { encoding: 'utf8', timeout: 900000, windowsHide: true });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const ok = r.status === 0 && /RESULT:\s*PASS/.test(out);
    if (ok) {
      console.log(`PASS ${c.name}`);
      passed += 1;
    } else {
      console.log(`FAIL ${c.name} — exit=${r.status}`);
      for (const line of out.split(/\r?\n/).filter((l) => /FAIL|误差|RESULT/.test(l)).slice(0, 12)) {
        console.log(`     ${line.trim()}`);
      }
      failed += 1;
    }
  }
}

console.log(`\nchain-contracts: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exitCode = failed > 0 ? 1 : 0;
