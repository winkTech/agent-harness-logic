#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/grok-render-contract.test.cjs — Phase 3.2 合同
 *
 *   1. hostPresets.grok 声明形态（eventsSubset 五族/dropAsync/skip 两条/matcher 翻译）
 *   2. HOST_DIALECTS.grok 方言（events 五映射/toolAliases/matcherTranslation）
 *   3. --check 零漂移 exit 0 + 幂等
 *   4. 产物剖面不变量：族=subset；零 async；超时≤30；maintenance 缺席；
 *      codegraph 仅 --file 形态；matcher 翻译后无 startup/resume 残留
 *   5. 剖面纯函数负例：伪造 async+长超时注册经 applyPreset 后被剥离/cap
 *      （applyPreset 不可直接 require——CLI 本体，经 smoke S2 行为覆盖；
 *       此处以真源+产物一致性替代，见 4）
 *   6. smoke 静态段 8/8（子进程跑 hosts/grok/smoke.cjs）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RENDERER = path.join(ROOT, 'core', 'engine', 'scripts', 'render-grok-hooks.cjs');
const SMOKE = path.join(ROOT, 'hosts', 'grok', 'smoke.cjs');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'engine', 'hooks', 'manifest.json'), 'utf8'));
const PRESET = MANIFEST.hostPresets.grok;

test('hostPresets.grok 声明形态', () => {
  assert.deepEqual(PRESET.eventsSubset,
    ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionStart', 'Stop']);
  assert.equal(PRESET.dropAsync, true);
  assert.equal(PRESET.skip.length, 2);
  assert.ok(PRESET.skip.some((s) => s.script.includes('memory-knowledge-maintenance')));
  assert.ok(PRESET.skip.some((s) => s.script.includes('codegraph-sync') && s.argPattern === '--session'));
  assert.equal(PRESET.matcherTranslation.startup, 'new');
  assert.equal(PRESET.matcherTranslation.resume, 'load');
});

test('HOST_DIALECTS.grok 方言表', () => {
  const { HOST_DIALECTS } = require('../lib/host-concepts.cjs');
  const g = HOST_DIALECTS.grok;
  assert.equal(g.events.SessionStart, 'session_start');
  assert.equal(g.events.Stop, 'turn_end');
  assert.equal(g.toolAliases.run_terminal_command, 'Bash');
  assert.equal(g.matcherTranslation.startup, 'new');
  assert.deepEqual([...g.sessionStartSources], ['new', 'load']);
});

test('--check 零漂移 + 幂等', () => {
  const a = spawnSync(process.execPath, [RENDERER, '--check'], { encoding: 'utf8', timeout: 60000 });
  const b = spawnSync(process.execPath, [RENDERER, '--check'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.status, b.status);
  assert.equal(a.stdout, b.stdout);
});

test('产物剖面不变量（B1 长钩子陷阱防护）', () => {
  const product = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.grok', 'hooks.json'), 'utf8'));
  const families = Object.keys(product.hooks);
  assert.equal(families.length, PRESET.eventsSubset.length);
  for (const f of families) assert.ok(PRESET.eventsSubset.includes(f));
  const s = JSON.stringify(product);
  assert.ok(!s.includes('memory-knowledge-maintenance'), '120s 长钩子必须在 grok 侧缺席');
  assert.ok(!s.includes('"async"'), 'async 字段必须剥离（grok 前台执行）');
  // codegraph 仅 --file
  let sessionForm = false; let fileForm = false;
  for (const gs of Object.values(product.hooks)) {
    for (const g of gs) {
      for (const hk of g.hooks) {
        if (String(hk.command).includes('codegraph-sync')) {
          if (String(hk.command).includes('--session')) sessionForm = true;
          if (String(hk.command).includes('--file')) fileForm = true;
        }
        assert.ok((hk.timeout || 0) <= (PRESET.maxTimeoutSeconds || 30), `超时未 cap: ${hk.command}`);
      }
      if (product.hooks.SessionStart) {
        assert.ok(!/startup|resume/.test(g.matcher || ''), 'SessionStart matcher 不得残留 claude 词汇');
      }
    }
  }
  assert.ok(!sessionForm, '--session 全量同步形态必须缺席');
  assert.ok(fileForm, '--file 增量形态应保留');
});

test('smoke 静态段 8/8', () => {
  const r = spawnSync(process.execPath, [SMOKE], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stdout);
  const passCount = (String(r.stdout).match(/✅/g) || []).length;
  assert.equal(passCount, 8, `静态检查应 8/8: ${r.stdout}`);
});
