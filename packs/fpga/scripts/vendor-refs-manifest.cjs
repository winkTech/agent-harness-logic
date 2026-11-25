#!/usr/bin/env node
'use strict';

/**
 * packs/fpga/scripts/vendor-refs-manifest.cjs — 第三方 Vendor 参考资产审计与外置工具（M5）
 *
 * 用于治理 packs/fpga/references/vendor/ 的体量与 Windows MAX_PATH(260) 风险：
 *   --audit               统计文件数、体积、超长路径（>= 180 / >= 260 字符）与顶级目录占用
 *   --generate-manifest   生成带 SHA-256 校验的 vendor 资产清单（默认写至指定 --out）
 *   --verify <manifest>   按清单校验本地 vendor 资产完整性
 *
 * 严格非破坏：从不自动删除本地 vendor 文件；完成外部 Release/镜像托管后由维护者决定是否剥离跟踪。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VENDOR_DIR = path.join(REPO_ROOT, 'packs', 'fpga', 'references', 'vendor');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function walkFiles(dir, base = dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, acc);
    else if (entry.isFile()) {
      const st = fs.statSync(full);
      acc.push({
        rel: path.relative(base, full).replace(/\\/g, '/'),
        repoRel: path.relative(REPO_ROOT, full).replace(/\\/g, '/'),
        bytes: st.size,
      });
    }
  }
  return acc;
}

function auditVendor(vendorDir = VENDOR_DIR) {
  const files = walkFiles(vendorDir, vendorDir);
  let totalBytes = 0;
  let maxRepoRelLen = 0;
  let longestPath = '';
  const over180 = [];
  const over240 = [];
  const byGroup = new Map();

  for (const f of files) {
    totalBytes += f.bytes;
    const len = f.repoRel.length;
    if (len > maxRepoRelLen) {
      maxRepoRelLen = len;
      longestPath = f.repoRel;
    }
    if (len >= 180) over180.push({ path: f.repoRel, length: len });
    if (len >= 240) over240.push({ path: f.repoRel, length: len });
    const group = f.rel.split('/')[0] || '(root)';
    const slot = byGroup.get(group) || { group, files: 0, bytes: 0 };
    slot.files += 1;
    slot.bytes += f.bytes;
    byGroup.set(group, slot);
  }

  return {
    vendorDir: vendorDir.replace(/\\/g, '/'),
    exists: fs.existsSync(vendorDir),
    fileCount: files.length,
    totalBytes,
    totalMB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    maxRepoRelLen,
    longestPath,
    pathsOver180: over180.length,
    pathsOver240: over240.length,
    groups: [...byGroup.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .map((g) => ({ ...g, mb: Number((g.bytes / (1024 * 1024)).toFixed(2)) })),
  };
}

function generateManifest(vendorDir = VENDOR_DIR) {
  const files = walkFiles(vendorDir, vendorDir).sort((a, b) => a.rel.localeCompare(b.rel));
  const entries = files.map((f) => ({
    path: f.rel,
    bytes: f.bytes,
    sha256: sha256File(path.join(vendorDir, f.rel)),
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    files: entries,
  };
}

function verifyManifest(manifest, vendorDir = VENDOR_DIR) {
  const missing = [];
  const mismatched = [];
  for (const entry of manifest.files || []) {
    const full = path.join(vendorDir, entry.path);
    if (!fs.existsSync(full)) {
      missing.push(entry.path);
      continue;
    }
    const actual = sha256File(full);
    if (actual !== entry.sha256) mismatched.push(entry.path);
  }
  return { ok: missing.length === 0 && mismatched.length === 0, checked: (manifest.files || []).length, missing, mismatched };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--generate-manifest')) {
    const outIdx = args.indexOf('--out');
    const manifest = generateManifest();
    if (outIdx >= 0 && args[outIdx + 1]) {
      const target = path.resolve(args[outIdx + 1]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      console.log(JSON.stringify({ written: target, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes }, null, 2));
    } else {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    return;
  }
  const verifyIdx = args.indexOf('--verify');
  if (verifyIdx >= 0 && args[verifyIdx + 1]) {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(args[verifyIdx + 1]), 'utf8'));
    const res = verifyManifest(manifest);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
    return;
  }
  console.log(JSON.stringify(auditVendor(), null, 2));
}

if (require.main === module) main();

module.exports = { auditVendor, generateManifest, verifyManifest };
