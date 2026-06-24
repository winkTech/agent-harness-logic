#!/usr/bin/env node
/**
 * engine/scripts/gates/commit-gate.cjs — 提交闸门 (P0)
 *
 * 在 git commit 前运行所有检查，将全部违规列在一张表中，exit 2 阻断。
 *
 * 检查项:
 *   1. 语法检查 (vlog -lint / ruff check)
 *   2. 综合违规 (initial/disable/force in non-test SV)
 *   3. 命名规范 (ri_/ro_ for non-test SV)
 *   4. 逻辑级数/扇出 (HDL)
 *   5. 验证门禁状态 (edit→verify)
 *   6. 黄金模型保护 (git diff 中是否有 matlab/golden 文件)
 *
 * 注册: PreToolUse(Bash) + git commit 检测
 * 退出码: 0 = 全部通过, 2 = 有违规
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HARNESS = path.join(require('os').homedir(), '.claude');
const LOGIC_ANALYZER = path.join(HARNESS, 'engine', 'scripts', 'hdl-lint', 'logic-analyzer.cjs');
const VERIFY_GATE_FILE = path.join(HARNESS, 'var', 'verify-gate.json');

const TIMEOUT_MS = 60000;

// ── 辅助函数 ─────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(r => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => r(d));
  });
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
    ...opts,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

// ── 检查项 ───────────────────────────────────────────────────────────────────

/** 获取暂存区文件 */
function getStagedFiles() {
  const r = run('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean);
}

/** 检查 HDL 语法 */
function checkHdlLint(files) {
  const hdlFiles = files.filter(f => /\.(sv|v)$/i.test(f));
  const errors = [];
  for (const f of hdlFiles) {
    const r = run('vlog', ['-lint', f], { cwd: process.cwd() });
    if (r.status !== 0) {
      const line = r.stderr.split('\n').find(l => l.includes('Error') || l.includes('Syntax'));
      errors.push({ file: f, detail: line || 'vlog lint 失败' });
    }
  }
  return errors;
}

/** 检查综合违规 */
function checkSynthesisViolations(files) {
  const hdlFiles = files.filter(f => /\.(sv|v)$/i.test(f) && !/tb_|_tb|testbench/i.test(f));
  const errors = [];
  for (const f of hdlFiles) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      for (const [pattern, msg] of [
        [/\binitial\b/, '禁止使用 initial（不可综合）'],
        [/\bdisable\b/, '禁止使用 disable（不可综合）'],
        [/\bwait\s+[^;]*;/, '禁止在综合代码中使用 wait'],
        [/\bforce\b/, '禁止使用 force（不可综合）'],
        [/#\d+\s/, '禁止使用延时 #delay（不可综合）'],
        [/\bassign\s+ri_/, '输入信号(ri_)不应被 assign 驱动'],
      ]) {
        if (pattern.test(content)) errors.push({ file: f, detail: msg });
      }
    } catch { /* skip unreadable */ }
  }
  return errors;
}

/** 检查 HDL 命名规范 */
function checkHdlNaming(files) {
  const hdlFiles = files.filter(f => /\.(sv|v)$/i.test(f) && !/tb_|_tb|testbench/i.test(f));
  const errors = [];
  for (const f of hdlFiles) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^\s*(output)\s+(reg|logic|wire)?\s*(\[.*?\]\s+)?(\w+)/);
        if (m && !m[4].startsWith('ro_')) errors.push({ file: f, detail: `输出信号 "${m[4]}" 应以 ro_ 开头` });
        const m2 = line.match(/^\s*(input)\s+(reg|logic|wire)?\s*(\[.*?\]\s+)?(\w+)/);
        if (m2 && !m2[4].startsWith('ri_')) errors.push({ file: f, detail: `输入信号 "${m2[4]}" 应以 ri_ 开头` });
      }
    } catch { /* skip */ }
  }
  return errors;
}

/** 检查逻辑级数/扇出 */
function checkHdlComplexity(files) {
  const hdlFiles = files.filter(f => /\.(sv|v)$/i.test(f) && !/tb_|_tb|testbench/i.test(f));
  const errors = [];
  for (const f of hdlFiles) {
    if (!fs.existsSync(LOGIC_ANALYZER)) continue;
    const r = run('node', [LOGIC_ANALYZER, f]);
    if (r.status === 2) {
      // 从输出中提取违规信息
      const fails = r.stdout.split('\n').filter(l => l.includes('[FAIL]'));
      for (const line of fails) errors.push({ file: f, detail: line.trim() });
    }
  }
  return errors;
}

