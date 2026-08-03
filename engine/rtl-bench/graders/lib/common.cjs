'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function loadTask(taskDir) {
  const p = path.join(taskDir, 'task.json');
  if (!fs.existsSync(p)) throw new Error(`task.json not found in ${taskDir}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 判卷前完整性校验: task.json.locks 里的相对路径 → sha256
function verifyLocks(taskDir, manifest) {
  const mismatches = [];
  const locks = manifest.locks || {};
  if (Object.keys(locks).length === 0) mismatches.push('locks empty — run lock-task.cjs first');
  for (const [rel, hash] of Object.entries(locks)) {
    const p = path.join(taskDir, rel);
    if (!fs.existsSync(p)) mismatches.push(`${rel}: missing`);
    else if (sha256File(p) !== hash) mismatches.push(`${rel}: hash mismatch`);
  }
  return mismatches;
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function argValue(args, name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

// --rtl 接受单文件或目录;目录时收集 .sv/.v(不递归,保持判卷面可预期)
function collectRtlSources(rtlArg) {
  const st = fs.statSync(rtlArg);
  if (st.isFile()) return [path.resolve(rtlArg)];
  return fs.readdirSync(rtlArg)
    .filter((f) => /\.(sv|v)$/i.test(f))
    .map((f) => path.resolve(rtlArg, f))
    .sort();
}

module.exports = { sha256File, loadTask, verifyLocks, ensureDir, writeJson, argValue, collectRtlSources };
