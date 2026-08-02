'use strict';

/**
 * engine/scripts/lib/failure-signature.cjs — 失败指纹归一化。
 *
 * 为什么需要它: harness 里有三处独立在数"同一个失败重复了几次", 三处各用一套
 * 判据, 于是"连续失败两次就换方法"这条规则实际上从未按预期生效:
 *
 *   1. dag-engine.checkLoop 用 errorMsg.slice(0, 40) 当指纹 —— 错误里只要带绝对
 *      路径、行号或耗时, 同一个失败每次都算"新错误", 循环门禁永远不触发;
 *   2. frustration-detector 的 failureCount 由**提示词关键词**驱动 (FRUSTRATION_
 *      PATTERNS 里含 /timeout/i), 用户消息里出现一次 "timeout" 就 +1 —— 实测
 *      runtime-state 里连续三条 trigger 都是 "timeout", 而当时并没有工具失败;
 *   3. 循环控制器要判断"上一轮和这一轮是不是同一个坑", 需要与前两者一致的判据。
 *
 * 本模块是这三处共用的唯一判据: 纯函数, 无 IO, 无状态。
 *
 * 设计取舍:
 *   - 位置类数字 (行号/列号/地址/耗时/时间戳/PID) 一律抹平 —— 它们是噪声;
 *   - 语义类数字 (exit code、错误码、断言里的期望值) 保留 —— 它们区分失败种类。
 *     一刀切把所有数字换成 N 会把 "exit 1" 和 "exit 127" 判成同一个失败。
 */

/** 指纹基准文本的截断长度。 */
const BASIS_CHARS = 240;
/** similar() 的宽松比对长度。 */
const SIMILAR_CHARS = 120;
/** 超长错误只取头尾, 中间省略 (堆栈中段信息密度最低)。 */
const HEAD_CHARS = 2000;
const TAIL_CHARS = 2000;

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');

/** 失败族: 顺序敏感, 先匹配者优先。 */
const FAMILIES = [
  ['cancelled', /\b(abort(ed)?|cancell?ed|sigint|sigterm|interrupted)\b/],
  ['timeout', /\b(timed?\s?out|timeout|etimedout|deadline exceeded)\b/],
  ['not_found', /\b(enoent|no such file|not found|cannot find|command not found|module_not_found|unresolved)\b/],
  ['permission', /\b(eacces|eperm|permission denied|access is denied|forbidden|unauthorized)\b/],
  ['network', /\b(econnrefused|econnreset|enotfound|network|dns|socket hang up|502|503|504)\b/],
  ['syntax', /\b(syntaxerror|parse error|unexpected token|near unexpected|invalid syntax)\b/],
  ['type', /\b(typeerror|referenceerror|is not a function|undefined is not|cannot read propert)\b/],
  ['assertion', /\b(assertionerror|assert(ion)? failed|expected .* (but )?(got|received)|mismatch|fail(ed)? \d+ (case|test)|\$fatal|\$error)\b/],
  ['dependency', /\b(cannot resolve|missing dependency|unmet peer|no module named|import error)\b/],
  ['resource', /\b(enomem|out of memory|enospc|no space left|too many open files|resource temporarily)\b/],
  ['nonzero_exit', /\b(exit(ed)?[ =:]+(code[ =:]+)?[1-9]\d*|non-?zero exit|exit status [1-9])\b/],
];

/**
 * 把错误文本归一化成稳定形式。
 * @param {unknown} value
 * @returns {string}
 */
