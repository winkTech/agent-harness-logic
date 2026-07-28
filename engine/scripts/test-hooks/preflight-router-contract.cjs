'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const settingsPath = path.join(HARNESS_ROOT, 'settings.json');
const routerPath = path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'preflight-router.cjs');
const EVALUATOR_MODULES = [
  'engine/scripts/hooks/verification-gate.cjs',
  'engine/scripts/hooks/pre-commit-lint.js',
  'engine/scripts/hooks/diff-size-gate.js',
  'engine/scripts/hooks/resource-budget-gate.js',
  'engine/scripts/hooks/bash-safety-guard.cjs',
  'engine/hooks/safety/fix-in-place-guard.cjs',
  'engine/scripts/hooks/file-protection-guard.cjs',
  'engine/scripts/hooks/project-directory-guard.cjs',
  'engine/scripts/hooks/repair-content-gate.cjs',
  'engine/scripts/hooks/hdl-gate.cjs',
  'engine/scripts/hooks/requirements-gate-guard.cjs',
  'engine/scripts/hooks/verification-quality-guard.cjs',
  'engine/scripts/hooks/rtl-semantic-oracle.cjs',
];

function runRouter(payload, env = {}) {
  return spawnSync(process.execPath, [routerPath], {
    cwd: HARNESS_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_HARNESS_NO_PERSIST: '1',
      CLAUDE_HARNESS_VERIFY_READONLY: '1',
      CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
      ...env,
    },
  });
}

function payload(toolName, toolInput = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    cwd: HARNESS_ROOT,
    session_id: 'preflight-router-contract',
  };
}

function assertSingleRouterRegistration() {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const groups = settings.hooks?.PreToolUse || [];
  const commands = groups.flatMap((group) => group.hooks || []);
  assert.equal(groups.length, 1, 'PreToolUse must have one matcher group');
  assert.equal(commands.length, 1, 'PreToolUse must launch one process');
  assert.match(commands[0].command || '', /preflight-router\.cjs/);
  assert.equal(groups[0].matcher || '*', '*');
}

