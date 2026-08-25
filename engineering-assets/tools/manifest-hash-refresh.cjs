#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { discoverManifestPaths } = require('./catalog-gen.cjs');

// 受保护路径判定见 lib/protected-write.cjs —— 该判定被多个经 Bash 运行、会写
// models/** 的工具共用, 抽成库以免各写一份后漂移(改了一处忘另一处, 洞就从没改的
// 那处漏)。本脚本的 --write 会改写全库每一份 manifest, 含受治理的 golden 模型。
const { blockReason } = require('./lib/protected-write.cjs');

const TEXT_EXTENSIONS = new Set(['.cjs', '.do', '.hex', '.json', '.m', '.md', '.py', '.sdc', '.sv', '.svh', '.tcl', '.txt', '.v', '.vh', '.xdc']);
function canonicalBytes(file) {
  const bytes = fs.readFileSync(file);
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : bytes;
}
function hash(file) { return crypto.createHash('sha256').update(canonicalBytes(file)).digest('hex'); }
function scan(root) {
  const changes = []; const missing = []; const blocked = [];
  const writing = process.argv.includes('--write');
  for (const manifestPath of discoverManifestPaths(root)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let changed = false;
    for (const source of manifest.sources || []) {
      const sourcePath = path.join(path.dirname(manifestPath), source.path);
      if (!fs.existsSync(sourcePath)) { missing.push({ manifest: path.relative(root, manifestPath), path: source.path }); continue; }
      const next = hash(sourcePath);
      if (source.sha256 !== next) { changes.push({ manifest: path.relative(root, manifestPath), path: source.path, old: source.sha256, next }); source.sha256 = next; changed = true; }
    }
    if (!changed || !writing) continue;
    // blockReason 放行时会**就地消费令牌并写审计** (owner 2026-08-09 裁定: 消费与
    // 留痕归库, 不推给 hook —— hook 在 Bash 路径上根本不运行)。故每次实际写入前
    // 恰好调一次, 且必须在 writeFileSync 之前。
    const why = blockReason(manifestPath, { tool: 'manifest-hash-refresh' });
    if (why) {
      blocked.push(path.relative(root, manifestPath));
      continue; // 受保护且无令牌 —— 跳过写入, 上面记下的 changes 仍如实报告
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { changes, missing, blocked };
}
function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--root'); const root = path.resolve(index >= 0 ? argv[index + 1] : path.resolve(__dirname, '..'));
  try {
    const result = scan(root);
    console.log(`[manifest-hash-refresh] mismatches=${result.changes.length} missing=${result.missing.length} blocked=${result.blocked.length} action=${argv.includes('--write') ? 'write' : 'check'}`);
    result.missing.forEach((item) => console.log(`MISSING ${item.manifest}:${item.path}`));
    result.blocked.forEach((item) => console.log(`BLOCKED ${item} — 受保护路径且无有效令牌, 未写入。请按 var/audit/protected-write-approvals.json 的令牌流程申请后重跑, 或用 Edit 工具逐项改 (走 file-protection 门禁并留审计)。`));
    if (result.blocked.length) return 1;
    if (!argv.includes('--write') && result.changes.length) return 1;
    return 0;
  } catch (error) { console.error(`[manifest-hash-refresh] ${error.message}`); return 2; }
}
if (require.main === module) process.exitCode = main();
module.exports = { canonicalBytes, hash, main, scan };
