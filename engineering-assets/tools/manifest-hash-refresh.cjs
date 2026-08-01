#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { discoverManifestPaths } = require('./catalog-gen.cjs');

// ── 受保护路径 ─────────────────────────────────────────────────────────────
// file-protection-guard 是 PreToolUse hook, 只拦 Edit/Write/MultiEdit/NotebookEdit
// 这类带 file_path 的工具调用。本脚本经 Bash 运行, 且 --write 会改写**全库每一份**
// manifest —— 其中就包括 engineering-assets/models/** 下受治理的 golden 模型。
// 2026-08-02 实测: 一次 --write 静默改掉了 models/comm/ldpc/manifest.json 的 8 处
// sha256, 既没有一次性令牌, 也没有在 var/audit/protected-writes.jsonl 留痕。
//
// 命令文本里根本不出现路径(只有 `--write`), 所以 hook 侧做命令扫描也拦不住;
// 唯一可靠的位置是写入方本身。故此处自行判定, 无令牌就跳过并如实报告。
const PROTECTED_PATTERNS = [
  /(^|\/)matlab\//i,
  /(^|\/)07_mat\//i,
  /(^|\/)golden_model[^/]*\//i,
  /(^|\/)engineering-assets\/models\//i,
];
const APPROVAL_FILE = path.join(__dirname, '..', '..', 'var', 'audit', 'protected-write-approvals.json');

function isProtected(manifestPath) {
  const normalized = manifestPath.replace(/\\/g, '/');
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 只读地看是否存在覆盖该路径的有效令牌; 不消费 —— 消费是 hook 的职责。 */
function hasApproval(manifestPath) {
  let list;
  try { list = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8')); }
  catch { return false; }
  if (!Array.isArray(list)) return false;
  const normalized = manifestPath.replace(/\\/g, '/');
  const now = Date.now();
  return list.some((token) => {
    if (!(new Date(token?.expiresAt || 0).getTime() > now)) return false;
    if (typeof token.path === 'string') {
      const target = token.path.replace(/\\/g, '/');
      return normalized === target || (target.includes('/') && normalized.endsWith(`/${target}`));
    }
    if (typeof token.scope === 'string') {
      const scope = token.scope.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (!scope.includes('/')) return false;
      const lower = normalized.toLowerCase();
      return lower.startsWith(`${scope}/`) || lower.includes(`/${scope}/`);
    }
    return false;
  });
}

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
    if (isProtected(manifestPath) && !hasApproval(manifestPath)) {
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
