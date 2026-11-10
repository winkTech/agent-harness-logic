#!/usr/bin/env node
/**
 * engine/scripts/sync-workflow-mirror.cjs — 把 workflows/ 同步到 .claude/workflows/。
 *
 * 背景：
 *   workflows/ 是入库的权威源；.claude/workflows/ 是 Claude Code 实际读取的位置，
 *   而整个 .claude/ 在 .gitignore 里。于是全新 checkout（含 CI）没有镜像目录，
 *   workflow-contracts 的 "root and platform workflow directories do not drift"
 *   会直接 ENOENT。
 *
 *   本脚本按权威源重建镜像。**只从 workflows/ 往 .claude/workflows/ 单向复制** ——
 *   反向同步会让手工改镜像的错误被"修复"掉，那正是漂移检查要抓的东西。
 *
 * 用法：
 *   node engine/scripts/sync-workflow-mirror.cjs           # 同步
 *   node engine/scripts/sync-workflow-mirror.cjs --check   # 只比对，漂移则 exit 1
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

const SOURCE_RELATIVE = 'workflows';
const MIRROR_RELATIVE = path.join('.claude', 'workflows');

function jsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort();
}

function paths(root = HARNESS_ROOT) {
  return {
    source: path.join(root, SOURCE_RELATIVE),
    mirror: path.join(root, MIRROR_RELATIVE),
  };
}

/**
 * 比对权威源与镜像。
 * @returns {{ drift: boolean, reasons: string[], mirrorExists: boolean, names: string[] }}
 */
function checkMirror(opts = {}) {
  const { source, mirror } = paths(opts.root || HARNESS_ROOT);
  if (!fs.existsSync(source)) {
    const e = new Error(`workflow 权威源目录不存在: ${source}`);
    e.exitCode = 2;
    throw e;
  }

  const names = jsFiles(source);
  const mirrorExists = fs.existsSync(mirror);
  if (!mirrorExists) {
    return { drift: true, reasons: [`镜像目录不存在: ${mirror}`], mirrorExists: false, names };
  }

  const mirrorNames = jsFiles(mirror);
  const reasons = [];
  const missing = names.filter((n) => !mirrorNames.includes(n));
  const extra = mirrorNames.filter((n) => !names.includes(n));
  if (missing.length) reasons.push(`镜像缺少: ${missing.join(', ')}`);
  if (extra.length) reasons.push(`镜像多出: ${extra.join(', ')}`);

  for (const name of names.filter((n) => mirrorNames.includes(n))) {
    const a = fs.readFileSync(path.join(source, name));
    const b = fs.readFileSync(path.join(mirror, name));
    if (!a.equals(b)) reasons.push(`内容不一致: ${name}`);
  }

  return { drift: reasons.length > 0, reasons, mirrorExists: true, names };
}

/** 按权威源重建镜像；返回本次写入与删除的文件名。 */
function syncMirror(opts = {}) {
  const { source, mirror } = paths(opts.root || HARNESS_ROOT);
  if (!fs.existsSync(source)) {
    const e = new Error(`workflow 权威源目录不存在: ${source}`);
    e.exitCode = 2;
    throw e;
  }

  fs.mkdirSync(mirror, { recursive: true });
  const names = jsFiles(source);
  const written = [];
  for (const name of names) {
    const from = path.join(source, name);
    const to = path.join(mirror, name);
    const src = fs.readFileSync(from);
    if (!fs.existsSync(to) || !fs.readFileSync(to).equals(src)) {
      fs.writeFileSync(to, src);
      written.push(name);
    }
  }

  // 镜像里多出来的 .js 是权威源已删除的工作流，留着会被漂移检查报出来。
  const removed = jsFiles(mirror).filter((name) => !names.includes(name));
  for (const name of removed) fs.unlinkSync(path.join(mirror, name));

  return { mirror, total: names.length, written, removed };
}

function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--check')) {
      const result = checkMirror();
      if (result.drift) {
        process.stderr.write(`[sync-workflow-mirror] ✖ 镜像漂移: ${result.reasons.join('；')}\n`);
        process.stderr.write('[sync-workflow-mirror]   workflows/ 是权威源。跑 '
          + 'node engine/scripts/sync-workflow-mirror.cjs 重建镜像\n');
        return 1;
      }
      process.stdout.write(`[sync-workflow-mirror] ✓ 镜像与 workflows/ 一致 (${result.names.length} 个)\n`);
      return 0;
    }

    const { mirror, total, written, removed } = syncMirror();
    process.stdout.write(`[sync-workflow-mirror] 已同步 ${mirror}`
      + ` (${total} 个工作流；写入 ${written.length}，删除 ${removed.length})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[sync-workflow-mirror] ${err.message}\n`);
    return err.exitCode || 2;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { SOURCE_RELATIVE, MIRROR_RELATIVE, paths, checkMirror, syncMirror };
