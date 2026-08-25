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

function assertPreflightDoesNotInjectMemoryContext() {
  const router = require(routerPath);
  assert.equal(router.collectMemoryContext, undefined,
    'PreToolUse must not expose or invoke task-context memory retrieval');
  assert.equal(typeof router.formatAdditionalContext, 'function',
    'preflight router must still render compact gate advisories');

  const runtime = router.runtimeFrom(payload('Edit', {
    file_path: path.join(HARNESS_ROOT, 'rtl', 'rx_fifo.sv'),
  }));
  assert.equal(router.formatAdditionalContext(runtime), '',
    'an allowed Edit without gate advisories must emit zero context');
  const source = fs.readFileSync(routerPath, 'utf8');
  assert.doesNotMatch(source, /memory-retrieve-hook|collectMemoryContext/,
    'preflight router still carries the duplicate Write-time memory stage');
}

function assertRiskAdaptivePreflight() {
  const router = require(routerPath);
  assert.equal(typeof router.evaluateRiskPolicy, 'function',
    'preflight router must expose its in-process risk policy evaluator');
  const forbiddenStateRead = () => {
    throw new Error('R0/off must not read persistent risk state');
  };

  let runtime = router.runtimeFrom(payload('Read', {
    file_path: path.join(HARNESS_ROOT, 'docs', 'rules', '05-harness.md'),
  }));
  let result = router.evaluateRiskPolicy(runtime, {
    env: { CLAUDE_RISK_POLICY_MODE: 'shadow' },
    readVerificationState: forbiddenStateRead,
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.assessment.effectiveRiskLevel, 'R0');
  assert.equal(result.advisory, null);

  runtime = router.runtimeFrom(payload('Edit', {
    file_path: path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'preflight-router.cjs'),
    old_string: 'const ordinary = true;',
    new_string: 'const ordinary = false;',
  }));
  result = router.evaluateRiskPolicy(runtime, {
    env: { CLAUDE_RISK_POLICY_MODE: 'shadow' },
    fileExists: () => true,
    readVerificationState: () => ({ version: 4, pending: {}, risk: {} }),
    riskForPayload: () => [],
  });
  assert.equal(result.assessment.minimumRiskLevel, 'R1');
  assert.equal(result.decision, 'allow');
  assert.equal(result.advisory, null);

  runtime = router.runtimeFrom(payload('Edit', {
    file_path: path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'preflight-router.cjs'),
    old_string: 'module.exports = { main };',
    new_string: 'module.exports = { main, evaluate };',
  }));
  result = router.evaluateRiskPolicy(runtime, {
    env: { CLAUDE_RISK_POLICY_MODE: 'shadow' },
    fileExists: () => true,
    readVerificationState: () => ({ version: 4, pending: {}, risk: {} }),
    riskForPayload: () => [],
  });
  assert.equal(result.assessment.minimumRiskLevel, 'R2');
  assert.equal(result.decision, 'warn');
  assert.equal(result.blocking, false);

  const sticky = {
    effectiveRiskLevel: 'R2',
    minimumRiskLevel: 'R2',
    riskReasons: ['interface-change'],
  };
  result = router.evaluateRiskPolicy(runtime, {
    env: { CLAUDE_RISK_POLICY_MODE: 'shadow' },
    fileExists: () => true,
    readVerificationState: () => ({ version: 4, pending: {}, risk: { sticky } }),
    riskForPayload: () => [sticky],
  });
  assert.equal(result.assessment.effectiveRiskLevel, 'R2');

  runtime = router.runtimeFrom(payload('Bash', {
    command: 'git reset --hard HEAD~1',
  }));
  result = router.evaluateRiskPolicy(runtime, {
    env: { CLAUDE_RISK_POLICY_MODE: 'enforce' },
    readVerificationState: () => ({ version: 4, pending: {}, risk: {} }),
    riskForPayload: () => [],
    evaluateBypass: () => ({ requested: false, allowed: false, errors: [] }),
  });
  assert.equal(result.assessment.effectiveRiskLevel, 'R3');
  assert.equal(result.decision, 'block');
  assert.equal(result.diagnostics.length, 1);
  assert(result.remediation);

  let authorizationRequest = null;
  result = router.evaluateRiskPolicy(runtime, {
    env: { CLAUDE_RISK_POLICY_MODE: 'enforce' },
    readVerificationState: () => ({ version: 4, pending: {}, risk: {} }),
    riskForPayload: () => [],
    evaluateBypass(request) {
      authorizationRequest = request;
      return { requested: true, allowed: true, errors: [] };
    },
  });
  assert.notEqual(result.decision, 'block');
  assert.match(authorizationRequest.actionHash, /^[a-f0-9]{64}$/);
  assert.equal(authorizationRequest.requireActionBinding, true);
  assert.equal(authorizationRequest.oneShot, true);

  runtime = router.runtimeFrom(payload('Bash', { command: 'git reset --hard HEAD~1' }));
  result = router.evaluateRiskPolicy(runtime, {
    env: { CLAUDE_RISK_POLICY_MODE: 'off' },
    readVerificationState: forbiddenStateRead,
    evaluateBypass: forbiddenStateRead,
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.assessment.effectiveRiskLevel, 'R0');
}

