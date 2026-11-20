'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../../..');
const ASSEMBLER = path.join(ROOT, 'core/engine/scripts/sync-plugin-dist.cjs');
const VALIDATOR = path.join(ROOT, 'core/engine/scripts/bench-d2-plugin-validate.cjs');
const CLAUDE = '.claude-plugin/marketplace.json';
const GROK = '.grok-plugin/marketplace.json';

test('skill projections preserve body spacing across LF and CRLF checkouts', () => {
  const { normalizeSkillMarkdown } = require('../sync-skills.cjs');
  for (const body of ['', '# Heading\n', '\n# Heading\n']) {
    const text = '---\nname: sample\ndescription: Example\n---\n' + body;
    assert.equal(normalizeSkillMarkdown(text), text);
    assert.equal(normalizeSkillMarkdown(text.replaceAll('\n', '\r\n')).replaceAll('\r\n', '\n'), text);
  }
});

test('Codex migration disables only user commands covered by a trusted, enabled plugin hook', () => {
  const { duplicates } = require('../../../../hosts/codex/connect.cjs');
  const script = 'hosts/codex/patch-hook.cjs';
  const plugin = {
    pluginId: 'logical-paradox@agent-harness-logic', source: 'plugin', enabled: true, trustStatus: 'trusted',
    command: 'node "$env:PLUGIN_ROOT/' + script + '" context; exit $LASTEXITCODE',
    sourcePath: path.join(ROOT, 'hooks/codex.json'), eventName: 'preToolUse', matcher: '*',
    handlerType: 'command', timeoutSec: 8, async: false,
  };
  const user = { ...plugin, pluginId: null, source: 'user', command: 'node "' + ROOT.replaceAll('\\', '/') + '/' + script + '" context' };
  const provider = { ...user, timeoutSec: 600, command: 'node "' + ROOT.replaceAll('\\', '/') + '/core/engine/scripts/rule-loader.cjs"' };
  const others = [ { ...user, isManaged: true }, { ...user, source: 'project' }, { ...user, matcher: 'Bash' },
    { ...user, enabled: false }, { ...user, async: true }, { ...user, command: user.command + ' custom' },
    { ...provider, timeoutSec: 99 }, { ...provider, eventName: 'userPromptSubmit' } ];
  assert.deepEqual(duplicates([plugin, user, provider, ...others]), [user, provider]);
  for (const change of [{ trustStatus: 'modified' }, { enabled: false }, { pluginId: 'another@plugin' }]) {
    assert.deepEqual(duplicates([{ ...plugin, ...change }, user, provider]), []);
  }
});

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'harness dist contract-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const item of ['package.json', '.mcp.json', '.gitattributes', 'CLAUDE.md', 'AGENTS.md',
    '.claude-plugin/plugin.json', 'core/engine', 'core/rules', 'hosts/codex',
    'packs/fpga/rules', 'packs/fpga/config', 'packs/fpga/agents']) {
    const source = path.join(ROOT, item);
    const target = path.join(root, item);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  const skill = '---\nname: sample\ndescription: Sample release skill.\n---\n';
  for (const dir of ['core/skills/sample', 'skills/sample', 'skills/local-only', 'packs']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    if (dir !== 'packs') fs.writeFileSync(path.join(root, dir, 'SKILL.md'), skill);
  }
  return root;
}

function node(root, args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, HARNESS_ROOT: root, HARNESS_STATE_DIR: path.join(root, 'state') },
    encoding: 'utf8',
    ...options,
  });
}

function success(result) {
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout;
}

function git(root, args, options = {}) {
  return success(spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options })).trim();
}

