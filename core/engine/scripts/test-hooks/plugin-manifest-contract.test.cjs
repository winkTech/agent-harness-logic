#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/plugin-manifest-contract.test.cjs — Claude Code 插件清单契约
 *
 * M2 目标：本仓库可被 `claude --plugin-dir <仓库根>` 直接加载。
 * 插件加载失败的典型形态是**静默**的（清单字段拼错、hooks 路径指错、命令写死了本机绝对
 * 路径而插件根每次更新都换目录），所以这里把结构、渲染幂等和真实可执行性都断言死：
 *
 *   1. `.claude-plugin/plugin.json` 可解析，name/hooks/agents/mcpServers 指向真实存在的东西；
 *   2. `core/engine/hooks/plugin.hooks.json` 每条 hook 是 exec 形式，args[0] 展开后文件存在，
 *      命令里不含本机绝对路径、不含未展开的 {{...}} 占位符；
 *   3. 渲染幂等：renderPluginHooks() 的输出与入库文件逐字节一致（CI 的 --check 能抓漂移，
 *      这里再钉一次，防止有人手改产物）；
 *   4. 非 `node ` 开头的模板命令必须让渲染器报错（exit 2），不静默降级 —— 插件目标不经 shell；
 *   5. 模拟触发：对每个事件用最小载荷真实 spawn 每条 hook，env 给 CLAUDE_PLUGIN_ROOT 与
 *      HARNESS_STATE_DIR（不设 CLAUDE_HARNESS_NO_PERSIST，要真写状态），断言无异常退出码，
 *      且状态落在临时状态根、仓库 var/ 不被写入（插件模式下运行时状态不落插件目录）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PLUGIN_MANIFEST = path.join(ROOT, '.claude-plugin', 'plugin.json');
const PLUGIN_HOOKS = path.join(ROOT, 'core', 'engine', 'hooks', 'plugin.hooks.json');
const RENDERER = path.join(ROOT, 'core', 'engine', 'scripts', 'render-hook-settings.cjs');
const { renderPluginHooks, toExecForm, PLUGIN_ROOT_PLACEHOLDER } = require(RENDERER);

const POSIX_ROOT = ROOT.replace(/\\/g, '/');

function expandPluginRoot(value) {
  return String(value).split(PLUGIN_ROOT_PLACEHOLDER).join(POSIX_ROOT);
}

function readPluginManifest() {
  return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST, 'utf8'));
}

function readPluginHooks() {
  return JSON.parse(fs.readFileSync(PLUGIN_HOOKS, 'utf8')).hooks;
}

function eachHook(hooks) {
  const flat = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group.hooks) ? group.hooks : []) {
        flat.push({ event, matcher: group.matcher || '*', hook });
      }
    }
  }
  return flat;
}

// ── 1. 插件清单结构 ────────────────────────────────────────────────────────