function normalize(value) {
  let text = typeof value === 'string' ? value : errorText(value);
  if (!text) return '';

  if (text.length > HEAD_CHARS + TAIL_CHARS) {
    text = `${text.slice(0, HEAD_CHARS)} … ${text.slice(-TAIL_CHARS)}`;
  }

  return text
    .replace(ANSI, ' ')
    // ISO 时间戳 / epoch 毫秒
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b1[0-9]{12}\b/g, '<ts>')
    // UUID / 长十六进制 id
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<addr>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hash>')
    // 绝对路径 → basename (Windows 与 POSIX 都处理)
    .replace(/[A-Za-z]:[\\/](?:[^\s:*?"<>|]+[\\/])*([^\s:*?"<>|\\/]+)/g, '$1')
    .replace(/(?:^|[\s"'(=])\/(?:[^\s/:*?"<>|]+\/)+([^\s/:*?"<>|]+)/g, ' $1')
    // 文件后的 :行:列
    .replace(/(\.[a-z0-9]{1,6}):\d+(:\d+)?/gi, '$1:<pos>')
    // "line 123" / "at line 123" / "第 12 行"
    .replace(/\b(line|lineno|row|col|column)\b[ :=#]*\d+/gi, '$1 <pos>')
    .replace(/第\s*\d+\s*行/g, '第 <pos> 行')
    // 耗时与体积
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|mins|h)\b/gi, '<dur>')
    .replace(/\b\d+(\.\d+)?\s?(b|kb|mb|gb|kib|mib|gib)\b/gi, '<size>')
    // 进程/线程 id
    .replace(/\b(pid|ppid|tid|thread)\b[ :=#]*\d+/gi, '$1 <n>')
    // 临时目录里的随机后缀
    .replace(/\b(tmp|temp|test|cg-sync|verify)[-_][a-z0-9]{4,}\b/gi, '$1<rand>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 从 Error/对象/字符串里抽出可读文本。 */
function errorText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'object') {
    const parts = [value.message, value.error, value.stderr, value.reason, value.detail]
      .filter((part) => typeof part === 'string' && part.trim());
    if (parts.length) return parts.join(' ');
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/**
 * 判定失败族。用于给出"换什么方法"的建议, 也让指纹在措辞变化时仍能分组。
 * @param {string} normalized — normalize() 的输出
 * @returns {string}
 */
function family(normalized) {
  const text = String(normalized || '');
  for (const [name, pattern] of FAMILIES) {
    if (pattern.test(text)) return name;
  }
  return 'unknown';
}

/** FNV-1a 32bit ×2 拼成 16 进制指纹 —— 无需 crypto, 可在任何上下文调用。 */
function hash(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

/**
 * 计算失败指纹。
 *
 * @param {unknown} error — 错误文本 / Error / 带 message|stderr 的对象
 * @param {object} [opts]
 * @param {string} [opts.tool] — 工具名 (Bash 的超时和 Edit 的超时不是同一个坑)
 * @param {string} [opts.scope] — 额外分组维度 (节点名 / 文件路径)
 * @returns {{ fingerprint: string, normalized: string, family: string, tool: string, empty: boolean }}
 */
function signature(error, opts = {}) {
  const normalized = normalize(error);
  const fam = family(normalized);
  const tool = String(opts.tool || '').toLowerCase();
  const scope = String(opts.scope || '').toLowerCase();
  const basis = normalized.slice(0, BASIS_CHARS);

  return {
    fingerprint: hash(`${tool}|${scope}|${fam}|${basis}`),
    normalized,
    family: fam,
    tool,
    empty: normalized.length === 0,
  };
}

/**
 * 两个失败是否"同一个坑"。
 *
 * 比指纹宽松一档: 指纹相同必然相似; 指纹不同但同族且前 120 字符一致也算相似
 * (典型场景: 同一个断言失败, 只有期望值里的路径不同)。
 *
 * @param {{fingerprint?: string, normalized?: string, family?: string}|string} a
 * @param {{fingerprint?: string, normalized?: string, family?: string}|string} b
 * @returns {boolean}
 */
function similar(a, b) {
  const sigA = typeof a === 'string' ? signature(a) : a;
  const sigB = typeof b === 'string' ? signature(b) : b;
  if (!sigA || !sigB) return false;
  if (sigA.empty || sigB.empty) return false;
  if (sigA.fingerprint && sigA.fingerprint === sigB.fingerprint) return true;
  if (sigA.family !== sigB.family) return false;
  const left = String(sigA.normalized || '').slice(0, SIMILAR_CHARS);
  const right = String(sigB.normalized || '').slice(0, SIMILAR_CHARS);
  return left.length > 0 && left === right;
}

/**
 * 依据失败族给出换方法的建议 —— 供循环控制器与 DAG 循环门禁共用措辞。
 * @param {string} fam
 * @param {number} repeats — 同一指纹已出现次数
 * @returns {string}
 */
function strategyHint(fam, repeats = 2) {
  const prefix = `同一失败已重复 ${repeats} 次`;
  switch (fam) {
    case 'timeout':
      return `${prefix}: 超时类失败重试无用, 先缩小输入规模或提高超时上限, 并确认目标进程真的在推进`;
    case 'not_found':
      return `${prefix}: 目标不存在, 先验证路径/符号是否真的存在再动手, 不要重试同一条命令`;
    case 'permission':
      return `${prefix}: 权限类失败不会因重试改变, 改用有权限的路径或显式申请授权`;
    case 'network':
      return `${prefix}: 网络类失败先确认可达性, 或改用离线/本地替代路径`;
    case 'syntax':
    case 'type':
      return `${prefix}: 属静态错误, 回到源头读代码定位, 不要靠改参数试探`;
    case 'assertion':
      return `${prefix}: 断言失败说明契约理解有偏差, 先核对期望值来源 (规格/Golden Model) 再改实现`;
    case 'dependency':
      return `${prefix}: 依赖缺失, 先解决依赖安装/解析, 重跑同一命令不会有变化`;
    case 'resource':
      return `${prefix}: 资源耗尽, 先降规模或清理资源, 而不是重试`;
    case 'cancelled':
      return `${prefix}: 上一轮是被取消而非失败, 先确认取消来源再决定是否重跑`;
    case 'nonzero_exit':
      return `${prefix}: 只拿到退出码不足以定位, 先取回真实 stderr 再判断`;
    default:
      return `${prefix}: 当前方法已证明无效, 换一条路径或先做前置条件验证`;
  }
}

module.exports = {
  BASIS_CHARS,
  SIMILAR_CHARS,
  FAMILIES,
  normalize,
  errorText,
  family,
  signature,
  similar,
  strategyHint,
};