test('lifecycle commands speak the hook protocol and inspect the project selected by the host', (t) => {
  const root = fixture(t);
  const cwd = path.join(root, 'sample project');
  fs.mkdirSync(cwd);
  const invoke = (script, args = [], options = {}) => node(root, [path.join(root, 'core/engine', script), ...args], {
    input: JSON.stringify({ cwd }), ...options,
  });
  const resume = () => success(invoke('scripts/context-resume.cjs', ['--session-start'], { cwd }));
  assert.equal(resume(), '');
  const snapshot = path.join(root, 'state/var/index/pre-compact-state.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, JSON.stringify({ projectRoot: cwd, currentMode: 'audit-marker' }));
  const ctx = JSON.parse(resume()).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.match(ctx.additionalContext, /audit-marker/);
  fs.writeFileSync(path.join(root, 'state/var/active-task.yaml'), 'project_root: ' + cwd + '\n');
  fs.writeFileSync(path.join(root, 'state/var/index/runtime-state.json'), JSON.stringify({
    sessionId: 'previous', currentMode: 'handoff-marker', lastActivityAt: new Date().toISOString(),
  }));
  const handoff = JSON.parse(success(invoke('scripts/state-resume.cjs', ['--session-start'], { cwd }))).hookSpecificOutput;
  assert.equal(handoff.hookEventName, 'SessionStart');
  assert.match(handoff.additionalContext, /handoff-marker/);
  assert.equal(success(invoke('scripts/pre-compact.cjs', ['--quiet'])), '');
  assert.ok(fs.existsSync(path.join(root, 'state/var/index/compaction-log.txt')) ||
    fs.readdirSync(path.join(root, 'state'), { recursive: true }).some(p => path.basename(p) === 'compaction-log.txt'));
  assert.equal(success(invoke('scripts/memory-knowledge-maintenance.cjs', ['--auto', '--dry-run', '--quiet'])), '');
  const guard = (project = cwd) => invoke('hooks/git/git-integrity-guard.cjs', ['--workspace'], { input: JSON.stringify({ cwd: project }) });
  assert.equal(success(guard()), '');
  git(cwd, ['init', '--quiet']);
  assert.equal(success(guard()), '');
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', 'first']);
  const linked = path.join(root, 'linked');
  git(cwd, ['worktree', 'add', '--detach', linked, 'HEAD']);
  assert.equal(success(guard(linked)), '');
  fs.writeFileSync(path.join(cwd, '.git/HEAD'), '');
  const damaged = guard();
  assert.equal(damaged.status, 2);
  assert.match(damaged.stderr, /HEAD|Git/);
  assert.equal(damaged.stdout, '');
});

test('distributed plugin loads the observer, maintenance, codegraph index and MCP entry', (t) => {
  const root = fixture(t);
  const cache = path.join(root, 'core/skills/sample/__pycache__');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'local.pyc'), Buffer.from([0xff, 0x00]));
  success(node(root, [ASSEMBLER]));
  assert.equal(fs.existsSync(path.join(root, 'dist/plugin/skills/sample/__pycache__')), false);
  for (const entry of [
    'core/engine/hooks/learning/postflight-observer.cjs',
    'core/engine/scripts/memory-knowledge-maintenance.cjs',
    'core/engine/scripts/code-graph-index.cjs',
  ]) {
    success(node(root, ['-e', 'require(process.argv[1])', path.join(root, 'dist/plugin', entry)]));
  }
  const mcp = JSON.parse(fs.readFileSync(path.join(root, 'dist/plugin/.mcp.json'))).mcpServers.codegraph;
  const entry = mcp.args[0].replace('${CLAUDE_PLUGIN_ROOT}', path.join(root, 'dist/plugin'));
  success(node(root, [entry], { input: '' }));
  assert.equal(fs.existsSync(path.join(root, 'dist/plugin/skills/local-only')), false);
  success(node(root, [VALIDATOR]));
});