/** 检查黄金模型保护 */
function checkGoldenModel(files) {
  const protectedFiles = files.filter(f =>
    /[\\/]matlab[\\/]/.test(f) ||
    /golden/.test(f) ||
    /fixed_point/.test(f)
  );
  return protectedFiles.map(f => ({ file: f, detail: '受保护文件(黄金模型)禁止修改' }));
}

/** 检查 Python lint */
function checkPythonLint(files) {
  const pyFiles = files.filter(f => /\.py$/i.test(f));
  const errors = [];
  for (const f of pyFiles) {
    const r = run('ruff', ['check', f]);
    if (r.status !== 0) {
      const first = r.stdout.split('\n').find(l => l.includes('Error') || l.includes('E\d'));
      errors.push({ file: f, detail: first || 'ruff check 失败' });
    }
  }
  return errors;
}

/** 检查 Git 分支名 (11-git.md) */
function checkBranchName() {
  const r = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) return [];
  const branch = r.stdout.trim();
  // 空仓库(无提交)或 detached HEAD 时 git 返回 HEAD,跳过检查
  if (!branch || branch === 'HEAD') return [];
  if (branch === 'main' || branch === 'master') return [];
  if (/^(feat|fix|refactor|docs|chore|test|ci)\//.test(branch)) return [];
  return [{ file: branch, detail: '分支名不符合规范: 应以 feat/fix/refactor/docs/chore/test/ci/ 开头' }];
}

