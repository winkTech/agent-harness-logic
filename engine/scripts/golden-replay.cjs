#!/usr/bin/env node
'use strict';

/**
 * golden-replay — golden task replayer.
 *
 * For a pinned batch of tasks, replays each task on a detached git worktree
 * at a pinned commit, driving a headless claude CLI run, then objectively
 * scores the result via an eval command and harvests real billing data from
 * the session transcript.
 *
 * Config schema (JSON, resolved relative to the config file's directory
 * unless absolute):
 * {
 *   "batchId":  "batch-2026-01",        // required, report file key
 *   "repoRoot": "../..",                // required, git repo to replay on
 *   "permissionMode": "acceptEdits",    // optional, batch default (acceptEdits|bypassPermissions|default|plan)
 *   "model": "claude-sonnet-4-5",       // optional, batch default --model
 *   "tasks": [{
 *     "id": "fix-null-guard",          // required
 *     "category": "bugfix",            // optional label
 *     "commit": "abc1234",             // required, pinned commit (sha/ref)
 *     "promptFile": "prompts/t1.txt",  // required, prompt text file
 *     "maxTurns": 30,                  // optional, default 30 (see NOTE-MAX-TURNS)
 *     "evalCommand": "npm test",       // required, pass = exit 0 (run in worktree)
 *     "runs": 1,                       // optional, default 1
 *     "restorePaths": ["engine/scripts/test-hooks"], // optional, see NOTE-RESTORE-PATHS
 *     "applyPatch": "patches/mutation.patch",  // optional, git-applied in the
 *                                              // worktree right after creation
 *                                              // (start state; see NOTE-TASK-PACKAGE)
 *     "injectFiles": [                         // optional, task-package files
 *       {"src": "tasks/P-T2/acceptance.test.cjs",
 *        "dst": "engine/scripts/test-hooks/..."}, // placed at start AND re-placed
 *     ],                                       // before eval (see NOTE-TASK-PACKAGE)
 *     "permissionMode": "bypassPermissions", // optional, overrides batch
 *     "model": "claude-opus-5"         // optional, overrides batch
 *   }]
 * }
 *
 * NOTE-MAX-TURNS: config maxTurns is recorded for budgeting/reporting but is
 * NOT forwarded to the CLI: claude 2.1.261 `--help` has no --max-turns flag
 * (verified 2026-11-05). If a future CLI adds it, forward it here.
 *
 * NOTE-RESTORE-PATHS: anti-tamper guard. After the agent run and BEFORE
 * evalCommand, every path in the task's restorePaths is reverted inside the
 * worktree via `git checkout -- <path>` (default ["engine/scripts/test-hooks"]),
 * so a misbehaving agent cannot edit the harness's acceptance tests to fake a
 * pass. Convention: acceptance tests injected by the TASK PACKAGE must live
 * OUTSIDE restorePaths and are referenced directly by evalCommand — the
 * harness-owned test hooks are restored, the task's own eval assets are not.
 *
 * NOTE-TASK-PACKAGE: start-state and eval-asset provisioning.
 *  - applyPatch: applied via `git apply` inside the worktree immediately after
 *    creation (before the agent runs). A failed apply aborts the run loudly —
 *    a wrong start state must never be judged.
 *  - injectFiles: copied src→dst at the same moment, AND re-copied after the
 *    restorePaths revert, right before eval. Rationale: injected files are
 *    untracked, so `git checkout --` does NOT revert them; a misbehaving agent
 *    could tamper an injected acceptance test. Re-placing the canonical copy
 *    from the task package closes that hole (curator spec §4.1). A failed
 *    re-place also aborts the run — an eval without the canonical asset is
 *    not judgeable.
 *
 * NOTE-CHILD-ENV: each claude child process gets
 *  - HARNESS_STATE_DIR=<worktree>/.harness-state (pre-created; kept after the
 *    run for harvest diagnosis) so hooks/observers write telemetry into the
 *    worktree instead of leaking through to the real state root, and
 *  - READONLY_ENV_VARS removed (see constant below; matches the zero-write
 *    guard in engine/scripts/lib/hook-latency.cjs persistenceDisabled() and
 *    hook-health.cjs): the replay environment must ALLOW hook telemetry
 *    writes — they are already isolated by HARNESS_STATE_DIR.
 *
 * Usage:
 *   node golden-replay.cjs <batchId> [--dry-run] [--yes] [--budget-usd N]
 *        [--config <path>] [--out <path>] [--worktree-root <dir>]
 *
 * Defaults: --config var/golden/<batchId>.config.json (under harness root);
 * dry-run is the default mode — real execution requires explicit --yes.
 *
 * Billing harvest (transcript under <claudeConfigDir>/projects/<cwd-slug>/):
 *  - cost-state: last record in file order = final cumulative
 *    (periodic double-writes collapse naturally; dedupe key
 *     sessionId|startTime|totalCostUSD per cost-state-ingest.cjs)
 *  - assistant records: identity = message.id + content fingerprint
 *    (sha1 of the content array). Pure double-writes collapse; split turns
 *    (same id, different content blocks — observed on third-party endpoints)
 *    are kept. usage summed per kept record; tool_use counted per kept record.
 *  - tool call count: tool_use blocks in kept assistant records
 * cwd-slug rule (validated against real samples, e.g.
 * C:\Users\Lihan\.claude -> C--Users-Lihan--claude): every non-alphanumeric
 * character replaced with '-'.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { atomicWriteJson, resolvePath } = require('./lib/project-scope.cjs');

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_BUDGET_USD = 20;
const DEFAULT_PERMISSION_MODE = 'acceptEdits';
const EVAL_TIMEOUT_MS = 10 * 60 * 1000;
const MTIME_SLACK_MS = 5000;
/** Per-run claude child state dir, inside the worktree (kept after the run). */
const HARNESS_STATE_DIRNAME = '.harness-state';
/**
 * Read-only env switches stripped from the claude child env. Exact group per
 * engine/scripts/lib/hook-latency.cjs persistenceDisabled() (lines 41-44) —
 * identical list in hook-health.cjs (lines 27-30). With these set, hooks write
 * zero telemetry; replay must allow writes (isolated by HARNESS_STATE_DIR).
 */
