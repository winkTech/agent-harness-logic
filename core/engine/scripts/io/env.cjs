'use strict';

/**
 * core/engine/scripts/io/env.cjs — 宿主 env 翻译层（Phase 2.4）
 *
 * core 与宿主 env 命名空间解耦的唯一边界：
 *   - 引擎统一读 HARNESS_*（HARNESS_SESSION_ID / HARNESS_NO_PERSIST / ...）
 *   - 宿主原生变量（CLAUDE_SESSION_ID / GROK_* / CODEX_*）在此映射为 HARNESS_*，
 *     引擎其余代码不再出现宿主前缀
 *   - C-6 扫描（env 泄漏检查）豁免清单 = 本文件
 *
 * 用法：
 *   const { envOf } = require('../io/env.cjs');
 *   const sid = envOf(process.env).sessionId;      // HARNESS_SESSION_ID ?? CLAUDE_SESSION_ID
 *   const flag = envOf(process.env).noPersist;     // 三源归一布尔
 *
 * 翻译表按需增长；HARNESS_* 永远优先（宿主侧值只在 HARNESS_* 缺席时兜底）。
 */

// ── 变量映射表：canonical(HARNESS_*) → 宿主兜底名 ────────────────────────────
const ALIASES = Object.freeze({
  HARNESS_SESSION_ID: ['CLAUDE_SESSION_ID', 'CODEBUDDY_SESSION_ID'],
  HARNESS_NO_PERSIST: ['CLAUDE_HARNESS_NO_PERSIST'],
  HARNESS_NO_DIAGNOSTIC_WRITES: ['CLAUDE_NO_DIAGNOSTIC_WRITES'],
  HARNESS_VERIFY_READONLY: ['CLAUDE_HARNESS_VERIFY_READONLY'],
  HARNESS_USER_MESSAGE: ['CLAUDE_USER_MESSAGE'],
  HARNESS_TRANSCRIPT_PATH: ['CLAUDE_TRANSCRIPT_PATH'],
  HARNESS_SESSION_DIR: ['CLAUDE_SESSION_DIR'],
  HARNESS_SQLITE_PATH: ['CLAUDE_SQLITE_PATH'],
  HARNESS_SQLITE_BUSY_TIMEOUT_MS: ['CLAUDE_SQLITE_BUSY_TIMEOUT_MS'],
  HARNESS_RUNTIME_STATE_FILE: ['CLAUDE_RUNTIME_STATE_FILE'],
  HARNESS_ROOT: ['CLAUDE_HARNESS_ROOT'],
});

/** 兼容视图：宿主名 → canonical（供适配器入口反向注册）。 */
const CANONICAL_FOR = Object.freeze((() => {
  const map = {};
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    map[canonical] = canonical;
    for (const a of aliases) map[a] = canonical;
  }
  return map;
})());

/** canonical 名优先级读取：HARNESS_X → 宿主别名（首个非空胜出）。 */
function envValue(env, canonicalName) {
  const sources = [canonicalName, ...(ALIASES[canonicalName] || [])];
  for (const key of sources) {
    const v = env ? env[key] : undefined;
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * 归一化 env 视图（常用字段的语义化访问器）。
 * @param {object} [env] 进程 env（默认 process.env；测试可注入）
 */
function envOf(env = process.env) {
  const read = (name) => envValue(env, name);
  const flag = (name) => {
    const v = read(name);
    return v === undefined ? false : ['1', 'true', 'yes'].includes(String(v).toLowerCase());
  };
  return {
    sessionId: read('HARNESS_SESSION_ID') || '',
    noPersist: flag('HARNESS_NO_PERSIST'),
    noDiagnosticWrites: flag('HARNESS_NO_DIAGNOSTIC_WRITES'),
    verifyReadonly: flag('HARNESS_VERIFY_READONLY'),
    userMessage: read('HARNESS_USER_MESSAGE') || '',
    transcriptPath: read('HARNESS_TRANSCRIPT_PATH') || '',
    sessionDir: read('HARNESS_SESSION_DIR') || '',
    sqlitePath: read('HARNESS_SQLITE_PATH') || '',
    runtimeStateFile: read('HARNESS_RUNTIME_STATE_FILE') || '',
    /** 原始透传（未列入映射表的变量仍可直接读 env）。 */
    raw: env,
    /** 通用读取：canonical 或任意裸名。 */
    get(name) { return read(name) ?? env[name]; },
  };
}

/**
 * 适配器入口翻译：把宿主原生变量物化成 HARNESS_*（写回传入 env 对象）。
 * 供 hosts/<name>/ 入口壳在引擎初始化前调用一次。
 */
function translateHostEnv(env = process.env) {
  const written = [];
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (env[canonical] !== undefined && env[canonical] !== '') continue;
    for (const alias of aliases) {
      if (env[alias] !== undefined && env[alias] !== '') {
        env[canonical] = env[alias];
        written.push(canonical);
        break;
      }
    }
  }
  return written;
}

module.exports = {
  ALIASES,
  CANONICAL_FOR,
  envValue,
  envOf,
  translateHostEnv,
};
