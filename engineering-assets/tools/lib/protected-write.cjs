'use strict';
/**
 * 受保护路径写入判定 —— 供经 Bash 运行、会写 models/** 的工具共用。
 *
 * 为什么需要它:
 *   file-protection-guard 是 PreToolUse hook, 只拦 Edit/Write/MultiEdit/NotebookEdit
 *   这类带 file_path 的工具调用。任何经 Bash 运行的脚本都绕过它 ——
 *   2026-08-02 实测: 一次 `manifest-hash-refresh.cjs --write` 静默改掉了
 *   models/comm/ldpc/manifest.json 的 8 处 sha256, 既没有一次性令牌, 也没有在
 *   var/audit/protected-writes.jsonl 留痕。
 *
 *   命令文本里往往根本不出现路径(只有 `--write`), 所以 hook 侧做命令扫描也拦不住;
 *   唯一可靠的位置是写入方本身。故此处提供共用判定, 由各工具在写入前自行调用。
 *
 * 为什么抽成库而不是各工具各写一份:
 *   判定逻辑一旦有两份副本就会漂移 —— 改了一处忘另一处, 洞就从没改的那处漏。
 *   本文件是唯一真相源; 新增会写 models/** 的工具时直接引它。
 *
 * 消费与留痕由**本库负责**, 不推给 hook (owner 2026-08-09 裁定):
 *   早先的分工是"判定归库、消费归 hook"。但 hook 在 Bash 路径上根本不运行 ——
 *   那正是本库存在的理由 —— 于是**两边都不消费、也都不留痕**: 缺口不在任一部件
 *   内部, 在两者的接缝处。2026-08-09 实测: 一次经批准的 manifest-hash-refresh
 *   --write 写完后 remainingWrites 仍是 1, 审计账本无新条目。
 *   现在 blockReason() 放行的同时就地消费令牌并写 protected-writes.jsonl,
 *   与 hook 侧的语义一致 (裁决级扣次数、逐文件即消费; reason 缺失即拒绝放行)。
 *
 *   消费时点取"放行前"而非 hook 那套"预留-结算": 本库的调用方都是同步写入,
 *   紧跟 blockReason() 之后就 writeFileSync。万一写失败, 令牌已扣 —— 那是**偏安全**
 *   的方向 (下次需重新申请), 好过写成功却没扣。
 */
const fs = require('node:fs');
const path = require('node:path');

// 与 engine/scripts/hooks/file-protection-guard.cjs 的 PROTECTED_PATTERNS 对应。
//
// 最后一条**比 hook 侧多一种形态**: hook 拿到的永远是绝对路径, 故它只需匹配
// `engineering-assets/models/`; 而本库的调用方可能传**相对 engineering-assets 的
// 路径**(如 `models/comm/ldpc/manifest.json`), 那种形态不含 `engineering-assets/`
// 前缀, 只写一条会静默漏过 —— 实测确实漏了。
// 加 `^models/` 一条兜住。全库只有 engineering-assets/models 一个 models 目录
// (已 find 确认), 不会误伤。
const PROTECTED_PATTERNS = [
  /(^|\/)matlab\//i,
  /(^|\/)07_mat\//i,
  /(^|\/)golden_model[^/]*\//i,
  /(^|\/)engineering-assets\/models\//i,
  /^models\//i,
];

const AUDIT_DIR = path.join(__dirname, '..', '..', '..', 'var', 'audit');
const APPROVAL_FILE = path.join(AUDIT_DIR, 'protected-write-approvals.json');
const AUDIT_FILE = path.join(AUDIT_DIR, 'protected-writes.jsonl');

// 依据方向映射不在此另写一份 —— 复制一份就会漂移, 而这正是本文件抽成库要避免的事。
// 从 hook 侧取; 取不到(单独部署 engineering-assets 时) 退化为 'unknown', 只影响
// 审计里的 direction 标注, 不影响放行判定。
function basisDirection(basis) {
  if (!basis || !basis.kind) return null;
  try {
    const { BASIS_DIRECTION } = require(path.join(__dirname, '..', '..', '..', 'engine', 'scripts', 'hooks', 'file-protection-guard.cjs'));
    return BASIS_DIRECTION[basis.kind] || 'unknown';
  } catch { return 'unknown'; }
}

/** 命中的是哪一条保护模式 —— 入账用, 便于日后按模式复核。 */
function matchedPattern(target) {
  const normalized = String(target || '').replace(/\\/g, '/');
  const hit = PROTECTED_PATTERNS.find((p) => p.test(normalized));
  return hit ? String(hit) : null;
}

function tokenAlive(token, now) {
  return Boolean(token) && new Date(token.expiresAt || 0).getTime() > now;
}

function tokenHits(token, normalized) {
  if (typeof token.path === 'string') {
    const t = token.path.replace(/\\/g, '/');
    return normalized === t || (t.includes('/') && normalized.endsWith(`/${t}`));
  }
  if (typeof token.scope === 'string') {
    const s = token.scope.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!s.includes('/')) return false;
    const lower = normalized.toLowerCase();
    return lower.startsWith(`${s}/`) || lower.includes(`/${s}/`);
  }
  return false;
}

