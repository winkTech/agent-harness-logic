#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/migrate-state-dir.cjs — 把 harness 运行时状态搬出代码根
 *
 * 用法:
 *   node engine/scripts/migrate-state-dir.cjs                       # dry-run（默认）：只打印计划，不写任何东西
 *   node engine/scripts/migrate-state-dir.cjs --json                 # dry-run，机器可读输出
 *   node engine/scripts/migrate-state-dir.cjs --execute [--to <dir>] # 真正搬运；目标默认 <homedir>/.logical-paradox
 *
 * 语义:
 *   - 源：<HARNESS_ROOT>/var、<HARNESS_ROOT>/.wright；任一不存在则跳过并说明。
 *   - 目标已含 var/、.wright/ 或 state.json → 拒绝（exit 3），不覆盖。
 *   - .wright/memory.db-wal|-shm 存在时先尝试 PRAGMA wal_checkpoint(TRUNCATE)；仍有 WAL 也照搬，但发警告。
 *   - 搬运策略：同卷 renameSync；跨卷或 rename 失败 → 递归复制 + 逐文件比对 size + 删源。
 *   - 成功后在目标写 state.json，并在旧位置留 STATE-MOVED.txt。
 *
 * 退出码: 0 成功/dry-run；2 参数错误；3 目标冲突；4 搬运失败（已复制部分不回滚，但明确列出）。
 *
 * 核心逻辑导出为 planMigration / runMigration，允许注入 fs 操作（至少 rename）以便测试跨卷回退。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const {
  STATE_LAYOUT_VERSION,
  STATE_MARKER,
  DEFAULT_STATE_DIRNAME,
} = require('./lib/harness-state.cjs');

const MOVED_NOTE = 'STATE-MOVED.txt';
const STATE_SUBDIRS = ['var', '.wright'];
const WAL_SUFFIXES = ['-wal', '-shm'];

const EXIT_OK = 0;
const EXIT_ARGS = 2;
const EXIT_CONFLICT = 3;
const EXIT_MOVE_FAILED = 4;

// ── 可注入的 fs 操作 ───────────────────────────────────────────────────────

function defaultOps() {
  return {
    rename: (from, to) => fs.renameSync(from, to),
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    copyFile: (from, to) => fs.copyFileSync(from, to),
    symlink: (target, linkPath) => fs.symlinkSync(target, linkPath),
    rm: (target) => fs.rmSync(target, { recursive: true, force: true }),
    writeFile: (file, text) => fs.writeFileSync(file, text, 'utf8'),
  };
}

function withOps(overrides) {
  return Object.assign(defaultOps(), overrides || {});
}

// ── 只读辅助 ───────────────────────────────────────────────────────────────

function statOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** 递归统计文件数与字节数（只读） */
function measureTree(root) {
  const summary = { files: 0, bytes: 0 };
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const st = statOrNull(current);
    if (!st) continue;
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(current);
      } catch {
        entries = [];
      }
      for (const entry of entries) stack.push(path.join(current, entry));
    } else {
      summary.files += 1;
      summary.bytes += st.size;
    }
  }
  return summary;
}

function resolveTarget(opts) {
  const env = opts.env || process.env;
  const homeDir = String(opts.homeDir || os.homedir());
  const explicit = opts.to || env.HARNESS_STATE_DIR || '';
  if (explicit) return path.resolve(String(explicit));
  return path.resolve(homeDir, DEFAULT_STATE_DIRNAME);
}

// ── 计划（严格只读） ───────────────────────────────────────────────────────

/**
 * 计算迁移计划。严格只读：只做 lstat/readdir，不创建任何东西。
 * @param {{harnessRoot?: string, homeDir?: string, to?: string, env?: object}} [opts]
 */
