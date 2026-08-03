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
 * 判定不消费令牌: 消费是 hook 的职责, 这里只做只读检查。
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

const APPROVAL_FILE = path.join(__dirname, '..', '..', '..', 'var', 'audit', 'protected-write-approvals.json');

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
 */
function blockReason(target) {
  if (!isProtected(target)) return null;
  if (hasApproval(target)) return null;
  return `${target} 落在受保护路径且无有效令牌 —— 未写入。`
    + '请按 var/audit/protected-write-approvals.json 的令牌流程申请后重跑, '
    + '或改用 Edit 工具逐项修改(走 file-protection 门禁并留审计)。';
}

module.exports = { PROTECTED_PATTERNS, isProtected, hasApproval, blockReason };