const READONLY_ENV_VARS = [
  'CLAUDE_HARNESS_NO_PERSIST',
  'CLAUDE_HARNESS_VERIFY_READONLY',
  'CLAUDE_NO_DIAGNOSTIC_WRITES',
  'CLAUDE_HOOK_NO_WRITE',
];
/** Default restorePaths: harness-owned acceptance-test hooks. */
const DEFAULT_RESTORE_PATHS = ['engine/scripts/test-hooks'];

/* ------------------------------------------------------------------ args */

function usage() {
  process.stdout.write([
    'Usage: node golden-replay.cjs <batchId> [options]',
    '  <batchId>             batch name; config defaults to var/golden/<batchId>.config.json',
    '  --config <path>       explicit config path (overrides batchId default)',
    '  --yes                 real execution (default is --dry-run)',
    '  --budget-usd <n>      stop scheduling further runs once accumulated',
    '                        cost-state totalCostUSD exceeds n (default 20)',
    '  --out <path>          report path (default var/metrics/golden-replay/report-<batchId>.json)',
    '  --worktree-root <dir> worktree base dir (default var/tmp/golden)',
    '  --help                this help',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    batchId: '',
    config: '',
    yes: false,
    budgetUsd: DEFAULT_BUDGET_USD,
    out: '',
    worktreeRoot: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') args.config = argv[++i];
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--budget-usd') args.budgetUsd = Number(argv[++i]);
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--worktree-root') args.worktreeRoot = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dry-run') { /* default mode, accepted for explicitness */ }
    else if (!arg.startsWith('-') && !args.batchId) args.batchId = arg;
    else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      usage();
      process.exit(2);
    }
  }
  if (!Number.isFinite(args.budgetUsd) || args.budgetUsd < 0) {
    process.stderr.write('--budget-usd must be a non-negative number\n');
    process.exit(2);
  }
  return args;
}

