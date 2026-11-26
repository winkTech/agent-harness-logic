#!/usr/bin/env node
'use strict';

/**
 * scripts/harness-unlock.cjs — 维护者限时自举解锁租约 CLI
 *
 * 背景：Antigravity 等宿主采用方案 A 瘦链接模式时，会将本源码仓设为受保护根，
 * 拦截会话对 core/、hosts/、var/ 的直接写入以防运行期自篡改。
 * 维护者在外部终端显式签发限时租约后，bridge.cjs 仅对工作区恰为本仓库的会话
 * 放行源码仓内编辑，同时继续硬拦截：
 *   - 已安装插件目录 (~/.gemini/config/plugins/logical-paradox)
 *   - 状态与租约目录自身 (~/.logical-paradox/maintainer-unlock.json)
 *   - 敏感凭据文件 (.ssh / .env / *credential* / id_rsa)
 *   - verification-gate --reset 及 bash-safety / verification-gate 门禁
 *
 * 用法：
 *   npm run harness:unlock -- --ttl 30m --reason "self-hosting maintenance"
 *   npm run harness:unlock -- --status [--json]
 *   npm run harness:unlock -- --revoke
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const ROOT = (() => {
  const candidate = path.resolve(__dirname, '..');
  try { return fs.realpathSync.native(candidate); } catch { return candidate; }
})();

const MAX_TTL_MS = 120 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function defaultLeasePath(homeDir = os.homedir()) {
  return path.join(homeDir, '.logical-paradox', 'maintainer-unlock.json');
}

function parseDurationMs(spec) {
  if (!spec) return DEFAULT_TTL_MS;
  const s = String(spec).trim().toLowerCase();
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s);
  if (!m) throw new Error(`Invalid --ttl "${spec}" (examples: 30m, 1h, 1800s)`);
  const n = Number(m[1]);
  const unit = m[2] || 'm';
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000;
  const total = n * mult;
  if (!Number.isSafeInteger(total) || total < 1000 || total > MAX_TTL_MS) {
    throw new Error(`--ttl must be between 1s and 120m (got ${spec})`);
  }
  return total;
}

function computeLeaseDigest(record) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    workspace: record.workspace,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    actor: record.actor,
    reason: record.reason,
  })).digest('hex');
}

function issueLease(opts = {}) {
  const leasePath = opts.leasePath || defaultLeasePath(opts.homeDir);
  const workspace = (() => {
    const w = path.resolve(opts.workspace || ROOT);
    try { return fs.realpathSync.native(w); } catch { return w; }
  })();
  const now = Number(opts.now ?? Date.now());
  const ttlMs = opts.ttlMs ?? parseDurationMs(opts.ttl);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) {
    throw new Error('Lease TTL out of bounds (1s..120m)');
  }
  const actor = String(opts.actor || os.userInfo().username || 'maintainer').trim();
  const reason = String(opts.reason || 'maintainer self-hosting edit session').trim();
  if (reason.length < 6) throw new Error('Unlock --reason must be at least 6 characters');

  const record = {
    version: 1,
    active: true,
    workspace,
    actor,
    reason,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    ttlMs,
  };
  record.sha256 = computeLeaseDigest(record);

  fs.mkdirSync(path.dirname(leasePath), { recursive: true, mode: 0o700 });
  const tmp = `${leasePath}.${process.pid}.${now}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, leasePath);
  return { leasePath, ...record };
}

function inspectLease(opts = {}) {
  const leasePath = opts.leasePath || defaultLeasePath(opts.homeDir);
  const now = Number(opts.now ?? Date.now());
  if (!fs.existsSync(leasePath)) {
    return { active: false, reason: 'missing', leasePath };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    if (!raw || raw.version !== 1 || raw.active !== true) {
      return { active: false, reason: 'revoked', leasePath };
    }
    if (raw.sha256 !== computeLeaseDigest(raw)) {
      return { active: false, reason: 'integrity-mismatch', leasePath };
    }
    const issuedMs = Date.parse(raw.issuedAt);
    const expiresMs = Date.parse(raw.expiresAt);
    if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs - issuedMs > MAX_TTL_MS) {
      return { active: false, reason: 'invalid-timestamps', leasePath };
    }
    if (now >= expiresMs) {
      return { active: false, reason: 'expired', expiresAt: raw.expiresAt, workspace: raw.workspace, leasePath };
    }
    return {
      active: true,
      workspace: raw.workspace,
      actor: raw.actor,
      reason: raw.reason,
      issuedAt: raw.issuedAt,
      expiresAt: raw.expiresAt,
      remainingSeconds: Math.max(0, Math.round((expiresMs - now) / 1000)),
      leasePath,
    };
  } catch (err) {
    return { active: false, reason: `corrupt:${err.message}`, leasePath };
  }
}

function revokeLease(opts = {}) {
  const leasePath = opts.leasePath || defaultLeasePath(opts.homeDir);
  if (fs.existsSync(leasePath)) fs.unlinkSync(leasePath);
  return { active: false, revoked: true, leasePath };
}

function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ttl: { type: 'string' },
      reason: { type: 'string' },
      actor: { type: 'string' },
      status: { type: 'boolean', default: false },
      revoke: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log('Usage: node scripts/harness-unlock.cjs [--ttl 30m] [--reason "..."] | --status | --revoke [--json]');
    return 0;
  }

  const out = values.revoke
    ? revokeLease()
    : values.status
      ? inspectLease()
      : issueLease({ ttl: values.ttl, reason: values.reason, actor: values.actor });

  if (values.json) {
    console.log(JSON.stringify(out, null, 2));
  } else if (values.revoke) {
    console.log(`[harness:unlock] Revoked maintainer lease (${out.leasePath})`);
  } else if (values.status) {
    console.log(out.active
      ? `[harness:unlock] ACTIVE for ${out.workspace} (${out.remainingSeconds}s remaining, expires ${out.expiresAt})`
      : `[harness:unlock] INACTIVE (${out.reason})`);
  } else {
    console.log(`[harness:unlock] Unlocked ${out.workspace} until ${out.expiresAt} (reason: ${out.reason})`);
  }
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (err) {
    console.error(`[harness:unlock] ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MAX_TTL_MS,
  defaultLeasePath,
  parseDurationMs,
  computeLeaseDigest,
  issueLease,
  inspectLease,
  revokeLease,
  main,
};