test('Codex plugin registers runnable hooks from the installed package', (t) => {
  const root = fixture(t);
  success(node(root, [ASSEMBLER]));
  const plugin = path.join(root, 'dist/plugin');
  const read = (relative) => JSON.parse(fs.readFileSync(path.join(plugin, relative), 'utf8'));
  const manifest = read('.codex-plugin/plugin.json');
  const hooks = read(manifest.hooks).hooks;
  assert.ok(fs.existsSync(path.join(plugin, 'packs/fpga/config/hdl-gate-synthesis-rules.json')));
  assert.equal(fs.readdirSync(path.join(plugin, 'agents/codex')).filter((name) => name.endsWith('.toml')).length, 6);
  assert.ok(hooks.UserPromptSubmit?.length, 'Codex must offer context before acting on the prompt');
  assert.ok(hooks.SessionStart.flatMap((group) => group.hooks).some((hook) => hook.command.includes('codegraph-sync.cjs')));
  assert.ok(hooks.PostToolUse.flatMap((group) => group.hooks).some((hook) => hook.command.endsWith(' observe')));
  assert.equal(fs.existsSync(path.join(plugin, 'plugin.json')), false, 'Codex must load the compatibility manifest to register hooks');
  const server = read(manifest.mcpServers).mcpServers.codegraph;
  assert.equal(server.cwd, '.');
  assert.equal(server.args[0], './core/engine/mcp/codegraph-server.cjs');
  const matlab = read(manifest.mcpServers).mcpServers.matlab;
  assert.equal(matlab.cwd, '.');
  const offline = node(root, matlab.args, { cwd: plugin, env: {
    PATH: '', HOME: root, USERPROFILE: root,
  }, input: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' });
  assert.deepEqual(JSON.parse(success(offline)).result.tools, []);
  const toolList = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n';
  const mcp = success(node(root, server.args, { cwd: path.resolve(plugin, server.cwd), input: toolList }));
  assert.ok(JSON.parse(mcp).result.tools.some((tool) => tool.name === 'harness_cg_search'));
  const rules = success(node(plugin, ['core/engine/scripts/rule-loader.cjs', 'index']));
  for (const rule of ['00-core.md', '01-hdl.md', '02-python.md']) assert.ok(rules.includes(rule), rule);
  const verify = hooks.PostToolUse.flatMap((group) => group.hooks)
    .find((hook) => hook.command.includes('patch-hook.cjs'));
  assert.match(verify.command, /"\$\{PLUGIN_ROOT\}\/hosts\/codex\/patch-hook\.cjs" verify$/);
  assert.match(verify.commandWindows, /"\$env:PLUGIN_ROOT\/hosts\/codex\/patch-hook\.cjs" verify; exit \$LASTEXITCODE$/);
  assert.ok(hooks.SessionStart.every((group) => group.hooks.every((hook) => !hook.command.includes('resolve-plugin-path.sh'))));
  const shell = process.platform === 'win32' ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', verify.commandWindows]
    : ['/bin/sh', '-c', verify.command];
  const run = spawnSync(shell[0], shell.slice(1), {
    cwd: root,
    env: { ...process.env, PLUGIN_ROOT: plugin, HARNESS_ROOT: plugin, HARNESS_NO_PERSIST: '1' },
    input: 'invalid JSON', encoding: 'utf8', timeout: 15000,
  });
  assert.equal(run.status, 2, run.error?.message || run.stderr);
  assert.match(run.stderr, /JSON/);
});

test('Codex package shares state and closes the prompt, edit, graph and knowledge loop', (t) => {
  const root = fixture(t);
  const knowledge = 'packs/fpga/engineering-assets/knowledge';
  const note = knowledge + '/primary/clock-crossing.md';
  fs.mkdirSync(path.join(root, knowledge, 'primary'), { recursive: true });
  fs.writeFileSync(path.join(root, knowledge, 'SCENE_CARDS.md'), '# Clock crossing\n');
  fs.writeFileSync(path.join(root, knowledge, 'TAG_INDEX.md'), '[CDC](primary/clock-crossing.md)\n');
  fs.writeFileSync(path.join(root, note), '# Clock crossing reference\n');
  git(root, ['init', '--quiet']);
  git(root, ['add', '--', knowledge]);
  fs.writeFileSync(path.join(root, knowledge, 'local-only.md'), 'untracked reference');
  success(node(root, [ASSEMBLER]));

  const pkg = path.join(root, 'dist', 'plugin');
  const project = path.join(root, 'sample project');
  const user = path.join(root, 'user');
  const codexHome = path.join(user, '.codex');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(project, 'rtl'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wright'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HARNESS|CLAUDE|CODEX)_/i.test(key)));
  Object.assign(env, { HOME: user, USERPROFILE: user, CODEX_HOME: codexHome, PLUGIN_ROOT: pkg });
  const install = path.join(root, 'core/engine/scripts/install-codex-plugin-profile.cjs');
  assert.equal(JSON.parse(success(node(root, [install], { env }))).profiles, 6);
  assert.equal(JSON.parse(success(node(root, [install, '--check'], { env }))).changed, 0);
  const roles = fs.readdirSync(path.join(codexHome, 'agents'));
  assert.deepEqual(roles, fs.readdirSync(path.join(pkg, 'agents', 'codex')));
  const stateLink = JSON.parse(fs.readFileSync(path.join(user, '.logical-paradox/state-link.json'), 'utf8'));
  assert.equal(stateLink.stateRoot, root);

  const seed = path.join(root, 'core/engine/sqlite/store-memory.cjs');
  const seedScript = "require(process.argv[1]).writeMemory({namespace:'reference',name:'firmware checksum',content:'firmware checksum uses amber sentinel',source:'manual',confidence:1,verificationState:'verified',scopeKind:'global_harness',triggerKind:'user_query',evidenceRef:'fixture',validUntil:Date.now()+3600000})";
  success(node(root, ['-e', seedScript, seed], { env }));
  const packageKnowledge = path.join(pkg, knowledge);
  const index = fs.readFileSync(path.join(packageKnowledge, 'TAG_INDEX.md'), 'utf8');
  const [, link] = /\]\(([^\n)]+)\)/.exec(index);
  assert.match(fs.readFileSync(path.join(packageKnowledge, link), 'utf8'), /Clock crossing reference/);
  assert.equal(fs.existsSync(path.join(packageKnowledge, 'local-only.md')), false);

  const hooks = JSON.parse(fs.readFileSync(path.join(pkg, 'hooks/codex.json'), 'utf8')).hooks;
  function invoke(event, fragment, input) {
    const hook = hooks[event].flatMap((group) => group.hooks).find((entry) => entry.command.includes(fragment));
    assert.ok(hook, event + ' ' + fragment);
    const shell = process.platform === 'win32'
      ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', hook.commandWindows]
      : ['/bin/sh', '-c', hook.command];
    return spawnSync(shell[0], shell.slice(1), {
      cwd: project, env, encoding: 'utf8', timeout: 15000,
      input: JSON.stringify({ cwd: project, session_id: 'plugin-loop', hook_event_name: event, ...input }),
    });
  }
  const prompt = success(invoke('UserPromptSubmit', ' context', { prompt: 'search firmware checksum' }));
  assert.match(JSON.parse(prompt).hookSpecificOutput.additionalContext, /amber sentinel/);

  const outName = 'rtl/package_loop_next.sv';
  const outPath = path.join(project, outName);
  const edit = (headers) => ({
    tool_name: 'apply_patch', tool_input: { command: ['*** Begin Patch', ...headers, '*** End Patch'].join('\n') },
    tool_response: { metadata: { exit_code: 0 } },
  });
  const add = edit(['*** Add File: ' + outName, '+module package_loop_next; endmodule']);
  const routed = success(invoke('PreToolUse', ' context', add));
  assert.match(JSON.parse(routed).hookSpecificOutput.additionalContext, /01-hdl\.md/);
  const badEdit = edit(['*** Add File: rtl/check.v', '+module check; reg q; initial q = 1; endmodule']);
  const guard = invoke('PreToolUse', ' write', badEdit);
  assert.equal(guard.status, 2, guard.stderr);
  assert.match(guard.stderr, /initial/);

  const originalName = 'rtl/package_loop_old.sv';
  fs.writeFileSync(path.join(project, originalName), 'module package_loop_old; endmodule\n');
  success(invoke('SessionStart', 'codegraph-sync.cjs', { source: 'startup' }));
  const { DatabaseSync } = require('node:sqlite');
  const beforeEdit = new DatabaseSync(path.join(root, '.wright/memory.db'), { readOnly: true });
  try {
    assert.equal(beforeEdit.prepare('SELECT count(*) n FROM cg_files WHERE relative_path = ?').get(originalName).n, 1);
  } finally { beforeEdit.close(); }
  fs.writeFileSync(outPath, 'module package_loop_next; endmodule\n');
  success(invoke('PostToolUse', ' observe', add));
  fs.unlinkSync(path.join(project, originalName));
  success(invoke('PostToolUse', ' observe', edit(['*** Delete File: ' + originalName])));
  success(invoke('PostToolUse', ' observe', {
    tool_name: 'Bash', tool_use_id: 'failed-shell', tool_input: { command: 'unit-test-fixture' },
    tool_response: { metadata: { exit_code: 1 } },
  }));

  const mcp = JSON.parse(fs.readFileSync(path.join(pkg, '.codex-mcp.json'), 'utf8')).mcpServers.codegraph;
  const query = (id, name) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'harness_cg_search', arguments: { query: name, projectPath: project } },
  });
  const output = success(node(root, mcp.args, {
    env, cwd: path.resolve(pkg, mcp.cwd),
    input: [query(1, 'package_loop_next'), query(2, 'package_loop_old'), ''].join('\n'),
  })).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.match(output[0].result.content[0].text, /package_loop_next/);
  assert.match(output[1].result.content[0].text, /未找到匹配/);
  const db = new DatabaseSync(path.join(root, '.wright/memory.db'), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_events WHERE type = 'tool_fail'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM cg_files WHERE relative_path = ?").get(originalName).n, 0);
  } finally { db.close(); }
  assert.ok(!fs.existsSync(path.join(user, '.logical-paradox/.wright/memory.db')));
});

