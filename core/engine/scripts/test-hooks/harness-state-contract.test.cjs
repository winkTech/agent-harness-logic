#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/test-hooks/harness-state-contract.test.cjs — 状态根解析与迁移契约
 *
 * 覆盖 M1（状态分离）合同的 10 条断言：
 *   1. env.HARNESS_STATE_DIR 覆盖优先于一切；
 *   2. 默认目录 <homedir>/.logical-paradox 有 state.json 时命中默认目录；
 *   3. 无 marker 时回落 harnessRoot（legacy in-place，本机当前形态）；
 *   4. marker 的 layoutVersion 比本 harness 新 → 抛错，不静默丢数据；
 *   5. marker 损坏（非法 JSON）→ 抛错；
 *   6. resolveStateRoot 是纯函数：调用前后目录树快照逐字节一致；
 *   7. 迁移 dry-run 严格只读：写接口一次都不调用，源/目标快照不变；
 *   8. 迁移 execute：文件搬到位、state.json 内容正确、旧位置留 STATE-MOVED.txt；
 *   9. 第二次 execute 到同一目标 → exit 3（拒绝覆盖）；
 *  10. 跨卷回退：注入 rename 失败后走递归复制 + 删源路径。
 * 以及 M2（插件模式）合同追加的 3 条：
 *  11. 旧位置没有 var/.wright 时不再回落 harnessRoot，而是落到默认状态目录；
 *  12. CLAUDE_PLUGIN_DATA 生效，但优先级低于 legacy in-place；
 *  13. STATE_MODE 五种取值 env / migrated / legacy / plugin-data / default。
 *
 * 全部在 os.tmpdir() 下的临时目录进行，不触碰真实 HARNESS_ROOT 的状态。
 * 独立可执行：退出码 0 = 通过（由 run-all-tests.cjs 的 AuditRemediationContracts spawn 校验）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const LIB = path.resolve(__dirname, '..', 'lib', 'harness-state.cjs');
const MIGRATOR = path.resolve(__dirname, '..', 'migrate-state-dir.cjs');
const {
  STATE_LAYOUT_VERSION,
  STATE_MARKER,
  DEFAULT_STATE_DIRNAME,
  STATE_MODE,
  resolveState,
  resolveStateRoot,
  readStateMarker,
} = require(LIB);
const {
  EXIT_OK,
  EXIT_CONFLICT,
  MOVED_NOTE,
  planMigration,
  runMigration,
} = require(MIGRATOR);

// ── 临时沙箱（绝对路径，按平台解析真实路径，避免 Windows 8.3 短名不匹配） ──

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-state-')));
let counter = 0;

