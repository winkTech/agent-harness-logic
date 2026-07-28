#!/usr/bin/env node
/**
 * File Protection Guard
 *
 * PreToolUse hook: intercepts Edit/Write operations and blocks them
 * if the target file path matches a protected pattern.
 *
 * Project-specific paths are declared in
 * var/project-init/directory-contract.json `protectedPaths`.
 *
 * Exit code:
 *   0 — allow (no match or not an Edit/Write)
 *   2 — block (file matches a protected pattern)
 *
 * ⚠️ 必须用 exit 2 才能被 Claude Code Hook 系统识别为"拦截"。
 *    exit 1 会被视为非阻断错误，操作仍然继续。
 *    参见: ~/.claude/CLAUDE.md → 铁律第零条
 */

'use strict';

const fs = require('node:fs');
const { evaluateGuardBypass } = require('../lib/gate-bypass.cjs');
const {
  findProjectRoot,
  readDirectoryContract,
  relativeToRoot,
} = require('../lib/project-directory-contract.cjs');

const GATE_ID = 'file-protection-guard.cjs';

// ── Protected File Patterns ────────────────────────────────────────────────
// Inline patterns are reserved for repository-wide governed model directories.
//   **  = match across directory boundaries
//   *   = match within a single path segment
//   ?   = match a single character
//
// See docs/rules-archive/08-constraints.md for the rationale behind each pattern.