/* ---------------------------------------------------------------- config */

function loadConfig(args) {
  const configPath = args.config
    ? resolvePath(args.config)
    : path.join(HARNESS_ROOT, 'var', 'golden', `${args.batchId}.config.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`config not found: ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config || typeof config !== 'object') throw new Error('config must be a JSON object');
  if (!config.batchId || typeof config.batchId !== 'string') throw new Error('config.batchId is required');
  if (!config.repoRoot || typeof config.repoRoot !== 'string') throw new Error('config.repoRoot is required');
  if (!Array.isArray(config.tasks) || config.tasks.length === 0) throw new Error('config.tasks must be a non-empty array');
  const configDir = path.dirname(configPath);
  const repoRoot = resolvePath(config.repoRoot, configDir);
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw new Error(`repoRoot is not a git repo: ${repoRoot}`);
  }
  const tasks = config.tasks.map((raw, index) => {
    const task = {
      id: String(raw.id || '').trim(),
      category: String(raw.category || 'uncategorized'),
      commit: String(raw.commit || '').trim(),
      maxTurns: Number.isFinite(Number(raw.maxTurns)) ? Number(raw.maxTurns) : DEFAULT_MAX_TURNS,
      runs: Math.max(1, Number.isFinite(Number(raw.runs)) ? Math.floor(Number(raw.runs)) : 1),
      permissionMode: String(raw.permissionMode || config.permissionMode || DEFAULT_PERMISSION_MODE),
      model: raw.model || config.model || '',
      evalCommand: String(raw.evalCommand || '').trim(),
      restorePaths: Array.isArray(raw.restorePaths)
        ? raw.restorePaths.map((p) => String(p)).filter(Boolean)
        : DEFAULT_RESTORE_PATHS.slice(),
      applyPatch: raw.applyPatch ? resolvePath(raw.applyPatch, configDir) : '',
      injectFiles: Array.isArray(raw.injectFiles)
        ? raw.injectFiles.map((f) => ({ src: resolvePath(f.src, configDir), dst: String(f.dst || '') }))
        : [],
      promptFile: raw.promptFile ? resolvePath(raw.promptFile, configDir) : '',
    };
    if (!task.id) throw new Error(`tasks[${index}].id is required`);
    if (!task.commit) throw new Error(`tasks[${index}].commit is required`);
    if (task.applyPatch && !fs.existsSync(task.applyPatch)) {
      throw new Error(`tasks[${index}].applyPatch not found: ${raw.applyPatch}`);
    }
    for (const f of task.injectFiles) {
      if (!f.dst) throw new Error(`tasks[${index}].injectFiles[].dst is required`);
      if (!fs.existsSync(f.src)) throw new Error(`tasks[${index}].injectFiles[].src not found: ${f.src}`);
    }
    if (!task.promptFile || !fs.existsSync(task.promptFile)) {
      throw new Error(`tasks[${index}].promptFile not found: ${raw.promptFile}`);
    }
    if (!task.evalCommand) throw new Error(`tasks[${index}].evalCommand is required`);
    return task;
  });
  return { config, configPath, repoRoot, tasks };
}

/* ------------------------------------------------------------------- git */

