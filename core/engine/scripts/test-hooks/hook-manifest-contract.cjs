#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REGISTRY = path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'hook-registry.cjs');
const MANIFEST = path.join(ROOT, 'core', 'engine', 'hooks', 'manifest.json');

function main() {
  const registry = require(REGISTRY);
  assert.equal(typeof registry.loadHookManifest, 'function', 'hook registry must load the active manifest');
  assert.equal(typeof registry.validateHookManifest, 'function', 'hook registry must validate event wiring');
  assert.ok(fs.existsSync(MANIFEST), 'active hook manifest is missing');

  const manifest = registry.loadHookManifest({ root: ROOT });
  // Phase 2.3：v3 = v2 全字段 + 增补（timeoutOverrides/action/通道声明/hostPresets）。
  assert.equal(manifest.version, 3, 'hook manifest version must be 3 (v2 fields + §3.7 additions)');
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0,
    'hook manifest must declare active entries');
  assert.ok(Array.isArray(manifest.consumerRegistry) && manifest.consumerRegistry.length > 0,
    'hook manifest must declare active consumers');

  const requiredFields = [
    'script', 'kind', 'tier', 'events', 'tools', 'payloadSchema', 'transports', 'blocking',
    'sideEffects', 'timeoutSeconds', 'owner', 'fixture', 'active',
  ];
  const ALLOWED_TRANSPORTS = new Set(['claude-code', 'workbuddy', 'codex']);
  // M4 分层：tier 决定 entry 属于哪个分发单元。lab 是未成熟实验位，
  // 只能停在 active:false —— 一条 active 的 lab hook 等于把实验推给所有安装者。
  const ALLOWED_TIERS = new Set(['core', 'fpga', 'codegraph', 'office', 'lab']);
  for (const entry of manifest.entries) {
    for (const field of requiredFields) {
      assert.ok(Object.hasOwn(entry, field), `${entry.script || '<unknown>'} missing ${field}`);
    }
    assert.equal(entry.payloadSchema, 'harness-event-v1',
      `${entry.script} payloadSchema must be the harness-event-v1 contract (not claude-hook/*-v1)`);
    assert.ok(Array.isArray(entry.transports) && entry.transports.length > 0,
      `${entry.script} transports must be a non-empty array`);
    for (const transport of entry.transports) {
      assert.ok(ALLOWED_TRANSPORTS.has(transport),
        `${entry.script} transports contains unknown value '${transport}'`);
    }
    assert.ok(Array.isArray(entry.events) && entry.events.length > 0,
      `${entry.script} must support at least one event`);
    assert.ok(Array.isArray(entry.tools) && entry.tools.length > 0,
      `${entry.script} must declare tool matchers`);
    assert.ok(ALLOWED_TIERS.has(entry.tier),
      `${entry.script} tier '${entry.tier}' is not one of ${[...ALLOWED_TIERS].join(', ')}`);
    assert.ok(!(entry.active === true && entry.tier === 'lab'),
      `${entry.script} is tier 'lab' and must not be active`);
    assert.ok(Array.isArray(entry.sideEffects), `${entry.script} sideEffects must be an array`);
    assert.equal(typeof entry.blocking, 'boolean', `${entry.script} blocking must be boolean`);
    assert.equal(typeof entry.active, 'boolean', `${entry.script} active must be boolean`);
    assert.ok(Number.isFinite(entry.timeoutSeconds) && entry.timeoutSeconds > 0,
      `${entry.script} timeoutSeconds must be positive`);
    assert.ok(fs.existsSync(path.join(ROOT, entry.fixture)), `${entry.script} fixture does not exist`);
  }

  const result = registry.validateHookManifest({ root: ROOT });
  assert.deepEqual(result.errors, [], `hook manifest errors:\n${result.errors.join('\n')}`);
  assert.ok(result.checked > 0, 'hook manifest did not inspect any active registrations');

  const scripts = registry.validateHookScripts({ root: ROOT });
  for (const router of [
    'preflight-router.cjs',
    'postflight-router.cjs',
    'prompt-context.cjs',
    'session-bootstrap.cjs',
    'stop-summary.cjs',
  ]) {
    assert.ok(scripts.found.some(record => record.kind === 'router-dependency'
        && path.basename(record.parent || '') === router),
    `${router} local dependencies are not checked recursively`);
  }

  const wrongEvent = JSON.parse(JSON.stringify(manifest));
  const preflight = wrongEvent.entries.find(entry => /preflight-router\.cjs$/.test(entry.script));
  assert.ok(preflight, 'preflight manifest entry is missing');
  preflight.events = ['Stop'];
  const mismatch = registry.validateHookManifest({ root: ROOT, manifest: wrongEvent });
  assert.ok(mismatch.errors.some(error => /PreToolUse/.test(error) && /preflight-router/.test(error)),
    'registry accepted a script registered on an unsupported event');

  const brokenConsumer = JSON.parse(JSON.stringify(manifest));
  const dream = brokenConsumer.consumerRegistry.find(consumer => consumer.id === 'dream');
  assert.ok(dream, 'dream consumer registry entry is missing');
  dream.event = 'Stop';
  const consumerMismatch = registry.validateHookManifest({ root: ROOT, manifest: brokenConsumer });
  assert.ok(consumerMismatch.errors.some(error => /dream/.test(error) && /Stop/.test(error)),
    'registry accepted a consumer event unsupported by its host entry');

  const ciSource = fs.readFileSync(path.join(ROOT, 'core', 'engine', 'scripts', 'harness-ci.cjs'), 'utf8');
  assert.match(ciSource, /validateHookManifest\s*\(/,
    'harness-ci does not enforce the active hook manifest');

  // ── v3 增补字段合同（Phase 2.3，§3.7）──
  // timeoutOverrides：注册超时与 manifest 单值不同的事件必须被精确声明。
  const postflight = manifest.entries.find((e) => e.script.endsWith('postflight-router.cjs'));
  assert.ok(postflight, 'postflight-router entry missing');
  assert.deepEqual(postflight.timeoutOverrides,
    [{ event: 'PostToolUse', timeoutSeconds: 8 }, { event: 'PostToolUseFailure', timeoutSeconds: 12 }],
    'postflight-router per-event timeout reality (8s/12s) must be declared in timeoutOverrides');

  // action 词表：全部条目 action ∈ §3.7 八动作。
  const hc = require(path.join(ROOT, 'core', 'engine', 'scripts', 'lib', 'host-concepts.cjs'));
  for (const entry of manifest.entries) {
    if (entry.action === undefined) continue;
    const actions = Array.isArray(entry.action) ? entry.action : [entry.action];
    for (const a of actions) {
      assert.ok(hc.ACTIONS.includes(a), `entry action outside §3.7 word list: ${entry.script} → ${a}`);
    }
  }
  // 通道声明枚举。
  for (const entry of manifest.entries) {
    if (entry.blockChannel !== undefined) {
      assert.ok(['exit_code_2', 'json_decision', 'none'].includes(entry.blockChannel),
        `${entry.script} bad blockChannel`);
    }
    if (entry.injectChannel !== undefined) {
      assert.ok(['additionalContext', 'stdout', 'none'].includes(entry.injectChannel),
        `${entry.script} bad injectChannel`);
    }
  }
  // hostPresets：三宿主剖面声明存在（v2.3 O2——特判前置为声明）。
  for (const host of ['claude-code', 'workbuddy', 'grok', 'codex']) {
    assert.ok(manifest.hostPresets && manifest.hostPresets[host],
      `hostPresets missing profile for ${host}`);
  }
  // 交叉校验负例：注册超时偏离且无 overrides → 必须报错。
  const noOverrides = JSON.parse(JSON.stringify(manifest));
  const pfNoOv = noOverrides.entries.find((e) => e.script.endsWith('postflight-router.cjs'));
  delete pfNoOv.timeoutOverrides;
  const crossCheck = registry.validateHookManifest({ root: ROOT, manifest: noOverrides });
  assert.ok(crossCheck.errors.some((e) => /timeoutOverrides/.test(e)),
    'registration timeout drift without timeoutOverrides declaration must fail cross-check');

  process.stdout.write('HOOK_MANIFEST_CONTRACT_RESULT: PASS\n');
}

main();
