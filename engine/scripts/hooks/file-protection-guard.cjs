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

// ── 依据方向 (basis) ───────────────────────────────────────────────────────
//
// 策略演进（用户 2026-08-01 裁定）：门禁要防的不是"改 golden"，而是**因果倒置**
// —— RTL 调不通, 于是把 golden 改成 RTL 的样子。golden 与需求有出入时该改就改。
//
// 路径级权限判不了这件事: 合法修正与本末倒置写出来是同一个动作(向受保护路径写),
// 唯一的差别在**依据指向哪一侧**。审计日志 (var/audit/protected-writes.jsonl)
// 已经证明了这一点 —— 里面既有 "ADR-004 G1 修复整帧只产出 1 符号"(上游依据),
// 也有 "RTL 已同步修改, 镜像逐字跟进"(下游依据), 门禁对两者一视同仁地放行,
// 判别力全部来自那段自由文本 reason 本身。
//
// 所以判据从"能不能写这个路径"改成"依据指向上游还是下游":
//   upstream   规格/标准/裁决/推导/用户判定 —— golden 的正当来源, 放行
//   neutral    非语义维护(版本号/哈希/provenance/文档) —— 放行, 但不足以支撑倒置
//   downstream 依据来自 RTL 实测行为 —— 默认拒绝; 位真镜像一类"golden 有意跟随
//              RTL"的合法特例必须显式挂裁决 (basis.ruling), 不能混在普通修复里
const BASIS_DIRECTION = {
  spec: 'upstream',              // 需求/算法规格条款
  standard: 'upstream',          // 外部标准章节 (802.11a 等)
  adr: 'upstream',               // 架构裁决记录
  derivation: 'upstream',        // 数学推导
  'user-ruling': 'upstream',     // 用户当场裁定
  maintenance: 'neutral',        // 版本/哈希/provenance/文档, 不改算法语义
  'rtl-observation': 'downstream', // 依据来自 RTL 实测行为
};

/** 能为"golden 跟随 RTL"背书的依据种类 —— 必须是一次显式裁决。 */
const RULING_KINDS = new Set(['adr', 'user-ruling']);

// 下游话术: 理由文本里出现这些说法, 说明改动是被 RTL 行为拖着走的。
// 出现即要求依据升级到裁决级, 否则拒绝 —— 这正是本末倒置的自述形状。
// 英文侧不写成 `align\s+(?:with\s+)?rtl` —— 实测 "align golden with the RTL output"
// 就因为中间夹了宾语而漏判。改为"动词 + 近距离出现 RTL"，宁可多要一次裁决背书：
// 误判的代价是"请补一个 ADR 号"，漏判的代价是本末倒置直接过关。
const DOWNSTREAM_PHRASES = /对齐\s*RTL|对上\s*RTL|跟(?:随|着|进)?\s*RTL|与\s*RTL\s*(?:一致|保持|对齐|同步)|RTL\s*已(?:改|修改|同步)|按照?\s*RTL|改成\s*RTL|以\s*RTL\s*为准|让\s*(?:cosim|比对|判卷)\s*(?:通过|过|不再?失配)|使\s*(?:cosim|比对|判卷)\s*通过|\b(?:align|match|follow|mirror|sync)(?:s|es|ed|ing)?\b[^.\n]{0,30}?\brtl\b|\brtl\b[^.\n]{0,20}?\b(?:already\s+)?(?:changed|updated|fixed)\b|(?:to\s+)?make\s+(?:the\s+)?cosim\s+pass/i;

/** 归一化 basis; 返回 null 表示缺失或形状不合法。 */
function normalizeBasis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim().toLowerCase();
  const ref = String(raw.ref || '').trim();
  const ruling = String(raw.ruling || '').trim();
  if (!kind || !ref) return null;
  return { kind, ref, ruling };
}

/**
 * 依据方向判定。
 *
 * @param {object|null} basis      归一化后的 basis
 * @param {string} reason          批准理由(自由文本, 仍要一并扫描话术)
 * @param {object|null} inversion  C1 倒置签名, 命中时收紧到裁决级
 * @returns {{ok: true} | {ok: false, why: string}}
 */
