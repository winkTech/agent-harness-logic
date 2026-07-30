'use strict';

/**
 * engine/scripts/lib/verification-markers.cjs — 通过/失败标记的唯一权威表。
 *
 * 为什么独立成模块 (2026-07-30): verification-gate 有一份标记表, evidence-ledger
 * 需要同样的判据来处理"载荷不带退出码"的观察型条目。复制一份表就会重演本仓库
 * 已经付过代价的"两份名单漂移"缺陷 (vvp 曾只在其中一份里, 于是空输出仿真算通过)。
 * 两侧共用本模块, 加标记只改一处。
 *
 * 判定原则: 通过必须有**正面**证据。退出码 0 且没扫到失败标记 ≠ 通过 ——
 * Icarus 的 $finish(1) 参数是诊断详细程度而非退出码, 这类 TB 永远 exit 0。
 */

const PASS_MARKERS = [
  /\bRESULT:\s*PASS\b/i,
  /\b(?:ALL\s+)?(?:TESTS?|CHECKS?)\s+PASSED\b/i,
  /\bPASSED\b/,
  /\bPASS\b/,
  /\b\d+\s+passed\b/i,
  /\b0\s+(?:failed|failures|errors|mismatches)\b/i,
  /\bno\s+(?:errors|mismatches|failures)\b/i,
  /\bbit-true\b/i,
  /\bsuccess(?:ful(?:ly)?)?\b/i,
  /\bcompleted\s+successfully\b/i,
  /\b(?:ok|OK)\b/,
  /** 项目自定义通过标记 — 编辑此数组添加 */
];

/** 输出里的失败标记。返回失败原因, 无失败标记返回 null。 */
function failureMarker(text) {
  const combined = String(text || '');
  if (/\bRESULT:\s*FAIL\b/i.test(combined)) return 'RESULT: FAIL in output';
  const failedCount = combined.match(/\b(\d+)\s+failed\b/i);
  if (failedCount && Number(failedCount[1]) > 0) return 'failed test count in output';
  if (/\b(?:FAILURE|FATAL|ASSERTION\s+FAILED)\b/i.test(combined)
    || (/\bFAILED\b/i.test(combined) && !/\b0\s+failed\b/i.test(combined))) {
    return 'failure marker in output';
  }
  return null;
}

function hasPassMarker(text) {
  const combined = String(text || '');
  return PASS_MARKERS.some((re) => re.test(combined));
}

/**
 * 纯标记判定 (不看退出码/信号/中断 —— 那些由调用方按各自的优先级先处理)。
 * 返回 'passed' | 'failed' | 'unknown' 与原因。
 */
function markerVerdict(text) {
  const combined = String(text || '');
  const failure = failureMarker(combined);
  if (failure) return { status: 'failed', reason: failure };
  if (!combined.trim()) return { status: 'unknown', reason: 'no log evidence' };
  if (!hasPassMarker(combined)) return { status: 'unknown', reason: 'no explicit PASS evidence in output' };
  return { status: 'passed', reason: 'explicit PASS evidence' };
}

module.exports = { PASS_MARKERS, failureMarker, hasPassMarker, markerVerdict };
