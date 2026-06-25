#!/usr/bin/env node
/**
 * engine/scripts/hooks/fpr-calibration-hook.cjs — FPR 校准自动触发 Hook
 *
 * Stop 事件钩子: 在 session 结束时自动调用 fp-rate-tracker auto-record，
 * 记录本次 session 的门禁拦截事件。
 *
 * 退出码: 始终 0 (不阻塞 Stop 事件)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOME = path.join(os.homedir(), '.claude');

function main() {
  const tracker = path.join(HOME, 'engine/scripts/fp-rate-tracker.cjs');

  if (!fs.existsSync(tracker)) {
    console.error('[FPR-Calibration] ⚠️ fp-rate-tracker 不存在');
    process.exit(0);
  }

  const result = spawnSync(process.execPath, [tracker, 'auto-record'], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });

  if (result.status === 0) {
    console.error('[FPR-Calibration] ✅ 自动记录完成');
  } else if (result.stdout) {
    console.error(`[FPR-Calibration] ${result.stdout.trim().split('\n').pop()}`);
  } else {
    console.error(`[FPR-Calibration] ⚠️ auto-record exit=${result.status}`);
  }

  // Stop 钩子永不阻塞
  process.exit(0);
}

main();