function planMigration(opts = {}) {
  const harnessRoot = path.resolve(String(opts.harnessRoot || HARNESS_ROOT));
  const target = resolveTarget(opts);

  const sources = [];
  const skipped = [];
  for (const name of STATE_SUBDIRS) {
    const from = path.join(harnessRoot, name);
    const st = statOrNull(from);
    if (!st || !st.isDirectory()) {
      skipped.push({ name, from, reason: 'not found' });
      continue;
    }
    sources.push(Object.assign({ name, from, to: path.join(target, name) }, measureTree(from)));
  }

  const conflicts = [];
  for (const name of STATE_SUBDIRS.concat([STATE_MARKER])) {
    const candidate = path.join(target, name);
    if (statOrNull(candidate)) conflicts.push(candidate);
  }

  const walFiles = [];
  const dbPath = path.join(harnessRoot, '.wright', 'memory.db');
  for (const suffix of WAL_SUFFIXES) {
    const candidate = `${dbPath}${suffix}`;
    if (statOrNull(candidate)) walFiles.push(candidate);
  }

  const warnings = [];
  if (target === harnessRoot) warnings.push('target equals harness root; nothing to do');

  return {
    harnessRoot,
    target,
    sources,
    skipped,
    conflicts,
    walFiles,
    warnings,
    markerPath: path.join(target, STATE_MARKER),
    notePath: path.join(harnessRoot, MOVED_NOTE),
    layoutVersion: STATE_LAYOUT_VERSION,
  };
}

// ── 搬运 ───────────────────────────────────────────────────────────────────

/** 递归复制并逐文件比对 size；任一不一致抛错。 */
function copyTree(src, dest, ops, report) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    ops.mkdir(dest);
    for (const entry of fs.readdirSync(src)) {
      copyTree(path.join(src, entry), path.join(dest, entry), ops, report);
    }
    return;
  }
  if (st.isSymbolicLink()) {
    try {
      ops.symlink(fs.readlinkSync(src), dest);
      report.links += 1;
      return;
    } catch {
      // Windows 上无权限建链接时退化为复制链接指向的内容
    }
  }
  ops.copyFile(src, dest);
  const srcSize = fs.statSync(src).size;
  const destSize = fs.statSync(dest).size;
  if (srcSize !== destSize) {
    throw new Error(`size mismatch after copy: ${dest} (${destSize} != ${srcSize})`);
  }
  report.files += 1;
  report.bytes += srcSize;
}

/** WAL 收尾：尽力而为，失败不阻断迁移。 */
function checkpointWal(plan, result) {
  if (!plan.walFiles.length) return;
  const dbPath = path.join(plan.harnessRoot, '.wright', 'memory.db');
  if (!statOrNull(dbPath)) return;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    result.checkpoint = 'ok';
  } catch (e) {
    result.checkpoint = `failed: ${e.message}`;
    result.warnings.push(`WAL checkpoint failed: ${e.message}`);
  }
  const remaining = plan.walFiles.filter(file => statOrNull(file));
  if (remaining.length) {
    result.warnings.push(
      `WAL sidecar files still present (${remaining.map(f => path.basename(f)).join(', ')}); `
      + '请确认没有活动会话，它们会被一并搬运',
    );
  }
}

/**
 * 执行（或演练）迁移。
 * @param {{harnessRoot?, homeDir?, to?, env?, execute?: boolean, fsOps?: object, now?: Date}} [opts]
 * @returns {{code: number, dryRun: boolean, plan: object, moved: object[], warnings: string[], errors: string[]}}
 */
