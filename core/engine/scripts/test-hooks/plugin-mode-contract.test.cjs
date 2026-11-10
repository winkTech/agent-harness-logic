#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/plugin-mode-contract.test.cjs — 插件模式判定与 SessionStart 插件组件契约
 *
 * 覆盖 M2 合同 C2 的断言：
 *   1. detectPluginMode 三种形态：非插件 / dev checkout / 已安装插件根；
 *   2. coreCapsule 在非插件与 dev checkout 下不注入；
 *   3. coreCapsule 在非 dev 插件根注入：带前缀、去掉一级标题、含 CLAUDE.md 第二节标题；
 *   4. coreCapsule 超过 6000 字符时截断并注明；插件根缺 CLAUDE.md 时静默不注入；
 *   5. registrationOverlap 在伪造的 ~/.claude/settings.json(.local) 命中 harness hook 时告警；
 *      hooks 块不含 harness 脚本 / 无 hooks / 非插件模式时不告警；
 *   6. 两个组件抛错时 fail-open：exitCode 仍为 0，只写一行 stderr warning；
 *   7. session-bootstrap 把两个组件路由在 stateResume 之前，且组件抛错不影响 exitCode。
 *
 * 全部在 os.tmpdir() 下的临时目录进行，env 与 homeDir 均为注入值，
 * 不读真实 ~/.claude/settings.json、不写任何运行时状态。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PLUGIN_MODE = path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'plugin-mode.cjs');
const PLUGIN_CONTEXT = path.join(ROOT, 'core', 'engine', 'scripts', 'hooks', 'plugin-session-context.cjs');
const SESSION_BOOTSTRAP = path.join(ROOT, 'core', 'engine', 'scripts', 'hooks', 'session-bootstrap.cjs');

const { detectPluginMode } = require(PLUGIN_MODE);
const {
  CAPSULE_LIMIT,
  CAPSULE_PREFIX,
  coreCapsule,
  registrationOverlap,
} = require(PLUGIN_CONTEXT);

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mode-')));
let counter = 0;