test('--check reports drift in either marketplace and preserves the current output', (t) => {
  const root = fixture(t);
  success(node(root, [ASSEMBLER]));
  success(node(root, [ASSEMBLER, '--check']));
  let file = path.join(root, GROK);
  const manifest = fs.readFileSync(file);
  fs.writeFileSync(file, '{}\n');
  const marketplaceDrift = node(root, [ASSEMBLER, '--check']);
  assert.equal(marketplaceDrift.status, 1, marketplaceDrift.stderr);
  assert.match(marketplaceDrift.stderr, /grok-plugin[\\/]marketplace\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  fs.writeFileSync(file, manifest);

  file = path.join(root, 'dist/plugin/saved.txt');
  fs.writeFileSync(file, 'keep');
  const distDrift = node(root, [ASSEMBLER, '--check']);
  assert.equal(distDrift.status, 1, distDrift.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  assert.equal(node(root, [ASSEMBLER, '--check']).status, 1);

  const source = path.join(root, '.mcp.json');
  fs.unlinkSync(source);
  assert.notEqual(node(root, [ASSEMBLER, '--check']).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('release catalogs refer to an exact committed artifact', (t) => {
  const root = fixture(t);
  success(node(root, [ASSEMBLER]));
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  assert.equal(read(CLAUDE).plugins[0].source, './dist/plugin');
  assert.deepEqual(read(GROK).plugins[0].source, { type: 'local', path: './dist/plugin' });

  git(root, ['init', '--quiet', '--object-format=sha1']);
  const makeCommit = () => {
    const tree = git(root, ['write-tree']);
    return git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com',
      'commit-tree', tree], { input: 'Fixture artifact\n' });
  };
  const url = 'https://example.com/harness.git';
  const release = (commit) => ['--release', '--repo-url=' + url, '--owner=Fixture', '--commit=' + commit];
  assert.notEqual(node(root, [ASSEMBLER, ...release(makeCommit())]).status, 0);
  assert.equal(read(CLAUDE).plugins[0].source, './dist/plugin');

  git(root, ['-c', 'core.autocrlf=true', 'add', '-f', '--', 'dist/plugin']);
  const commit = makeCommit();
  success(node(root, [ASSEMBLER, ...release(commit)]));
  assert.deepEqual(read(CLAUDE).plugins[0].source, {
    source: 'git-subdir', url, path: 'dist/plugin', sha: commit,
  });
  assert.deepEqual(read(GROK).plugins[0].source, { type: 'local', path: './dist/plugin' });
  assert.equal(read(GROK).owner.name, 'Fixture');
  success(node(root, [ASSEMBLER, '--check', ...release(commit)]));
  success(node(root, [ASSEMBLER, '--check']));
  success(node(root, [ASSEMBLER]));
  assert.equal(read(CLAUDE).plugins[0].source.sha, commit);
  assert.equal(read('.agents/plugins/marketplace.json').plugins[0].source.path, './dist/plugin');
  success(node(root, [VALIDATOR]));

  fs.appendFileSync(path.join(root, 'CLAUDE.md'), '\nUpdated artifact source.\n');
  const mismatch = node(root, [ASSEMBLER, ...release(commit)]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /CLAUDE\.md/);
  assert.equal(read(CLAUDE).plugins[0].source.sha, commit);
});
