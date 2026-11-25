'use strict';

/**
 * core/engine/scripts/lib/plugin-acl.cjs — 跨平台插件目录 OS 级只读封固器（M3）
 *
 * 目标：用操作系统内核权限兜底插件安装目录的防篡改，阻断图灵完备子进程
 * （node helper.js / python helper.py）在运行期修改 hooks.json / bridge.cjs 等文件。
 *
 * 机制：
 *   - Windows：先 `/reset` 清理残留显式 ACE，再通过 icacls 禁用继承（`/inheritance:r`），
 *     仅授予当前主体 `(OI)(CI)(RX,WDAC)`、`BUILTIN\Administrators` `(OI)(CI)(RX)`、
 *     `NT AUTHORITY\SYSTEM` `(OI)(CI)(F)`，并通过 .NET `Directory::SetAccessControl` 写入
 *     不含 `SYNCHRONIZE` 位的内核级显式拒绝 ACE `DENY(WD,AD,WEA,WA,DE,DC)`（避开
 *     `icacls /deny` 误带 `SYNCHRONIZE` 导致 `readFileSync` 失败的 Windows 缺陷），
 *     再对子项自顶向下 `/reset` 继承只读权限（即便提权管理员会话如 GitHub Actions
 *     `runneradmin` 也受内核 `DENY` 强阻断，同时保留 `WDAC` 以便 `unsealWritable`
 *     无提权原子解封）。
 *   - POSIX：目录置 `0o555`、文件置 `0o444`（可执行文件保留 `0o555`）；`unsealWritable`
 *     先自顶向下恢复目录 `0o755`，再恢复文件 `0o644`/`0o755`。
 *
 * 安全护栏：拒绝封固文件系统根、用户主目录、含 `.git` 的开发仓根或运行态状态目录。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function canonicalTarget(targetDir) {
  const resolved = path.resolve(targetDir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameTargetPath(a, b) {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function assertSafeTarget(targetDir) {
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new Error('plugin-acl: target directory is required');
  }
  const resolved = canonicalTarget(targetDir);
  const parsed = path.parse(resolved);
  if (sameTargetPath(resolved, parsed.root)) {
    throw new Error(`plugin-acl: refusing to modify filesystem root: ${resolved}`);
  }
  const home = canonicalTarget(os.homedir());
  if (sameTargetPath(resolved, home)) {
    throw new Error(`plugin-acl: refusing to modify user home directory: ${resolved}`);
  }
  if (fs.existsSync(path.join(resolved, '.git'))) {
    throw new Error(`plugin-acl: refusing to seal a Git working tree root: ${resolved}`);
  }
  const base = path.basename(resolved).toLowerCase();
  if (base === 'var' || base === '.logical-paradox') {
    throw new Error(`plugin-acl: refusing to seal runtime state directory: ${resolved}`);
  }
  return resolved;
}

function currentWindowsIdentity() {
  const who = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  let account = '';
  let sid = '';
  if (who.status === 0 && who.stdout) {
    const csvMatch = /"([^"]+)","(S-1-5-[0-9-]+)"/.exec(who.stdout);
    if (csvMatch) {
      account = csvMatch[1];
      sid = csvMatch[2];
    } else {
      const sidMatch = /"(S-1-5-[0-9-]+)"/.exec(who.stdout);
      if (sidMatch) sid = sidMatch[1];
    }
  }
  const fallbackUser = process.env.USERNAME || os.userInfo().username || '';
  const principal = sid
    ? `*${sid}`
    : (account || (process.env.USERDOMAIN && fallbackUser ? `${process.env.USERDOMAIN}\\${fallbackUser}` : fallbackUser));
  const userName = (account ? account.split('\\').pop() : fallbackUser).toLowerCase();
  return { principal, account: account.toLowerCase(), userName, sid };
}

function stripIcaclsPathPrefix(line, candidates) {
  const lower = line.toLowerCase();
  for (const prefix of candidates) {
    if (prefix && lower.startsWith(prefix.toLowerCase())) {
      const rest = line.slice(prefix.length);
      if (!rest || /^\s/.test(rest)) return rest.trim();
    }
  }
  return line.trim();
}

function runIcacls(args) {
  const res = spawnSync('icacls', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`icacls failed (${res.status}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout || '';
}

/**
 * Add an explicit kernel DENY ACE for write/delete rights WITHOUT the SYNCHRONIZE bit.
 * `icacls /deny` on Windows always sets SYNCHRONIZE (0x00100000), which breaks synchronous
 * file reads (`fs.readFileSync`). Using .NET `GetAccessControl('Access')` +
 * `Directory::SetAccessControl` writes the exact 0x00010156 mask without needing elevation
 * or SeSecurityPrivilege, blocking writes even for elevated Administrators while preserving
 * read/execute and WDAC (ChangePermissions) so `unsealWritable` works without elevation.
 */
