#!/usr/bin/env node
/**
 * core/engine/scripts/sync-pack-skills.cjs — 把 packs 下各 pack 的 skills/ 同步到 skills/（运行时发现位）。
 *
 * 背景（M4b）：
 *   packs/{fpga,office}/skills/ 是入库的权威源（市场渠道只复制各 pack 自有目录，
 *   engine 驻留 Core）。skills/ 是 Claude Code / skill-evolve / code-graph-index
 *   实际扫描的运行时发现位置。镜像复制到 skills/ 的 pack 技能在 .gitignore 里
 *   登记路径，避免与权威源重复入库。
 *
 *   与 sync-workflow-mirror.cjs 同一契约：**只从 packs 往 skills 单向复制** ——
 *   反向同步会把手工改镜像的错误"修"掉，那正是漂移检查要抓的东西。
 *
 *   注意：镜像只覆盖 pack 自有的 8 个技能目录；skills/ 下其余目录（Core 技能）
 *   归 skills/ 原地所有，本脚本不触碰。
 *
 * 用法：
 *   node core/engine/scripts/sync-pack-skills.cjs           # 同步
 *   node core/engine/scripts/sync-pack-skills.cjs --check   # 只比对，漂移则 exit 1
 *
 * 退出码：
 *   0 — 成功 / 无漂移
 *   1 — --check 发现镜像与权威源不一致
 *   2 — 权威源目录不存在
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const PACKS = ['fpga', 'office'];
/** pack → 该 pack 拥有、允许镜像进 skills/ 的技能目录（防止镜像越权写 Core 技能）。 */
const OWNED = {
  fpga: ['vivado-flow', 'rtl-gen', 'hdl-coding', 'python-hardware-debug', 'xdc-constraint-gen'],
  office: ['doc-gen', 'markitdown-converter', 'pdf', 'presentation'],
};

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
}

/** 递归收集目录内全部文件的相对路径（用于逐字节比对）。 */
function walkRel(dir, base = dir, acc = []) {
  for (const name of listDir(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walkRel(full, base, acc);
    else acc.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return acc.sort();
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const rel of walkRel(from)) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/**
 * 比对每个 pack 技能的权威源与镜像。
 * @returns {{ drift: boolean, reasons: string[] }}
 */
function checkMirror(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const reasons = [];
  for (const pack of PACKS) {
    for (const skill of OWNED[pack]) {
      const source = path.join(root, 'packs', pack, 'skills', skill);
      const mirror = path.join(root, 'skills', skill);
      if (!fs.existsSync(source)) {
        reasons.push(`权威源缺失: packs/${pack}/skills/${skill}`);
        continue;
      }
      if (!fs.existsSync(mirror)) {
        reasons.push(`镜像缺失: skills/${skill} (源 packs/${pack}/skills/${skill})`);
        continue;
      }
      const srcFiles = walkRel(source);
      const mirFiles = walkRel(mirror);
      const missing = srcFiles.filter((f) => !mirFiles.includes(f));
      const extra = mirFiles.filter((f) => !srcFiles.includes(f));
      if (missing.length) reasons.push(`skills/${skill} 缺少: ${missing.join(', ')}`);
      if (extra.length) reasons.push(`skills/${skill} 多出: ${extra.join(', ')}`);
      for (const rel of srcFiles.filter((f) => mirFiles.includes(f))) {
        const a = fs.readFileSync(path.join(source, rel));
        const b = fs.readFileSync(path.join(mirror, rel));
        if (!a.equals(b)) reasons.push(`内容不一致: skills/${skill}/${rel}`);
      }
    }
  }
  return { drift: reasons.length > 0, reasons };
}

/** 按权威源重建镜像；返回本次写入的技能目录。 */
function syncMirror(opts = {}) {
  const root = opts.root || HARNESS_ROOT;
  const written = [];
  for (const pack of PACKS) {
    for (const skill of OWNED[pack]) {
      const source = path.join(root, 'packs', pack, 'skills', skill);
      if (!fs.existsSync(source)) {
        const e = new Error(`权威源目录不存在: ${source}`);
        e.exitCode = 2;
        throw e;
      }
      copyTree(source, path.join(root, 'skills', skill));
      written.push(`${pack}/${skill}`);
    }
  }
  return { written, total: written.length };
}

function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--check')) {
      const result = checkMirror();
      if (result.drift) {
        process.stderr.write(`[sync-pack-skills] ✖ 镜像漂移: ${result.reasons.join('；')}\n`);
        process.stderr.write('[sync-pack-skills]   packs/*/skills/ 是权威源。跑 '
          + 'node core/engine/scripts/sync-pack-skills.cjs 重建镜像\n');
        return 1;
      }
      const total = Object.values(OWNED).reduce((n, list) => n + list.length, 0);
      process.stdout.write(`[sync-pack-skills] ✓ 镜像与 packs 下各 pack 的 skills/ 一致 (${total} 个 pack 技能)\n`);
      return 0;
    }

    const { written, total } = syncMirror();
    process.stdout.write(`[sync-pack-skills] 已同步 ${total} 个 pack 技能到 skills/`
      + ` (${written.join(', ')})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[sync-pack-skills] ${err.message}\n`);
    return err.exitCode || 2;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { PACKS, OWNED, checkMirror, syncMirror };