function makeCase(name) {
  const dir = path.join(SANDBOX, `${name}-${counter += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 建一棵 harnessRoot 样子的假状态树：var/** 与 .wright/** */
function seedHarnessRoot(root) {
  fs.mkdirSync(path.join(root, 'var', 'gates'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wright'), { recursive: true });
  fs.writeFileSync(path.join(root, 'var', 'state.txt'), 'alpha\n', 'utf8');
  fs.writeFileSync(path.join(root, 'var', 'gates', 'gate.json'), '{"ok":true}\n', 'utf8');
  fs.writeFileSync(path.join(root, '.wright', 'memory.db'), 'not-a-real-db\n', 'utf8');
  return root;
}

/** 目录树快照：相对路径 + 类型 + 大小，排序后可逐字节比对 */
function snapshot(root) {
  const out = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out.push(`d ${rel}`);
        walk(full);
      } else {
        out.push(`f ${rel} ${fs.statSync(full).size}`);
      }
    }
  };
  if (!fs.existsSync(root)) return ['<missing>'];
  walk(root);
  return out.sort();
}

/** dry-run 用：任何写操作都直接炸掉，证明它一次都没被调用 */
function forbiddenOps(calls) {
  const trap = (name) => (...args) => {
    calls.push(`${name}(${args.join(', ')})`);
    throw new Error(`dry-run must not call ${name}`);
  };
  return {
    rename: trap('rename'),
    mkdir: trap('mkdir'),
    copyFile: trap('copyFile'),
    symlink: trap('symlink'),
    rm: trap('rm'),
    writeFile: trap('writeFile'),
  };
}

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

// ── 1. env 覆盖优先 ────────────────────────────────────────────────────────

test('1. HARNESS_STATE_DIR overrides both the migrated default and legacy in-place', () => {
  const base = makeCase('env-override');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const homeDir = path.join(base, 'home');
  const defaultRoot = path.join(homeDir, DEFAULT_STATE_DIRNAME);
  fs.mkdirSync(defaultRoot, { recursive: true });
  fs.writeFileSync(path.join(defaultRoot, STATE_MARKER), JSON.stringify({ layoutVersion: 1 }), 'utf8');
  const envDir = path.join(base, 'elsewhere');

  const resolved = resolveStateRoot({ env: { HARNESS_STATE_DIR: envDir }, harnessRoot, homeDir });
  assert.equal(resolved, path.resolve(envDir), 'env override must win over the default marker');
  assert.equal(fs.existsSync(envDir), false, 'env override must not be created by resolution');
});

// ── 2. 默认目录有 marker → 已迁移机器 ──────────────────────────────────────

test('2. default state dir with a marker wins over the harness root', () => {
  const base = makeCase('default-marker');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const homeDir = path.join(base, 'home');
  const defaultRoot = path.join(homeDir, DEFAULT_STATE_DIRNAME);
  fs.mkdirSync(defaultRoot, { recursive: true });
  fs.writeFileSync(
    path.join(defaultRoot, STATE_MARKER),
    JSON.stringify({ layoutVersion: STATE_LAYOUT_VERSION, tool: 'migrate-state-dir' }),
    'utf8',
  );

  assert.equal(resolveStateRoot({ env: {}, harnessRoot, homeDir }), path.resolve(defaultRoot));
  assert.equal(readStateMarker(defaultRoot).layoutVersion, STATE_LAYOUT_VERSION);
});

// ── 3. 无 marker + 旧位置仍有状态 → legacy in-place ────────────────────────

test('3. without any marker resolution falls back to the harness root (legacy in-place)', () => {
  const base = makeCase('legacy');
  // M2 起 legacy 一级要求旧位置真的有状态目录：seedHarnessRoot 建的 var/ 与 .wright/ 即前提
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const homeDir = path.join(base, 'home');
  fs.mkdirSync(homeDir, { recursive: true });

  assert.equal(resolveStateRoot({ env: {}, harnessRoot, homeDir }), path.resolve(harnessRoot));
  assert.equal(readStateMarker(harnessRoot), null, 'legacy root must not carry a marker');
});

// ── 4. layoutVersion 过新 → 拒绝启动 ───────────────────────────────────────

test('4. a newer layoutVersion refuses to start instead of silently dropping state', () => {
  const base = makeCase('too-new');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const homeDir = path.join(base, 'home');
  const defaultRoot = path.join(homeDir, DEFAULT_STATE_DIRNAME);
  fs.mkdirSync(defaultRoot, { recursive: true });
  fs.writeFileSync(
    path.join(defaultRoot, STATE_MARKER),
    JSON.stringify({ layoutVersion: STATE_LAYOUT_VERSION + 1 }),
    'utf8',
  );

  assert.throws(
    () => resolveStateRoot({ env: {}, harnessRoot, homeDir }),
    /state layout too new/,
  );
});

// ── 5. marker 损坏 → 抛错 ──────────────────────────────────────────────────

test('5. a corrupt marker throws rather than being ignored', () => {
  const base = makeCase('corrupt');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const homeDir = path.join(base, 'home');
  const stateDir = path.join(base, 'broken');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, STATE_MARKER), '{ not json', 'utf8');

  assert.throws(() => readStateMarker(stateDir), /corrupt/);
  assert.throws(
    () => resolveStateRoot({ env: { HARNESS_STATE_DIR: stateDir }, harnessRoot, homeDir }),
    /corrupt/,
  );
});

// ── 6. resolveStateRoot 是纯函数 ───────────────────────────────────────────

test('6. resolveStateRoot creates nothing (before/after snapshots are identical)', () => {
  const base = makeCase('pure');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const homeDir = path.join(base, 'home');
  fs.mkdirSync(homeDir, { recursive: true });

  const before = snapshot(base);
  resolveStateRoot({ env: {}, harnessRoot, homeDir });
  resolveStateRoot({ env: { HARNESS_STATE_DIR: path.join(base, 'never-created') }, harnessRoot, homeDir });
  resolveStateRoot({ env: {}, harnessRoot, homeDir: path.join(base, 'no-such-home') });
  const afterSnapshot = snapshot(base);

  assert.deepEqual(afterSnapshot, before, 'resolveStateRoot must not touch the filesystem');
});

// ── 7. dry-run 严格只读 ────────────────────────────────────────────────────

test('7. migration dry-run performs zero writes', () => {
  const base = makeCase('dry-run');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const target = path.join(base, 'state');
  const before = snapshot(base);
  const calls = [];

  const result = runMigration({ harnessRoot, to: target, env: {}, fsOps: forbiddenOps(calls) });

  assert.equal(result.code, EXIT_OK);
  assert.equal(result.dryRun, true);
  assert.deepEqual(calls, [], 'dry-run must not invoke any write operation');
  assert.deepEqual(snapshot(base), before, 'dry-run must leave the tree untouched');
  assert.equal(fs.existsSync(target), false, 'dry-run must not create the target');

  const plan = planMigration({ harnessRoot, to: target, env: {} });
  assert.deepEqual(plan.sources.map(s => s.name).sort(), ['.wright', 'var']);
  assert.equal(plan.sources.reduce((sum, s) => sum + s.files, 0), 3);
  assert.deepEqual(plan.conflicts, []);
});

// ── 8. execute：搬到位 + marker + STATE-MOVED.txt ──────────────────────────

test('8. migration execute moves both trees and writes the marker plus the moved note', () => {
  const base = makeCase('execute');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const target = path.join(base, 'state');

  const result = runMigration({ harnessRoot, to: target, env: {}, execute: true });

  assert.deepEqual(result.errors, [], `unexpected errors: ${result.errors.join('; ')}`);
  assert.equal(result.code, EXIT_OK);
  assert.equal(fs.readFileSync(path.join(target, 'var', 'state.txt'), 'utf8'), 'alpha\n');
  assert.equal(fs.readFileSync(path.join(target, 'var', 'gates', 'gate.json'), 'utf8'), '{"ok":true}\n');
  assert.equal(fs.readFileSync(path.join(target, '.wright', 'memory.db'), 'utf8'), 'not-a-real-db\n');
  assert.equal(fs.existsSync(path.join(harnessRoot, 'var')), false, 'source var/ must be gone');
  assert.equal(fs.existsSync(path.join(harnessRoot, '.wright')), false, 'source .wright/ must be gone');

  const marker = readStateMarker(target);
  assert.equal(marker.layoutVersion, STATE_LAYOUT_VERSION);
  assert.equal(marker.migratedFrom, path.resolve(harnessRoot));
  assert.equal(marker.tool, 'migrate-state-dir');
  assert.ok(!Number.isNaN(Date.parse(marker.migratedAt)), 'migratedAt must be an ISO timestamp');

  const note = fs.readFileSync(path.join(harnessRoot, MOVED_NOTE), 'utf8');
  assert.match(note, new RegExp(target.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')));

  // 目标不在默认位置时，只有 HARNESS_STATE_DIR 能指向它；否则仍是 legacy。
  // M2 起 legacy 一级以旧位置存在 var/.wright 为前提，迁移已把它们搬走，这里重建同一前提。
  seedHarnessRoot(harnessRoot);
  assert.equal(
    resolveStateRoot({ env: {}, harnessRoot, homeDir: base }),
    path.resolve(harnessRoot),
    'a non-default target still resolves to legacy unless HARNESS_STATE_DIR points at it',
  );
  assert.equal(
    resolveStateRoot({ env: { HARNESS_STATE_DIR: target }, harnessRoot }),
    path.resolve(target),
  );
});

// ── 9. 第二次 execute → exit 3 ─────────────────────────────────────────────

test('9. a second execute into the same target refuses with exit 3', () => {
  const base = makeCase('conflict');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const target = path.join(base, 'state');

  const first = runMigration({ harnessRoot, to: target, env: {}, execute: true });
  assert.equal(first.code, EXIT_OK);

  seedHarnessRoot(harnessRoot); // 旧位置又长出状态：仍然不许覆盖已有目标
  const targetBefore = snapshot(target);
  const second = runMigration({ harnessRoot, to: target, env: {}, execute: true });

  assert.equal(second.code, EXIT_CONFLICT, 'existing state at the target must not be overwritten');
  assert.ok(second.errors.length > 0, 'conflict must be explained');
  assert.deepEqual(snapshot(target), targetBefore, 'the refused run must not modify the target');
  assert.equal(fs.existsSync(path.join(harnessRoot, 'var')), true, 'the refused run must keep the source');
});

// ── 10. 跨卷回退：注入 rename 失败 ─────────────────────────────────────────

test('10. a failing rename falls back to recursive copy plus source removal', () => {
  const base = makeCase('cross-volume');
  const harnessRoot = seedHarnessRoot(path.join(base, 'repo'));
  const target = path.join(base, 'state');
  let renameAttempts = 0;

  const result = runMigration({
    harnessRoot,
    to: target,
    env: {},
    execute: true,
    fsOps: {
      rename: () => {
        renameAttempts += 1;
        const err = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      },
    },
  });

  assert.equal(renameAttempts, 2, 'rename must be attempted once per source tree');
  assert.deepEqual(result.errors, [], `unexpected errors: ${result.errors.join('; ')}`);
  assert.equal(result.code, EXIT_OK);
  assert.deepEqual(result.moved.map(m => m.strategy), ['copy', 'copy']);
  assert.equal(result.moved.reduce((sum, m) => sum + m.files, 0), 3, 'every file must be copied and size-checked');
  assert.equal(fs.readFileSync(path.join(target, 'var', 'gates', 'gate.json'), 'utf8'), '{"ok":true}\n');
  assert.equal(fs.existsSync(path.join(harnessRoot, 'var')), false, 'copy fallback must still delete the source');
  assert.equal(fs.existsSync(path.join(harnessRoot, '.wright')), false, 'copy fallback must still delete the source');
  assert.equal(readStateMarker(target).layoutVersion, STATE_LAYOUT_VERSION);
});

// ── 11. 旧位置没有状态目录 → 不再回落 harnessRoot ──────────────────────────

test('11. an empty harness root no longer captures state (falls through to the default dir)', () => {
  const base = makeCase('no-legacy');
  const harnessRoot = path.join(base, 'repo');
  fs.mkdirSync(harnessRoot, { recursive: true });
  fs.writeFileSync(path.join(harnessRoot, 'README.md'), 'code only', 'utf8');
  const homeDir = path.join(base, 'home');
  fs.mkdirSync(homeDir, { recursive: true });

  const resolved = resolveStateRoot({ env: {}, harnessRoot, homeDir });
  assert.equal(resolved, path.resolve(homeDir, DEFAULT_STATE_DIRNAME),
    'a harness root without var/ or .wright/ must not become the state root');
  assert.notEqual(resolved, path.resolve(harnessRoot));
  assert.equal(fs.existsSync(resolved), false, 'resolution must not create the default dir');

  // 只要旧位置有其中任意一个目录，legacy 一级就重新成立
  for (const dirname of ['var', '.wright']) {
    const legacyRoot = path.join(base, `legacy-${dirname.replace('.', '')}`);
    fs.mkdirSync(path.join(legacyRoot, dirname), { recursive: true });
    assert.equal(
      resolveStateRoot({ env: {}, harnessRoot: legacyRoot, homeDir }),
      path.resolve(legacyRoot),
      `${dirname}/ alone must keep legacy in-place resolution`,
    );
  }
});

// ── 12. CLAUDE_PLUGIN_DATA 生效，但低于 legacy ─────────────────────────────

test('12. CLAUDE_PLUGIN_DATA is honoured for fresh installs but never outranks legacy state', () => {
  const base = makeCase('plugin-data');
  const homeDir = path.join(base, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const pluginData = path.join(base, 'plugins', 'data', 'logical-paradox');
  const env = { CLAUDE_PLUGIN_DATA: pluginData };

  const freshRoot = path.join(base, 'fresh-repo');
  fs.mkdirSync(freshRoot, { recursive: true });
  assert.equal(
    resolveStateRoot({ env, harnessRoot: freshRoot, homeDir }),
    path.resolve(pluginData),
    'a plugin install with no legacy state must use CLAUDE_PLUGIN_DATA',
  );
  assert.equal(fs.existsSync(pluginData), false, 'resolution must not create CLAUDE_PLUGIN_DATA');

  const legacyRoot = seedHarnessRoot(path.join(base, 'legacy-repo'));
  assert.equal(
    resolveStateRoot({ env, harnessRoot: legacyRoot, homeDir }),
    path.resolve(legacyRoot),
    'existing in-place state must outrank CLAUDE_PLUGIN_DATA',
  );

  // env 覆盖与已迁移默认目录仍然压过 CLAUDE_PLUGIN_DATA
  const envDir = path.join(base, 'explicit');
  assert.equal(
    resolveStateRoot({ env: { ...env, HARNESS_STATE_DIR: envDir }, harnessRoot: freshRoot, homeDir }),
    path.resolve(envDir),
  );
  const defaultRoot = path.join(homeDir, DEFAULT_STATE_DIRNAME);
  fs.mkdirSync(defaultRoot, { recursive: true });
  fs.writeFileSync(
    path.join(defaultRoot, STATE_MARKER),
    JSON.stringify({ layoutVersion: STATE_LAYOUT_VERSION }),
    'utf8',
  );
  assert.equal(
    resolveStateRoot({ env, harnessRoot: freshRoot, homeDir }),
    path.resolve(defaultRoot),
    'a migrated default dir must outrank CLAUDE_PLUGIN_DATA',
  );
});

// ── 13. STATE_MODE 五种取值 ───────────────────────────────────────────────

test('13. resolveState reports which precedence level was hit', () => {
  const base = makeCase('state-mode');
  const homeDir = path.join(base, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const legacyRoot = seedHarnessRoot(path.join(base, 'legacy-repo'));
  const freshRoot = path.join(base, 'fresh-repo');
  fs.mkdirSync(freshRoot, { recursive: true });
  const pluginData = path.join(base, 'plugin-data');

  assert.deepEqual(
    resolveState({ env: { HARNESS_STATE_DIR: path.join(base, 'explicit') }, harnessRoot: legacyRoot, homeDir }),
    { stateRoot: path.resolve(base, 'explicit'), mode: 'env' },
  );
  assert.deepEqual(
    resolveState({ env: {}, harnessRoot: legacyRoot, homeDir }),
    { stateRoot: path.resolve(legacyRoot), mode: 'legacy' },
  );
  assert.deepEqual(
    resolveState({ env: { CLAUDE_PLUGIN_DATA: pluginData }, harnessRoot: freshRoot, homeDir }),
    { stateRoot: path.resolve(pluginData), mode: 'plugin-data' },
  );
  assert.deepEqual(
    resolveState({ env: {}, harnessRoot: freshRoot, homeDir }),
    { stateRoot: path.resolve(homeDir, DEFAULT_STATE_DIRNAME), mode: 'default' },
  );

  const defaultRoot = path.join(homeDir, DEFAULT_STATE_DIRNAME);
  fs.mkdirSync(defaultRoot, { recursive: true });
  fs.writeFileSync(
    path.join(defaultRoot, STATE_MARKER),
    JSON.stringify({ layoutVersion: STATE_LAYOUT_VERSION }),
    'utf8',
  );
  assert.deepEqual(
    resolveState({ env: {}, harnessRoot: legacyRoot, homeDir }),
    { stateRoot: path.resolve(defaultRoot), mode: 'migrated' },
  );

  assert.ok(
    ['env', 'migrated', 'legacy', 'plugin-data', 'default'].includes(STATE_MODE),
    `exported STATE_MODE must be one of the five levels, got ${STATE_MODE}`,
  );
});
