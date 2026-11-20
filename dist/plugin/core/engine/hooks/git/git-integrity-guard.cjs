#!/usr/bin/env node
// git-integrity-guard.cjs — Codex turn-diffs safe-delete 事故的检测+自动恢复兜底
//
// 背景 (2026-08-25 四次事故根因, 见 memory/2026-08-25.md):
//   Codex CLI turn 结束时对 "turn 产生的文件" 做 safe-delete 批量删除,
//   非交互环境直接执行 (SAFE_DELETE_BULK_CONFIRM_REQUIRED count:186)。
//   它把 .git/refs、.git/objects/pack/*.pack 误判为可删临时文件 →
//   refs 消失 / object 库被清空。官方文档确认无配置项可禁用该行为;
//   workspace-write 沙箱的 .git 只读保护对宿主级 turn 清理无效。
//
// 策略: 检测+恢复 (检测要快, 恢复要幂等):
//   1. HEAD ref 可解析?    否 → 从 packed-refs / reflog 重建 loose ref
//   2. HEAD commit object 存在? 否 → 报 CRITICAL (需 git fetch --refetch 或重提交)
//   3. loose refs 目录存在? 否 → 重建 (packed-refs 可解出全部分支)
//   4. pack 文件存在?      否 → 报 CRITICAL (fetch --refetch 可恢复 remote 历史)
//
// 退出码: 0 = 健康/已自动恢复; 2 = 需人工介入 (CRITICAL)
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const sourceRoot = path.resolve(__dirname, '..', '..', '..', '..');
const workspace = process.argv.includes('--workspace');
let HOME = sourceRoot;
if (workspace) {
  const event = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '') || '{}');
  HOME = path.resolve(event.cwd || process.cwd());
  while (!fs.existsSync(path.join(HOME, '.git'))) {
    const parent = path.dirname(HOME);
    if (parent === HOME) process.exit(0);
    HOME = parent;
  }
}
const gitMarker = path.join(HOME, '.git');
const GIT_DIR = workspace && fs.statSync(gitMarker).isFile()
  ? git(['rev-parse', '--absolute-git-dir'])?.trim() : gitMarker;
if (!GIT_DIR) { console.error('[git-integrity-guard] Invalid Git worktree metadata'); process.exit(2); }
const commonDir = workspace ? git(['rev-parse', '--path-format=absolute', '--git-common-dir'])?.trim() || GIT_DIR : GIT_DIR;
// The historical repair path owns the Harness checkout. Inspect other projects without rewriting their refs.
const canRepair = !workspace || HOME === sourceRoot;