function applyWindowsKernelWriteDeny(resolvedDir) {
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    '$dir = $env:HARNESS_ACL_TARGET',
    "$acl = (Get-Item -LiteralPath $dir).GetAccessControl('Access')",
    '$rights = [System.Security.AccessControl.FileSystemRights]::WriteData'
      + ' -bor [System.Security.AccessControl.FileSystemRights]::AppendData'
      + ' -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes'
      + ' -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes'
      + ' -bor [System.Security.AccessControl.FileSystemRights]::Delete'
      + ' -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles',
    '$inh = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit',
    '$prop = [System.Security.AccessControl.PropagationFlags]::None',
    '$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$adminSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")',
    "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, $rights, $inh, $prop, 'Deny')))",
    "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($adminSid, $rights, $inh, $prop, 'Deny')))",
    '[System.IO.Directory]::SetAccessControl($dir, $acl)',
  ].join('; ');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, HARNESS_ACL_TARGET: resolvedDir },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`SetAccessControl deny failed (${res.status}): ${(res.stderr || res.stdout || '').trim()}`);
  }
}

function walkTree(dir) {
  const dirs = [];
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    dirs.push(current);
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return { dirs, files };
}

function isSealed(targetDir) {
  const rawResolved = path.resolve(targetDir);
  const resolved = canonicalTarget(targetDir);
  if (!fs.existsSync(resolved)) return false;
  if (process.platform === 'win32') {
    const res = spawnSync('icacls', [resolved], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (res.status !== 0) return false;
    const out = res.stdout || '';
    const identity = currentWindowsIdentity();
    // Strip the leading path from line 1 (matching either canonical or 8.3 short form) so a
    // username inside the path (e.g., C:\Users\<user>) never matches another principal's ACE.
    const aceLines = out.split(/\r?\n/)
      .map((line, idx) => (idx === 0 ? stripIcaclsPathPrefix(line, [resolved, rawResolved]) : line.trim()))
      .filter((line) => line && !/^Successfully processed /i.test(line));
    const userLines = aceLines.filter((line) => {
      const lower = line.toLowerCase();
      return (identity.account && lower.startsWith(`${identity.account}:`))
        || (identity.userName && lower.includes(`\\${identity.userName}:`))
        || (identity.userName && lower.startsWith(`${identity.userName}:`));
    });
    if (userLines.length === 0) return false;
    // Any non-SYSTEM ALLOW ACE granting write, modify, full control, or delete means not sealed.
    // Ignore explicit (DENY) ACEs when checking for write grants.
    const nonSystemAllowLines = aceLines.filter(
      (line) => !/^nt authority\\system:/i.test(line) && !/\(DENY\)/i.test(line)
    );
    const userAllowLines = userLines.filter((line) => !/\(DENY\)/i.test(line));
    const hasWrite = nonSystemAllowLines.some((line) => /[(,](?:F|M|W|WD|AD|WA|D|DC)[,)]/i.test(line));
    const hasRead = userAllowLines.some((line) => /[(,](?:RX|R)[,)]/i.test(line));
    return hasRead && !hasWrite;
  }
  try {
    const mode = fs.statSync(resolved).mode & 0o777;
    return (mode & 0o222) === 0;
  } catch {
    return false;
  }
}

function unsealWritable(targetDir) {
  const resolved = assertSafeTarget(targetDir);
  if (!fs.existsSync(resolved)) return { target: resolved, unsealed: false, existed: false };

  if (process.platform === 'win32') {
    const { principal } = currentWindowsIdentity();
    // Remove explicit DENY ACEs, restore inheritance on root, and reset children to inherit full control.
    runIcacls([resolved, '/remove:d', principal, '/remove:d', '*S-1-5-32-544', '/Q']);
    runIcacls([resolved, '/inheritance:e', '/grant:r', `${principal}:(OI)(CI)(F)`, '/Q']);
    runIcacls([resolved, '/reset', '/T', '/Q']);
    const { files } = walkTree(resolved);
    for (const file of files) {
      try { fs.chmodSync(file, 0o666); } catch { /* ignore */ }
    }
    return { target: resolved, unsealed: true, existed: true, platform: 'win32' };
  }

  // POSIX: restore directory write bits top-down before walking children.
  const stack = [resolved];
  while (stack.length > 0) {
    const current = stack.pop();
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      fs.chmodSync(current, (st.mode & 0o777) | 0o700);
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) stack.push(path.join(current, entry.name));
      }
    } else if (st.isFile()) {
      const exec = (st.mode & 0o111) ? 0o111 : 0;
      fs.chmodSync(current, 0o644 | exec);
    }
  }
  return { target: resolved, unsealed: true, existed: true, platform: process.platform };
}