function basisVerdict(basis, reason, inversion) {
  if (!basis) {
    return { ok: false, why: '批准缺少 basis{kind,ref} —— 受保护模型的改动必须声明依据来源' };
  }
  const direction = BASIS_DIRECTION[basis.kind];
  if (!direction) {
    return { ok: false, why: `basis.kind 非法: ${basis.kind} (可选: ${Object.keys(BASIS_DIRECTION).join(', ')})` };
  }

  const hasRuling = RULING_KINDS.has(basis.kind) || Boolean(basis.ruling);

  if (direction === 'downstream' && !basis.ruling) {
    return {
      ok: false,
      why: 'basis.kind=rtl-observation 但没有 basis.ruling —— 依据来自 RTL 实测行为时，'
        + '必须挂一次显式裁决(ADR 号或用户判定)说明为何 RTL 才是正确的一方。'
        + '缺了它, 这个改动的形状就是"RTL 调不通所以改 golden"。',
    };
  }

  const corpus = `${reason || ''} ${basis.ref} ${basis.ruling}`;
  if (DOWNSTREAM_PHRASES.test(corpus) && !hasRuling) {
    return {
      ok: false,
      why: `理由文本指向 RTL 侧(下游)而 basis.kind=${basis.kind} 声称是上游依据。`
        + '若确实是 golden 有意跟随 RTL(如位真镜像), 请改用 basis.kind=rtl-observation 并挂 basis.ruling; '
        + '若是需求侧修正, 请把依据写成规格/标准/推导的具体条款, 而不是 RTL 的行为。',
    };
  }

  if (inversion && !hasRuling) {
    return {
      ok: false,
      why: `倒置签名: 同模块 RTL ${inversion.module} (${inversion.rtlPath}) 在 ${Math.round(inversion.ageMs / 60000)} 分钟前刚被改过, `
        + `现在要改 golden, 而 basis.kind=${basis.kind} 不是裁决级依据。`
        + 'RTL 先动、golden 后跟, 是本末倒置的时序指纹 —— 请先确认这次 golden 改动的依据来自需求侧, '
        + '并用 basis.kind=adr|user-ruling 记下裁决。',
    };
  }

  return { ok: true };
}

// ── C1 倒置签名 ────────────────────────────────────────────────────────────
//
// "golden 指导 RTL" 这条流程方向, 以前只存在于规则文本里, 没有任何可观测判据。
// 这里用两个**不依赖模型自述**的事实把它变成可检查的: 模型 manifest 的
// implements_for 给出它服务的 RTL 模块名, 文件系统 mtime 给出那些模块最近被改
// 的时刻。RTL 刚改完就来改 golden, 就是倒置的时序指纹。
//
// 命中不等于阻断 —— 它把所需依据收紧到裁决级(见 basisVerdict), 合法场景
// (ADR 排期内的 golden 修正、有意的位真镜像) 照常放行, 只是必须写下裁决。
const INVERSION_WINDOW_MS = 4 * 60 * 60 * 1000;
const RTL_EXTENSIONS = new Set(['.sv', '.v', '.svh', '.vh']);
const WALK_SKIP = new Set(['.git', 'node_modules', 'var', '.wright', 'telemetry', 'cache', '.venv', '__pycache__']);
const WALK_BUDGET = 4000; // 目录预算; 耗尽即放弃检测(fail-open), 不拖慢写入

/** 从受保护文件向上找出它所属的 golden-model 目录 (含 manifest.json)。 */
function findModelDir(filePath) {
  const path = require('node:path');
  let dir = path.dirname(filePath);
  for (let depth = 0; depth < 8; depth++) {
    const manifest = path.join(dir, 'manifest.json');
    if (fs.existsSync(manifest)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (String(parsed?.kind || '').includes('golden-model')) return { dir, manifest: parsed };
      } catch { /* manifest 不可解析 —— 当作没有 */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 在预算内查找 modules 中任一模块的 RTL 文件, 返回最近一次修改。 */
function latestRtlTouch(root, modules) {
  const path = require('node:path');
  const wanted = new Set(modules.map((m) => String(m).toLowerCase()));
  let budget = WALK_BUDGET;
  let best = null;
  const queue = [root];
  while (queue.length && budget-- > 0) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!RTL_EXTENSIONS.has(ext)) continue;
      const base = path.basename(entry.name, ext).toLowerCase();
      if (!wanted.has(base)) continue;
      try {
        const mtime = fs.statSync(full).mtimeMs;
        if (!best || mtime > best.mtimeMs) best = { module: base, rtlPath: path.relative(root, full), mtimeMs: mtime };
      } catch { /* 读不到 stat 就跳过 */ }
    }
  }
  return best;
}