/** 检查提交信息格式 (11-git.md) */
function checkCommitMessage(command) {
  // 从 git commit -m "..." 中提取提交信息
  const m = command.match(/-m\s+["'](.+?)["']/);
  if (!m) return [];  // 没提供 -m, 让编辑器输入, 跳过
  const msg = m[1];
  const valid = /^(feat|fix|refactor|docs|chore|test|ci)\([a-z0-9_-]+\):\s.+/.test(msg);
  if (!valid) {
    return [{
      file: '(提交信息)',
      detail: '格式: type(scope): description  (如 feat(fft): 添加 64 点流水线支持)'
    }];
  }
  return [];
}


/** 检查是否需要 rebase (11-git.md) */
function checkRebaseNeeded() {
  const r = run('git', ['rev-list', '--count', '--left-right', 'HEAD...origin/main']);
  if (r.status !== 0) {
    const r2 = run('git', ['rev-list', '--count', '--left-right', 'HEAD...origin/master']);
    if (r2.status !== 0) return [];
    const parts = r2.stdout.trim().split(String.fromCharCode(9));
    if (parts.length === 2 && parseInt(parts[0]) > 0)
      return [{ file: '(git)', detail: '分支落后 origin/master ' + parts[0] + ' 个提交, 先 rebase' }];
    return [];
  }
  const parts = r.stdout.trim().split(String.fromCharCode(9));
  if (parts.length === 2 && parseInt(parts[0]) > 0)
    return [{ file: '(git)', detail: '分支落后 origin/main ' + parts[0] + ' 个提交, 先 rebase' }];
  return [];
}

/** 检查 .gitignore (11-git.md) */
function checkGitignore() {
  if (!fs.existsSync('.gitignore'))
    return [{ file: '.gitignore', detail: '项目缺少 .gitignore 文件' }];
  const c = fs.readFileSync('.gitignore', 'utf8');
  const required = ['*.vcd', '__pycache__', '.DS_Store'];
  const errs = [];
  for (const r of required) {
    if (!c.includes(r)) errs.push({ file: '.gitignore', detail: '缺少  + r +  规则' });
  }
  return errs;
}

/** 检查 TDD 测试先于实现 (12-tdd.md) */
function checkTddTestFirst(files) {
  const errs = [];
  for (const f of files) {
    const m = f.match(/^src[\/](.+)\.py$/);
    if (m) {
      const et = 'tests/test_' + m[1] + '.py';
      if (!files.includes(et) && !fs.existsSync(et))
        errs.push({ file: f, detail: 'TDD: 测试文件 ' + et + ' 不存在, 先写测试' });
    }
  }
  return errs;
}

/** 检查系统安装路径 (07-system.md) */
function checkInstallPath(files) {
  const errs = [];
  if (!process.cwd().match(/^[Cc]:/)) return errs;
  for (const f of files) {
    if (/\.gitignore|requirements\.txt|package\.json|Cargo\.toml|setup\.py|pyproject\.toml/.test(f))
      errs.push({ file: f, detail: '确保安装到 D 盘而非 C 盘 (07-system.md)' });
  }
  return errs;
}

/** 检查验证门禁状态 */
function checkVerifyGate() {
  try {
    if (fs.existsSync(VERIFY_GATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(VERIFY_GATE_FILE, 'utf8'));
      if (state.edited && !state.verified) {
        return [{ file: '(全局)', detail: '有待验证的修改，请先运行验证命令 (pytest/vlog/make 等)' }];
      }
    }
  } catch { /* ignore */ }
  return [];
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);

  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }

  const command = (payload?.tool_input?.command || payload?.tool?.input?.command || payload?.command || '').trim();
  if (!/^git\s+commit(\s|$)/.test(command)) process.exit(0);

  // ── 收集暂存文件 ──────────────────────────────────────────────────────────
  const files = getStagedFiles();
  if (files.length === 0) process.exit(0);

  console.error('');
  console.error('┌──────────────────────────────────────────────────────────────┐');
  console.error('│  🔬 COMMIT GATE — 预提交综合检查                            │');
  console.error(`│  暂存文件: ${files.length} 个`);
  console.error('└──────────────────────────────────────────────────────────────┘');

  // ── 运行所有检查 ──────────────────────────────────────────────────────────
  const allErrors = [];

  console.error('  [1/13] Git 分支名检查...');
  allErrors.push(...checkBranchName().map(e => ({ check: 'Git分支', ...e })));

  console.error('  [2/13] 提交信息格式检查...');
  allErrors.push(...checkCommitMessage(command).map(e => ({ check: '提交格式', ...e })));

  console.error('  [3/13] Rebase 检查...');
  allErrors.push(...checkRebaseNeeded().map(e => ({ check: 'Rebase', ...e })));

  console.error('  [4/13] .gitignore 检查...');
  allErrors.push(...checkGitignore().map(e => ({ check: 'gitignore', ...e })));

  console.error('  [5/13] HDL 语法检查 (vlog -lint)...');
  allErrors.push(...checkHdlLint(files).map(e => ({ check: '语法', ...e })));

  console.error('  [6/13] 综合违规检查...');
  allErrors.push(...checkSynthesisViolations(files).map(e => ({ check: '综合', ...e })));

  console.error('  [7/13] HDL 命名规范检查...');
  allErrors.push(...checkHdlNaming(files).map(e => ({ check: '命名', ...e })));

  console.error('  [8/13] HDL 逻辑级数/扇出检查...');
  allErrors.push(...checkHdlComplexity(files).map(e => ({ check: '逻辑级数', ...e })));

  console.error('  [9/13] 黄金模型保护检查...');
  allErrors.push(...checkGoldenModel(files).map(e => ({ check: '黄金模型', ...e })));

  console.error('  [10/13] Python lint 检查...');
  allErrors.push(...checkPythonLint(files).map(e => ({ check: 'Python', ...e })));

  allErrors.push(...checkVerifyGate().map(e => ({ check: '验证门禁', ...e })));

  // ── 输出结果 ──────────────────────────────────────────────────────────────
  if (allErrors.length === 0) {
    console.error('');
    console.error('  ✅ 全部检查通过');
    process.exit(0);
  }

  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║     🔒 COMMIT GATE — 阻断提交                               ║');
  console.error('╠══════════════════════════════════════════════════════════════╣');
  for (const e of allErrors) {
    console.error(`║  [${e.check.padEnd(8)}] ${e.detail.slice(0, 60).padEnd(62)}║`);
    if (e.file !== '(全局)') console.error(`║         ${('→ ' + e.file).slice(0, 70).padEnd(72)}║`);
  }
  console.error('╠══════════════════════════════════════════════════════════════╣');
  console.error(`║  共 ${allErrors.length} 项违规，修复后重试                       ║`);
  console.error('║  git commit --no-verify 可跳过（不推荐）                       ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');

  process.exit(2);
}

/** 后合并分支清理提醒 — 不阻断,仅 console.error */
function remindBranchCleanup() {
  const r = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.status !== 0) return;
  const branch = r.stdout.trim();
  if (branch === 'main' || branch === 'master') {
    // 刚合并到 main, 提醒删除功能分支
    const r2 = run('git', ['branch', '--merged']);
    if (r2.status === 0) {
      const merged = r2.stdout.split('\n').map(s => s.trim().replace(/^\*\s*/, '')).filter(b => b && b !== 'main' && b !== 'master');
      if (merged.length > 0) {
        console.error('[BranchCleanup] 已合并的分支: ' + merged.join(', ') + ' | 考虑删除: git branch -d <分支名>');
      }
    }
  }
}

async function mainWithCleanup() {
  await main();
  remindBranchCleanup();
}
mainWithCleanup();