function sealReadOnly(targetDir) {
  const resolved = assertSafeTarget(targetDir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`plugin-acl: cannot seal missing directory: ${resolved}`);
  }

  if (process.platform === 'win32') {
    const identity = currentWindowsIdentity();
    const { principal } = identity;
    const { files } = walkTree(resolved);
    // 0) Set DOS read-only bit while still writable for defense-in-depth (cleared by unsealWritable).
    for (const file of files) {
      try { fs.chmodSync(file, 0o444); } catch { /* ignore */ }
    }
    // 1) Reset explicit ACEs on the root directory first so any pre-existing explicit ACEs
    //    (e.g. CREATOR OWNER-expanded BUILTIN\Administrators:(F) on elevated Windows runners)
    //    cannot survive /inheritance:r.
    // 2) Disable inheritance and REPLACE (/grant:r) ACEs on the root directory ONLY (no /T —
    //    files reject OI/CI), then add explicit kernel DENY ACEs (0x00010156, no SYNCHRONIZE)
    //    for current user and BUILTIN\Administrators so even elevated runners receive OS EPERM.
    // 3) Reset immediate children (files without /T, subdirectories with /T) so every item
    //    cleanly inherits the sealed DACL without swallowing errors via /C.
    runIcacls([resolved, '/reset', '/Q']);
    const grantArgs = [
      resolved,
      '/inheritance:r',
      '/grant:r', `${principal}:(OI)(CI)(RX,WDAC)`,
      '/grant:r', '*S-1-5-32-544:(OI)(CI)(RX)',
    ];
    if (identity.sid !== 'S-1-5-18') {
      grantArgs.push('/grant:r', '*S-1-5-18:(OI)(CI)(F)');
    }
    grantArgs.push('/Q');
    runIcacls(grantArgs);
    applyWindowsKernelWriteDeny(resolved);
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const childPath = path.join(resolved, entry.name);
      if (entry.isDirectory()) {
        runIcacls([childPath, '/reset', '/T', '/Q']);
      } else {
        runIcacls([childPath, '/reset', '/Q']);
      }
    }
    return { target: resolved, sealed: true, platform: 'win32', filesSealed: files.length };
  }

  const { dirs, files } = walkTree(resolved);
  for (const file of files) {
    const mode = fs.statSync(file).mode;
    const exec = (mode & 0o111) ? 0o111 : 0;
    fs.chmodSync(file, 0o444 | exec);
  }
  // Seal directories bottom-up so child chmod succeeds before parent drops +w.
  for (const dir of dirs.reverse()) {
    fs.chmodSync(dir, 0o555);
  }
  return { target: resolved, sealed: true, platform: process.platform, filesSealed: files.length };
}

function withUnsealedDir(targetDir, fn, opts = {}) {
  const shouldSeal = opts.seal !== false;
  const existed = fs.existsSync(targetDir);
  if (existed) unsealWritable(targetDir);
  try {
    return fn();
  } finally {
    if (shouldSeal && fs.existsSync(targetDir)) {
      sealReadOnly(targetDir);
    }
  }
}

module.exports = {
  assertSafeTarget,
  isSealed,
  sealReadOnly,
  unsealWritable,
  withUnsealedDir,
};
