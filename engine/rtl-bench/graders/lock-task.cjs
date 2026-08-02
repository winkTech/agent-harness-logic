#!/usr/bin/env node
'use strict';

// 计算/刷新任务判卷资产的 sha256 锁,写回 task.json.locks。
// 用法: node engine/rtl-bench/graders/lock-task.cjs --task <taskDir>

const fs = require('node:fs');
const path = require('node:path');
const { sha256File, loadTask, argValue } = require('./lib/common.cjs');

const LOCK_DIRS = ['ref', 'hidden', 'seed', 'xdc', 'public'];

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
}

function main() {
  const args = process.argv.slice(2);
  const taskDir = argValue(args, '--task');
  if (!taskDir) {
    console.error('Usage: node lock-task.cjs --task <taskDir>');
    process.exit(2);
  }
  const manifest = loadTask(taskDir);
  const files = [];
  for (const d of LOCK_DIRS) {
    const p = path.join(taskDir, d);
    if (fs.existsSync(p)) walk(p, taskDir, files);
  }
  manifest.locks = {};
  for (const rel of files.sort()) {
    manifest.locks[rel] = sha256File(path.join(taskDir, rel));
  }
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`locked ${files.length} files in ${taskDir}`);
}

main();