function inversionSignal(filePath, cwd, nowMs = Date.now()) {
  try {
    const windowMs = Number(process.env.CLAUDE_GOLDEN_INVERSION_WINDOW_MS || INVERSION_WINDOW_MS);
    if (!(windowMs > 0)) return null;
    const model = findModelDir(filePath);
    const modules = model?.manifest?.implements_for;
    if (!Array.isArray(modules) || !modules.length) return null;
    const root = findProjectRoot(filePath, cwd) || cwd;
    if (!root) return null;
    const touch = latestRtlTouch(root, modules);
    if (!touch) return null;
    const ageMs = nowMs - touch.mtimeMs;
    if (ageMs < 0 || ageMs > windowMs) return null;
    return { module: touch.module, rtlPath: touch.rtlPath, ageMs };
  } catch {
    return null; // 检测本身失败绝不改变放行判定
  }
}

/**
 * 受批准的例外写入。
 *
 * 策略（用户 2026-07-27 确认，2026-08-01 细化）：受保护文件**可以修改，但不能随便
 * 修改**。批准仍是必要条件，但不再是充分条件 —— 还要通过依据方向判定。
 *
 *   CLAUDE_PROTECTED_WRITE_APPROVAL="<路径>[,<路径>...]"   逐个文件，禁止通配符
 *   CLAUDE_PROTECTED_WRITE_REASON="<一句话说明>"           必填，写入审计
 *   CLAUDE_PROTECTED_WRITE_BASIS="<kind>|<ref>[|<ruling>]" 必填，依据方向
 *
 * 令牌文件通道支持两种粒度:
 *   逐文件  {path, reason, basis, expiresAt}              —— 一次性, 命中即消费
 *   裁决级  {scope, decision, reason, basis, expiresAt,
 *            remainingWrites}                            —— 覆盖一次裁决的全部改动
 *
 * 裁决级令牌是对"续发风暴"的修正: 审计日志里 8/15 条是"同一范围续发", 因为一次
 * ADR 修复要分多次 Write, 而逐文件令牌命中即消费。人的判断力于是被消耗在"要不要
 * 再写一次这个文件"上, 而不是"这次 golden 改动对不对"上 —— 那才是真正的决策。
 * 提升粒度不削弱约束: 每次写照旧单独审计, 依据方向照旧逐次判定, 只是批准的单位
 * 回到了裁决本身。
 *
 * @returns {{ok: boolean, reason?: string, why?: string} | null} null = 未申请例外
 */
const APPROVAL_FILE = 'var/audit/protected-write-approvals.json';

function approvalFilePath() {
  return require('node:path').join(__dirname, '..', '..', '..', APPROVAL_FILE);
}

/** 令牌是否仍在有效期内。 */
function tokenAlive(token, now) {
  return Boolean(token) && new Date(token.expiresAt || 0).getTime() > now;
}