function assertCompactDeduplicatedAdvisoryContext() {
  const router = require(routerPath);
  const runtime = router.runtimeFrom(payload('Write', {
    file_path: path.join(HARNESS_ROOT, 'src', 'future_module.py'),
    content: 'print("fixture")\n',
  }));
  const advisory = {
    source: 'verification-quality',
    message: 'Verification plan is incomplete for this target.',
    target: 'src/future_module.py',
    findings: ['detailed finding '.repeat(40)],
  };
  runtime.advisories.push(advisory, { ...advisory });

  const context = router.formatAdditionalContext(runtime);
  assert(context.length <= 320,
    `preflight advisory context exceeded 320 characters: ${context.length}`);
  assert.equal((context.match(/verification-quality/g) || []).length, 1,
    'duplicate gate advisories must be collapsed before context injection');
  assert.match(context, /Verification plan is incomplete/,
    'compact context must preserve the actionable advisory summary');
  assert.doesNotMatch(context, /detailed finding/,
    'verbose gate findings must stay in diagnostics instead of model context');
}

function assertWriteGatesAreSelectedByTarget() {
  const router = require(routerPath);
  assert.equal(typeof router.writeSpecs, 'function',
    'preflight router must expose its write-gate selector for contract testing');
  const sourcesFor = (toolName, filePath) => router.writeSpecs(router.runtimeFrom(payload(toolName, {
    file_path: filePath,
    content: 'fixture\n',
  }))).map((spec) => spec.source);
  const base = ['project-directory', 'repair-content', 'file-protection', 'fix-in-place'];

  assert.deepEqual(sourcesFor('Write', path.join(HARNESS_ROOT, 'docs', 'future-note.md')), base,
    'ordinary documents must not load code-specific gates');
  assert.deepEqual(sourcesFor('Write', path.join(HARNESS_ROOT, 'src', 'future_module.py')),
    [...base, 'requirements-gate'],
    'new Python source must load only the applicable requirements gate');
  assert.deepEqual(sourcesFor('Write', path.join(HARNESS_ROOT, 'tests', 'test_future_module.py')),
    [...base, 'verification-quality'],
    'new Python tests must load only the applicable verification-quality gate');
  assert.deepEqual(sourcesFor('Write', path.join(HARNESS_ROOT, 'rtl', 'future_module.sv')),
    [...base, 'hdl-gate', 'requirements-gate', 'rtl-semantic-oracle'],
    'new RTL source must retain HDL, requirements, and semantic checks');
  assert.deepEqual(sourcesFor('Write', path.join(HARNESS_ROOT, 'tb', 'tb_future_module.sv')),
    [...base, 'hdl-gate', 'verification-quality', 'rtl-semantic-oracle'],
    'new RTL testbenches must retain HDL, verification-quality, and semantic checks');
}