function makeCase(name) {
  const dir = path.join(SANDBOX, `${name}-${counter += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 收集 io.stderr 的假 io */
function makeIo() {
  const stderr = [];
  const stdout = [];
  return { stderr: line => stderr.push(line), stdout: line => stdout.push(line), lines: stderr, out: stdout };
}

/** 在 base 下造一个插件根，放一份 CLAUDE.md（默认拷贝本仓库真实内容） */
function makePluginRoot(base, content) {
  const pluginRoot = path.join(base, 'plugin');
  fs.mkdirSync(pluginRoot, { recursive: true });
  const body = content === undefined
    ? fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8')
    : content;
  if (body !== null) fs.writeFileSync(path.join(pluginRoot, 'CLAUDE.md'), body, 'utf8');
  return pluginRoot;
}

/** 在 base 下造一个假 HOME，写 <home>/.claude/<name> */
function makeHome(base, files) {
  const homeDir = path.join(base, 'home');
  const settingsDir = path.join(homeDir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  for (const [name, value] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(settingsDir, name), value, 'utf8');
  }
  return homeDir;
}

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ── 1. detectPluginMode 三种形态 ───────────────────────────────────────────

test('1. detectPluginMode distinguishes no-plugin, dev checkout and installed plugin root', () => {
  const base = makeCase('detect');
  const homeDir = path.join(base, 'home');

  assert.deepEqual(
    detectPluginMode({ env: {}, homeDir }),
    { pluginRoot: '', isPlugin: false, isDevCheckout: false },
  );
  assert.deepEqual(
    detectPluginMode({ env: { CLAUDE_PLUGIN_ROOT: '   ' }, homeDir }),
    { pluginRoot: '', isPlugin: false, isDevCheckout: false },
    'a blank CLAUDE_PLUGIN_ROOT is not plugin mode',
  );

  const devRoot = path.join(homeDir, '.claude');
  assert.deepEqual(
    detectPluginMode({ env: { CLAUDE_PLUGIN_ROOT: devRoot }, homeDir }),
    { pluginRoot: path.resolve(devRoot), isPlugin: true, isDevCheckout: true },
  );
  assert.equal(
    detectPluginMode({ env: { CLAUDE_PLUGIN_ROOT: `${devRoot}${path.sep}` }, homeDir }).isDevCheckout,
    true,
    'a trailing separator must not hide the dev checkout',
  );

  const installed = path.join(base, 'plugins', 'logical-paradox', 'v0.1.0');
  assert.deepEqual(
    detectPluginMode({ env: { CLAUDE_PLUGIN_ROOT: installed }, homeDir }),
    { pluginRoot: path.resolve(installed), isPlugin: true, isDevCheckout: false },
  );
});

// ── 2. coreCapsule 不注入的形态 ────────────────────────────────────────────

test('2. coreCapsule injects nothing outside plugin mode and nothing on a dev checkout', () => {
  const base = makeCase('capsule-skip');
  const homeDir = makeHome(base, {});
  const devRoot = path.join(homeDir, '.claude');
  fs.writeFileSync(path.join(devRoot, 'CLAUDE.md'), '# T\n\n## A\n\nbody\n', 'utf8');
  const io = makeIo();

  assert.deepEqual(coreCapsule({}, io, { env: {}, homeDir }), { exitCode: 0 });
  assert.deepEqual(
    coreCapsule({}, io, { env: { CLAUDE_PLUGIN_ROOT: devRoot }, homeDir }),
    { exitCode: 0 },
    'dev checkout already loads CLAUDE.md as user memory; injecting again would double it',
  );
  assert.deepEqual(io.lines, [], 'skipping must be silent');
});

// ── 3. coreCapsule 在已安装插件根注入 ──────────────────────────────────────

test('3. coreCapsule injects the CLAUDE.md body under a prefix, without the level-1 heading', () => {
  const base = makeCase('capsule-inject');
  const homeDir = makeHome(base, {});
  const pluginRoot = makePluginRoot(base);
  const source = fs.readFileSync(path.join(pluginRoot, 'CLAUDE.md'), 'utf8');
  const sections = source.split(/\r?\n/).filter(line => /^##\s+\S/.test(line));
  assert.ok(sections.length >= 2, 'fixture CLAUDE.md must have at least two sections');
  const io = makeIo();

  const result = coreCapsule({}, io, { env: { CLAUDE_PLUGIN_ROOT: pluginRoot }, homeDir });

  assert.equal(result.exitCode, 0);
  assert.ok(result.context.startsWith(`${CAPSULE_PREFIX}\n\n`), 'capsule must carry the injection prefix');
  assert.ok(result.context.includes(sections[1]), 'capsule must carry the second section heading');
  const firstBodyLine = result.context.split('\n')[2];
  assert.ok(!/^#\s+\S/.test(firstBodyLine), `level-1 heading must be stripped, got ${firstBodyLine}`);
  assert.equal(result.context.includes(source.split(/\r?\n/)[0]), false,
    'the original level-1 title must not survive');
  assert.deepEqual(io.lines, []);
});

// ── 4. 截断与缺文件 ────────────────────────────────────────────────────────

test('4. coreCapsule truncates past the 6000 character cap and stays silent without CLAUDE.md', () => {
  const base = makeCase('capsule-limit');
  const homeDir = makeHome(base, {});
  const long = `# Title\n\n## 第一节\n\n${'安'.repeat(CAPSULE_LIMIT + 500)}\n`;
  const pluginRoot = makePluginRoot(base, long);
  const io = makeIo();

  const result = coreCapsule({}, io, { env: { CLAUDE_PLUGIN_ROOT: pluginRoot }, homeDir });
  assert.equal(result.exitCode, 0);
  assert.match(result.context, /（已截断，完整内容见 /);
  const body = result.context.slice(`${CAPSULE_PREFIX}\n\n`.length);
  assert.ok(body.length < CAPSULE_LIMIT + 200, `truncated body is too long: ${body.length}`);

  const emptyRoot = path.join(base, 'no-capsule');
  fs.mkdirSync(emptyRoot, { recursive: true });
  assert.deepEqual(
    coreCapsule({}, io, { env: { CLAUDE_PLUGIN_ROOT: emptyRoot }, homeDir }),
    { exitCode: 0 },
    'a plugin root without CLAUDE.md must not break the session',
  );
  assert.deepEqual(io.lines, [], 'a missing capsule is not a warning');
});

// ── 5. registrationOverlap 告警条件 ────────────────────────────────────────