function git(args, opts) {
  try {
    return execFileSync('git', args, { cwd: HOME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    return null;
  }
}

function out(msg) {
  if (workspace && msg.startsWith('OK:')) return;
  (workspace ? process.stderr : process.stdout).write(`[git-integrity-guard] ${msg}\n`);
}

// ── 1. .git 目录本体 ──
if (!fs.existsSync(GIT_DIR)) {
  out(`CRITICAL: .git 目录不存在 (${GIT_DIR})`);
  process.exit(2);
}

// ── 2. refs 目录存在性 ──
const refsDir = path.join(commonDir, 'refs');
if (!fs.existsSync(refsDir)) {
  if (!canRepair) { out('CRITICAL: Git refs/ missing'); process.exit(2); }
  out('refs/ 目录消失 — 正在重建 (heads/ tags/)');
  try {
    fs.mkdirSync(path.join(refsDir, 'heads'), { recursive: true });
    fs.mkdirSync(path.join(refsDir, 'tags'), { recursive: true });
    out('refs/ 目录已重建');
  } catch (e) {
    out(`CRITICAL: refs/ 重建失败: ${e.message}`);
    process.exit(2);
  }
} else if (canRepair) {
  if (!fs.existsSync(path.join(refsDir, 'heads'))) fs.mkdirSync(path.join(refsDir, 'heads'), { recursive: true });
  if (!fs.existsSync(path.join(refsDir, 'tags'))) fs.mkdirSync(path.join(refsDir, 'tags'), { recursive: true });
}

// ── 3. HEAD 可解析性 ──
let headContent = '';
try { headContent = fs.readFileSync(path.join(GIT_DIR, 'HEAD'), 'utf8').trim(); } catch { /* handled below */ }

if (!headContent) {
  out('CRITICAL: .git/HEAD 缺失或为空 — 需人工重建 (echo "ref: refs/heads/<branch>" > .git/HEAD)');
  process.exit(2);
}

let headSha = git(['rev-parse', 'HEAD']);
if (!headSha) {
  // HEAD 指向的 ref 文件丢失或被清空 → 从 packed-refs 恢复
  // (2026-08-27 第六次事故形态: safe-delete 把 ref 文件清空而非删除,
  //  目录还在, 只查目录存在性查不出来 —— rev-parse 失败是唯一信号)
  const m = headContent.match(/^ref:\s*(\S+)/);
  const refName = m ? m[1] : null;
  if (workspace && refName && git(['check-ref-format', refName]) === null) {
    out('CRITICAL: invalid HEAD ref'); process.exit(2);
  }
  if (workspace && refName?.startsWith('refs/heads/') && !fs.existsSync(path.join(commonDir, refName)) &&
      !fs.existsSync(path.join(GIT_DIR, 'logs', 'HEAD')) && !fs.existsSync(path.join(commonDir, 'logs', refName)) &&
      git(['rev-list', '--all', '--max-count=1'])?.trim() === '') process.exit(0);
  if (!canRepair) { out('CRITICAL: Git HEAD cannot be resolved'); process.exit(2); }
  if (refName) {
    let recovered = null;
    const packedRefsPath = path.join(GIT_DIR, 'packed-refs');
    if (fs.existsSync(packedRefsPath)) {
      const lines = fs.readFileSync(packedRefsPath, 'utf8').split('\n');
      for (const line of lines) {
        const pm = line.match(/^([0-9a-f]{40})\s+(\S+)/);
        if (pm && pm[2] === refName) { recovered = pm[1]; break; }
      }
    }
    // packed-refs 没有 → 直接读 .git/logs/HEAD (reflog 文件), 再退 .git/logs/<ref>
    // 注意: `git reflog show <ref>` 在 ref 文件缺失时也会失败, 必须读文件本体
    if (!recovered) {
      for (const logPath of [path.join(GIT_DIR, 'logs', 'HEAD'), path.join(GIT_DIR, 'logs', refName)]) {
        try {
          const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            const lm = lines[i].match(/^([0-9a-f]{40})\s+([0-9a-f]{40})\s/);
            if (lm && lm[2] && !/^0+$/.test(lm[2])) { recovered = lm[2]; break; }
          }
          if (recovered) break;
        } catch { /* 下一个来源 */ }
      }
    }
    // 三个来源都验证 object 真实存在才算恢复成功
    if (recovered && git(['cat-file', '-t', recovered]) === null) recovered = null;
    if (recovered) {
      const refFile = path.join(GIT_DIR, refName);
      fs.mkdirSync(path.dirname(refFile), { recursive: true });
      fs.writeFileSync(refFile, `${recovered}\n`);
      out(`HEAD ref (${refName}) 已从 packed-refs/reflog 恢复 → ${recovered.slice(0, 8)}`);
      headSha = git(['rev-parse', 'HEAD']);
    }
  }
  if (!headSha) {
    out(`CRITICAL: HEAD (${headContent}) 无法解析且自动恢复失败 — 参考 memory/2026-08-25.md 的 fetch --refetch 流程`);
    process.exit(2);
  }
}

// ── 4. HEAD commit object 存在性 (refs 活但 object 被删的情况) ──
const headType = git(['cat-file', '-t', headSha.trim()]);
if (headType === null) {
  out(`CRITICAL: HEAD ref 存在但 commit object 丢失 (${headSha.trim().slice(0, 8)}) — git fetch --refetch origin 可恢复 remote 历史; 未 push 的提交需从工作区重建`);
  process.exit(2);
}

// ── 5. pack 文件存在性 (object 库被清空的早期信号) ──
const packDir = path.join(commonDir, 'objects', 'pack');
if (fs.existsSync(packDir)) {
  const packs = fs.readdirSync(packDir).filter(f => f.endsWith('.pack'));
  const idx = fs.readdirSync(packDir).filter(f => f.endsWith('.idx'));
  if (idx.length > 0 && packs.length === 0) {
    out(`CRITICAL: pack 目录有 ${idx.length} 个 .idx 但 0 个 .pack — object 库已被清空, 立即 git fetch --refetch origin`);
    process.exit(2);
  }
}

// ── 5.5 HEAD 落后 reflog 顶端检测 (2026-08-27 第七次事故盲区) ──
// 形态: loose ref 被删但 packed-refs 里有旧值 → rev-parse 经 packed-refs 兜底
// 成功, HEAD 静默回退到旧提交, 一切看似健康。对策: reflog 顶端(本仓最近一次
// 真实操作的结果)比 HEAD 新时, 自动把 HEAD ref 快进到 reflog 顶端。
// 仅当顶端 object 存在且 HEAD 是其祖先(纯落后, 无分叉)时才动。
{
  let reflogTop = null;
  try {
    const lines = fs.readFileSync(path.join(GIT_DIR, 'logs', 'HEAD'), 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const lm = lines[i].match(/^([0-9a-f]{40})\s+([0-9a-f]{40})\s/);
      if (lm && lm[2] && !/^0+$/.test(lm[2])) { reflogTop = lm[2]; break; }
    }
  } catch { /* 无 reflog 文件则跳过本检查 */ }
  if (reflogTop && reflogTop !== headSha.trim()) {
    const topExists = git(['cat-file', '-t', reflogTop]) !== null;
    // git() 成功返回 stdout 字符串、失败(含 merge-base 判否的 exit 1)返回 null。
    // merge-base --is-ancestor 静默: 返回非 null 即退出码 0 = HEAD 是 reflog 顶端的祖先。
    const mergeBase = topExists ? git(['merge-base', '--is-ancestor', headSha.trim(), reflogTop]) : null;
    if (topExists && mergeBase !== null) {
      if (!canRepair) { out('CRITICAL: HEAD is behind the latest reflog entry'); process.exit(2); }
      const m = headContent.match(/^ref:\s*(\S+)/);
      const refName = m ? m[1] : null;
      if (refName) {
        const refFile = path.join(GIT_DIR, ...refName.split('/'));
        fs.mkdirSync(path.dirname(refFile), { recursive: true });
        fs.writeFileSync(refFile, `${reflogTop}\n`);
        out(`HEAD 静默回退检测: ${headSha.trim().slice(0, 8)} → reflog 顶端 ${reflogTop.slice(0, 8)} 已恢复`);
        headSha = reflogTop + '\n';
      } else {
        out(`WARN: HEAD (${headSha.trim().slice(0, 8)}) 落后 reflog 顶端 ${reflogTop.slice(0, 8)} 但 HEAD 非符号引用, 需人工核对`);
      }
    } else if (topExists) {
      out(`WARN: HEAD (${headSha.trim().slice(0, 8)}) 与 reflog 顶端 ${reflogTop.slice(0, 8)} 分叉 — 不自动改写, 需人工确认哪个是预期状态`);
    }
  }
}

// ── 6. index 完整性 (轻量探测; 不跑全量 fsck, 守卫必须快) ──
const lsFiles = git(['ls-files', '-z']);
if (lsFiles === null) {
  out('WARN: git ls-files 失败 — index 可能损坏, 运行 git read-tree HEAD 修复');
}

out(`OK: HEAD=${headSha.trim().slice(0, 8)} refs/objects 完整`);
process.exit(0);
