#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const acl = require('../lib/plugin-acl.cjs');
const bashGuard = require('../hooks/bash-safety-guard.cjs');

test('plugin-acl refuses dangerous targets (fs root, home, git root, var)', (t) => {
  assert.throws(() => acl.assertSafeTarget(path.parse(os.tmpdir()).root), /filesystem root/);
  assert.throws(() => acl.assertSafeTarget(os.homedir()), /home directory/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-guard-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const gitDir = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
  assert.throws(() => acl.assertSafeTarget(gitDir), /Git working tree/);

  const varDir = path.join(tmp, 'var');
  fs.mkdirSync(varDir, { recursive: true });
  assert.throws(() => acl.assertSafeTarget(varDir), /runtime state directory/);
});

test('plugin-acl blocks external Node subprocess writes while keeping read/require intact', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-seal-'));
  const pluginDir = path.join(parent, 'logical-paradox');
  fs.mkdirSync(path.join(pluginDir, 'rules'), { recursive: true });
  const hooksFile = path.join(pluginDir, 'hooks.json');
  const modFile = path.join(pluginDir, 'helper.cjs');
  fs.writeFileSync(hooksFile, '{"ok":true}\n', 'utf8');
  fs.writeFileSync(modFile, 'module.exports = { answer: 42 };\n', 'utf8');

  t.after(() => {
    try { acl.unsealWritable(pluginDir); } catch { /* ignore */ }
    fs.rmSync(parent, { recursive: true, force: true });
  });

  const sealed = acl.sealReadOnly(pluginDir);
  assert.equal(sealed.sealed, true);
  assert.equal(acl.isSealed(pluginDir), true);

  // Reading & require() must continue working while sealed.
  assert.equal(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).ok, true);
  assert.equal(require(modFile).answer, 42);

  // External helper script attempting direct write, chmod+write, unlink, or new-file injection must be denied by OS.
  // Skip destructive write probe when running as POSIX root (uid 0 bypasses DAC mode bits).
  const isPosixRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isPosixRoot) {
    const probeScript = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const hooks = process.argv[1];',
      'const dir = path.dirname(hooks);',
      'const results = {};',
      'const checks = [',
      '  ["write", () => fs.writeFileSync(hooks, "{}")],',
      '  ...(process.platform === "win32" ? [["chmodWrite", () => { try { fs.chmodSync(hooks, 0o666); } catch {} fs.writeFileSync(hooks, "{}"); }]] : []),',
      '  ["unlink", () => fs.unlinkSync(hooks)],',
      '  ["inject", () => fs.writeFileSync(path.join(dir, "evil.cjs"), "x")],',
      '];',
      'for (const [k, fn] of checks) {',
      '  try { fn(); results[k] = "WRITABLE"; } catch (e) { results[k] = e.code || e.message; }',
      '}',
      'console.log(JSON.stringify(results));',
    ].join('\n');

    const res = spawnSync(process.execPath, ['-e', probeScript, hooksFile], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(res.status, 0, res.stderr);
    const outcomes = JSON.parse(res.stdout.trim());
    // On non-root POSIX and Windows NTFS, OS kernel denies write/unlink/inject.
    // Note: on POSIX the file owner can still chmod their own file unless directory is immutable,
    // while Windows NTFS (RX,WDAC) blocks chmod+write too.
    const requiredKeys = process.platform === 'win32'
      ? ['write', 'chmodWrite', 'unlink', 'inject']
      : ['write', 'unlink', 'inject'];
    for (const key of requiredKeys) {
      assert.match(String(outcomes[key]), /EPERM|EACCES/, `expected OS kernel deny for ${key}, got ${outcomes[key]}`);
    }
    assert.equal(fs.readFileSync(hooksFile, 'utf8'), '{"ok":true}\n');
  }

  // withUnsealedDir atomically unseals, updates, and re-seals.
  acl.withUnsealedDir(pluginDir, () => {
    fs.writeFileSync(hooksFile, '{"ok":"updated"}\n', 'utf8');
  });
  assert.equal(JSON.parse(fs.readFileSync(hooksFile, 'utf8')).ok, 'updated');
  assert.equal(acl.isSealed(pluginDir), true);

  acl.unsealWritable(pluginDir);
  assert.equal(acl.isSealed(pluginDir), false);
});

test('bash-safety-guard blocks single-backslash Windows takeown/icacls and externalizes FPGA rules', () => {
  for (const cmd of [
    'takeown /f C:\\Windows',
    'takeown /f C:/System32',
    'icacls C:\\Windows /grant Everyone:F',
  ]) {
    const hit = bashGuard.scanCommand(cmd);
    assert.equal(hit.matched, true, `expected block for: ${cmd}`);
    assert.equal(hit.info.category, 'privilege-escalation');
  }

  // FPGA rule active by default when pack is mounted.
  const prevPacks = process.env.HARNESS_PACKS_DISABLED;
  const prevSys = process.env.HARNESS_ALLOW_SYSTEM_INSTALL;
  try {
    delete process.env.HARNESS_PACKS_DISABLED;
    const bitBlocked = bashGuard.scanCommand('vivado -mode batch -tclargs write_bitstream');
    assert.equal(bitBlocked.matched, true);
    assert.equal(bitBlocked.info.category, 'no-bit-cfgmem');

    // When packs are disabled (P-4), FPGA rules cleanly unload from core.
    process.env.HARNESS_PACKS_DISABLED = '1';
    const bitUnmounted = bashGuard.scanCommand('vivado -mode batch -tclargs write_bitstream');
    assert.equal(bitUnmounted.matched, false);

    // Optional opt-out for system-install on non-Windows/non-D-drive machines.
    process.env.HARNESS_ALLOW_SYSTEM_INSTALL = '1';
    assert.equal(bashGuard.scanCommand('pip install pytest').matched, false);
    assert.equal(bashGuard.scanCommand('npm install -g typescript').matched, false);
  } finally {
    if (prevPacks === undefined) delete process.env.HARNESS_PACKS_DISABLED;
    else process.env.HARNESS_PACKS_DISABLED = prevPacks;
    if (prevSys === undefined) delete process.env.HARNESS_ALLOW_SYSTEM_INSTALL;
    else process.env.HARNESS_ALLOW_SYSTEM_INSTALL = prevSys;
  }
});