const PROTECTED_PATTERNS = [
  '**/matlab/**',
  '**/07_mat/**',
  '**/golden_model*/**',
  '**/engineering-assets/models/**',
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if a file path matches a glob-like pattern.
 * Supports ** (match anything), * (match within single path segment), ? (single char).
 */
function matchesPattern(filePath, pattern) {
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___GLOBSTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___GLOBSTAR___/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(filePath);
}

function normalizeManifestPath(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return '';
  if (/[*?\0-\x1f]/.test(normalized)) return '';
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return '';
  return normalized;
}

function manifestProtection(filePath, cwd = process.cwd()) {
  const projectRoot = findProjectRoot(filePath, cwd);
  if (!projectRoot) return '';

  let contract;
  try {
    contract = readDirectoryContract(projectRoot);
  } catch {
    return '';
  }
  if (!Array.isArray(contract?.protectedPaths)) return '';

  const relative = relativeToRoot(projectRoot, filePath, cwd).toLowerCase();
  for (const candidate of contract.protectedPaths) {
    const protectedPath = normalizeManifestPath(candidate);
    if (!protectedPath) continue;
    const comparable = protectedPath.toLowerCase();
    if (relative === comparable || relative.startsWith(`${comparable}/`)) {
      return `manifest:${protectedPath}`;
    }
  }
  return '';
}

/**
 * 受批准的例外写入。
 *
 * 策略（用户 2026-07-27 确认）：受保护文件**可以修改，但不能随便修改，修改时需要用户批准**。
 * 因此默认阻断保持不变；只有当用户显式授予**逐文件**批准时才放行，且强制留痕。
 *
 *   CLAUDE_PROTECTED_WRITE_APPROVAL="<路径>[,<路径>...]"   逐个文件，禁止通配符
 *   CLAUDE_PROTECTED_WRITE_REASON="<一句话说明>"           必填，写入审计
 *
 * 统一门禁旁路同样要求精确 gate/session、短 TTL 与审计；本通道额外绑定具体文件，
 * 只对列出的确切文件生效，缺理由不放行，且每次放行都追加审计条目。
 *
 * @returns {{ok: boolean, reason?: string, why?: string} | null} null = 未申请例外
 */
const APPROVAL_FILE = 'var/audit/protected-write-approvals.json';

function approvalFilePath() {
  return require('node:path').join(__dirname, '..', '..', '..', APPROVAL_FILE);
}

/**
 * 文件令牌通道：会话中用户口头批准后，由调用方写入一次性令牌。
 * 令牌形如 [{path, reason, expiresAt}]；命中即**消费**（从文件移除），且有 TTL。
 * 设计意图是"一次批准放行一次"，不是长期开关 —— 过期或用过的令牌不再生效。
 */
function consumeFileApproval(normalizedPath) {
  const p = approvalFilePath();
  let list;
  try {
    if (!fs.existsSync(p)) return null;
    list = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(list)) return null;
  } catch (_e) { return null; }

  const now = Date.now();
  const alive = list.filter((t) => t && typeof t.path === 'string' && new Date(t.expiresAt || 0).getTime() > now);
  const idx = alive.findIndex((t) => {
    const tp = t.path.replace(/\\/g, '/');
    if (tp.includes('*') || tp.includes('?')) return false;
    return normalizedPath === tp || (tp.includes('/') && normalizedPath.endsWith('/' + tp.replace(/^\.\//, '')));
  });
  if (idx < 0) {
    if (alive.length !== list.length) { try { fs.writeFileSync(p, JSON.stringify(alive, null, 1)); } catch (_e) {} }
    return null;
  }
  const token = alive[idx];
  if (!String(token.reason || '').trim()) return { ok: false, why: '令牌缺少 reason' };

  alive.splice(idx, 1);                       // 一次性：命中即消费
  try { fs.writeFileSync(p, JSON.stringify(alive, null, 1)); }
  catch (_e) { return { ok: false, why: '令牌无法消费(文件不可写)，为避免变成长期开关而拒绝放行' }; }
  return { ok: true, reason: `[一次性令牌] ${token.reason}` };
}

function approvedException(normalizedPath) {
  const raw = (process.env.CLAUDE_PROTECTED_WRITE_APPROVAL || '').trim();
  if (!raw) return consumeFileApproval(normalizedPath);

  const reason = (process.env.CLAUDE_PROTECTED_WRITE_REASON || '').trim();
  if (!reason) return { ok: false, why: '已给出 CLAUDE_PROTECTED_WRITE_APPROVAL 但缺少 CLAUDE_PROTECTED_WRITE_REASON' };

  const targets = raw.split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
  if (targets.some((t) => t.includes('*') || t.includes('?'))) {
    return { ok: false, why: '批准列表禁止通配符 —— 必须逐个文件列出' };
  }

  const hit = targets.some((t) => {
    if (normalizedPath === t) return true;
    // 允许用仓库相对路径批准绝对路径的写入；要求 target 至少含一层目录，避免裸文件名放行同名文件
    return t.includes('/') && normalizedPath.endsWith('/' + t.replace(/^\.\//, ''));
  });
  return hit ? { ok: true, reason } : null;
}

function inspectFileApproval(normalizedPath, env = process.env) {
  const raw = String(env.CLAUDE_PROTECTED_WRITE_APPROVAL || '').trim();
  if (raw) {
    const reason = String(env.CLAUDE_PROTECTED_WRITE_REASON || '').trim();
    if (!reason) return { ok: false, why: 'approval reason is required' };
    const targets = raw.split(',').map((item) => item.trim().replace(/\\/g, '/')).filter(Boolean);
    if (targets.some((item) => item.includes('*') || item.includes('?'))) {
      return { ok: false, why: 'approval paths must not contain wildcards' };
    }
    const hit = targets.some((target) => normalizedPath === target
      || (target.includes('/') && normalizedPath.endsWith('/' + target.replace(/^\.\//, ''))));
    return hit ? { ok: true, reason, kind: 'environment' } : null;
  }

  const filePath = approvalFilePath();
  let list;
  try {
    if (!fs.existsSync(filePath)) return null;
    list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(list)) return null;
  } catch {
    return null;
  }
  const now = Date.now();
  const token = list.find((item) => {
    if (!item || typeof item.path !== 'string' || new Date(item.expiresAt || 0).getTime() <= now) return false;
    const tokenPath = item.path.replace(/\\/g, '/');
    if (tokenPath.includes('*') || tokenPath.includes('?')) return false;
    return normalizedPath === tokenPath
      || (tokenPath.includes('/') && normalizedPath.endsWith('/' + tokenPath.replace(/^\.\//, '')));
  });
  if (!token) return null;
  if (!String(token.reason || '').trim()) return { ok: false, why: 'approval token is missing reason' };
  return { ok: true, reason: `[one-time token] ${token.reason}`, kind: 'token' };
}

function evaluate(payload, runtime = {}) {
  const source = GATE_ID;
  if (evaluateGuardBypass({ gateId: GATE_ID, payload, context: runtime.context }).allowed) {
    return { source, decision: 'allow', diagnostics: [] };
  }
  const toolName = String(payload?.tool_name || payload?.tool?.name || payload?.name || '').trim();
  const input = payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
  const filePath = String(runtime.filePath || input.file_path || input.filePath || '').trim();
  const writeTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  if (!writeTools.has(toolName) || !filePath) return { source, decision: 'allow', diagnostics: [] };

  const normalizedPath = filePath.replace(/\\/g, '/');
  const cwd = runtime.cwd || payload?.cwd || process.cwd();
  const projectPattern = manifestProtection(filePath, cwd);
  const matchedPattern = (projectPattern ? [projectPattern, ...PROTECTED_PATTERNS] : PROTECTED_PATTERNS)
    .find((pattern) => pattern.startsWith('manifest:') || matchesPattern(normalizedPath, pattern));
  const needsBackup = normalizedPath.endsWith('settings.local.json') || normalizedPath.endsWith('settings.json');
  const env = runtime.env || process.env;
  let approval = null;

  if (matchedPattern) {
    approval = inspectFileApproval(normalizedPath, env);
    if (!approval?.ok) {
      return {
        source,
        decision: 'block',
        diagnostics: [{
          code: 'protected-file',
          message: approval?.why || 'file is protected and requires explicit per-file approval',
          filePath,
          pattern: matchedPattern,
        }],
      };
    }
  }

  const commit = (needsBackup || matchedPattern) ? () => {
    if (approval?.kind === 'token') {
      const consumed = consumeFileApproval(normalizedPath);
      if (!consumed?.ok) throw new Error(consumed?.why || 'approval token was no longer available');
    }
    if (needsBackup && fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
    if (matchedPattern) auditApprovedWrite(filePath, matchedPattern, approval.reason);
    return { ok: true };
  } : undefined;

  return {
    source,
    decision: approval ? 'warn' : 'allow',
    diagnostics: approval ? [{
      code: 'protected-file-approved',
      message: `approved protected write: ${filePath}`,
      filePath,
      pattern: matchedPattern,
      reason: approval.reason,
    }] : [],
    advisories: approval ? [{ source, status: 'warning', blocking: false, target: filePath, reason: approval.reason }] : [],
    ...(commit ? { commit } : {}),
  };
}

/**
 * 审计留痕。CI / 只读诊断场景下跳过写盘，不影响放行判定。
 */
function auditApprovedWrite(filePath, pattern, reason) {
  if (process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1' || process.env.CLAUDE_HARNESS_NO_PERSIST === '1') return;
  try {
    const path = require('node:path');
    const dir = path.join(__dirname, '..', '..', '..', 'var', 'audit');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'protected-writes.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), file: filePath, pattern, reason }) + '\n'
    );
  } catch (_e) {
    // 审计失败不改变放行判定，但要让用户看见
    console.error('[FileProtection] ⚠️ 审计写入失败，放行仍已发生');
  }
}

/**
 * Try to extract tool call from stdin or env vars.
 */
function parseToolCall() {
  // Strategy 1: Read stdin (tool call JSON from Claude Code hook system)
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (input && input.trim()) {
      const data = JSON.parse(input);

      // Format (a): {tool: {name: "Write", input: {file_path: "..."}}}
      if (data?.tool?.name && data?.tool?.input?.file_path) {
        return { toolName: data.tool.name, filePath: data.tool.input.file_path, payload: data };
      }
      // Format (b): {tool_name: "Write", tool_input: {file_path: "..."}}
      if (data?.tool_name && data?.tool_input?.file_path) {
        return { toolName: data.tool_name, filePath: data.tool_input.file_path, payload: data };
      }
      // Format (c): flat {name: "Write", input: {file_path: "..."}}
      if (data?.name && data?.input?.file_path) {
        return { toolName: data.name, filePath: data.input.file_path, payload: data };
      }
      // Format (d): flat {arguments: {file_path: "..."}}
      if (data?.name && data?.arguments?.file_path) {
        return { toolName: data.name, filePath: data.arguments.file_path, payload: data };
      }
    }
  } catch (_e) {
    // fall through to env var strategy
  }

  // Strategy 2: Environment variables
  const envName = process.env.CLAUDE_TOOL_NAME || '';
  const envInput = process.env.CLAUDE_TOOL_INPUT || '';
  if (envName && envInput) {
    try {
      const parsed = JSON.parse(envInput);
      const filePath = parsed?.file_path || parsed?.arguments?.file_path || '';
      if (filePath) {
        return {
          toolName: envName,
          filePath,
          payload: {
            session_id: process.env.CLAUDE_SESSION_ID || '',
            tool_name: envName,
            tool_input: parsed,
          },
        };
      }
    } catch (_e) {
      // ignore
    }
  }

  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const call = parseToolCall();
  if (!call) {
    process.exit(0); // Can't determine tool call — allow (fail-open)
  }
  if (evaluateGuardBypass({ gateId: GATE_ID, payload: call.payload }).allowed) process.exit(0);

  // Only protect against file-modifying operations.
  //
  // MultiEdit 必须在列表里: settings.json 一直按 "Edit|Write|MultiEdit" 注册本 guard,
  // 但这里只判 Edit/Write —— 于是用 MultiEdit 改 golden model 完全无阻拦, 注册意图
  // 与实现存在缺口。同类缺口在 hdl-gate / rtl-semantic-oracle / bash-safety-guard
  // 上重复出现过, 见 test-hooks 的门禁注册矩阵检查。
  const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  if (!WRITE_TOOLS.has(call.toolName)) {
    process.exit(0);
  }

  // Normalize: use forward slashes for cross-platform matching
  const normalizedPath = call.filePath.replace(/\\/g, '/');
  const projectPattern = manifestProtection(call.filePath);

  // ── Auto-backup settings.local.json ──────────────────────────────────────
  // 在修改 settings.local.json 前自动备份
  if (normalizedPath.endsWith('settings.local.json') || normalizedPath.endsWith('settings.json')) {
    try {
      const bakPath = call.filePath + '.bak';
      if (fs.existsSync(call.filePath)) {
        fs.copyFileSync(call.filePath, bakPath);
        console.error(`[FileProtection] 已自动备份 ${call.filePath} → ${bakPath}`);
      }
    } catch (_e) {
      // 备份失败不阻断操作
    }
  }

  const applicablePatterns = projectPattern ? [projectPattern, ...PROTECTED_PATTERNS] : PROTECTED_PATTERNS;
  for (const pattern of applicablePatterns) {
    if (pattern.startsWith('manifest:') || matchesPattern(normalizedPath, pattern)) {
      // 受批准的逐文件例外 —— 默认仍然阻断，只有显式批准 + 理由才放行并留痕
      const appr = approvedException(normalizedPath);
      if (appr && appr.ok) {
        auditApprovedWrite(call.filePath, pattern, appr.reason);
        console.error(`[FileProtection] ✅ 经批准放行受保护文件: ${call.filePath}`);
        console.error(`[FileProtection]    规则=${pattern}  理由=${appr.reason}`);
        console.error('[FileProtection]    已记入 var/audit/protected-writes.jsonl');
        process.exit(0);
      }
      console.error('');
      console.error('╔══════════════════════════════════════════════════════════════╗');
      console.error('║           🔒 FILE PROTECTION GUARD — BLOCKED               ║');
      console.error('╠══════════════════════════════════════════════════════════════╣');
      console.error(`║  File:  ${call.filePath.padEnd(51)}║`);
      console.error(`║  Rule:  ${pattern.padEnd(51)}║`);
      console.error('║                                                              ║');
      console.error('║  This file is protected by hard constraint rules.             ║');
      console.error('║  See docs/rules-archive/08-constraints.md for context.        ║');
      console.error('║                                                              ║');
      console.error('║  单次改动: 取得用户批准后设置                                 ║');
      console.error('║    CLAUDE_PROTECTED_WRITE_APPROVAL + _REASON (逐文件, 留审计) ║');
      console.error('║  永久放开某类: edit file-protection-guard.cjs PROTECTED_PATTERNS ║');
      console.error('╚══════════════════════════════════════════════════════════════╝');
      console.error('');
      if (appr && appr.ok === false) console.error(`[FileProtection] 批准无效: ${appr.why}`);
      process.exit(2); // 必须 exit 2 才被 Hook 系统识别为"拦截"；exit 1 仅警告不阻断
    }
  }

  process.exit(0); // No match — allow
}

function pureCliMain() {
  const call = parseToolCall();
  if (!call) process.exit(0);
  const outcome = evaluate(call.payload);
  if (outcome.decision === 'block') {
    for (const diagnostic of outcome.diagnostics) {
      console.error(`[FileProtection] ${diagnostic.message}: ${diagnostic.filePath || call.filePath}`);
    }
    process.exit(2);
  }
  try {
    outcome.commit?.();
  } catch (error) {
    console.error(`[FileProtection] commit failed: ${error.message}`);
    process.exit(2);
  }
  for (const diagnostic of outcome.diagnostics) console.error(`[FileProtection] ${diagnostic.message}`);
  process.exit(0);
}

if (require.main === module) pureCliMain();

module.exports = {
  evaluate,
  matchesPattern,
};
