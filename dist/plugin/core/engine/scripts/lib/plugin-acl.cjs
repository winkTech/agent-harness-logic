'use strict';

/**
 * core/engine/scripts/lib/plugin-acl.cjs — 跨平台插件目录 OS 级只读封固器（M3）
 *
 * 目标：用操作系统内核权限兜底插件安装目录的防篡改，阻断图灵完备子进程
 * （node helper.js / python helper.py）在运行期修改 hooks.json / bridge.cjs 等文件。
 *
 * 机制：
 *   - Windows：保留所有者 WRITE_DAC，通过 icacls 对目标目录施加 `(OI)(CI)(W,D,DC)` Deny ACE
 *     并置位只读属性（无需管理员权限）；`unsealWritable` 通过 `/remove:d` 原子解封。
 *   - POSIX：目录置 `0o555`、文件置 `0o444`（可执行文件保留 `0o555`）；`unsealWritable`
 *     先自顶向下恢复目录 `0o755`，再恢复文件 `0o644`/`0o755`。
 *
 * 安全护栏：拒绝封固文件系统根、用户主目录、含 `.git` 的开发仓根或运行态状态目录。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function assertSafeTarget(targetDir) {
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new Error('plugin-acl: target directory is required');
  }
  const resolved = path.resolve(targetDir);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new Error(`plugin-acl: refusing to modify filesystem root: ${resolved}`);
  }
  const home = path.resolve(os.homedir());
  if (resolved === home) {
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

function currentWindowsPrincipal() {
  const who = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (who.status === 0 && who.stdout) {
    const match = /"(S-1-5-[0-9-]+)"/.exec(who.stdout);
    if (match) return `*${match[1]}`;
  }
  if (process.env.USERDOMAIN && process.env.USERNAME) {
    return `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  }
  return process.env.USERNAME || os.userInfo().username;
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
  const resolved = path.resolve(targetDir);
  if (!fs.existsSync(resolved)) return false;
  if (process.platform === 'win32') {
    const res = spawnSync('icacls', [resolved], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (res.status !== 0) return false;
    const out = res.stdout || '';
    const user = (process.env.USERNAME || os.userInfo().username || '').toLowerCase();
    // Strip the leading path from line 1 so username inside path (e.g., C:\Users\<user>) never matches Administrators:(F).
    const aceLines = out.split(/\r?\n/).map((line, idx) => (
      idx === 0 && line.toLowerCase().startsWith(resolved.toLowerCase())
        ? line.slice(resolved.length).trim()
        : line.trim()
    ));
    const userLines = aceLines.filter((line) => user && line.toLowerCase().includes(user));
    if (userLines.length === 0) return false;
    const hasWrite = userLines.some((line) => /[(,](?:F|M|W|WD|AD)[,)]/i.test(line));
    const hasRead = userLines.some((line) => /[(,](?:RX|R)[,)]/i.test(line));
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
    const principal = currentWindowsPrincipal();
    // Restore inheritance on the root dir and reset children to inherit full control.
    runIcacls([resolved, '/inheritance:e', '/grant:r', `${principal}:(OI)(CI)(F)`, '/Q']);
    runIcacls([resolved, '/reset', '/T', '/C', '/Q']);
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
    const principal = currentWindowsPrincipal();
    const { files } = walkTree(resolved);
    // 1) Set non-inherited (OI)(CI)(RX,WDAC) on the root directory ONLY (no /T — files reject OI/CI).
    // 2) Reset immediate children recursively so all files/subdirs cleanly inherit (I)(RX,WDAC).
    runIcacls([
      resolved,
      '/inheritance:r',
      '/grant:r', `${principal}:(OI)(CI)(RX,WDAC)`,
      '/grant', '*S-1-5-18:(OI)(CI)(F)',
      '/grant', '*S-1-5-32-544:(OI)(CI)(F)',
      '/Q',
    ]);
    for (const entry of fs.readdirSync(resolved)) {
      runIcacls([path.join(resolved, entry), '/reset', '/T', '/C', '/Q']);
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