function runMigration(opts = {}) {
  const plan = planMigration(opts);
  const execute = Boolean(opts.execute);
  const ops = withOps(opts.fsOps);
  const result = {
    code: EXIT_OK,
    dryRun: !execute,
    plan,
    moved: [],
    warnings: plan.warnings.slice(),
    errors: [],
    marker: null,
  };

  if (plan.conflicts.length) {
    result.code = EXIT_CONFLICT;
    result.errors.push(`target already holds harness state: ${plan.conflicts.join(', ')}`);
    return result;
  }
  if (plan.target === plan.harnessRoot) {
    result.code = EXIT_ARGS;
    result.errors.push('target must differ from the harness root');
    return result;
  }

  if (!execute) return result; // dry-run 到此为止：一次写操作都没有发生

  checkpointWal(plan, result);

  try {
    ops.mkdir(plan.target);
  } catch (e) {
    result.code = EXIT_MOVE_FAILED;
    result.errors.push(`cannot create target ${plan.target}: ${e.message}`);
    return result;
  }

  for (const source of plan.sources) {
    const entry = { name: source.name, from: source.from, to: source.to, strategy: 'rename' };
    try {
      ops.rename(source.from, source.to);
    } catch (renameError) {
      entry.strategy = 'copy';
      entry.renameError = renameError.message;
      const report = { files: 0, bytes: 0, links: 0 };
      try {
        copyTree(source.from, source.to, ops, report);
        ops.rm(source.from);
      } catch (copyError) {
        entry.error = copyError.message;
        result.moved.push(entry);
        result.code = EXIT_MOVE_FAILED;
        result.errors.push(
          `failed to move ${source.from} -> ${source.to}: ${copyError.message}; `
          + `已复制 ${report.files} 个文件到目标且未回滚，请人工核对`,
        );
        return result;
      }
      entry.files = report.files;
      entry.bytes = report.bytes;
    }
    result.moved.push(entry);
  }

  const migratedAt = (opts.now instanceof Date ? opts.now : new Date()).toISOString();
  const marker = {
    layoutVersion: STATE_LAYOUT_VERSION,
    migratedFrom: plan.harnessRoot,
    migratedAt,
    tool: 'migrate-state-dir',
  };
  try {
    ops.writeFile(plan.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    ops.writeFile(plan.notePath, `harness state moved to ${plan.target} at ${migratedAt}\n`);
  } catch (e) {
    result.code = EXIT_MOVE_FAILED;
    result.errors.push(`state moved but marker write failed: ${e.message}`);
    return result;
  }
  result.marker = marker;
  return result;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = { execute: false, json: false, to: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') parsed.execute = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--dry-run') parsed.execute = false;
    else if (arg === '--to') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { error: '--to requires a directory' };
      parsed.to = value;
      i += 1;
    } else if (arg.startsWith('--to=')) {
      const value = arg.slice('--to='.length);
      if (!value) return { error: '--to requires a directory' };
      parsed.to = value;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return parsed;
}

function formatHuman(result) {
  const { plan } = result;
  const lines = [];
  lines.push(result.dryRun ? '迁移计划 (dry-run，未写入任何东西)' : '迁移执行结果');
  lines.push(`  源根:   ${plan.harnessRoot}`);
  lines.push(`  目标:   ${plan.target}`);
  for (const source of plan.sources) {
    lines.push(`  ${source.name.padEnd(8)}: ${source.files} 个文件 / ${source.bytes} 字节 → ${source.to}`);
  }
  for (const skip of plan.skipped) {
    lines.push(`  ${skip.name.padEnd(8)}: 不存在，跳过 (${skip.from})`);
  }
  if (plan.walFiles.length) {
    lines.push(`  WAL:      ${plan.walFiles.map(f => path.basename(f)).join(', ')}`);
  }
  for (const entry of result.moved) {
    lines.push(`  已搬运:   ${entry.name} (${entry.strategy}${entry.files !== undefined ? `, ${entry.files} 文件` : ''})`);
  }
  if (result.marker) lines.push(`  已写入:   ${plan.markerPath} / ${plan.notePath}`);
  for (const warning of result.warnings) lines.push(`  ⚠️  ${warning}`);
  for (const error of result.errors) lines.push(`  ❌ ${error}`);
  if (result.dryRun && !result.errors.length) {
    lines.push('  下一步:   加 --execute 真正搬运（可用 --to <dir> 指定目标）');
  }
  return lines.join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`[migrate-state-dir] ${args.error}\n`);
    return EXIT_ARGS;
  }
  const result = runMigration({ execute: args.execute, to: args.to });
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${formatHuman(result)}\n`);
  return result.code;
}

module.exports = {
  EXIT_OK,
  EXIT_ARGS,
  EXIT_CONFLICT,
  EXIT_MOVE_FAILED,
  MOVED_NOTE,
  STATE_SUBDIRS,
  defaultOps,
  parseArgs,
  planMigration,
  runMigration,
  formatHuman,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