function assertNoNestedExecution() {
  assert(fs.existsSync(routerPath), 'preflight-router.cjs is missing');
  const source = fs.readFileSync(routerPath, 'utf8');
  assert(!/child_process|spawn(?:Sync)?\s*\(|exec(?:File|Sync)?\s*\(|new\s+Worker\s*\(/.test(source),
    'preflight router must evaluate guards in-process without child processes or workers');
  assert(!source.includes("load: () => require('./pre-commit-lint.js')"),
    'pre-commit lint must stay in the Git hook, outside the 20-second PreToolUse path');
}

function assertGitCommandClassification() {
  const { gitSubcommand } = require(path.join(
    HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'verification-gate.cjs',
  ));
  assert.equal(gitSubcommand('git commit -m test'), 'commit');
  assert.equal(gitSubcommand('git -C "C:\\repo path" push origin HEAD'), 'push');
  assert.equal(gitSubcommand('cd package && git -c advice.detachedHead=false commit -m test'), 'commit');
  assert.equal(gitSubcommand('git -c core.sshCommand="ssh -i C:/key path" push'), 'push');
  assert.equal(gitSubcommand('git.exe push origin main'), 'push');
  assert.equal(gitSubcommand('result=$(git push origin main)'), 'push');
  assert.equal(gitSubcommand('"C:\\Program Files\\Git\\cmd\\git.exe" push origin main'), 'push');
  assert.equal(gitSubcommand('& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main'), 'push');
  assert.equal(gitSubcommand('C:\\Git\\cmd\\git.exe push origin main'), 'push');
  assert.equal(gitSubcommand('echo ok # $(git push origin main)'), '',
    'commented command substitution must not be classified as a Git action');
  assert.equal(gitSubcommand('# `git push origin main`'), '',
    'commented backtick substitution must not be classified as a Git action');
  assert.equal(gitSubcommand('echo ok # ignored; git push origin main'), '',
    'comment delimiters must not turn the remainder into executable segments');
  assert.equal(gitSubcommand('# ignored && git push origin main'), '',
    'commented command chains must not be classified as Git actions');
  assert.equal(gitSubcommand('Write-Output ok # ignored | git push origin main'), '',
    'commented pipelines must not be classified as Git actions');
  assert.equal(gitSubcommand('echo "prefix # $(git push origin main)"'), 'push',
    'double-quoted command substitution remains executable in Bash and PowerShell');
  assert.equal(gitSubcommand('echo "prefix # `git push origin main`"'), 'push',
    'double-quoted backtick substitution remains executable in Bash');
  assert.equal(gitSubcommand('echo ok # ignored\ngit push origin main'), 'push',
    'a real Git action on the next line must remain visible after a comment');
  assert.equal(gitSubcommand('(git push origin main)'), 'push',
    'subshell Git actions must be classified');
  assert.equal(gitSubcommand('cat <(git push origin main)'), 'push',
    'process-substitution Git actions must be classified');
  assert.equal(gitSubcommand('{ git push origin main; }'), 'push',
    'brace-group Git actions must be classified');
  assert.equal(gitSubcommand('env FOO=bar git push origin main'), 'push',
    'env-wrapped Git actions must be classified');
  assert.equal(gitSubcommand('if true; then git push origin main; fi'), 'push',
    'control-flow Git actions must be classified');
  assert.equal(gitSubcommand('<# ignored; git push origin main #>\nWrite-Output ok'), '',
    'PowerShell block comments must not be classified as Git actions');
  assert.equal(gitSubcommand('env -u GIT_DIR git push origin main'), 'push',
    'env options with a separate value must preserve the wrapped command');
  assert.equal(gitSubcommand('env -C repo git push origin main'), 'push',
    'env chdir wrappers must preserve the wrapped command');
  assert.equal(gitSubcommand('case "$x" in main) git push origin main;; esac'), 'push',
    'case branch commands must be classified');
  assert.equal(gitSubcommand('cmd /c git push origin main'), 'push',
    'cmd inline commands must be classified');
  assert.equal(gitSubcommand('powershell -NoProfile -Command "git push origin main"'), 'push',
    'PowerShell inline commands must be classified');
  assert.equal(gitSubcommand('g<# ignored #>it push origin main'), '',
    'PowerShell block comments must preserve a token boundary');
  assert.equal(gitSubcommand('git<# ignored #> push origin main'), '',
    'PowerShell block comment syntax inside a token must not manufacture git');
  assert.equal(gitSubcommand('env -S "git push origin main"'), 'push',
    'env split-string commands must be classified');
  assert.equal(gitSubcommand('env --split-string="git push origin main"'), 'push',
    'env inline split-string commands must be classified');
  assert.equal(gitSubcommand('powershell "git push origin main"'), 'push',
    'PowerShell positional commands must be classified');
  assert.equal(gitSubcommand('powershell -ConfigurationName "git push origin main"'), '',
    'PowerShell option values must not be mistaken for commands');
  assert.equal(gitSubcommand('pwsh -CustomPipeName "git push origin main"'), '',
    'PowerShell custom pipe values must not be mistaken for commands');
  assert.equal(gitSubcommand('echo "git push origin main"'), '',
    'quoted text must not be classified as a Git action');
}

function assertInProcessMemoryContext() {
  const router = require(routerPath);
  assert.equal(typeof router.collectMemoryContext, 'function',
    'preflight router does not expose the in-process memory context stage');
  assert.equal(typeof router.formatAdditionalContext, 'function',
    'preflight router cannot render collected context into hook output');

  let calls = 0;
  const runtime = router.runtimeFrom(payload('Edit', {
    file_path: path.join(HARNESS_ROOT, 'rtl', 'rx_fifo.sv'),
  }));
  const collected = router.collectMemoryContext(runtime, {
    retrieveContext(input) {
      calls += 1;
      assert.equal(input.tool_name, 'Edit');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: '[memory] rx_fifo prior failure evidence',
        },
      };
    },
  });
  assert.equal(calls, 1, 'Edit did not invoke in-process memory retrieval exactly once');
  assert.match(collected, /rx_fifo prior failure evidence/);
  assert.match(router.formatAdditionalContext(runtime), /rx_fifo prior failure evidence/,
    'collected memory was not included in hook additionalContext');

  const readRuntime = router.runtimeFrom(payload('Read', {
    file_path: path.join(HARNESS_ROOT, 'docs', 'rules', '00-core.md'),
  }));
  assert.equal(router.collectMemoryContext(readRuntime, {
    retrieveContext() { calls += 1; return null; },
  }), null, 'Read unexpectedly triggered task-context memory retrieval');
  assert.equal(calls, 1, 'non-write tool invoked memory retrieval');
}

function assertReadOnlyMemoryHitDoesNotCache() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-memory-cache-'));
  const cacheFile = path.join(root, 'memory-cache.json');
  const envNames = [
    'CLAUDE_MEMORY_HINT_CACHE_FILE',
    'CLAUDE_MEMORY_HINT_CACHE_DISABLED',
    'CLAUDE_HOOK_NO_WRITE',
    'CLAUDE_BENCH',
    'CLAUDE_HARNESS_NO_PERSIST',
    'CLAUDE_HARNESS_VERIFY_READONLY',
    'CLAUDE_NO_DIAGNOSTIC_WRITES',
  ];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of envNames) delete process.env[name];
    process.env.CLAUDE_MEMORY_HINT_CACHE_FILE = cacheFile;
    process.env.CLAUDE_HARNESS_NO_PERSIST = '1';
    const memoryHook = require(path.join(
      HARNESS_ROOT, 'engine', 'scripts', 'memory-retrieve-hook.cjs',
    ));
    assert.equal(memoryHook.cacheDisabled(), true,
      'no-persist mode must disable the memory hint cache');
    const output = memoryHook.retrieveContext(payload('Edit', {
      file_path: path.join(HARNESS_ROOT, 'rtl', 'cache_probe.sv'),
    }), {
      doMemoryQuery() {
        return [{
          namespace: 'verified',
          name: 'cache-probe',
          summary: 'Relevant verified failure evidence.',
          source: 'test',
          sourceKey: 'cache-probe',
          confidence: 1,
          status: 'active',
          updatedAt: Date.now(),
        }];
      },
      resolveWikiLinks() { return { resolved: [] }; },
    });
    assert.match(output?.hookSpecificOutput?.additionalContext || '', /cache-probe/,
      'fixture must prove a real retrieval hit before checking cache side effects');
    assert.equal(fs.existsSync(cacheFile), false,
      'no-persist retrieval hit must not create a memory cache file');
  } finally {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPureEvaluatorImports() {
  for (const relative of EVALUATOR_MODULES) {
    const modulePath = path.join(HARNESS_ROOT, relative);
    const code = [
      `const value = require(${JSON.stringify(modulePath)});`,
      "if (typeof value?.evaluate !== 'function') process.exit(9);",
      "process.stdout.write('IMPORTED');",
    ].join(' ');
    const result = spawnSync(process.execPath, ['-e', code], {
      cwd: HARNESS_ROOT,
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      input: JSON.stringify(payload('Bash', { command: 'rm -rf /' })),
      env: {
        ...process.env,
        CLAUDE_HARNESS_NO_PERSIST: '1',
        CLAUDE_HARNESS_VERIFY_READONLY: '1',
        CLAUDE_NO_DIAGNOSTIC_WRITES: '1',
      },
    });
    assert.equal(result.status, 0, `${relative} import failed: ${result.stderr}`);
    assert.equal(result.stdout, 'IMPORTED', `${relative} emitted stdout while imported`);
    assert.equal(result.stderr, '', `${relative} emitted stderr while imported`);
  }
}

function assertBehaviorParity() {
  const read = runRouter(payload('Read', { file_path: path.join(HARNESS_ROOT, 'docs', 'rules', '00-core.md') }));
  assert.equal(read.status, 0, `Read should pass: ${read.stderr}`);

  const safeBash = runRouter(payload('Bash', { command: 'echo preflight-safe' }));
  assert.equal(safeBash.status, 0, `safe Bash should pass: ${safeBash.stderr}`);

  const unsafeBash = runRouter(payload('Bash', { command: 'rm -rf /' }));
  assert.equal(unsafeBash.status, 2, 'destructive Bash must remain hard-blocked');

  const protectedWrite = runRouter(payload('Write', {
    file_path: path.join(HARNESS_ROOT, '07_mat', 'golden_model.m'),
    content: '% blocked fixture',
  }));
  assert.equal(protectedWrite.status, 2, 'protected golden-model write must remain hard-blocked');
  assert.doesNotMatch(protectedWrite.stderr, /\[object Object\]/,
    'structured guard diagnostics must not degrade to [object Object]');
}

function assertEditReconstructionAndDisableSwitches() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-edit-content-'));
  try {
    const rtlPath = path.join(root, 'design.sv');
    fs.writeFileSync(rtlPath, 'module design;\nendmodule\n', 'utf8');
    const editPayload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: rtlPath,
        edits: [{ old_string: 'endmodule', new_string: 'initial begin end\nendmodule' }],
      },
      cwd: root,
      session_id: 'preflight-multiedit-content',
    };
    const blocked = runRouter(editPayload);
    assert.equal(blocked.status, 2,
      `MultiEdit must be checked as reconstructed full RTL: ${blocked.stderr}`);

    const disabled = runRouter(editPayload, { CLAUDE_RTL_SEMANTIC_ORACLE_DISABLED: '1' });
    assert.equal(disabled.status, 0,
      `RTL oracle disable switch must apply through router evaluate: ${disabled.stderr}`);

    const fixGuard = require(path.join(
      HARNESS_ROOT, 'engine', 'hooks', 'safety', 'fix-in-place-guard.cjs',
    ));
    const variantPayload = payload('Write', {
      file_path: path.join(root, 'check_rtl_debug1.sv'),
      content: 'module check_rtl_debug1; endmodule\n',
    });
    const previous = process.env.FIX_IN_PLACE_GUARD_DISABLED;
    delete process.env.FIX_IN_PLACE_GUARD_DISABLED;
    const active = fixGuard.evaluate(variantPayload);
    process.env.FIX_IN_PLACE_GUARD_DISABLED = '1';
    const bypassed = fixGuard.evaluate(variantPayload);
    if (previous === undefined) delete process.env.FIX_IN_PLACE_GUARD_DISABLED;
    else process.env.FIX_IN_PLACE_GUARD_DISABLED = previous;
    assert.equal(active.decision, 'block', 'fix-in-place fixture must exercise a real block');
    assert.equal(bypassed.decision, 'allow', 'fix-in-place disable switch must apply to evaluate');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertRepairMultiEditUsesFullContent() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-repair-content-'));
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture\n', 'utf8');
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'safe\n', 'utf8');
    const specPath = path.join(root, 'var', 'repair', 'repair-spec.json');
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, JSON.stringify({
      schemaVersion: 1,
      id: 'multi-edit-repair-contract',
      objective: 'Reject forbidden content introduced through MultiEdit.',
      allowedFiles: ['target.txt'],
      readonlyFiles: [],
      patches: [{ file: 'target.txt', oldBlock: 'safe', newBlock: 'FORBIDDEN' }],
      forbiddenRegex: [{ file: 'target.txt', pattern: 'FORBIDDEN' }],
    }), 'utf8');

    const result = runRouter({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: target,
        edits: [{ old_string: 'safe', new_string: 'FORBIDDEN' }],
      },
      cwd: root,
      session_id: 'preflight-repair-multiedit',
    }, { CLAUDE_REPAIR_SPEC: specPath });
    assert.equal(result.status, 2,
      `repair forbiddenRegex must inspect reconstructed MultiEdit content: ${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertReadOnlyDoesNotPersist() {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'preflight-readonly-'));
  const stateFile = path.join(root, 'watchdog.json');
  try {
    const result = runRouter(payload('Read', {
      file_path: path.join(HARNESS_ROOT, 'docs', 'rules', '00-core.md'),
    }), {
      CLAUDE_HARNESS_NO_PERSIST: '0',
      CLAUDE_HARNESS_VERIFY_READONLY: '0',
      CLAUDE_TRANSPARENCY_LEDGER_DISABLED: '1',
      PROGRESS_WATCHDOG_STATE_FILE: stateFile,
      PROGRESS_WATCHDOG_ARCHIVE_DIR: path.join(root, 'archive'),
    });
    assert.equal(result.status, 0, `production-shape Read should pass: ${result.stderr}`);
    assert.equal(fs.existsSync(stateFile), false, 'Read must not create watchdog state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertActionContractBindsFullToolInput() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-input-contract-'));
  const envNames = [
    'CLAUDE_TOOL_ACTION_CONTRACT_MODE',
    'CLAUDE_TRANSPARENCY_RUN_DIR',
    'CLAUDE_TRANSPARENCY_RUN_ID',
  ];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    process.env.CLAUDE_TOOL_ACTION_CONTRACT_MODE = 'all';
    process.env.CLAUDE_TRANSPARENCY_RUN_DIR = root;
    process.env.CLAUDE_TRANSPARENCY_RUN_ID = 'tool-input-binding';
    const ledger = require(path.join(
      HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'agent-transparency-ledger.cjs',
    ));
    const contractGate = require(path.join(
      HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'tool-action-contract-gate.cjs',
    ));
    const filePath = path.join(HARNESS_ROOT, 'docs', 'rules', '00-core.md');
    const first = {
      ...payload('MultiEdit', {
        file_path: filePath,
        edits: [{ old_string: 'alpha', new_string: 'beta' }],
      }),
      user_message: 'Apply only the specified edit.',
    };
    const changed = {
      ...payload('MultiEdit', {
        file_path: filePath,
        edits: [{ old_string: 'alpha', new_string: 'gamma' }],
      }),
      user_message: 'Apply only the specified edit.',
    };
    const firstContext = ledger.buildContext(first);
    const changedContext = ledger.buildContext(changed);
    assert.notEqual(firstContext.toolInputSha256, changedContext.toolInputSha256,
      'different edit arrays must produce different tool_input hashes');
    const written = ledger.run(first, { context: firstContext });
    const contract = written.artifacts?.toolActionContract;
    assert.equal(contract?.toolPayload?.inputSha256, firstContext.toolInputSha256,
      'action contract must store the complete canonical tool_input hash');
    const mismatch = contractGate.evaluate(changed, {
      context: changedContext,
      contract,
    });
    assert.equal(mismatch.decision, 'warn');
    assert.match((mismatch.diagnostics || []).join('\n'), /tool input hash mismatch/);
  } finally {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  assertSingleRouterRegistration();
  assertNoNestedExecution();
  assertGitCommandClassification();
  assertInProcessMemoryContext();
  assertReadOnlyMemoryHitDoesNotCache();
  assertPureEvaluatorImports();
  assertBehaviorParity();
  assertEditReconstructionAndDisableSwitches();
  assertRepairMultiEditUsesFullContent();
  assertReadOnlyDoesNotPersist();
  assertActionContractBindsFullToolInput();
  process.stdout.write('PREFLIGHT_ROUTER_RESULT: PASS\n');
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