function git(repoRoot, gitArgs, opts = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...gitArgs], {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120000,
  });
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`git ${gitArgs.join(' ')} failed (exit ${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function prepareWorktree(repoRoot, worktreePath, commit) {
  // Reuse the path: an existing directory (registered or leftover) is removed first.
  if (fs.existsSync(worktreePath)) {
    git(repoRoot, ['worktree', 'remove', '--force', worktreePath], { allowFailure: true });
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch (rmError) {
      // Host safe-delete/trash layers can veto recursive deletes (observed:
      // "Error during a `trash` operation"). Move the leftover aside instead
      // so the run proceeds on a clean path; the stale copy is cleaned later.
      const stale = `${worktreePath}.stale-${Date.now()}`;
      try {
        fs.renameSync(worktreePath, stale);
      } catch (renameError) {
        throw new Error(
          `worktree reuse cleanup failed: rm=${String(rmError.message || rmError)} `
          + `rename=${String(renameError.message || renameError)}`,
        );
      }
    }
  }
  git(repoRoot, ['worktree', 'prune']);
  // Force LF in replay worktrees: global core.autocrlf=true would check out
  // CRLF and break LF-context applyPatch files (git apply matches exactly).
  git(repoRoot, ['-c', 'core.autocrlf=false', 'worktree', 'add', '--detach', worktreePath, commit]);
}

function cleanupWorktree(repoRoot, worktreePath) {
  try {
    git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    return { removed: true, warning: '' };
  } catch (error) {
    return { removed: false, warning: String(error.message || error) };
  }
}

/** Revert restorePaths inside the worktree (git -C worktree checkout -- path). */
function restoreTaskPaths(worktreePath, restorePaths) {
  return restorePaths.map((p) => {
    try {
      git(worktreePath, ['checkout', '--', p]);
      return { path: p, ok: true };
    } catch (error) {
      // Tolerated: a path absent from the pinned commit has nothing to revert.
      return { path: p, ok: false, error: String(error.message || error) };
    }
  });
}

/** Apply the task-package patch in the worktree (start state). Throws loudly. */
function applyTaskPatch(worktreePath, patchPath) {
  git(worktreePath, ['apply', '--whitespace=nowarn', patchPath]);
  return { patch: path.basename(patchPath), ok: true };
}

/** Copy task-package files into the worktree (start state). Throws loudly. */
function injectTaskFiles(injectFiles, worktreePath) {
  return injectFiles.map((f) => {
    const dst = path.join(worktreePath, f.dst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f.src, dst);
    return { dst: f.dst, ok: true };
  });
}

/**
 * Re-place task-package files after the restorePaths revert, right before
 * eval (NOTE-TASK-PACKAGE): injected files are untracked, so the anti-tamper
 * checkout cannot restore them. Throws loudly — an eval without the canonical
 * asset is not judgeable.
 */
function reinjectTaskFiles(injectFiles, worktreePath) {
  return injectFiles.map((f) => {
    const dst = path.join(worktreePath, f.dst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f.src, dst);
    return { dst: f.dst, ok: true };
  });
}

/* ---------------------------------------------------------------- claude */

function resolveClaudeCmd() {
  if (process.env.CLAUDE_CMD) return process.env.CLAUDE_CMD;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const cmd = path.join(process.env.APPDATA, 'npm', 'claude.cmd');
    if (fs.existsSync(cmd)) return cmd;
  }
  return 'claude'; // PATH fallback
}

function runClaude(claudeCmd, cliArgs, opts) {
  if (process.platform === 'win32') {
    // .cmd files require a shell; args contain only fixed flags (prompt goes
    // via stdin), so a pre-quoted command line is safe.
    const cmdLine = /\s/.test(claudeCmd) ? `"${claudeCmd}"` : claudeCmd;
    return spawnSync(`${cmdLine} ${cliArgs.join(' ')}`, { ...opts, shell: true });
  }
  return spawnSync(claudeCmd, cliArgs, opts);
}

/** Child env: strip read-only switches, pin HARNESS_STATE_DIR into worktree. */
function buildChildEnv(worktreePath) {
  const env = { ...process.env };
  for (const key of READONLY_ENV_VARS) delete env[key];
  const stateDir = path.join(worktreePath, HARNESS_STATE_DIRNAME);
  fs.mkdirSync(stateDir, { recursive: true });
  env.HARNESS_STATE_DIR = stateDir;
  return env;
}

function runHeadless(task, worktreePath, runIndex) {
  const prompt = fs.readFileSync(task.promptFile, 'utf8');
  const cliArgs = [
    '-p',
    '--output-format', 'json',
    '--permission-mode', task.permissionMode,
  ];
  if (task.model) cliArgs.push('--model', task.model);
  // NOTE-MAX-TURNS: maxTurns not forwarded — claude 2.1.261 has no such flag.
  const startedAt = Date.now();
  const result = runClaude(resolveClaudeCmd(), cliArgs, {
    cwd: worktreePath,
    input: prompt,
    encoding: 'utf8',
    timeout: Math.max(600000, task.maxTurns * 60000),
    env: buildChildEnv(worktreePath),
  });
  const wallMs = Date.now() - startedAt;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return {
    claudeExitCode: result.status,
    ok: result.status === 0,
    wallMs,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stdout,
    error: result.error ? String(result.error.message || result.error) : '',
    startedAt,
    runIndex,
  };
}

/* -------------------------------------------------------------- harvest */

function cwdSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function projectsDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

function findTranscript(worktreePath, startedAt) {
  const dir = path.join(projectsDir(), cwdSlug(worktreePath));
  if (!fs.existsSync(dir)) return '';
  let best = { file: '', mtimeMs: -1 };
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs + MTIME_SLACK_MS < startedAt) continue;
    if (stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
  }
  return best.file;
}

function emptyTokens() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function harvestTranscript(file) {
  const cost = {
    totalCostUSD: null,
    totalAPIDuration: null,
    totalToolDuration: null,
  };
  const tokens = emptyTokens();
  let toolUseCount = 0;
  const seenRecords = new Set(); // id + content fingerprint — see note above
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'cost-state') {
      // last record in file order = final cumulative snapshot
      cost.totalCostUSD = typeof rec.totalCostUSD === 'number' ? rec.totalCostUSD : cost.totalCostUSD;
      cost.totalAPIDuration = rec.totalAPIDuration ?? cost.totalAPIDuration;
      cost.totalToolDuration = rec.totalToolDuration ?? cost.totalToolDuration;
    } else if (rec.type === 'assistant' && rec.message) {
      // Record identity = message.id + content fingerprint. A pure double-write
      // (identical copies) collapses; a split turn — same id emitted as several
      // records with DIFFERENT content blocks (observed on third-party
      // endpoints: first record thinking-only, later records carry tool_use) —
      // is kept, so tool_use counting stays exact.
      const id = typeof rec.message.id === 'string' ? rec.message.id : '';
      const fp = crypto.createHash('sha1')
        .update(JSON.stringify(rec.message.content ?? null))
        .digest('hex')
        .slice(0, 16);
      const recordKey = `${id || 'noid'}:${fp}`;
      if (seenRecords.has(recordKey)) continue;
      seenRecords.add(recordKey);
      const usage = rec.message.usage;
      if (usage && typeof usage === 'object') {
        tokens.inputTokens += Number(usage.input_tokens) || 0;
        tokens.outputTokens += Number(usage.output_tokens) || 0;
        tokens.cacheReadInputTokens += Number(usage.cache_read_input_tokens) || 0;
        tokens.cacheCreationInputTokens += Number(usage.cache_creation_input_tokens) || 0;
      }
      if (Array.isArray(rec.message.content)) {
        toolUseCount += rec.message.content.filter((block) => block && block.type === 'tool_use').length;
      }
    }
  }
  return { cost, tokens, toolUseCount };
}

/* ----------------------------------------------------------------- eval */

function runEval(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    encoding: 'utf8',
    shell: true,
    timeout: EVAL_TIMEOUT_MS,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  return {
    command,
    exitCode: result.status,
    pass: result.status === 0,
    outputTail: output.length > 2000 ? `...${output.slice(-2000)}` : output,
  };
}

/* --------------------------------------------------------------- median */

function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function majorityPass(runs) {
  if (runs.length === 0) return false;
  return runs.filter((r) => r.eval && r.eval.pass === true).length > runs.length / 2;
}

/* ------------------------------------------------------------------ main */

function round4(value) {
  return typeof value === 'number' ? Math.round(value * 10000) / 10000 : value;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }
  if (!args.batchId && !args.config) {
    process.stderr.write('batchId or --config is required\n');
    usage();
    process.exit(2);
  }

  const { config, configPath, repoRoot, tasks } = loadConfig(args);
  const batchId = args.batchId || config.batchId;
  const reportPath = args.out
    ? resolvePath(args.out)
    : path.join(HARNESS_ROOT, 'var', 'metrics', 'golden-replay', `report-${batchId}.json`);
  const worktreeRoot = args.worktreeRoot
    ? resolvePath(args.worktreeRoot)
    : path.join(HARNESS_ROOT, 'var', 'tmp', 'golden');
  const dryRun = !args.yes;

  const plan = {
    batchId,
    mode: dryRun ? 'dry-run' : 'execute',
    budgetUsd: args.budgetUsd,
    repoRoot,
    reportPath,
    tasks: tasks.map((t) => ({
      id: t.id,
      category: t.category,
      commit: t.commit,
      runs: t.runs,
      maxTurns: t.maxTurns,
      permissionMode: t.permissionMode,
      model: t.model || '(cli default)',
      promptFile: t.promptFile,
      evalCommand: t.evalCommand,
      restorePaths: t.restorePaths,
      applyPatch: t.applyPatch || '',
      injectFiles: t.injectFiles || [],
    })),
  };

  if (dryRun) {
    process.stdout.write(`golden-replay dry-run — batch ${batchId}\n`);
    process.stdout.write(`repoRoot: ${repoRoot}\n`);
    process.stdout.write(`budget: $${args.budgetUsd}  claudeCmd: ${resolveClaudeCmd()}\n`);
    for (const t of plan.tasks) {
      process.stdout.write(`  plan ${t.id} [${t.category}] commit=${t.commit} runs=${t.runs} `
        + `maxTurns=${t.maxTurns}(not forwarded, no CLI flag) mode=${t.permissionMode} ${t.model}\n`);
      process.stdout.write(`    prompt: ${t.promptFile}\n    eval:   ${t.evalCommand}\n`);
      process.stdout.write(`    restorePaths: ${JSON.stringify(t.restorePaths)}\n`);
      if (t.applyPatch) process.stdout.write(`    applyPatch:  ${t.applyPatch}\n`);
      if (t.injectFiles.length) {
        process.stdout.write(`    injectFiles: ${JSON.stringify(t.injectFiles.map((f) => f.dst))}\n`);
      }
    }
    process.stdout.write(`would write report to: ${reportPath}\n`);
    process.stdout.write('dry-run complete — no claude invocation, no worktree created\n');
    process.exit(0);
  }

  const taskReports = [];
  let accumulatedUsd = 0;
  let aborted = null;

  for (const task of tasks) {
    if (aborted) {
      taskReports.push({ id: task.id, category: task.category, commit: task.commit, runs: [], skipped: aborted });
      continue;
    }
    const runs = [];
    for (let runIndex = 1; runIndex <= task.runs; runIndex++) {
      const worktreePath = path.join(worktreeRoot, `${task.id}-r${runIndex}`);
      const entry = {
        run: runIndex,
        worktree: worktreePath,
        ok: false,
        claudeExitCode: null,
        wallMs: null,
        stdoutBytes: null,
        transcript: '',
        cost: null,
        tokens: null,
        toolUseCount: null,
        eval: null,
        restore: [],
        reinject: [],
        setup: null,
        harnessStateDir: '',
        error: '',
      };
      try {
        prepareWorktree(repoRoot, worktreePath, task.commit);
        entry.setup = { patch: null, inject: [] };
        if (task.applyPatch) entry.setup.patch = applyTaskPatch(worktreePath, task.applyPatch);
        if (task.injectFiles.length) entry.setup.inject = injectTaskFiles(task.injectFiles, worktreePath);
        const headless = runHeadless(task, worktreePath, runIndex);
        entry.harnessStateDir = path.join(worktreePath, HARNESS_STATE_DIRNAME);
        Object.assign(entry, {
          ok: headless.ok,
          claudeExitCode: headless.claudeExitCode,
          wallMs: headless.wallMs,
          stdoutBytes: headless.stdoutBytes,
          error: headless.error,
        });
        const transcript = findTranscript(worktreePath, headless.startedAt);
        if (transcript) {
          entry.transcript = transcript;
          const harvested = harvestTranscript(transcript);
          entry.cost = harvested.cost;
          entry.tokens = harvested.tokens;
          entry.toolUseCount = harvested.toolUseCount;
          if (typeof harvested.cost.totalCostUSD === 'number') {
            accumulatedUsd += harvested.cost.totalCostUSD;
          }
        } else {
          entry.error = entry.error || 'transcript not found';
        }
        // Anti-tamper: revert harness test-hook paths before judging (NOTE-RESTORE-PATHS).
        entry.restore = restoreTaskPaths(worktreePath, task.restorePaths);
        // Re-place task-package eval assets after the revert (NOTE-TASK-PACKAGE):
        // injected files are untracked, so the checkout above cannot restore them.
        entry.reinject = task.injectFiles.length ? reinjectTaskFiles(task.injectFiles, worktreePath) : [];
        entry.eval = runEval(task.evalCommand, worktreePath);
      } catch (error) {
        entry.error = entry.error || String(error.message || error);
      } finally {
        entry.worktreeCleanup = cleanupWorktree(repoRoot, worktreePath);
        if (!entry.worktreeCleanup.removed && !entry.worktreeCleanup.warning) {
          entry.worktreeCleanup.warning = 'unknown';
        }
      }
      runs.push(entry);
      if (accumulatedUsd > args.budgetUsd) {
        aborted = 'budget';
        process.stdout.write(`budget exceeded: $${round4(accumulatedUsd)} > $${args.budgetUsd} — stopping after ${task.id} r${runIndex}\n`);
        break;
      }
    }
    taskReports.push({
      id: task.id,
      category: task.category,
      commit: task.commit,
      runs,
      medians: {
        costUSD: round4(median(runs.map((r) => r.cost && r.cost.totalCostUSD))),
        apiActiveMs: median(runs.map((r) => r.cost && r.cost.totalAPIDuration)),
        toolDurationMs: median(runs.map((r) => r.cost && r.cost.totalToolDuration)),
        actionCount: median(runs.map((r) => r.toolUseCount)),
        pass: majorityPass(runs),
      },
      pass: majorityPass(runs),
    });
  }

  const evaluated = taskReports.filter((t) => Array.isArray(t.runs) && t.runs.length > 0);
  const passedTasks = evaluated.filter((t) => t.pass).length;
  const report = {
    batchId,
    generatedAt: new Date().toISOString(),
    configPath,
    repoRoot,
    dryRun: false,
    budgetUsd: args.budgetUsd,
    accumulatedCostUSD: round4(accumulatedUsd),
    aborted,
    fpy: {
      passed: passedTasks,
      total: evaluated.length,
      ratio: evaluated.length > 0 ? Math.round((passedTasks / evaluated.length) * 10000) / 10000 : null,
    },
    tasks: taskReports,
  };

  atomicWriteJson(reportPath, report);

  process.stdout.write(`golden-replay batch ${batchId} complete${aborted ? ` (aborted:${aborted})` : ''}\n`);
  process.stdout.write(`FPY ${passedTasks}/${evaluated.length}  accumulated $${round4(accumulatedUsd)}\n`);
  for (const t of evaluated) {
    process.stdout.write(`  ${t.pass ? 'PASS' : 'FAIL'} ${t.id}  median $${t.medians.costUSD}  `
      + `api=${t.medians.apiActiveMs}ms  actions=${t.medians.actionCount}\n`);
  }
  process.stdout.write(`report: ${reportPath}\n`);
  process.exit(aborted ? 1 : 0);
}

try {
  main();
} catch (error) {
  process.stderr.write(`golden-replay failed: ${error.stack || error.message}\n`);
  process.exit(1);
}
