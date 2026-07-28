#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const PRE_COMMIT = path.join(ROOT, '.githooks', 'pre-commit');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'lint-health.yml');
const MCP_CONFIG = path.join(ROOT, '.mcp.json');
const PLUGIN_LOCK = path.join(ROOT, 'plugins.lock.json');
const PLUGIN_LOCK_SCHEMA = path.join(ROOT, 'engine', 'schemas', 'plugin-lock.schema.json');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    ...options,
  });
}

function git(cwd, args) {
  const result = run('git', args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result;
}

function findBash() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\cygwin64\\bin\\bash.exe',
      ]
    : ['/usr/bin/bash', '/bin/bash'];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hook-contract-'));
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'feature/test']);
  return repo;
}

test('pre-commit ignores unrelated unstaged worktree artifacts', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('Git Bash is unavailable');

  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  fs.writeFileSync(path.join(repo, 'README.md'), '# staged\n');
  fs.writeFileSync(path.join(repo, 'unrelated.vcd'), 'waveform garbage\n');
  git(repo, ['add', 'README.md']);

  const result = run(bash, [PRE_COMMIT], {
    cwd: repo,
    env: { ...process.env, CLAUDE_HARNESS_ROOT: ROOT },
  });

  assert.equal(
    result.status,
    0,
    `unstaged artifact blocked the commit\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test('pre-commit treats a staged path containing spaces as one file', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('Git Bash is unavailable');

  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const relative = path.join('dir with spaces', 'broken script.py');
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), 'def broken(:\n');
  git(repo, ['add', relative]);

  const result = run(bash, [PRE_COMMIT], {
    cwd: repo,
    env: { ...process.env, CLAUDE_HARNESS_ROOT: ROOT },
  });

  assert.notEqual(
    result.status,
    0,
    `invalid staged Python with spaces was skipped\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test('pre-commit Python syntax check leaves no bytecode beside source', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('Git Bash is unavailable');

  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const sourceDir = path.join(repo, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'valid.py'), 'VALUE = 1\n');
  git(repo, ['add', 'src/valid.py']);

  const result = run(bash, [PRE_COMMIT], {
    cwd: repo,
    env: { ...process.env, CLAUDE_HARNESS_ROOT: ROOT },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    fs.existsSync(path.join(sourceDir, '__pycache__')),
    false,
    'pre-commit polluted the source tree with Python bytecode',
  );
});

test('pre-commit Tcl check never sources the staged script', (t) => {
  const hookSource = fs.readFileSync(PRE_COMMIT, 'utf8');
  assert.doesNotMatch(hookSource, /tclsh[^\n]*source\s+/, 'hook must not source a staged Tcl file');
  assert.match(hookSource, /info complete/, 'hook must use Tcl parse-completeness checking');

  const bash = findBash();
  if (!bash) return t.skip('Git Bash is unavailable');

  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const fakeBin = path.join(repo, 'fake-bin');
  const argsLog = path.join(repo, 'tcl-args.log');
  const sentinel = path.join(repo, 'tcl-source-executed');
  fs.mkdirSync(fakeBin);
  const fakeTcl = path.join(fakeBin, 'tclsh');
  fs.writeFileSync(
    fakeTcl,
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" > "$TCL_ARGS_LOG"\ncase "$*" in *source*) : > "$TCL_SENTINEL";; esac\n',
  );
  fs.chmodSync(fakeTcl, 0o755);

  fs.writeFileSync(path.join(repo, 'dangerous.tcl'), 'set fh [open should-not-exist w]\nclose $fh\n');
  git(repo, ['add', 'dangerous.tcl']);

  const result = run(bash, [PRE_COMMIT], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      CLAUDE_HARNESS_ROOT: ROOT,
      HARNESS_PRECOMMIT_TCLSH: fakeTcl,
      TCL_ARGS_LOG: argsLog,
      TCL_SENTINEL: sentinel,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(sentinel), false, 'pre-commit invoked tclsh with source');
  assert.equal(fs.existsSync(argsLog), true, 'configured Tcl checker was not invoked');
  const args = fs.readFileSync(argsLog, 'utf8');
  assert.doesNotMatch(args, /source/);
  assert.match(args.trim(), /^\S+\s+\S+$/, 'tclsh must receive checker and staged-content paths');
});

test('pre-commit declares advisory and required missing-tool policies', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('Git Bash is unavailable');

  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'algorithm.py'), 'VALUE = 1\n');
  git(repo, ['add', 'algorithm.py']);

  const common = {
    ...process.env,
    CLAUDE_HARNESS_ROOT: ROOT,
    HARNESS_PRECOMMIT_PYTHON: '__missing_python_for_contract_test__',
  };

  const advisory = run(bash, [PRE_COMMIT], { cwd: repo, env: common });
  assert.equal(advisory.status, 0, advisory.stderr || advisory.stdout);
  assert.match(advisory.stdout, /missing tool: python .*policy=advisory/i);

  const required = run(bash, [PRE_COMMIT], {
    cwd: repo,
    env: { ...common, HARNESS_PRECOMMIT_REQUIRE_TOOLS: '1' },
  });
  assert.notEqual(required.status, 0, 'strict missing-tool policy did not block');
  assert.match(required.stdout, /missing tool: python .*policy=required/i);
});

