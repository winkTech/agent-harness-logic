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

const WIN_ROOT = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
const WIN_WHOAMI = path.join(WIN_ROOT, 'System32', 'whoami.exe');
const WIN_ICACLS = path.join(WIN_ROOT, 'System32', 'icacls.exe');
const WIN_POWERSHELL = path.join(WIN_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * Elevated Git Bash / MSYS2 (msys-2.0.dll, used by GitHub Actions `windows-latest` with
 * `shell: bash`) enables SeBackupPrivilege and SeRestorePrivilege on startup to emulate
 * Unix root. Because Node.js/libuv passes FILE_FLAG_BACKUP_SEMANTICS on fs.open/fs.chmod,
 * an enabled SeRestorePrivilege makes the Windows kernel skip all NTFS DACL checks
 * (Windows equivalent of POSIX uid 0 / CAP_DAC_OVERRIDE).
 *
 * Rather than skipping write assertions on elevated Git Bash, drop SeRestorePrivilege and
 * SeBackupPrivilege on the probe wrapper's own token via AdjustTokenPrivileges before
 * spawning the untrusted Node helper so every single write/chmodWrite/unlink/inject
 * assertion still executes against the real NTFS DACL.
 */
function runWriteProbe(probeScript, hooksFile) {
  if (process.platform === 'win32') {
    const privs = spawnSync(WIN_WHOAMI, ['/priv', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (privs.status === 0 && /SeRestorePrivilege/i.test(privs.stdout || '')) {
      const dropAndRun = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -TypeDefinition @'",
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class TokenPrivDrop {',
        '  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }',
        '  [StructLayout(LayoutKind.Sequential)] public struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID Luid; public uint Attributes; }',
        '  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);',
        '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);',
        '  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges, ref TOKEN_PRIVILEGES NewState, uint BufferLength, IntPtr PreviousState, IntPtr ReturnLength);',
        '  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr hObject);',
        '  public static void Disable(string[] names) {',
        '    IntPtr tok;',
        '    if (!OpenProcessToken(System.Diagnostics.Process.GetCurrentProcess().Handle, 0x0028, out tok)) return;',
        '    try {',
        '      foreach (var name in names) {',
        '        LUID luid;',
        '        if (!LookupPrivilegeValue(null, name, out luid)) continue;',
        '        var tp = new TOKEN_PRIVILEGES { PrivilegeCount = 1, Luid = luid, Attributes = 0 };',
        '        AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);',
        '      }',
        '    } finally { CloseHandle(tok); }',
        '  }',
        '}',
        "'@",
        "[TokenPrivDrop]::Disable(@('SeRestorePrivilege', 'SeBackupPrivilege'))",
        "& $env:HARNESS_PROBE_NODE -e 'eval(process.env.HARNESS_PROBE_SCRIPT)' $env:HARNESS_PROBE_HOOKS",
        'exit $LASTEXITCODE',
      ].join('\n');
      return spawnSync(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', dropAndRun], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        env: {
          ...process.env,
          HARNESS_PROBE_NODE: process.execPath,
          HARNESS_PROBE_SCRIPT: probeScript,
          HARNESS_PROBE_HOOKS: hooksFile,
        },
      });
    }
  }
  return spawnSync(process.execPath, ['-e', probeScript, hooksFile], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
}

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

  if (process.platform === 'win32') {
    // Regression guard: simulate elevated Windows Server / GitHub Actions runner where
    // CREATOR OWNER materializes an explicit BUILTIN\Administrators:(OI)(CI)(F) ACE before sealing.
    const preSeed = spawnSync(WIN_ICACLS, [pluginDir, '/grant', '*S-1-5-32-544:(OI)(CI)(F)', '/Q'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(preSeed.status, 0, preSeed.stderr || preSeed.stdout);
  }

  const sealed = acl.sealReadOnly(pluginDir);
  assert.equal(sealed.sealed, true);
  assert.equal(acl.isSealed(pluginDir), true);

  if (process.platform === 'win32') {
    const icaclsOut = spawnSync(WIN_ICACLS, [pluginDir], { encoding: 'utf8', windowsHide: true }).stdout || '';
    const adminAllowLines = icaclsOut
      .split(/\r?\n/)
      .filter((line) => /BUILTIN\\Administrators:/i.test(line) && !/\(DENY\)/i.test(line));
    for (const line of adminAllowLines) {
      assert.doesNotMatch(line, /[(,](?:F|M|W|WD|AD)[,)]/i,
        `sealed plugin dir must not grant write/full control to Administrators: ${icaclsOut}`);
    }
    assert.match(icaclsOut, /BUILTIN\\Administrators:.*\(DENY\)/i,
      `sealed plugin dir must include explicit kernel DENY for Administrators: ${icaclsOut}`);
  }

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

    const res = runWriteProbe(probeScript, hooksFile);
    assert.equal(res.status, 0, res.stderr);
    const outcomes = JSON.parse(res.stdout.trim());
    // On non-root POSIX and Windows NTFS, OS kernel denies write/unlink/inject.
    // Note: on POSIX the file owner can still chmod their own file unless directory is immutable,
    // while Windows NTFS (RX,WDAC + DENY) blocks chmod+write too.
    const requiredKeys = process.platform === 'win32'
      ? ['write', 'chmodWrite', 'unlink', 'inject']
      : ['write', 'unlink', 'inject'];
    for (const key of requiredKeys) {
      if (!/EPERM|EACCES/.test(String(outcomes[key]))) {
        let diag = '';
        if (process.platform === 'win32') {
          const dirAcl = spawnSync(WIN_ICACLS, [pluginDir], { encoding: 'utf8', windowsHide: true }).stdout || '';
          const fileAcl = spawnSync(WIN_ICACLS, [hooksFile], { encoding: 'utf8', windowsHide: true }).stdout || '';
          const who = spawnSync(WIN_WHOAMI, ['/user'], { encoding: 'utf8', windowsHide: true }).stdout || '';
          diag = ` | who=${who.trim()} | dirAcl=${dirAcl.trim()} | fileAcl=${fileAcl.trim()}`;
        }
        assert.match(String(outcomes[key]), /EPERM|EACCES/, `expected OS kernel deny for ${key}, got ${outcomes[key]}${diag}`);
      }
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
