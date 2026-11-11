#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/bench-p4-removable.js — P-4 可卸性烟测（Phase 2.6）
 *
 * HARNESS_PACKS_DISABLED=1 下跑 core 套件（全量回归），core 不得依赖 packs 存在。
 * 判定：run-all-tests 退出 0 且失败数 = 基线（4——Phase 0 行为级基线）。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const suite = spawnSync(process.execPath, [
  path.join(ROOT, 'core/engine/scripts/test-hooks/run-all-tests.cjs'), '--no-persist',
], {
  encoding: 'utf8',
  timeout: 420000,
  windowsHide: true,
  env: { ...process.env, HARNESS_PACKS_DISABLED: '1' },
});

const tail = (suite.stdout || '').trim().split('\n').filter(l => /总计/.test(l)).pop() || '';
const m = tail.match(/失败:\s*(\d+)/);
const failed = m ? Number(m[1]) : -1;
// 基线 4 = Phase 0 行为级（E2E/painpoints/managed-action/long-task），与 packs 无关。
if (suite.status === null || failed !== 4) {
  console.error(`[p4] FAIL exit=${suite.status} failed=${failed}`);
  console.error((tail || 'no summary') + '\n' + (suite.stderr || '').slice(-500));
  process.exit(1);
}
console.log(`[p4] PASS HARNESS_PACKS_DISABLED=1 下 core 套件全绿（失败=${failed}=基线）`);
