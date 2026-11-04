#!/usr/bin/env node
'use strict';

/**
 * Contract test for golden-replay.cjs.
 * Never touches the real claude CLI or real repos:
 *  - builds a scratch git repo (one commit, one README) in a temp dir
 *  - installs a fake claude shim (writes a synthetic transcript with
 *    cost-state double-writes and assistant usage double-writes, exit 0)
 *    and injects it via CLAUDE_CMD + CLAUDE_CONFIG_DIR
 *  - runs the replayer on a synthetic 2-task config (one pass, one fail)
 * Asserts:
 *  - worktree established + cleaned up, shim invoked with correct cwd/args/stdin
 *  - harvest: final cumulative cost-state, usage dedup by message.id,
 *    token sums, tool_use count
 *  - eval executed in worktree; pass judged by exit code
 *  - report medians, task pass, FPY correct
 *  - dry-run mode performs zero shim invocations
 *  - budget stop marks aborted:budget and skips remaining tasks
 *  - anti-tamper: shim tampers a tracked file under the default restorePaths
 *    (engine/scripts/test-hooks); the pass task's eval only sees the ORIGINAL
 *    content, proving git checkout -- restored it before eval
 *  - child env: read-only switches (CLAUDE_HARNESS_NO_PERSIST /
 *    CLAUDE_HARNESS_VERIFY_READONLY / CLAUDE_NO_DIAGNOSTIC_WRITES /
 *    CLAUDE_HOOK_NO_WRITE) are stripped even when set by the parent
 *  - child env: HARNESS_STATE_DIR points inside the worktree and the shim
 *    observes the directory as existing at run time
 *  - task package: applyPatch applied at start (eval sees MUTATED app.js);
 *    injectFiles placed at start, tampered by the shim, and RE-PLACED after
 *    the restorePaths revert so eval sees the canonical canary content
 * Cleans up all temp artifacts.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'golden-replay.cjs');

let passed = 0;
let failed = 0;

function assert(name, condition, detail) {
  if (condition) {
    passed++;
    process.stdout.write(`  ok    ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function cwdSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/* ------------------------------------------------------------ fake shim */

// Synthetic transcript: cost-state written 3x (initial, duplicate double-write
// of final with jittered duration, final) and usage double-written per message.
const TRANSCRIPT_LINES = [
  { type: 'cost-state', sessionId: 'SID', startTime: 1000, totalCostUSD: 0.01, totalAPIDuration: 1000, totalToolDuration: 400 },
  { type: 'cost-state', sessionId: 'SID', startTime: 2000, totalCostUSD: 0.025, totalAPIDuration: 2488, totalToolDuration: 890 },
  { type: 'cost-state', sessionId: 'SID', startTime: 2000, totalCostUSD: 0.025, totalAPIDuration: 2500, totalToolDuration: 900 },
  { type: 'assistant', message: { id: 'msg_a', model: 'claude-shim', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }, content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Read' }, { type: 'tool_use', id: 't2', name: 'Edit' }] } },
  { type: 'assistant', message: { id: 'msg_a', model: 'claude-shim', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }, content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Read' }, { type: 'tool_use', id: 't2', name: 'Edit' }] } },
  { type: 'assistant', message: { id: 'msg_b', model: 'claude-shim', usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 8, cache_creation_input_tokens: 3 }, content: [{ type: 'tool_use', id: 't3', name: 'Bash' }] } },
];

function buildShim(shimDir) {
  const shimJs = path.join(shimDir, 'claude-shim.js');
  write(shimJs, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
const cwd = process.cwd();
const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
const sessionId = crypto.randomUUID();
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(require('node:os').homedir(), '.claude');
const dir = path.join(configDir, 'projects', slug);
fs.mkdirSync(dir, { recursive: true });
const lines = JSON.parse(fs.readFileSync(process.env.GOLDEN_SHIM_TRANSCRIPT, 'utf8'))
  .map((rec) => JSON.stringify({ ...rec, sessionId }));
fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), lines.join('\\n') + '\\n', 'utf8');
// Simulate a misbehaving agent: tamper a tracked file under the harness's
// default restorePaths so the contract can prove eval sees restored content.
try {
  const guard = path.join(cwd, 'engine', 'scripts', 'test-hooks', 'guard.txt');
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  fs.writeFileSync(guard, 'GUARD-TAMPERED', 'utf8');
} catch { /* tamper is best-effort */ }
// Simulate tampering of the task-package-injected (untracked) acceptance file:
// git checkout -- does NOT revert untracked files, so only the re-place step
// can bring the canonical content back before eval.
try {
  const canary = path.join(cwd, 'engine', 'scripts', 'test-hooks', 'injected-canary.txt');
  if (fs.existsSync(canary)) fs.writeFileSync(canary, 'CANARY-TAMPERED', 'utf8');
} catch { /* tamper is best-effort */ }
const READONLY_KEYS = ['CLAUDE_HARNESS_NO_PERSIST', 'CLAUDE_HARNESS_VERIFY_READONLY', 'CLAUDE_NO_DIAGNOSTIC_WRITES', 'CLAUDE_HOOK_NO_WRITE'];
fs.appendFileSync(process.env.GOLDEN_SHIM_LOG, JSON.stringify({
  cwd, argv, stdin,
  env: {
    harnessStateDir: process.env.HARNESS_STATE_DIR || '',
    harnessStateDirExists: process.env.HARNESS_STATE_DIR
      ? fs.existsSync(process.env.HARNESS_STATE_DIR) : false,
    readonlyPresent: READONLY_KEYS.filter((k) => process.env[k] !== undefined),
  },
}) + '\\n', 'utf8');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId }));
process.exit(0);
`);
  if (process.platform === 'win32') {
    const wrapper = path.join(shimDir, 'claude.cmd');
    write(wrapper, `@echo off\r\nnode "%~dp0claude-shim.js" %*\r\n`);
    return wrapper;
  }
  const wrapper = path.join(shimDir, 'claude');
  write(wrapper, `#!/usr/bin/env node\nrequire('${shimJs.replace(/\\/g, '\\\\')}');\n`);
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

