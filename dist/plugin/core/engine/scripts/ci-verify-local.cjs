'use strict';

/**
 * scripts/ci-verify-local.cjs — 推送前本地 CI 全步骤模拟（门禁工具）。
 *
 * 背景：#86-#101 十六个 run 连红的根因全部是"本机开发环境 vs runner 全新
 * checkout"的差异（无 dist/、无 skills 镜像、无 codex/grok 渲染产物、无
 * settings.local.json、home 无本机状态）。本脚本在临时 fresh clone +
 * 临时 runner home 里运行 .github/workflows/lint-health.yml 的项目检查。
 * Node/Python 等工具来自当前 PATH，结果受本机版本约束。
 *
 * 用法：node core/engine/scripts/ci-verify-local.cjs [--keep]
 * 退出码：0 = CI-READY（可推送）；1 = 某步骤红（勿推送）；2 = 环境缺失。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-verify-'));
const CLONE = path.join(TMP, 'repo');
const RUNNER_HOME = path.join(TMP, 'runner-home');
const SYSTEM_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);
const runnerEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => SYSTEM_ENV_KEYS.has(name.toUpperCase()))),
  HOME: RUNNER_HOME,
  USERPROFILE: RUNNER_HOME,
  APPDATA: path.join(RUNNER_HOME, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(RUNNER_HOME, 'AppData', 'Local'),
  TMP: TMP,
  TEMP: TMP,
  TMPDIR: TMP,
  GIT_CONFIG_NOSYSTEM: '1',
  HARNESS_ROOT: CLONE,
  CI: 'true',
};

function run(label, cmd, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout || 600_000,
    windowsHide: true,
    cwd: opts.cwd || CLONE,
    env: { ...runnerEnv, ...opts.env },
    maxBuffer: 8 * 1024 * 1024,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  const ok = r.status === 0 && !r.error;
  console.log(`  ${ok ? '✅' : '❌'} ${label} (${secs}s)`);
  if (!ok) {
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-20).join('\n');
    console.log(`     └─ exit=${r.status} signal=${r.signal || 'none'} error=${r.error?.message || 'none'}\n${tail.split('\n').map((l) => `     ${l}`).join('\n')}`);
  }
  return ok;
}

function main() {
  console.log('━━━ 本地 CI 模拟（fresh clone + runner home）━━━');
  fs.mkdirSync(RUNNER_HOME, { recursive: true });

  // checkout
  console.log('[1/8] checkout（fresh clone，无本机残留）');
  const sourceDirectory = SOURCE_ROOT.replace(/\\/g, '/');
  const cloned = run('git clone', 'git',
    ['-c', `safe.directory=${sourceDirectory}`, 'clone', '-c', 'core.longpaths=true', '--no-local', '--quiet', '--', SOURCE_ROOT, CLONE],
    { cwd: TMP });
  if (!cloned) return 2;

  // runner 特征自检：退跟踪文件必须不在 checkout 里（审计 P2-5 教训）
  const leaked = ['settings.local.json'].filter((f) => fs.existsSync(path.join(CLONE, f)));
  if (leaked.length) {
    console.log(`  ❌ runner 特征自检失败：${leaked.join(', ')} 不应出现在 checkout（退跟踪失效）`);
    return 1;
  }

  console.log('[2/8] step5 Verify Git/CI/MCP/plugin contracts');
  const s5 = run('contract tests', process.execPath,
    ['--test', 'core/engine/scripts/test-hooks/git-ci-repro-contract.test.cjs', 'core/engine/scripts/test-hooks/gate-bypass-contract.test.cjs']);

  console.log('[3/8] step7 render-hook-settings + workflow mirror');
  const s7 = run('render-hook-settings', process.execPath, ['core/engine/scripts/render-hook-settings.cjs'])
    && run('render-hook-settings --check', process.execPath, ['core/engine/scripts/render-hook-settings.cjs', '--check'])
    && run('sync-workflow-mirror', process.execPath, ['core/engine/scripts/sync-workflow-mirror.cjs'])
    && run('sync-workflow-mirror --check', process.execPath, ['core/engine/scripts/sync-workflow-mirror.cjs', '--check']);
  if (!s7) return 1;

  console.log('[4/8] step8 skill mirrors（三宿主）');
  const s8 = run('sync-skills', process.execPath, ['core/engine/scripts/sync-skills.cjs'])
    && run('sync-skills --check', process.execPath, ['core/engine/scripts/sync-skills.cjs', '--check']);

  console.log('[5/8] step9 codex + grok projections（runner home）');
  const s9 = run('render-codex-hooks', process.execPath, ['core/engine/scripts/render-codex-hooks.cjs'])
    && run('render-codex-hooks --check', process.execPath, ['core/engine/scripts/render-codex-hooks.cjs', '--check']);
  const s9b = run('render-grok-hooks', process.execPath, ['core/engine/scripts/render-grok-hooks.cjs'])
    && run('render-grok-hooks --check', process.execPath, ['core/engine/scripts/render-grok-hooks.cjs', '--check']);

  console.log('[6/8] step10 plugin distribution（skills 镜像 + dist）');
  const s10 = run('sync-skills → workspace 镜像', process.execPath, ['core/engine/scripts/sync-skills.cjs'],
    { env: { HARNESS_SKILLS_DIR: path.join(CLONE, 'skills') } })
    && run('sync-plugin-dist', process.execPath, ['core/engine/scripts/sync-plugin-dist.cjs'])
    && run('sync-plugin-dist --check', process.execPath, ['core/engine/scripts/sync-plugin-dist.cjs', '--check']);

  console.log('[7/8] step11 fail-closed gate（verify-only env）');
  const coverageFile = path.join(CLONE, 'var', 'coverage', 'coverage-summary.json');
  const gateEnv = {
    HARNESS_COVERAGE_SUMMARY_FILE: coverageFile,
    HARNESS_NO_PERSIST: '1',
    HARNESS_VERIFY_READONLY: '1',
    HARNESS_NO_DIAGNOSTIC_WRITES: '1',
  };
  const s11 = run('harness-ci', process.execPath, ['core/engine/scripts/harness-ci.cjs'],
    { env: gateEnv, timeout: 900_000 });

  console.log('[8/8] gate 失败摘要提取');
  const logPath = path.join(CLONE, 'var', 'ci');
  if (fs.existsSync(logPath)) {
    for (const f of fs.readdirSync(logPath).filter((n) => n.startsWith('harness-ci'))) {
      const log = fs.readFileSync(path.join(logPath, f), 'utf8');
      const fails = log.split('\n').filter((l) => l.includes('FAIL') || l.includes('✖'));
      if (fails.length) console.log(`  ${f} 失败行:\n${fails.slice(0, 5).map((l) => `    ${l}`).join('\n')}`);
    }
  }

  const hasCoverage = fs.existsSync(coverageFile) && fs.statSync(coverageFile).size > 0;
  if (s11 && !hasCoverage) console.log('  ❌ 工作区缺少覆盖率报告 var/coverage/coverage-summary.json');
  const allOk = s5 && s7 && s8 && s9 && s9b && s10 && s11 && hasCoverage;
  console.log(allOk
    ? `━━━ ✅ CI-READY：本地检查通过（Node ${process.version}，工具链来自本机） ━━━`
    : '━━━ ❌ NOT-READY：模拟红——勿推送，先修复 ━━━');
  return allOk ? 0 : 1;
}

try {
  process.exitCode = main();
} finally {
  if (process.argv.includes('--keep')) {
    console.log(`（保留现场：${TMP}）`);
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}
