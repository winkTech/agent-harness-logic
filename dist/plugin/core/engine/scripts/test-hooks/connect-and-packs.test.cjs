#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/connect-and-packs.test.cjs
 *
 * 锁定跨宿主统一接入 CLI（scripts/connect.cjs）、Pack 按需裁剪（core / core,office / all）
 * 以及 consumer-scheduler 实时积压追赶契约。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const packConfig = require(path.join(ROOT, 'core/engine/scripts/lib/pack-config.cjs'));
const { collectSkillSources } = require(path.join(ROOT, 'core/engine/scripts/sync-skills.cjs'));
const { isDue } = require(path.join(ROOT, 'core/engine/scripts/consumer-scheduler.cjs'));
const agSync = require(path.join(ROOT, 'hosts/antigravity/sync-from-claude.cjs'));
const connectCli = require(path.join(ROOT, 'scripts/connect.cjs'));

test('resolveEnabledPacks supports core, core+office, fpga, all, and HARNESS_PACKS_DISABLED', () => {
  const all = packConfig.resolveEnabledPacks({ root: ROOT, env: {} });
  assert.ok(all.includes('fpga') && all.includes('office'), `expected fpga and office, got ${all}`);

  assert.deepEqual(packConfig.resolveEnabledPacks({ root: ROOT, packs: 'core', env: {} }), []);
  assert.deepEqual(packConfig.resolveEnabledPacks({ root: ROOT, packs: 'none', env: {} }), []);
  assert.deepEqual(packConfig.resolveEnabledPacks({ root: ROOT, packs: 'core,office', env: {} }), ['office']);
  assert.deepEqual(packConfig.resolveEnabledPacks({ root: ROOT, packs: 'fpga', env: {} }), ['fpga']);
  assert.deepEqual(packConfig.resolveEnabledPacks({ root: ROOT, packs: 'all', env: {} }), all);
  assert.deepEqual(
    packConfig.resolveEnabledPacks({ root: ROOT, packs: 'all', env: { HARNESS_PACKS_DISABLED: '1' } }),
    [],
    'HARNESS_PACKS_DISABLED=1 must override pack selection',
  );
  assert.throws(
    () => packConfig.resolveEnabledPacks({ root: ROOT, packs: 'nonexistent-pack', env: {} }),
    /Unknown pack/,
  );
});

test('collectSkillSources filters skills cleanly by pack profile', () => {
  const coreOnly = collectSkillSources(ROOT, { packs: 'core', env: {} }).map((s) => s.name);
  const coreOffice = collectSkillSources(ROOT, { packs: 'core,office', env: {} }).map((s) => s.name);
  const full = collectSkillSources(ROOT, { packs: 'all', env: {} }).map((s) => s.name);

  assert.ok(coreOnly.includes('tdd') && coreOnly.includes('debugging') && coreOnly.includes('code-review'));
  assert.ok(!coreOnly.includes('hdl-coding') && !coreOnly.includes('vivado-flow'), 'core profile must exclude FPGA skills');
  assert.ok(!coreOnly.includes('pdf') && !coreOnly.includes('presentation'), 'core profile must exclude Office skills');

  assert.ok(coreOffice.includes('pdf') && coreOffice.includes('doc-gen'));
  assert.ok(!coreOffice.includes('hdl-coding'), 'core,office profile must exclude FPGA skills');

  assert.ok(full.includes('hdl-coding') && full.includes('pdf') && full.includes('tdd'));
  assert.ok(full.length > coreOffice.length && coreOffice.length > coreOnly.length);
});

test('Antigravity syncPlugin respects --packs core (no FPGA agents, no MATLAB/PDF MCP, domain-neutral rules)', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-core-pack-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const summary = agSync.syncPlugin({
    root: ROOT,
    target: tmp,
    portable: false,
    copyRuntime: true,
    packs: 'core',
  });

  assert.deepEqual(summary.packs, []);
  assert.equal(summary.agentsDeployed, 0, 'core-only plugin must not bundle FPGA agents');
  assert.deepEqual(summary.mcpServers, ['codegraph'], 'core-only plugin must expose only codegraph/console MCP');

  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'plugin.json'), 'utf8'));
  assert.ok(!manifest.suggestedPrompts.some((p) => /RTL/i.test(p)), 'core-only prompts must be domain-neutral');

  const rules = fs.readFileSync(path.join(tmp, 'rules', 'AGENTS.md'), 'utf8');
  assert.ok(!rules.includes('packs/fpga/rules/'), 'core-only rules must omit FPGA pack rule references');

  const check = agSync.checkAssets(tmp, null, { root: ROOT, portable: false, packs: 'core' });
  assert.deepEqual(check.drift, [], `core-only asset check drifted: ${check.drift.join(', ')}`);
});

test('scripts/connect.cjs plans host actions accurately and rejects invalid inputs', () => {
  const claudePlugin = connectCli.parseCli(['claude-code', '--packs', 'core']);
  const claudeActions = connectCli.planActions(claudePlugin, ROOT);
  assert.equal(claudeActions.length, 1);
  assert.ok(claudeActions[0].script.endsWith('sync-plugin-dist.cjs'));
  assert.deepEqual(claudeActions[0].args, ['--packs=core']);
  assert.match(claudeActions[0].nextStep, /claude --plugin-dir/);

  const agPortable = connectCli.parseCli(['ag', '--portable', '--packs=core,office', '--no-seal']);
  const agActions = connectCli.planActions(agPortable, ROOT);
  assert.equal(agActions.length, 1);
  assert.ok(agActions[0].script.endsWith(path.join('hosts', 'antigravity', 'connect.cjs')));
  assert.ok(agActions[0].args.includes('--portable'));
  assert.ok(agActions[0].args.includes('--packs=core,office'));
  assert.ok(agActions[0].args.includes('--no-seal'));

  const allCheck = connectCli.parseCli(['all', '--check']);
  const allActions = connectCli.planActions(allCheck, ROOT);
  assert.ok(allActions.length >= 5, 'all --check must cover all 5 hosts');

  assert.throws(() => connectCli.parseCli(['unknown-host']), /Unknown host/);
  assert.throws(() => connectCli.parseCli(['claude-code', '--mode', 'invalid']), /Invalid --mode/);
});

test('consumer-scheduler wakes up on live SQLite backlog even when stale heartbeat pending is low', () => {
  const now = Date.parse('2026-11-25T01:36:00.000Z');
  const staleHeartbeat = {
    status: 'skipped',
    lastCompletedAt: '2026-11-24T09:32:22.692Z',
    nextDueAt: '2026-11-25T09:32:22.692Z',
    pending: 25,
  };
  assert.equal(
    isDue(staleHeartbeat, 24 * 3600_000, now, { maxBatch: 100, livePending: 25 }),
    false,
    'low live backlog should stay asleep during 24h cooldown',
  );
  assert.equal(
    isDue(staleHeartbeat, 24 * 3600_000, now, { maxBatch: 100, livePending: 101 }),
    true,
    'live backlog >= maxBatch must wake up consumer after 60s backlog cooldown',
  );
});