/* ----------------------------------------------------------------- setup */

function setupScratchRepo(root) {
  const repo = path.join(root, 'scratch-repo');
  fs.mkdirSync(repo, { recursive: true });
  const run = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const init = run(['init', '-b', 'main']);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  // Keep LF exact so the hand-crafted mutation patch applies deterministically.
  run(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# scratch\n', 'utf8');
  // Tracked file under the harness's default restorePaths: the shim tampers it
  // and the pass eval asserts the replayer restored the original content.
  fs.mkdirSync(path.join(repo, 'engine', 'scripts', 'test-hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'engine', 'scripts', 'test-hooks', 'guard.txt'), 'GUARD-ORIGINAL', 'utf8');
  // Tracked file targeted by the task package's applyPatch (start-state mutation).
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), "module.exports.tag = 'ORIGINAL';\n", 'utf8');
  run(['add', '.']);
  const commit = run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  const sha = run(['rev-parse', 'HEAD']).stdout.trim();
  return { repo, sha };
}

function readShimLog(logFile) {
  try {
    return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function cleanup(root) {
  try {
    // Best-effort: prune any leftover worktree registration before deleting.
    const repo = path.join(root, 'scratch-repo');
    if (fs.existsSync(repo)) spawnSync('git', ['-C', repo, 'worktree', 'prune'], { timeout: 30000 });
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-replay-contract-'));
  try {
    const { repo, sha } = setupScratchRepo(root);
    const shimDir = path.join(root, 'shim');
    const claudeCmd = buildShim(shimDir);
    const transcriptFixture = path.join(root, 'shim-transcript.json');
    write(transcriptFixture, JSON.stringify(TRANSCRIPT_LINES));

    const promptPass = path.join(root, 'prompt-pass.txt');
    const promptFail = path.join(root, 'prompt-fail.txt');
    write(promptPass, 'contract pass prompt');
    write(promptFail, 'contract fail prompt');

    const passScript = path.join(root, 'eval-pass.cjs');
    const failScript = path.join(root, 'eval-fail.cjs');
    const restoreObserved = path.join(root, 'restore-observed.txt');
    // Passes only if (a) the tampered guard file was reverted before eval,
    // (b) applyPatch's start-state mutation is present in src/app.js, and
    // (c) the tampered injected canary was re-placed from the task package.
    // Dumps everything observed for dedicated assertions.
    write(passScript, `
'use strict';
const fs = require('node:fs');
const observed = fs.readFileSync('engine/scripts/test-hooks/guard.txt', 'utf8');
const app = fs.readFileSync('src/app.js', 'utf8');
const canary = fs.readFileSync('engine/scripts/test-hooks/injected-canary.txt', 'utf8');
fs.writeFileSync(process.env.GOLDEN_RESTORE_OBSERVED, JSON.stringify({ guard: observed, app, canary }), 'utf8');
const pass = observed === 'GUARD-ORIGINAL'
  && app.includes("module.exports.tag = 'MUTATED';")
  && canary === 'INJECT-CANARY';
process.exit(pass ? 0 : 1);
`);
    write(failScript, 'process.exit(3);');

    // Task package: single-hunk mutation patch (ORIGINAL -> MUTATED) and the
    // canonical injected acceptance asset the shim will tamper mid-run.
    const mutationPatch = path.join(root, 'mutation.patch');
    write(mutationPatch, [
      'diff --git a/src/app.js b/src/app.js',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1 +1 @@',
      "-module.exports.tag = 'ORIGINAL';",
      "+module.exports.tag = 'MUTATED';",
      '',
    ].join('\n'));
    const canarySrc = path.join(root, 'task-package', 'injected-canary.txt');
    write(canarySrc, 'INJECT-CANARY');

    const worktreeRoot = path.join(root, 'wt');
    const cfg = {
      batchId: 'golden-contract',
      repoRoot: repo,
      permissionMode: 'acceptEdits',
      tasks: [
        { id: 't-pass', category: 'cat-a', commit: sha, promptFile: promptPass, maxTurns: 30, evalCommand: `node "${passScript}"`, runs: 1,
          applyPatch: mutationPatch,
          injectFiles: [{ src: canarySrc, dst: 'engine/scripts/test-hooks/injected-canary.txt' }] },
        { id: 't-fail', category: 'cat-b', commit: sha, promptFile: promptFail, maxTurns: 30, evalCommand: `node "${failScript}"`, runs: 1 },
      ],
    };
    const cfgPath = path.join(root, 'contract.config.json');
    write(cfgPath, JSON.stringify(cfg, null, 2));

    const shimLog = path.join(root, 'shim-log.jsonl');
    const reportPath = path.join(root, 'report.json');

    const baseEnv = {
      ...process.env,
      CLAUDE_CMD: claudeCmd,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
      GOLDEN_SHIM_LOG: shimLog,
      GOLDEN_SHIM_TRANSCRIPT: transcriptFixture,
      GOLDEN_RESTORE_OBSERVED: restoreObserved,
      // Deliberately set: the replayer must strip these from the claude child
      // env so hook telemetry writes stay enabled inside HARNESS_STATE_DIR.
      CLAUDE_HARNESS_NO_PERSIST: '1',
      CLAUDE_HARNESS_VERIFY_READONLY: '1',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
      CLAUDE_HOOK_NO_WRITE: '1',
    };

    /* -- dry-run: zero invocations ------------------------------------- */
    const dry = spawnSync(process.execPath, [
      SCRIPT, '--config', cfgPath, '--out', path.join(root, 'report-dry.json'),
    ], { encoding: 'utf8', env: baseEnv, timeout: 60000 });
    assert('dry-run exits 0', dry.status === 0, `status=${dry.status} stderr=${(dry.stderr || '').slice(0, 300)}`);
    assert('dry-run prints plan', /dry-run/.test(dry.stdout) && /t-pass/.test(dry.stdout) && /t-fail/.test(dry.stdout));
    assert('dry-run makes zero shim calls', readShimLog(shimLog).length === 0);
    assert('dry-run creates no worktrees', !fs.existsSync(worktreeRoot));

    /* -- real execution ------------------------------------------------ */
    const run = spawnSync(process.execPath, [
      SCRIPT, '--config', cfgPath, '--yes', '--budget-usd', '5',
      '--out', reportPath, '--worktree-root', worktreeRoot,
    ], { encoding: 'utf8', env: baseEnv, timeout: 120000 });
    assert('execute exits 0', run.status === 0, `status=${run.status} stderr=${(run.stderr || '').slice(0, 400)}`);

    let report = null;
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { /* below */ }
    assert('report written and parseable', !!report);
    if (!report) return;

    assert('report has 2 task entries', Array.isArray(report.tasks) && report.tasks.length === 2);

    const tPass = report.tasks.find((t) => t.id === 't-pass');
    const tFail = report.tasks.find((t) => t.id === 't-fail');
    assert('both tasks have run details', tPass && tFail && tPass.runs.length === 1 && tFail.runs.length === 1);

    const rPass = tPass.runs[0];
    const rFail = tFail.runs[0];

    assert('claude shim exited 0 both runs', rPass.claudeExitCode === 0 && rFail.claudeExitCode === 0);
    assert('wallMs and stdoutBytes recorded', rPass.wallMs >= 0 && rPass.stdoutBytes > 0);
    assert('transcript located', typeof rPass.transcript === 'string' && rPass.transcript.endsWith('.jsonl'));

    /* shim invocations: cwd, argv, stdin */
    const log = readShimLog(shimLog);
    assert('shim called exactly twice', log.length === 2, `calls=${log.length}`);
    const expectedWt1 = path.join(worktreeRoot, 't-pass-r1');
    const expectedWt2 = path.join(worktreeRoot, 't-fail-r1');
    if (log.length === 2) {
      assert('shim run1 cwd is task worktree', path.resolve(log[0].cwd) === path.resolve(expectedWt1), log[0].cwd);
      assert('shim run1 args contain -p/--output-format json/--permission-mode acceptEdits',
        log[0].argv.includes('-p') && log[0].argv.includes('--output-format')
        && log[0].argv[log[0].argv.indexOf('--output-format') + 1] === 'json'
        && log[0].argv.includes('--permission-mode')
        && log[0].argv[log[0].argv.indexOf('--permission-mode') + 1] === 'acceptEdits',
        JSON.stringify(log[0].argv));
      assert('shim run1 received prompt via stdin', log[0].stdin === 'contract pass prompt');
      assert('shim run2 cwd is second worktree', path.resolve(log[1].cwd) === path.resolve(expectedWt2), log[1].cwd);
      /* child env: HARNESS_STATE_DIR scoped to the worktree */
      const stateDir = log[0].env.harnessStateDir;
      assert('shim env HARNESS_STATE_DIR inside worktree, .harness-state, exists at run time',
        stateDir
        && path.resolve(stateDir).startsWith(path.resolve(expectedWt1) + path.sep)
        && path.basename(stateDir) === '.harness-state'
        && log[0].env.harnessStateDirExists === true,
        JSON.stringify(log[0].env));
      /* child env: read-only switches stripped despite being set by parent */
      assert('shim env has none of the 4 read-only harness vars',
        Array.isArray(log[0].env.readonlyPresent) && log[0].env.readonlyPresent.length === 0,
        JSON.stringify(log[0].env.readonlyPresent));
    }

    /* anti-tamper: eval observed the restored (original) guard content */
    let observedDump = '';
    try { observedDump = fs.readFileSync(restoreObserved, 'utf8'); } catch { /* below */ }
    let observed = { guard: '', app: '', canary: '' };
    try { observed = JSON.parse(observedDump); } catch { /* parse failures fail assertions below */ }
    assert('eval read restored guard.txt (tamper reverted before eval)',
      observed.guard === 'GUARD-ORIGINAL', JSON.stringify(observedDump));
    /* task package: applyPatch start state + injected asset re-placed pre-eval */
    assert('applyPatch start state visible to eval (src/app.js mutated)',
      String(observed.app).trim() === "module.exports.tag = 'MUTATED';", JSON.stringify(observed.app));
    assert('injected canary re-placed before eval (tamper overwritten by task package)',
      observed.canary === 'INJECT-CANARY', JSON.stringify(observed.canary));
    assert('run entry records restorePaths restore ok',
      Array.isArray(rPass.restore) && rPass.restore.length === 1
      && rPass.restore[0].path === 'engine/scripts/test-hooks' && rPass.restore[0].ok === true,
      JSON.stringify(rPass.restore));
    assert('run entry records setup.patch ok, setup.inject ok, reinject ok',
      rPass.setup && rPass.setup.patch && rPass.setup.patch.ok === true
      && Array.isArray(rPass.setup.inject) && rPass.setup.inject.length === 1
      && rPass.setup.inject[0].ok === true
      && Array.isArray(rPass.reinject) && rPass.reinject.length === 1
      && rPass.reinject[0].ok === true,
      JSON.stringify({ setup: rPass.setup, reinject: rPass.reinject }));

    /* harvest: cost-state last-wins + usage dedupe */
    assert('cost harvested with final cumulative (double-write collapsed)',
      rPass.cost && rPass.cost.totalCostUSD === 0.025
      && rPass.cost.totalAPIDuration === 2500
      && rPass.cost.totalToolDuration === 900,
      JSON.stringify(rPass.cost));
    assert('tokens deduped by message.id and summed',
      rPass.tokens
      && rPass.tokens.inputTokens === 140
      && rPass.tokens.outputTokens === 70
      && rPass.tokens.cacheReadInputTokens === 18
      && rPass.tokens.cacheCreationInputTokens === 8,
      JSON.stringify(rPass.tokens));
    assert('tool_use count = 3', rPass.toolUseCount === 3, String(rPass.toolUseCount));

    /* eval judgment */
    assert('t-pass eval pass=true', rPass.eval && rPass.eval.pass === true && rPass.eval.exitCode === 0);
    assert('t-fail eval pass=false exit 3', rFail.eval && rFail.eval.pass === false && rFail.eval.exitCode === 3);

    /* worktree cleanup */
    assert('worktrees removed after run',
      !fs.existsSync(expectedWt1) && !fs.existsSync(expectedWt2)
      && rPass.worktreeCleanup && rPass.worktreeCleanup.removed === true);

    /* medians + FPY */
    assert('t-pass medians match single run',
      tPass.medians.costUSD === 0.025 && tPass.medians.apiActiveMs === 2500
      && tPass.medians.actionCount === 3 && tPass.medians.pass === true,
      JSON.stringify(tPass.medians));
    assert('t-fail task pass=false', tFail.pass === false);
    assert('FPY = 1/2 = 0.5', report.fpy && report.fpy.passed === 1 && report.fpy.total === 2 && report.fpy.ratio === 0.5,
      JSON.stringify(report.fpy));
    assert('accumulated cost recorded', report.accumulatedCostUSD === 0.05, String(report.accumulatedCostUSD));
    assert('not aborted in full run', report.aborted === null);

    /* -- budget stop ---------------------------------------------------- */
    const budgetLog = path.join(root, 'shim-log-budget.jsonl');
    const budgetReport = path.join(root, 'report-budget.json');
    const budgetRun = spawnSync(process.execPath, [
      SCRIPT, '--config', cfgPath, '--yes', '--budget-usd', '0.001',
      '--out', budgetReport, '--worktree-root', path.join(root, 'wt-budget'),
    ], { encoding: 'utf8', env: { ...baseEnv, GOLDEN_SHIM_LOG: budgetLog }, timeout: 120000 });
    let bReport = null;
    try { bReport = JSON.parse(fs.readFileSync(budgetReport, 'utf8')); } catch { /* below */ }
    assert('budget run exits 1 and marks aborted:budget', budgetRun.status === 1 && bReport && bReport.aborted === 'budget');
    assert('budget run executed only first task', bReport && bReport.tasks.filter((t) => t.runs.length > 0).length === 1
      && bReport.tasks.find((t) => t.id === 't-fail').skipped === 'budget');
    assert('budget run shim called once', readShimLog(budgetLog).length === 1);
    process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
    cleanup(root);
    process.exit(failed > 0 ? 1 : 0);
  } catch (error) {
    cleanup(root);
    process.stdout.write(`contract test crashed: ${error.stack || error.message}\n`);
    process.exit(1);
  }
}

main();