test('pre-commit hot path never scans unstaged or untracked files', () => {
  const hookSource = fs.readFileSync(PRE_COMMIT, 'utf8');
  assert.doesNotMatch(hookSource, /git\s+ls-files\s+--others/);
  assert.doesNotMatch(hookSource, /git\s+ls-files\s+--modified/);
});

test('pre-commit checks staged blob size with space-safe paths', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('Git Bash is unavailable');

  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const relative = path.join('large dir', 'blob name.bin');
  fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
  fs.writeFileSync(path.join(repo, relative), 'x'.repeat(32));
  git(repo, ['add', relative]);

  const result = run(bash, [PRE_COMMIT], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_HARNESS_ROOT: ROOT,
      HARNESS_PRECOMMIT_MAX_BYTES: '16',
    },
  });

  assert.notEqual(result.status, 0, 'oversized staged blob did not block');
  assert.match(result.stdout, /large dir[\\/]blob name\.bin/);
});

test('pre-commit defers heavyweight HDL and MATLAB checks', () => {
  const hookSource = fs.readFileSync(PRE_COMMIT, 'utf8');
  assert.doesNotMatch(hookSource, /\bmatlab\s+-batch\b/);
  assert.doesNotMatch(hookSource, /\b(?:vlog|vcom)\s+-lint\b/);
  assert.doesNotMatch(hookSource, /\b(?:ruff\s+check|flake8\b)/);
  assert.match(hookSource, /policy=explicit-verification/);
});

test('pre-commit checks staged Python content instead of unstaged edits', (t) => {
  const bash = findBash();
  if (!bash) return t.skip('Git Bash is unavailable');

  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const source = path.join(repo, 'partial.py');
  fs.writeFileSync(source, 'VALUE = 1\n');
  git(repo, ['add', 'partial.py']);
  fs.writeFileSync(source, 'def unstaged_broken(:\n');

  const result = run(bash, [PRE_COMMIT], {
    cwd: repo,
    env: { ...process.env, CLAUDE_HARNESS_ROOT: ROOT },
  });
  assert.equal(
    result.status,
    0,
    `unstaged edit affected staged-only check\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test('CI is least-privilege, immutable, cross-platform, and uploads provenance', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.match(workflow, /matrix:\s*\n\s+os:\s*\[ubuntu-latest, windows-latest\]/);
  assert.match(workflow, /runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  assert.match(workflow, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\s+# v4\.2\.2/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\s+# v4\.4\.0/);
  assert.match(workflow, /node-version:\s*['"]22\.17\.1['"]/);
  assert.match(workflow, /actions\/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065\s+# v5\.6\.0/);
  assert.match(workflow, /python-version:\s*['"]3\.12\.11['"]/);
  assert.match(workflow, /node --test engine\/scripts\/test-hooks\/git-ci-repro-contract\.test\.cjs/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+# v4\.6\.2/);
  assert.match(workflow, /var\/coverage\/coverage-summary\.json/);
  assert.match(workflow, /provenance/);
});

test('MCP package and enabled plugins are reproducibly locked', () => {
  const mcp = JSON.parse(fs.readFileSync(MCP_CONFIG, 'utf8'));
  assert.deepEqual(mcp.mcpServers['mcp-pdf'].args, ['-y', 'mcp-pdf@1.1.0']);

  assert.equal(fs.existsSync(PLUGIN_LOCK), true, 'plugins.lock.json is missing');
  assert.equal(fs.existsSync(PLUGIN_LOCK_SCHEMA), true, 'plugin lock schema is missing');
  const lockText = fs.readFileSync(PLUGIN_LOCK, 'utf8');
  const lock = JSON.parse(lockText);
  const schema = JSON.parse(fs.readFileSync(PLUGIN_LOCK_SCHEMA, 'utf8'));
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.local.json'), 'utf8'));

  assert.equal(lock.$schema, './engine/schemas/plugin-lock.schema.json');
  assert.equal(lock.version, 1);
  assert.deepEqual(
    Object.keys(lock.plugins).sort(),
    Object.entries(settings.enabledPlugins).filter(([, enabled]) => enabled).map(([name]) => name).sort(),
  );
  for (const [name, entry] of Object.entries(lock.plugins)) {
    assert.equal(typeof entry.version, 'string', `${name} has no version`);
    assert.match(entry.gitCommitSha, /^[0-9a-f]{40}$/, `${name} has no immutable git SHA`);
    assert.deepEqual(Object.keys(entry).sort(), ['gitCommitSha', 'version']);
  }
  assert.doesNotMatch(lockText, /(?:[A-Za-z]:[\\/]|\[PLUGINS_CACHE\]|installPath|installedAt)/);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.required, ['$schema', 'version', 'plugins']);
  assert.equal(schema.additionalProperties, false);
});
