#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { discoverManifestPaths } = require('./catalog-gen.cjs');
// 本脚本会**原地重写**它遍历到的每一份 manifest, 其中 7 份落在受治理的 models/**。
// file-protection-guard 是 PreToolUse hook, 只拦 Edit/Write/MultiEdit —— 经 Bash 跑
// 的脚本一律绕过它 (原因见 lib/protected-write.cjs 文件头: 命令文本里往往根本不出现
// 路径, hook 侧扫命令也拦不住)。故受保护路径的判定必须由**写入方自己**做。
const { blockReason } = require('./lib/protected-write.cjs');

function main(argv = process.argv.slice(2)) {
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.resolve(__dirname, '..'));
  const manifests = discoverManifestPaths(root);
  const planned = [];
  for (const file of manifests) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!['1.0', '1.1'].includes(manifest.schema_version)) {
      console.error(`[manifest-migrate] unsupported schema_version in ${path.relative(root, file)}`);
      return 1;
    }
    if (manifest.schema_version === '1.0') planned.push({ file, manifest });
  }
  const blocked = [];
  if (argv.includes('--write')) {
    for (const { file, manifest } of planned) {
      // blockReason 放行时会**就地消费令牌并写审计** —— 故每次实际写入前恰好调一次,
      // 且必须在 writeFileSync 之前 (owner 2026-08-09 裁定: 消费与留痕归库)。
      if (blockReason(file, { tool: 'manifest-migrate' })) {
        blocked.push(path.relative(root, file));
        continue; // 受保护且无令牌 —— 跳过写入, 上面统计的 legacy_v1.0 仍如实报告
      }
      manifest.schema_version = '1.1';
      const versionedSnapshot = manifest.version && path.join(root, 'evidence', manifest.asset_uid, manifest.version, 'SNAPSHOT.json');
      if (versionedSnapshot && fs.existsSync(versionedSnapshot)) manifest.evidence_snapshot_ref = `evidence/${manifest.asset_uid}/${manifest.version}/SNAPSHOT.json`;
      else delete manifest.evidence_snapshot_ref;
      manifest.maintenance = { owner: manifest.owner, review_cadence: 'quarterly', status: 'active' };
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
  }
  console.log(`[manifest-migrate] manifests=${manifests.length} legacy_v1.0=${planned.length} blocked=${blocked.length} action=${argv.includes('--write') ? 'write' : 'check'}`);
  blocked.forEach((item) => console.log(`BLOCKED ${item} — 受保护路径且无有效令牌, 未写入。请按 var/audit/protected-write-approvals.json 的令牌流程申请后重跑, 或用 Edit 工具逐项改 (走 file-protection 门禁并留审计)。`));
  return blocked.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