test('5. registrationOverlap warns only when user settings also register a harness router', () => {
  const base = makeCase('overlap');
  const pluginRoot = makePluginRoot(base, '# X\n\n## A\n\nbody\n');
  const env = { CLAUDE_PLUGIN_ROOT: pluginRoot };
  const io = makeIo();

  const harnessSettings = JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: 'startup|resume',
        hooks: [{ type: 'command', command: 'node C:/Users/x/.claude/core/engine/scripts/hooks/session-bootstrap.cjs' }],
      }],
    },
  });
  const unrelatedSettings = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ./tools/unrelated.cjs' }] }] },
  });

  const hitMain = makeHome(makeCase('overlap-main'), { 'settings.json': harnessSettings });
  const overlap = registrationOverlap({}, io, { env, homeDir: hitMain });
  assert.equal(overlap.exitCode, 0);
  assert.match(overlap.context, /^\[logical-paradox\] 检测到用户级 settings\.json 也注册了 harness hook/);
  assert.match(overlap.context, /插件副本与用户副本会各跑一次/);
  assert.ok(overlap.context.includes(path.join(pluginRoot, 'core', 'engine', 'scripts', 'render-hook-settings.cjs')),
    'the warning must name the plugin-root remediation script');
  assert.match(overlap.context, /--remove-user-hooks/);

  const hitLocal = makeHome(makeCase('overlap-local'), {
    'settings.json': unrelatedSettings,
    'settings.local.json': harnessSettings,
  });
  assert.match(
    registrationOverlap({}, io, { env, homeDir: hitLocal }).context,
    /各跑一次/,
    'settings.local.json must be checked as well',
  );

  const noHit = makeHome(makeCase('overlap-none'), {
    'settings.json': unrelatedSettings,
    'settings.local.json': JSON.stringify({ permissions: { allow: [] } }),
  });
  assert.deepEqual(registrationOverlap({}, io, { env, homeDir: noHit }), { exitCode: 0 });

  const emptyHome = makeHome(makeCase('overlap-empty'), {});
  assert.deepEqual(registrationOverlap({}, io, { env, homeDir: emptyHome }), { exitCode: 0 });

  assert.deepEqual(
    registrationOverlap({}, io, { env: {}, homeDir: hitMain }),
    { exitCode: 0 },
    'outside plugin mode there is no double run to warn about',
  );
  assert.deepEqual(io.lines, [], 'the overlap check must not emit warnings on any of these paths');
});

test('5b. registrationOverlap warns on a dev checkout too (that is the double run to catch)', () => {
  const base = makeCase('overlap-dev');
  const homeDir = makeHome(base, {
    'settings.json': JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'node ~/.claude/core/engine/scripts/hooks/preflight-router.cjs' }] }],
      },
    }),
  });
  const devRoot = path.join(homeDir, '.claude');
  const io = makeIo();

  const result = registrationOverlap({}, io, { env: { CLAUDE_PLUGIN_ROOT: devRoot }, homeDir });
  assert.equal(result.exitCode, 0);
  assert.match(result.context, /各跑一次/);
});

// ── 6. 两个组件 fail-open ──────────────────────────────────────────────────

test('6. both components fail open: exitCode stays 0 and the failure is one stderr warning', () => {
  const base = makeCase('fail-open');
  const homeDir = makeHome(base, {});
  const hostileEnv = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'CLAUDE_PLUGIN_ROOT') throw new Error('env access exploded');
      return undefined;
    },
  });

  for (const component of [coreCapsule, registrationOverlap]) {
    const io = makeIo();
    const result = component({}, io, { env: hostileEnv, homeDir });
    assert.equal(result.exitCode, 0, `${component.name} must never fail the session`);
    assert.equal(result.context, undefined);
    assert.equal(io.lines.length, 1, `${component.name} must emit exactly one warning`);
    const parsed = JSON.parse(io.lines[0]);
    assert.equal(parsed.type, 'warning');
    assert.equal(parsed.source, 'plugin-session-context');
    assert.match(parsed.message, /env access exploded/);
  }

  // 损坏的 settings.json 不是致命错误：解析失败按“没注册”处理
  const brokenHome = makeHome(makeCase('fail-open-json'), { 'settings.json': '{ not json' });
  const io = makeIo();
  assert.deepEqual(
    registrationOverlap({}, io, {
      env: { CLAUDE_PLUGIN_ROOT: path.join(base, 'plugin') },
      homeDir: brokenHome,
    }),
    { exitCode: 0 },
  );
  assert.deepEqual(io.lines, []);
});

// ── 7. session-bootstrap 路由顺序与 fail-open ─────────────────────────────

test('7. session-bootstrap routes both plugin components before stateResume and survives their failure', () => {
  const { runSessionBootstrap } = require(SESSION_BOOTSTRAP);
  const calls = [];
  const stdout = [];
  const stderr = [];

  const result = runSessionBootstrap(
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'plugin-mode-contract' }),
    {
      components: {
        coreCapsule() {
          calls.push('coreCapsule');
          throw new Error('capsule blew up');
        },
        registrationOverlap() {
          calls.push('registrationOverlap');
          throw new Error('overlap blew up');
        },
        stateResume() {
          calls.push('stateResume');
          return { exitCode: 0, context: 'state' };
        },
        contextResumeInject() {
          calls.push('contextResumeInject');
          return { exitCode: 0 };
        },
        dreamStartup() {
          calls.push('dreamStartup');
          return { exitCode: 0 };
        },
      },
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    },
  );

  assert.deepEqual(calls, [
    'coreCapsule', 'registrationOverlap', 'stateResume', 'contextResumeInject', 'dreamStartup',
  ]);
  assert.equal(result.exitCode, 0, 'plugin component failures must not fail SessionStart');
  assert.equal(result.componentsRun[0], 'coreCapsule');
  assert.equal(result.componentsRun[1], 'registrationOverlap');
  assert.equal(stderr.length, 2, 'each failure is reported once');
  assert.equal(JSON.parse(stdout[0]).hookSpecificOutput.additionalContext, 'state');
});
