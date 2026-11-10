#!/usr/bin/env node

/**
 * Stop hook: cost-tracker-hook.cjs
 *
 * 从 Stop 事件中估算本轮 token 消耗, 写入 cost_ledger 表。
 * 轻量: 静默失败, 不阻塞 Stop 链。
 */

'use strict';

const fs = require('node:fs');

async function main() {
  try {
    // 从 stdin 读取 (Claude Code Stop hook 通过 stdin 传递响应)
    let input = '';
    try {
      input = fs.readFileSync(0, 'utf8');
    } catch { return; }

    if (!input || input.length < 10) return;

    const sessionId = process.env.CLAUDE_SESSION_ID || `s-${Date.now()}`;

    const { estimate } = require('../../sqlite/store-costs.cjs');
    const { openDb } = require('../../sqlite/index.cjs');

    const wDb = openDb();
    estimate(sessionId, input, { db: wDb.db });
    wDb.close();
  } catch { /* 静默 */ }
}

main();