test('plugin.json is parseable and every declared path resolves', () => {
  assert.ok(fs.existsSync(PLUGIN_MANIFEST), '.claude-plugin/plugin.json is missing');
  const manifest = readPluginManifest();

  assert.equal(manifest.name, 'logical-paradox', 'plugin name is the installed identity; it must not drift');
  assert.equal(typeof manifest.version, 'string', 'plugin version must be a string');

  assert.equal(typeof manifest.hooks, 'string', 'plugin hooks must be a relative path string');
  assert.match(manifest.hooks, /^\.\//, 'plugin hooks path must start with ./ (relative to the plugin root)');
  const hooksTarget = path.resolve(ROOT, manifest.hooks);
  assert.ok(fs.existsSync(hooksTarget), `plugin hooks file does not exist: ${manifest.hooks}`);
  assert.equal(path.resolve(hooksTarget), path.resolve(PLUGIN_HOOKS),
    'plugin.json must point at the rendered core/engine/hooks/plugin.hooks.json');

  // Claude Code 的清单校验只接受 .md 文件路径作为 agents 字段（"Invalid string: must end with .md"），
  // 写目录会让整个插件被静默拒绝加载（2026-09-03 真机复现）。agents/ 是默认目录且递归发现，
  // 所以清单里不写该字段；若将来写，必须是 .md 路径。
  if (manifest.agents !== undefined) {
    const list = Array.isArray(manifest.agents) ? manifest.agents : [manifest.agents];
    for (const entry of list) {
      assert.ok(typeof entry === 'string' && entry.endsWith('.md'),
        `plugin agents entries must be .md file paths, got: ${entry}`);
      assert.ok(fs.existsSync(path.resolve(ROOT, entry)), `plugin agent file does not exist: ${entry}`);
    }
  }
  // M4b 后 agent 定义迁 packs/fpga/agents/（域包资产），根 agents/ 仅在历史
  // 工作区残留空目录——git 不跟踪空目录，全新 clone 上不存在是常态。插件形态
  // 的 agents 发现走 packs（清单不声明 agents 字段），因此目录缺失不再构成
  // 契约违规；只有清单声明了 agents 字段而目录缺失才是真问题（上方已断言）。
  const agentsDir = path.resolve(ROOT, 'agents');
  if (fs.existsSync(agentsDir)) {
    assert.ok(fs.statSync(agentsDir).isDirectory(), 'agents exists but is not a directory');
  }

  assert.ok(manifest.mcpServers && typeof manifest.mcpServers === 'object',
    'plugin must declare mcpServers');
  for (const [name, server] of Object.entries(manifest.mcpServers)) {
    assert.ok(server.command, `${name} mcp server must declare a command`);
    assert.ok(Array.isArray(server.args), `${name} mcp server args must be an array`);
    // node/npx 走 PATH，无法在此断言；只检查指向本仓库的脚本参数确实存在。
    for (const arg of server.args) {
      if (!String(arg).includes(PLUGIN_ROOT_PLACEHOLDER)) continue;
      const resolved = expandPluginRoot(arg);
      assert.ok(fs.existsSync(resolved), `${name} mcp server arg does not exist: ${arg}`);
    }
  }

  // 清单本身不得泄漏本机绝对路径 —— 插件安装到别的机器上就失效了。
  const raw = fs.readFileSync(PLUGIN_MANIFEST, 'utf8');
  assert.doesNotMatch(raw, /[A-Za-z]:[\\/]Users[\\/]/, 'plugin.json leaks a machine-local path');
});

// ── 2. 插件 hooks 产物形态 ─────────────────────────────────────────────────

test('plugin.hooks.json entries are portable exec-form commands', () => {
  assert.ok(fs.existsSync(PLUGIN_HOOKS), 'core/engine/hooks/plugin.hooks.json is missing (run render-hook-settings.cjs)');
  const raw = fs.readFileSync(PLUGIN_HOOKS, 'utf8');
  assert.doesNotMatch(raw, /\{\{[A-Z_]+\}\}/, 'plugin.hooks.json still contains unexpanded template placeholders');
  assert.doesNotMatch(raw, /[A-Za-z]:[\\/]/, 'plugin.hooks.json leaks an absolute path (plugin root moves on every update)');

  const hooks = readPluginHooks();
  const flat = eachHook(hooks);
  assert.ok(flat.length > 0, 'plugin.hooks.json registers no hooks at all');

  for (const { event, hook } of flat) {
    assert.equal(hook.type, 'command', `${event}: plugin hook type must be command`);
    assert.equal(hook.command, 'node', `${event}: plugin hooks must use exec form with command "node"`);
    assert.ok(Array.isArray(hook.args) && hook.args.length > 0, `${event}: plugin hook args must be non-empty`);
    assert.ok(String(hook.args[0]).startsWith(PLUGIN_ROOT_PLACEHOLDER),
      `${event}: script arg must be rooted at ${PLUGIN_ROOT_PLACEHOLDER}, got ${hook.args[0]}`);
    const script = expandPluginRoot(hook.args[0]);
    assert.ok(fs.existsSync(script), `${event}: hook script does not exist: ${hook.args[0]}`);
    if (Object.hasOwn(hook, 'timeout')) {
      assert.ok(Number.isFinite(hook.timeout) && hook.timeout > 0, `${event}: timeout must be positive`);
    }
  }
});

// ── 3. 渲染幂等 ───────────────────────────────────────────────────────────

test('plugin.hooks.json is byte-identical to renderPlugin() output', () => {
  const expected = `${JSON.stringify(renderPluginHooks({ root: ROOT }), null, 2)}\n`;
  const actual = fs.readFileSync(PLUGIN_HOOKS, 'utf8');
  assert.equal(actual, expected,
    'plugin.hooks.json drifted from registrations.json (run node core/engine/scripts/render-hook-settings.cjs)');
});

test('renderer refuses template commands that are not node invocations', () => {
  assert.throws(
    () => toExecForm({ type: 'command', command: 'bash ${CLAUDE_PLUGIN_ROOT}/engine/x.sh' }),
    (err) => err.exitCode === 2 && /node/.test(err.message),
    'non-node template commands must fail rendering with exit code 2, not degrade silently',
  );
  assert.throws(() => toExecForm({ type: 'command', command: '' }), (err) => err.exitCode === 2);
  assert.throws(() => toExecForm({ type: 'command', command: 'node' }), (err) => err.exitCode === 2);
});

// ── 4. 模拟触发 ───────────────────────────────────────────────────────────

const EVENT_PAYLOADS = {
  PreToolUse: () => ({ tool_name: 'Read', tool_input: { file_path: path.join(ROOT, 'CLAUDE.md') } }),
  PostToolUse: () => ({
    tool_name: 'Read',
    tool_input: { file_path: path.join(ROOT, 'CLAUDE.md') },
    tool_response: { success: true },
  }),
  PostToolUseFailure: () => ({
    tool_name: 'Read',
    tool_input: { file_path: path.join(ROOT, 'does-not-exist.md') },
    tool_response: { success: false, error: 'ENOENT: no such file' },
  }),
  UserPromptSubmit: () => ({ prompt: 'ping' }),
  SessionStart: () => ({ source: 'startup' }),
  Stop: () => ({ stop_hook_active: false }),
  SubagentStop: () => ({ stop_hook_active: false }),
  PreCompact: () => ({ trigger: 'manual' }),
};

test('every plugin hook survives a minimal payload for its event', { timeout: 300000 }, () => {
  const hooks = readPluginHooks();
  const flat = eachHook(hooks);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-manifest-contract-'));
  const stateDir = path.join(workspace, 'state');
  const projectDir = path.join(workspace, 'project');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const repoVar = path.join(ROOT, 'var');
  const repoVarBefore = fs.existsSync(repoVar) ? fs.statSync(repoVar).mtimeMs : null;

  // 真写状态：CLAUDE_HARNESS_NO_PERSIST 等抑制开关必须**不设**，否则这条测试证明不了
  // "插件模式下状态落在状态根、不落插件目录"。
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, HARNESS_STATE_DIR: stateDir };
  delete env.CLAUDE_HARNESS_NO_PERSIST;
  delete env.CLAUDE_HARNESS_VERIFY_READONLY;
  delete env.CLAUDE_NO_DIAGNOSTIC_WRITES;

  try {
    for (const { event, hook } of flat) {
      const payload = EVENT_PAYLOADS[event];
      assert.ok(payload, `no minimal payload fixture for event ${event}`);
      const args = hook.args.map(expandPluginRoot);
      const input = JSON.stringify({
        hook_event_name: event,
        session_id: `plugin-manifest-contract-${event}`,
        cwd: projectDir,
        ...payload(),
      });
      // async 条目在这里也同步跑 —— 契约要验的是脚本本身能跑通，不是宿主的调度语义。
      const budget = Number.isFinite(hook.timeout) ? (hook.timeout * 1000) + 15000 : 30000;
      const label = `${event} ${path.basename(args[0])}${args[1] ? ` ${args[1]}` : ''}`;
      const result = spawnSync(process.execPath, args, {
        cwd: projectDir,
        input,
        encoding: 'utf8',
        timeout: budget,
        windowsHide: true,
        env,
      });

      assert.ok(!result.error, `${label}: spawn failed: ${result.error && result.error.message}`);
      assert.equal(result.signal, null, `${label}: killed by signal ${result.signal} (budget ${budget}ms)`);
      // exit 2 是门禁的"阻断"语义（无害载荷不该触发，但不是崩溃）；其余非零值都是故障。
      assert.ok(result.status === 0 || result.status === 2,
        `${label}: unexpected exit code ${result.status}\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`);
      if (event === 'PreToolUse') {
        assert.equal(result.status, 0, `${label}: a harmless Read payload must not be blocked\n${result.stderr}`);
      }
    }

    const stateEntries = fs.readdirSync(stateDir);
    assert.ok(stateEntries.includes('var') || stateEntries.includes('.wright'),
      `hooks wrote no runtime state under HARNESS_STATE_DIR: ${stateEntries.join(', ') || '<empty>'}`);

    if (repoVarBefore !== null) {
      assert.equal(fs.statSync(repoVar).mtimeMs, repoVarBefore,
        'plugin-mode hooks wrote into the repository var/ instead of the state root');
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