/** 路径相对匹配：允许用仓库相对路径批准绝对路径的写入，但禁止裸文件名与通配符。 */
function pathTargetHits(target, normalizedPath) {
  const t = String(target || '').replace(/\\/g, '/').trim();
  if (!t || t.includes('*') || t.includes('?')) return false;
  return normalizedPath === t || (t.includes('/') && normalizedPath.endsWith('/' + t.replace(/^\.\//, '')));
}

/**
 * 裁决级令牌的范围匹配：scope 是目录前缀，必须至少含一层目录、不得含通配符。
 * 目录前缀只在**路径分隔边界**上命中，避免 `models/comm/of` 误盖 `models/comm/ofdm2`。
 */
function scopeHits(scope, normalizedPath) {
  const s = String(scope || '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!s || !s.includes('/') || s.includes('*') || s.includes('?')) return false;
  const lower = normalizedPath.toLowerCase();
  const needle = s.toLowerCase();
  return lower.startsWith(`${needle}/`) || lower.includes(`/${needle}/`);
}

function tokenHits(token, normalizedPath) {
  if (typeof token?.path === 'string') return pathTargetHits(token.path, normalizedPath);
  if (typeof token?.scope === 'string') return scopeHits(token.scope, normalizedPath);
  return false;
}

/** 环境变量通道的 basis：`kind|ref[|ruling]`。 */
function basisFromEnv(raw) {
  const parts = String(raw || '').split('|').map((s) => s.trim());
  if (!parts[0]) return null;
  return normalizeBasis({ kind: parts[0], ref: parts[1], ruling: parts[2] });
}

/**
 * 只读地检查是否存在可用批准。不产生副作用 —— 消费留给 commit 阶段，
 * 避免"门禁判定通过但写入没发生"时白白烧掉一张令牌。
 */
function inspectFileApproval(normalizedPath, env = process.env) {
  const raw = String(env.CLAUDE_PROTECTED_WRITE_APPROVAL || '').trim();
  if (raw) {
    const reason = String(env.CLAUDE_PROTECTED_WRITE_REASON || '').trim();
    if (!reason) return { ok: false, why: 'approval reason is required (CLAUDE_PROTECTED_WRITE_REASON)' };
    const targets = raw.split(',').map((item) => item.trim().replace(/\\/g, '/')).filter(Boolean);
    if (targets.some((item) => item.includes('*') || item.includes('?'))) {
      return { ok: false, why: 'approval paths must not contain wildcards' };
    }
    if (!targets.some((target) => pathTargetHits(target, normalizedPath))) return null;
    return {
      ok: true,
      reason,
      basis: basisFromEnv(env.CLAUDE_PROTECTED_WRITE_BASIS),
      kind: 'environment',
    };
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
  const token = list.find((item) => tokenAlive(item, now) && tokenHits(item, normalizedPath));
  if (!token) return null;
  if (!String(token.reason || '').trim()) return { ok: false, why: 'approval token is missing reason' };

  const scoped = typeof token.scope === 'string';
  if (scoped && !String(token.decision || '').trim()) {
    return { ok: false, why: '裁决级令牌缺少 decision(ADR 号或裁定标识) —— 范围批准必须绑定到一次具体裁决' };
  }
  const remaining = scoped ? Number(token.remainingWrites) : 1;
  if (scoped && !(Number.isFinite(remaining) && remaining > 0)) {
    return { ok: false, why: '裁决级令牌缺少可用的 remainingWrites —— 范围批准必须有写入次数上限' };
  }

  const label = scoped ? `[裁决级令牌 ${token.decision}, 余 ${remaining} 次]` : '[一次性令牌]';
  return {
    ok: true,
    reason: `${label} ${token.reason}`,
    basis: normalizeBasis(token.basis),
    kind: 'token',
  };
}

/**
 * 消费令牌。逐文件令牌命中即移除；裁决级令牌扣减 remainingWrites，扣光后移除。
 * 同时顺手清理过期条目，避免令牌文件变成长期开关。
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
  const alive = list.filter((t) => tokenAlive(t, now));
  const idx = alive.findIndex((t) => tokenHits(t, normalizedPath));
  if (idx < 0) {
    if (alive.length !== list.length) { try { fs.writeFileSync(p, JSON.stringify(alive, null, 1)); } catch (_e) {} }
    return null;
  }
  const token = alive[idx];
  if (!String(token.reason || '').trim()) return { ok: false, why: '令牌缺少 reason' };

  if (typeof token.scope === 'string') {
    const remaining = Number(token.remainingWrites) - 1;
    if (remaining > 0) alive[idx] = { ...token, remainingWrites: remaining };
    else alive.splice(idx, 1);
  } else {
    alive.splice(idx, 1);                     // 逐文件：一次性，命中即消费
  }

  try { fs.writeFileSync(p, JSON.stringify(alive, null, 1)); }
  catch (_e) { return { ok: false, why: '令牌无法消费(文件不可写)，为避免变成长期开关而拒绝放行' }; }
  return { ok: true, reason: String(token.reason) };
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

  let inversion = null;

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

    // 批准是必要条件, 不是充分条件: 还要看这次改动的依据指向上游(需求)还是下游(RTL)。
    inversion = inversionSignal(filePath, cwd);
    const verdict = basisVerdict(approval.basis, approval.reason, inversion);
    if (!verdict.ok) {
      return {
        source,
        decision: 'block',
        diagnostics: [{
          code: 'protected-file-basis',
          message: verdict.why,
          filePath,
          pattern: matchedPattern,
          ...(inversion ? { inversion } : {}),
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
    if (matchedPattern) auditApprovedWrite(filePath, matchedPattern, approval.reason, approval.basis, inversion);
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
      basis: approval.basis,
      ...(inversion ? { inversion } : {}),
    }] : [],
    advisories: approval ? [{ source, status: 'warning', blocking: false, target: filePath, reason: approval.reason }] : [],
    ...(commit ? { commit } : {}),
  };
}

/**
 * 审计留痕。CI / 只读诊断场景下跳过写盘，不影响放行判定。
 */
function auditApprovedWrite(filePath, pattern, reason, basis, inversion) {
  if (process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1' || process.env.CLAUDE_HARNESS_NO_PERSIST === '1') return;
  try {
    const path = require('node:path');
    const dir = path.join(__dirname, '..', '..', '..', 'var', 'audit');
    fs.mkdirSync(dir, { recursive: true });
    // basis/direction 入账: 日后要复核"这批 golden 改动是被需求推的还是被 RTL 拖的",
    // 靠的是这两个字段, 而不是重读一遍自由文本 reason。
    fs.appendFileSync(
      path.join(dir, 'protected-writes.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        file: filePath,
        pattern,
        reason,
        ...(basis ? { basis, direction: BASIS_DIRECTION[basis.kind] || 'unknown' } : {}),
        ...(inversion ? { inversion } : {}),
      }) + '\n'
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
//
// 曾经这里还有一个 main(), 与 evaluate() 各自实现了一遍批准判定, 但
// `require.main === module` 走的一直是 pureCliMain。两份实现同时在改依据方向
// 判据时必然分叉, 而分叉的那份是**没人执行却看起来像在生效**的门禁 —— 比没有
// 门禁更危险。判定只保留 evaluate() 一处。

/** 阻断时给出可执行的下一步, 否则调用方只知道"被拦了"却不知道缺什么。 */
function blockHint(code) {
  if (code === 'protected-file-basis') {
    return [
      '  依据方向不成立。golden 可以改, 但依据必须指向需求侧(上游), 不能指向 RTL 行为(下游)。',
      `  basis.kind 可选: ${Object.keys(BASIS_DIRECTION).join(' | ')}`,
      '  令牌: {scope|path, decision, reason, basis:{kind,ref[,ruling]}, expiresAt[, remainingWrites]}',
      '  环境: CLAUDE_PROTECTED_WRITE_BASIS="<kind>|<ref>[|<ruling>]"',
    ];
  }
  return [
    '  受保护文件需要用户批准。取得批准后二选一:',
    '    环境变量 CLAUDE_PROTECTED_WRITE_APPROVAL + _REASON + _BASIS (逐文件)',
    '    令牌文件 var/audit/protected-write-approvals.json (逐文件或裁决级 scope)',
  ];
}

function pureCliMain() {
  const call = parseToolCall();
  if (!call) process.exit(0);
  const outcome = evaluate(call.payload);
  if (outcome.decision === 'block') {
    for (const diagnostic of outcome.diagnostics) {
      console.error(`[FileProtection] ${diagnostic.message}: ${diagnostic.filePath || call.filePath}`);
      for (const line of blockHint(diagnostic.code)) console.error(`[FileProtection] ${line}`);
    }
    process.exit(2); // 必须 exit 2 才被 Hook 系统识别为"拦截"；exit 1 仅警告不阻断
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
  BASIS_DIRECTION,
  basisVerdict,
  evaluate,
  inversionSignal,
  matchesPattern,
  normalizeBasis,
  scopeHits,
};
