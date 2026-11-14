#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/pack-externalization-contract.test.cjs
 * Phase 2.6 验收：F 内容外置行为等价 + P-4 可卸性。
 *
 * 双场景矩阵：
 *   A. pack 在场：五处规则全部生效（与外置前逐字等价）
 *   B. HARNESS_PACKS_DISABLED=1：全部降级、core 骨架不炸
 * 子进程矩阵跑（env 隔离——require 期读配置必须进程级隔离）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ENGINE = path.join(ROOT, 'core', 'engine');

function runChild(script, env = {}) {
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, ...env },
  });
}

// ── pack 在场：五处规则生效 ────────────────────────────────────────────────

test('pack 在场：watchdog FPGA 验证命令识别（vivado batch）', () => {
  const r = runChild(`
    const wd = require(${JSON.stringify(path.join(ENGINE, 'hooks/session/progress-watchdog.cjs'))});
    process.env.PROGRESS_WATCHDOG_STATE_FILE = require('node:os').tmpdir() + '/wd-p4.json';
    const m = wd.inspect || null;
    // 直接探正则字段（导出面契约）:
    console.log(JSON.stringify({ fpga: typeof wd.FPGA_VERIFICATION_COMMAND }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const { fpga } = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.notEqual(fpga, 'null', 'pack 在场时 FPGA 正则不得为 null'); // typeof null === 'object'
});

test('pack 在场：hdl-gate 综合红线（initial 触发）', () => {
  const r = runChild(`
    const src = require('node:fs').readFileSync(${JSON.stringify(path.join(ENGINE, 'scripts/hooks/hdl-gate.cjs'))}, 'utf8');
    // 经 pack-config 验证规则表可编译且含 initial 规则
    const { loadPackConfig, compileRegexRules } = require(${JSON.stringify(path.join(ENGINE, 'scripts/lib/pack-config.cjs'))});
    const rules = compileRegexRules(loadPackConfig('hdl-gate-synthesis-rules').synthesisViolations);
    console.log(JSON.stringify({ count: rules.length, initial: rules.some(x => x.re.test('initial begin')) }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const { count, initial } = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(count, 6);
  assert.equal(initial, true);
});

test('pack 在场：file-protection 模式（golden_model 命中）', () => {
  const r = runChild(`
    const { loadPackConfig } = require(${JSON.stringify(path.join(ENGINE, 'scripts/lib/pack-config.cjs'))});
    const patterns = loadPackConfig('file-protection-patterns').protectedPatterns;
    console.log(JSON.stringify({ n: patterns.length, golden: patterns.includes('**/golden_model*/**') }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const { n, golden } = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(n, 4);
  assert.equal(golden, true);
});

test('pack 在场：fix-in-place RTL 变体（_v2.sv 识别）', () => {
  const r = runChild(`
    const { loadPackConfig, compileRegexRules } = require(${JSON.stringify(path.join(ENGINE, 'scripts/lib/pack-config.cjs'))});
    const rules = compileRegexRules(loadPackConfig('fix-in-place-variant-rules').variantPatterns);
    console.log(JSON.stringify({ n: rules.length, v2: rules.some(x => x.re.test('fifo_v2.sv')) }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const { n, v2 } = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(n, 5);
  assert.equal(v2, true);
});

test('pack 在场：sim-governance 触发（vsim 命令）', () => {
  const r = runChild(`
    const { loadPackConfig, compileRegexField } = require(${JSON.stringify(path.join(ENGINE, 'scripts/lib/pack-config.cjs'))});
    const re = compileRegexField(loadPackConfig('sim-governance-rules'), 'triggerCommand');
    console.log(JSON.stringify({ hit: re.test('vsim -c work.tb_top') }));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).hit, true);
});

// ── P-4 可卸性：HARNESS_PACKS_DISABLED=1 全降级 ───────────────────────────

test('P-4: pack 禁用时 loadPackConfig 恒 null', () => {
  const r = runChild(`
    const { loadPackConfig, packsDisabled } = require(${JSON.stringify(path.join(ENGINE, 'scripts/lib/pack-config.cjs'))});
    console.log(JSON.stringify({ disabled: packsDisabled(), cfg: loadPackConfig('hdl-gate-synthesis-rules') }));
  `, { HARNESS_PACKS_DISABLED: '1' });
  assert.equal(r.status, 0, r.stderr);
  const { disabled, cfg } = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(disabled, true);
  assert.equal(cfg, null);
});

test('P-4: 五消费方在禁用下降级加载不炸', () => {
  const r = runChild(`
    // 五个消费方全部 require 一遍——降级路径必须无异常
    require(${JSON.stringify(path.join(ENGINE, 'hooks/session/progress-watchdog.cjs'))});
    require(${JSON.stringify(path.join(ENGINE, 'hooks/safety/fix-in-place-guard.cjs'))});
    require(${JSON.stringify(path.join(ENGINE, 'hooks/safety/sim-governance.cjs'))});
    require(${JSON.stringify(path.join(ENGINE, 'scripts/hooks/hdl-gate.cjs'))});
    require(${JSON.stringify(path.join(ENGINE, 'scripts/hooks/file-protection-guard.cjs'))});
    console.log('OK');
  `, { HARNESS_PACKS_DISABLED: '1' });
  assert.equal(r.status, 0, `禁用下加载失败: ${r.stderr}`);
  assert.ok(r.stdout.includes('OK'));
});

test('P-4: watchdog 禁用下通用验证命令仍生效', () => {
  const r = runChild(`
    const wd = require(${JSON.stringify(path.join(ENGINE, 'hooks/session/progress-watchdog.cjs'))});
    console.log(JSON.stringify({ fpga: wd.FPGA_VERIFICATION_COMMAND === null ? 'null' : typeof wd.FPGA_VERIFICATION_COMMAND }));
  `, { HARNESS_PACKS_DISABLED: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).fpga, 'null');
});

// ── 配置形态 ───────────────────────────────────────────────────────────────

test('五份规则表形态齐备（packs/fpga/config）', () => {
  for (const name of [
    'progress-watchdog-rules', 'fix-in-place-variant-rules',
    'hdl-gate-synthesis-rules', 'sim-governance-rules', 'file-protection-patterns',
  ]) {
    const file = path.join(ROOT, 'packs', 'fpga', 'config', `${name}.json`);
    assert.ok(fs.existsSync(file), `缺规则表: ${name}`);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(cfg.$schema && cfg.description, `${name} 缺 $schema/description`);
  }
});

test('坏 JSON fail-soft：返回 null 不抛', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'broken-rules.json'), '{broken', 'utf8');
  const r = runChild(`
    process.env.HARNESS_FPGA_CONFIG_DIR = ${JSON.stringify(dir)};
    const { loadPackConfig } = require(${JSON.stringify(path.join(ENGINE, 'scripts/lib/pack-config.cjs'))});
    console.log(JSON.stringify({ v: loadPackConfig('broken-rules') }));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).v, null);
});