function assertAdvisoryUsesSingleModelChannel() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-advisory-channel-'));
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture\n', 'utf8');
    const target = path.join(root, 'src', 'future_module.py');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const result = runRouter({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: target, content: 'print("fixture")\n' },
      cwd: root,
      session_id: 'preflight-advisory-channel',
    });
    assert.equal(result.status, 0, `non-blocking requirement advisory must pass: ${result.stderr}`);
    assert.match(result.stdout, /requirements-gate/,
      'non-blocking requirement advisory must be emitted as compact additionalContext');
    assert.doesNotMatch(result.stderr, /preflight-router:requirements-gate/,
      'the same non-blocking advisory must not be duplicated on stderr');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertWatchdogPrecheckIsReadOnly() {
  const os = require('node:os');
  const watchdog = require(path.join(
    HARNESS_ROOT, 'engine', 'hooks', 'session', 'progress-watchdog.cjs',
  ));
  assert.equal(typeof watchdog.inspectProgress, 'function',
    'watchdog must expose a read-only pre-action inspection');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-precheck-'));
  try {
    const stateFile = path.join(root, 'state.json');
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(root, 'future.py'), content: 'fixture\n' },
      cwd: root,
      session_id: 'watchdog-precheck',
    };
    const key = watchdog.stableSessionKey(root, input.session_id);
    const state = {
      schemaVersion: 2,
      sessions: {
        [key]: {
          cwd: root,
          sessionId: input.session_id,
          status: 'frozen',
          freezeReason: 'repair_budget_exhausted',
          noProgressTurns: 8,
          history: [],
        },
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
    const before = fs.readFileSync(stateFile, 'utf8');
    const result = watchdog.inspectProgress(input, { stateFile, mode: 'enforce' });
    assert.equal(result.status, 'frozen_escalation_required',
      'read-only precheck must preserve frozen-state blocking');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before,
      'pre-action watchdog inspection must not rewrite or append state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertPreflightUsesReadOnlyWatchdogCheck() {
  const source = fs.readFileSync(routerPath, 'utf8');
  assert.match(source, /watchdog\.inspectProgress\(runtime\.payload,\s*\{\s*riskLevel:/,
    'PreToolUse must pass its current risk assessment to the read-only watchdog inspection');
  assert.doesNotMatch(source, /watchdog\.updateProgress\(/,
    'PreToolUse must not record an outcome before the tool has run');
}

function assertGateTargetsStayNarrowAndRelative() {
  const os = require('node:os');
  const { stateHasTaskTargetForFile } = require(path.join(
    HARNESS_ROOT, 'engine', 'scripts', 'lib', 'project-scope.cjs',
  ));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-target-scope-'));
  try {
    const target = path.join(root, 'src', 'future.py');
    const state = {
      version: 2,
      taskId: 'gate-target-scope',
      projectRoot: root,
      contractHash: 'c'.repeat(64),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    assert.equal(stateHasTaskTargetForFile({ ...state, targets: ['src/**'] }, target), true);
    assert.equal(stateHasTaskTargetForFile({ ...state, targets: ['./**'] }, target), false,
      'a gate receipt must not grant project-root recursive scope');
    assert.equal(stateHasTaskTargetForFile({ ...state, targets: [target] }, target), false,
      'gate targets must be project-relative, not absolute paths');
    assert.equal(stateHasTaskTargetForFile({ ...state, targets: ['../outside/**'] }, target), false,
      'gate targets must not escape the project root');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertLegacyProjectRootDoesNotCompleteRequirementsGate() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'requirements-scope-v2-'));
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture\n', 'utf8');
    fs.mkdirSync(path.join(root, 'var', 'gates'), { recursive: true });
    const target = path.join(root, 'src', 'future_module.py');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(root, 'var', 'gates', 'requirements-gate.json'), JSON.stringify({
      status: 'completed',
      task: 'an unrelated historical task',
      projectRoot: root,
      dimensions: {
        D1_scope: 'confirmed', D2_data_contract: 'confirmed', D3_success_criteria: 'confirmed',
        D4_algorithm: 'confirmed', D5_micro_arch: 'confirmed', D6_risks: 'confirmed',
      },
    }), 'utf8');
    const guard = require(path.join(
      HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'requirements-gate-guard.cjs',
    ));
    const result = guard.evaluate(payload('Write', {
      file_path: target,
      content: 'def future_module():\n    return True\n',
    }), { filePath: target });
    assert.equal(result.decision, 'warn',
      'projectRoot-only legacy state must not complete a future task gate');

    fs.writeFileSync(path.join(root, 'var', 'gates', 'requirements-gate.json'), JSON.stringify({
      version: 2,
      status: 'completed',
      taskId: 'future-module-task',
      projectRoot: root,
      targets: [path.relative(root, target)],
      contractHash: 'a'.repeat(64),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      dimensions: {
        D1_scope: 'confirmed', D2_data_contract: 'confirmed', D3_success_criteria: 'confirmed',
        D4_algorithm: 'confirmed', D5_micro_arch: 'confirmed', D6_risks: 'confirmed',
      },
    }), 'utf8');
    assert.equal(guard.evaluate(payload('Write', {
      file_path: target,
      content: 'def future_module():\n    return True\n',
    }), { filePath: target }).decision, 'allow',
    'valid v2 requirements state must cover its exact target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertLegacyProjectRootDoesNotCompleteVerificationQualityGate() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-scope-v2-'));
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# fixture\n', 'utf8');
    fs.mkdirSync(path.join(root, 'var', 'gates'), { recursive: true });
    const target = path.join(root, 'tests', 'test_future.py');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(root, 'var', 'gates', 'verification-quality.json'), JSON.stringify({
      status: 'completed',
      task: 'an unrelated historical test plan',
      projectRoot: root,
      env_profile: {
        clock: true, reset: true, interface: true, data_format: true,
        frame_struct: true, backpressure: true, throughput: true, neighbor: true,
      },
      scenarios: {
        S1_basic: true, S2_backpressure: true, S3_frame_boundary: true,
        S4_reset: true, S5_throughput: true,
      },
    }), 'utf8');
    const guard = require(path.join(
      HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'verification-quality-guard.cjs',
    ));
    const result = guard.evaluate(payload('Write', {
      file_path: target,
      content: 'def test_future():\n    assert True\n',
    }), { filePath: target });
    assert.equal(result.decision, 'warn',
      'projectRoot-only legacy state must not complete a future verification gate');

    fs.writeFileSync(path.join(root, 'var', 'gates', 'verification-quality.json'), JSON.stringify({
      version: 2,
      status: 'completed',
      taskId: 'future-test-task',
      projectRoot: root,
      targets: [path.relative(root, target)],
      contractHash: 'b'.repeat(64),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      env_profile: {
        clock: true, reset: true, interface: true, data_format: true,
        frame_struct: true, backpressure: true, throughput: true, neighbor: true,
      },
      scenarios: {
        S1_basic: true, S2_backpressure: true, S3_frame_boundary: true,
        S4_reset: true, S5_throughput: true,
      },
    }), 'utf8');
    assert.equal(guard.evaluate(payload('Write', {
      file_path: target,
      content: 'def test_future():\n    assert True\n',
    }), { filePath: target }).decision, 'allow',
    'valid v2 verification state must cover its exact target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

function assertWatchdogScopeIsRiskAdaptive() {
  const watchdog = require(path.join(
    HARNESS_ROOT, 'engine', 'hooks', 'session', 'progress-watchdog.cjs',
  ));
  assert.equal(typeof watchdog.shouldTrackProgress, 'function',
    'watchdog must expose one scope decision for every router');
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'watchdog-scope-'));
  const stateFile = path.join(root, 'watchdog.json');
  const archiveDir = path.join(root, 'archive');
  const update = (input, options = {}) => watchdog.updateProgress({
    hook_event_name: 'PostToolUse',
    cwd: root,
    session_id: options.sessionId || 'ordinary-edit',
    ...input,
  }, {
    stateFile,
    archiveDir,
    riskLevel: options.riskLevel,
  });
  try {
    const ordinary = update({
      tool_name: 'Edit',
      tool_input: { file_path: path.join(root, 'module.cjs') },
    }, { riskLevel: 'R1' });
    assert.equal(ordinary.status, 'not_tracked');
    assert.equal(fs.existsSync(stateFile), false,
      'ordinary R1 edit must not create watchdog state');

    const elevated = update({
      tool_name: 'Edit',
      tool_input: { file_path: path.join(root, 'shared-core.cjs') },
    }, { riskLevel: 'R2', sessionId: 'elevated-risk' });
    assert.notEqual(elevated.status, 'not_tracked', 'R2/R3 work must be tracked');
    assert.equal(fs.existsSync(stateFile), true, 'elevated work must persist watchdog state');

    const longTask = update({
      tool_name: 'Agent',
      user_message: 'Run this long task to completion.',
    }, { riskLevel: 'R1', sessionId: 'long-task' });
    assert.notEqual(longTask.status, 'not_tracked', 'long-running agent work must be tracked');

    const repair = update({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'node --test failing.test.cjs' },
      tool_response: { status: 1, stderr: '1 failed' },
    }, { riskLevel: 'R1', sessionId: 'repair-loop' });
    assert.notEqual(repair.status, 'not_tracked', 'a failed verification must start repair tracking');
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
  assertPreflightDoesNotInjectMemoryContext();
  assertRiskAdaptivePreflight();
  assertCompactDeduplicatedAdvisoryContext();
  assertWriteGatesAreSelectedByTarget();
  assertAdvisoryUsesSingleModelChannel();
  assertWatchdogPrecheckIsReadOnly();
  assertPreflightUsesReadOnlyWatchdogCheck();
  assertGateTargetsStayNarrowAndRelative();
  assertLegacyProjectRootDoesNotCompleteRequirementsGate();
  assertLegacyProjectRootDoesNotCompleteVerificationQualityGate();
  assertReadOnlyMemoryHitDoesNotCache();
  assertPureEvaluatorImports();
  assertBehaviorParity();
  assertEditReconstructionAndDisableSwitches();
  assertRepairMultiEditUsesFullContent();
  assertReadOnlyDoesNotPersist();
  assertWatchdogScopeIsRiskAdaptive();
  assertActionContractBindsFullToolInput();
  process.stdout.write('PREFLIGHT_ROUTER_RESULT: PASS\n');
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