/**
 * 消费一次令牌。语义与 hook 侧 consumeFileApproval 一致:
 *   裁决级(scope) 扣 remainingWrites, 扣光即移除; 逐文件(path) 命中即移除;
 *   顺手清掉过期条目, 免得令牌文件变成长期开关; reason 缺失即拒绝放行。
 * @returns {{ok: true, token: object} | {ok: false, why: string} | null} null = 无可用令牌
 */
function consumeApproval(target) {
  let list;
  try {
    if (!fs.existsSync(APPROVAL_FILE)) return null;
    list = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8'));
    if (!Array.isArray(list)) return null;
  } catch { return null; }

  const normalized = String(target || '').replace(/\\/g, '/');
  const now = Date.now();
  const alive = list.filter((t) => tokenAlive(t, now));
  const idx = alive.findIndex((t) => tokenHits(t, normalized));
  if (idx < 0) {
    if (alive.length !== list.length) {
      try { fs.writeFileSync(APPROVAL_FILE, `${JSON.stringify(alive, null, 1)}\n`, 'utf8'); } catch { /* 清理失败不改变判定 */ }
    }
    return null;
  }

  const token = alive[idx];
  if (!String(token.reason || '').trim()) return { ok: false, why: '令牌缺少 reason —— 无理由的放行不可审计, 拒绝' };
  if (typeof token.scope === 'string') {
    const remaining = Number(token.remainingWrites) - 1;
    if (!Number.isFinite(remaining)) return { ok: false, why: '裁决级令牌缺少可用的 remainingWrites' };
    if (remaining > 0) alive[idx] = { ...token, remainingWrites: remaining };
    else alive.splice(idx, 1);
  } else {
    alive.splice(idx, 1);
  }

  try { fs.writeFileSync(APPROVAL_FILE, `${JSON.stringify(alive, null, 1)}\n`, 'utf8'); }
  catch { return { ok: false, why: '令牌无法消费(文件不可写) —— 为避免它变成长期开关, 拒绝放行' }; }
  return { ok: true, token };
}

/** 写审计。与 hook 侧同一文件同一字段布局, 便于合并复核。 */
function appendAudit(entry) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    // 审计失败不改变已发生的放行, 但必须让人看见 —— 静默吞掉等于账本有洞而无人知道
    console.error('[protected-write] ⚠️ 审计写入失败, 放行仍已发生:', entry.file);
    return false;
  }
}

/** 目标路径是否落在受保护区。 */
function isProtected(target) {
  const normalized = String(target || '').replace(/\\/g, '/');
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 只读地看是否存在覆盖该路径的有效令牌; 不消费。 */
function hasApproval(target) {
  let list;
  try { list = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8')); }
  catch { return false; }
  if (!Array.isArray(list)) return false;
  const normalized = String(target || '').replace(/\\/g, '/');
  const now = Date.now();
  return list.some((token) => {
    if (!(new Date(token?.expiresAt || 0).getTime() > now)) return false;
    if (typeof token.path === 'string') {
      const t = token.path.replace(/\\/g, '/');
      return normalized === t || (t.includes('/') && normalized.endsWith(`/${t}`));
    }
    if (typeof token.scope === 'string') {
      const s = token.scope.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (!s.includes('/')) return false;
      const lower = normalized.toLowerCase();
      return lower.startsWith(`${s}/`) || lower.includes(`/${s}/`);
    }
    return false;
  });
}

/**
 * 写入前判定。返回 null 表示放行; 返回字符串表示应跳过写入, 内容是给用户看的原因。
 *
 * **放行不是只读的**: 命中受保护区且有令牌时, 本函数就地消费令牌并写审计, 然后才
 * 返回 null。调用方必须在每次实际写入前**恰好调一次** —— 调多了会多扣, 不调就没账。
 *
 * @param {string} target 写入目标路径
 * @param {{tool?: string}} [opts] tool: 调用方标识, 写进审计便于追溯是谁写的
 */
function blockReason(target, opts = {}) {
  if (!isProtected(target)) return null;

  const consumed = consumeApproval(target);
  if (!consumed) {
    return `${target} 落在受保护路径且无有效令牌 —— 未写入。`
      + '请按 var/audit/protected-write-approvals.json 的令牌流程申请后重跑, '
      + '或改用 Edit 工具逐项修改(走 file-protection 门禁并留审计)。';
  }
  if (!consumed.ok) return `${target} 落在受保护路径, 令牌不可用 —— 未写入。${consumed.why}`;

  const { token } = consumed;
  const direction = basisDirection(token.basis);
  appendAudit({
    ts: new Date().toISOString(),
    file: target,
    pattern: matchedPattern(target),
    reason: String(token.reason),
    ...(token.basis ? { basis: token.basis, direction } : {}),
    ...(opts.tool ? { tool: opts.tool } : {}),
    via: 'tool',   // 与 hook 侧记录区分: 这条是经 Bash 跑的工具自报的
  });
  return null;
}

module.exports = {
  PROTECTED_PATTERNS, isProtected, hasApproval, blockReason,
  consumeApproval, appendAudit, matchedPattern,
};
