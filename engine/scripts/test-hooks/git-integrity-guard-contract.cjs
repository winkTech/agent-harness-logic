#!/usr/bin/env node
'use strict';
// git-integrity-guard 契约测试 —— manifest.json 的 fixture 硬门禁要求每个 active
// hook 都有真实测试。行为契约在临时仓上验证(不碰真实 .git):
//   1. 健康仓 → exit 0
//   2. refs 目录被删 → 自动恢复 HEAD ref, exit 0
//   3. pack 被清空(留 .idx) → CRITICAL, exit 2
//   4. HEAD commit object 丢失 → CRITICAL, exit 2
//   5. 非 HEAD loose ref 单删 → 不误报, exit 0
//   6. HEAD ref 文件被清空 → 自动恢复, exit 0
//   7. loose ref 删除且 packed-refs 有旧值(静默回退) → 快进到 reflog 顶端, exit 0
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GUARD = path.join(ROOT, 'engine', 'hooks', 'git', 'git-integrity-guard.cjs');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-contract-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'engine', 'hooks', 'git'), { recursive: true });
  fs.copyFileSync(GUARD, path.join(repo, 'engine', 'hooks', 'git', 'git-integrity-guard.cjs'));
  fs.writeFileSync(path.join(repo, 'f.txt'), 'a\n');
  const git = (args) => cp.spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 15000 });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['add', '.']);
  git(['commit', '-qm', 'c1']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'b\n');
  git(['add', '.']);
  git(['commit', '-qam', 'c2']);
  return { repo, git };
}

function runGuard(repo) {
  return cp.spawnSync('node', [path.join(repo, 'engine', 'hooks', 'git', 'git-integrity-guard.cjs')], {
    cwd: repo, encoding: 'utf8', timeout: 30000,
  });
}

// 1. 健康仓 → exit 0
{
  const { repo } = makeRepo();
  const r = runGuard(repo);
  assert.equal(r.status, 0, `healthy repo must be OK, got exit=${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /OK: HEAD=[0-9a-f]{8}/, 'guard must report HEAD sha');
  console.log('ok 1 - healthy repo exits 0 with HEAD sha');
}

// 2. refs 目录删除 → 自动恢复
{
  const { repo, git } = makeRepo();
  const before = git(['rev-parse', 'HEAD']).stdout.trim();
  fs.rmSync(path.join(repo, '.git', 'refs'), { recursive: true, force: true });
  const r = runGuard(repo);
  assert.equal(r.status, 0, `refs deletion must auto-recover, got exit=${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /恢复/, 'guard must log the recovery');
  const after = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(after, before, 'recovered HEAD must match the pre-deletion sha');
  assert.equal(git(['log', '--oneline']).status, 0, 'git log must work after recovery');
  console.log('ok 2 - refs deletion auto-recovers HEAD');
}

// 3. pack 清空(留 .idx) → CRITICAL exit 2
{
  const { repo, git } = makeRepo();
  for (const c of [1, 2, 3]) { fs.appendFileSync(path.join(repo, 'f.txt'), `${c}\n`); git(['add', '.']); git(['commit', '-qm', `c${c}`]); }
  cp.spawnSync('git', ['-C', repo, 'gc', '-q'], { encoding: 'utf8', timeout: 20000 });
  for (const f of fs.readdirSync(path.join(repo, '.git', 'objects', 'pack'))) {
    if (f.endsWith('.pack')) fs.rmSync(path.join(repo, '.git', 'objects', 'pack', f), { force: true });
  }
  const r = runGuard(repo);
  assert.equal(r.status, 2, `cleared pack must be CRITICAL, got exit=${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /CRITICAL/, 'guard must log CRITICAL');
  console.log('ok 3 - cleared pack detected as CRITICAL');
}

// 4. HEAD commit object 丢失 → CRITICAL exit 2
{
  const { repo, git } = makeRepo();
  // 找到 HEAD commit 的 loose object 并删掉 (gc 前是 loose 的)
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  const objPath = path.join(repo, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  if (fs.existsSync(objPath)) fs.rmSync(objPath, { force: true });
  const r = runGuard(repo);
  assert.equal(r.status, 2, `missing HEAD object must be CRITICAL, got exit=${r.status}: ${r.stdout}${r.stderr}`);
  console.log('ok 4 - missing HEAD object detected as CRITICAL');
}

// 5. 非 HEAD loose ref 单删 → 不误报
{
  const { repo, git } = makeRepo();
  git(['branch', '-q', 'feature-x']);
  fs.rmSync(path.join(repo, '.git', 'refs', 'heads', 'feature-x'), { force: true });
  const r = runGuard(repo);
  assert.equal(r.status, 0, `non-HEAD ref deletion must not false-positive, got exit=${r.status}: ${r.stdout}${r.stderr}`);
  console.log('ok 5 - non-HEAD ref deletion does not false-positive');
}

// 6. HEAD ref 文件被清空(2026-08-27 第六次事故形态: safe-delete 清空而非删除) → 自动恢复
{
  const { repo, git } = makeRepo();
  const before = git(['rev-parse', 'HEAD']).stdout.trim();
  const refFile = path.join(repo, '.git', 'refs', 'heads', 'master');
  if (!fs.existsSync(refFile)) {
    const branch = git(['symbolic-ref', '--short', 'HEAD']).stdout.trim();
    fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', branch), '');
  } else {
    fs.writeFileSync(refFile, '');
  }
  const r = runGuard(repo);
  assert.equal(r.status, 0, `emptied HEAD ref must auto-recover, got exit=${r.status}: ${r.stdout}${r.stderr}`);
  const after = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(after, before, 'recovered HEAD must match pre-corruption sha');
  console.log('ok 6 - emptied HEAD ref auto-recovers');
}

// 7. loose ref 删除但 packed-refs 持旧值 → HEAD 静默回退, guard 快进到 reflog 顶端
{
  const { repo, git } = makeRepo();
  const branch = git(['symbolic-ref', '--short', 'HEAD']).stdout.trim();
  const headC2 = git(['rev-parse', 'HEAD']).stdout.trim();
  // c2 打进 packed-refs (stale 锚点), loose ref 消失
  git(['pack-refs', '--all']);
  // 新提交 c3 → loose ref 重新覆盖 packed 里的 c2
  fs.appendFileSync(path.join(repo, 'f.txt'), 'c\n');
  git(['add', '.']);
  git(['commit', '-qm', 'c3']);
  const headC3 = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.notEqual(headC2, headC3, 'c3 must differ from c2');
  // 删 loose ref → rev-parse 经 packed-refs 兜底静默回退到 c2
  fs.rmSync(path.join(repo, '.git', 'refs', 'heads', branch), { force: true });
  assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), headC2, 'HEAD must silently roll back to stale packed value');
  const r = runGuard(repo);
  assert.equal(r.status, 0, `silent rollback must auto-recover, got exit=${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /HEAD 静默回退检测: .+已恢复/, 'guard must log the silent-rollback recovery');
  assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), headC3, 'HEAD must be fast-forwarded to reflog top (c3)');
  console.log('ok 7 - silent rollback (packed-refs stale) fast-forwards HEAD to reflog top');
}

console.log('git-integrity-guard contract: all checks passed');
