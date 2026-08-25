#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REGISTRY = path.join(ROOT, 'engine', 'scripts', 'lib', 'hook-registry.cjs');
const MANIFEST = path.join(ROOT, 'engine', 'hooks', 'manifest.json');

function main() {
  const registry = require(REGISTRY);
  assert.equal(typeof registry.loadHookManifest, 'function', 'hook registry must load the active manifest');
  assert.equal(typeof registry.validateHookManifest, 'function', 'hook registry must validate event wiring');
  assert.ok(fs.existsSync(MANIFEST), 'active hook manifest is missing');

  const manifest = registry.loadHookManifest({ root: ROOT });
  assert.equal(manifest.version, 2, 'hook manifest version must be 2');
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0,
    'hook manifest must declare active entries');
  assert.ok(Array.isArray(manifest.consumerRegistry) && manifest.consumerRegistry.length > 0,
    'hook manifest must declare active consumers');

  const requiredFields = [
    'script', 'kind', 'events', 'tools', 'payloadSchema', 'transports', 'blocking',
    'sideEffects', 'timeoutSeconds', 'owner', 'fixture', 'active',
  ];
  const ALLOWED_TRANSPORTS = new Set(['claude-code', 'workbuddy', 'codex']);
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

  const ciSource = fs.readFileSync(path.join(ROOT, 'engine', 'scripts', 'harness-ci.cjs'), 'utf8');
  assert.match(ciSource, /validateHookManifest\s*\(/,
    'harness-ci does not enforce the active hook manifest');

  process.stdout.write('HOOK_MANIFEST_CONTRACT_RESULT: PASS\n');
}

main();
