#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/bench-h5-telemetry.js — H-5 遥测 spool bench（Phase 2.5）
 *
 * 验收三条：100 合成事件损失 0 / 水位推进 / 心跳闭合。
 * 全程临时目录 + 临时 DB，不碰真实 var/ 与 memory.db。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'h5-bench-'));

function fail(msg) {
  console.error(`[h5] FAIL ${msg}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

try {
  const spoolDir = path.join(TMP, 'spool');
  const dbPath = path.join(TMP, 'h5.db');

  // 1) 100 合成事件写 spool（子进程模拟 hook 入口热路径）
  const writeScript = `
    const { appendToSpool } = require(${JSON.stringify(path.join(ROOT, 'core/engine/scripts/io/telemetry-spool.cjs'))});
    process.env.HARNESS_TELEMETRY_SPOOL_DIR = ${JSON.stringify(spoolDir)};
    for (let i = 0; i < 100; i += 1) {
      const r = appendToSpool({ type: 'h5_bench', sessionId: 'h5-' + i, payload: { i } });
      if (!r.wrote) { console.error('write failed at ' + i); process.exit(1); }
    }
  `;
  const w = spawnSync(process.execPath, ['-e', writeScript], { encoding: 'utf8', timeout: 60000 });
  if (w.status !== 0) fail(`writer 子进程 exit=${w.status}: ${w.stderr}`);

  // 2) drain 搬运（子进程走 CLI 壳路径）
  const d = spawnSync(process.execPath, [
    path.join(ROOT, 'core/engine/scripts/telemetry-spool-drain.cjs'),
  ], {
    encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env,
      HARNESS_TELEMETRY_SPOOL_DIR: spoolDir,
      HARNESS_SQLITE_PATH: dbPath,
    },
  });
  if (d.status !== 0) fail(`drain exit=${d.status}: ${d.stderr}`);
  const drain = JSON.parse(d.stdout.trim().split('\n').pop());
  if (drain.moved !== 100 || drain.dropped !== 0) {
    fail(`损失非零: moved=${drain.moved} dropped=${drain.dropped}`);
  }
  if (drain.heartbeat !== 'completed') fail(`心跳未闭合: ${drain.heartbeat}`);

  // 3) 库内核验：水位推进 + 事件全量 + heartbeat 表闭合
  const verifyScript = `
    const { openDb } = require(${JSON.stringify(path.join(ROOT, 'core/engine/sqlite/index.cjs'))});
    process.env.HARNESS_SQLITE_PATH = ${JSON.stringify(dbPath)};
    const h = openDb({});
    const count = h.db.prepare('SELECT COUNT(*) c FROM runtime_events').get().c;
    const hb = h.db.prepare("SELECT consumer, status, processed_count FROM runtime_consumer_heartbeats WHERE consumer='telemetry-spool-drain'").get();
    h.close();
    console.log(JSON.stringify({ count, hb }));
  `;
  const v = spawnSync(process.execPath, ['-e', verifyScript], { encoding: 'utf8', timeout: 60000 });
  if (v.status !== 0) fail(`verify exit=${v.status}: ${v.stderr}`);
  const { count, hb } = JSON.parse(v.stdout.trim().split('\n').pop());
  if (count !== 100) fail(`库内事件数 ${count} !== 100`);
  if (!hb || hb.status !== 'success' || hb.processed_count !== 100) {
    fail(`心跳闭合异常: ${JSON.stringify(hb)}`);
  }
  if (typeof drain.watermark !== 'number' || drain.watermark <= 0) {
    fail(`水位未推进: ${drain.watermark}`);
  }

  console.log(`[h5] PASS 100 事件损失 0 | 水位 ${drain.watermark} | 心跳 success(100)`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
