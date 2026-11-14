#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/render-codex-hooks.cjs — Codex hooks 渲染器（Phase 3.1）
 *
 * 真源链：hosts/codex/registrations.json（${HARNESS_ROOT} 占位）
 *   → 本渲染器（占位展开 + manifest 一致性校验）
 *   → ~/.codex/hooks.json（Codex 实际读取位）
 *
 * 用法：
 *   render-codex-hooks.cjs            渲染（写 ~/.codex/hooks.json）
 *   render-codex-hooks.cjs --check    漂移检查（CI/出 exit 1 列差异）
 *
 * 渲染一致性：H-1(codex)——重渲染幂等，产物与真源零漂移。
 * trusted_hash：写 hooks.json 后 Codex 要求重信任（config.toml [hooks.state]）。
 *   渲染器检测 hash 失配时在 stderr 提示重信任命令（不自动改 config.toml——
 *   信任动作必须人发起）。
 *
 * manifest 一致性（H-2 codex 侧）：渲染前校验真源注册的每个 hook 脚本
 *   在 manifest 声明的 transports 含 codex（batch 复合命令取其全部脚本引用）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const REGISTRATIONS = path.join(HARNESS_ROOT, 'hosts', 'codex', 'registrations.json');
const TARGET = path.join(os.homedir(), '.codex', 'hooks.json');
const CONFIG_TOML = path.join(os.homedir(), '.codex', 'config.toml');
const AGENTS_TARGET = path.join(os.homedir(), '.codex', 'AGENTS.md');
const AGENTS_SOURCE = path.join(HARNESS_ROOT, 'hosts', 'claude-code', 'AGENTS.md');

// ── 渲染 ────────────────────────────────────────────────────────────────────

function loadRegistrations(file = REGISTRATIONS) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** ${HARNESS_ROOT} 占位展开（路径统一正斜杠——Windows 下两种都可用，但产物要规整）。 */
function expandCommand(command, root = HARNESS_ROOT) {
  return String(command || '')
    .split('${HARNESS_ROOT}')
    .join(String(root).replace(/\\/g, '/'));
}

/** 渲染产物（纯函数——check 与 render 共用）。 */
function renderProduct(registrations, root = HARNESS_ROOT) {
  const product = { hooks: {} };
  for (const [event, groups] of Object.entries(registrations.hooks || {})) {
    product.hooks[event] = groups.map((g) => ({
      matcher: g.matcher || '*',
      hooks: (g.hooks || []).map((hk) => {
        const entry = { type: hk.type || 'command', command: expandCommand(hk.command, root) };
        if (hk.timeout !== undefined) entry.timeout = hk.timeout;
        return entry;
      }),
    }));
  }
  return product;
}

// ── manifest 一致性 ─────────────────────────────────────────────────────────

function manifestDeclaredScripts() {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(HARNESS_ROOT, 'core', 'engine', 'hooks', 'manifest.json'), 'utf8',
  ));
  const map = new Map(); // script basename → entry
  for (const e of manifest.entries) {
    map.set(path.basename(e.script).replace(/\.cjs$/, ''), e);
  }
  return map;
}

/** 真源里引用的全部 .cjs 脚本（batch 命令内联引用也计入）。 */
function referencedScripts(registrations) {
  const refs = new Set();
  for (const groups of Object.values(registrations.hooks || {})) {
    for (const g of groups) {
      for (const hk of g.hooks || []) {
        for (const m of String(hk.command || '').matchAll(/([\w.-]+\.cjs)\b/g)) {
          refs.add(m[1].replace(/\.cjs$/, ''));
        }
      }
    }
  }
  return refs;
}

/** manifest 侧校验：引用脚本须（在 manifest 中）声明 codex transport 或属于豁免面。 */
// 豁免：batch 复合命令里的辅助脚本（local-runner 批量挂 verification-gate 等）
// 在 manifest 之外独立存在是既有设计（hooks/manifest.json 管 router 面）；
// 渲染器只强校验 manifest 已声明条目的 transports 正确性。
function checkManifestConsistency(registrations, manifestMap) {
  const errors = [];
  for (const base of referencedScripts(registrations)) {
    const entry = manifestMap.get(base);
    if (!entry) continue; // manifest 外的脚本（batch 辅助/独立 gate）不在此校验
    if (!entry.transports || !entry.transports.includes('codex')) {
      errors.push(`${base}: manifest transports 未含 codex，但真源注册了它`);
    }
    // hostOnly 条目不得出现在 codex 真源
    if (Array.isArray(entry.hostOnly) && entry.hostOnly.length > 0
        && !entry.transports.includes('codex')) {
      errors.push(`${base}: hostOnly 条目出现在 codex 注册真源`);
    }
  }
  return errors;
}

// ── trusted_hash 提示 ───────────────────────────────────────────────────────

/** hooks.json 各条目的 config.toml 键形（'C:\...\hooks.json:pre_tool_use:g:h'）。 */
function hookStateKeys(product) {
  const evMap = {
    PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use',
    PreCompact: 'pre_compact', SessionStart: 'session_start', Stop: 'stop',
  };
  const keys = [];
  for (const [event, groups] of Object.entries(product.hooks || {})) {
    const evKey = evMap[event];
    if (!evKey) continue;
    groups.forEach((g, gi) => {
      (g.hooks || []).forEach((hk, hi) => {
        keys.push(`${TARGET}:${evKey}:${gi}:${hi}`);
      });
    });
  }
  return keys;
}

/** 从 config.toml 抽 [hooks.state.'key'] trusted_hash 行（容错解析——只找前缀匹配）。 */
function readTrustedHashes() {
  let toml;
  try { toml = fs.readFileSync(CONFIG_TOML, 'utf8'); } catch { return new Map(); }
  const map = new Map();
  for (const line of toml.split('\n')) {
    const m = line.match(/^\[hooks\.state\.'(.+)'\]$/);
    if (m) {
      // 段头后 2 行内找 trusted_hash
      const idx = toml.indexOf(line);
      const seg = toml.slice(idx + line.length, idx + line.length + 200);
      const hm = seg.match(/trusted_hash\s*=\s*"([0-9a-f]{40,64})"/);
      if (hm) map.set(m[1].replace(/\\\\/g, '\\'), hm[1]);
    }
  }
  return map;
}

/** 单条目 hash（与 git-integrity-guard 同构：canonical JSON sha256）。 */
function entryHash(hookEntry, eventName, matcher) {
  const obj = {
    event_name: eventName.toLowerCase(),
    matcher,
    hooks: [{ type: hookEntry.type, command: hookEntry.command, ...(hookEntry.timeout !== undefined ? { timeout: hookEntry.timeout } : {}) }],
  };
  const canonical = JSON.stringify(obj, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((acc, key) => { acc[key] = v[key]; return acc; }, {})
    : v));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function staleTrustKeys(product) {
  const trusted = readTrustedHashes();
  const stale = [];
  const evMap = {
    PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use',
    PreCompact: 'pre_compact', SessionStart: 'session_start', Stop: 'stop',
  };
  for (const [event, groups] of Object.entries(product.hooks || {})) {
    groups.forEach((g, gi) => {
      (g.hooks || []).forEach((hk, hi) => {
        const key = `${TARGET}:${evMap[event]}:${gi}:${hi}`;
        const recorded = trusted.get(key);
        if (recorded !== undefined && recorded !== entryHash(hk, event, g.matcher || '*')) {
          stale.push(key);
        }
      });
    });
  }
  return stale;
}

// ── AGENTS.md 投影 ──────────────────────────────────────────────────────────

/** 规则真源 → Codex 全局 AGENTS.md 投影（消灭手工双拷贝）。 */
function renderAgentsProduct(sourceText = fs.readFileSync(AGENTS_SOURCE, 'utf8')) {
  const body = sourceText.replace(/^# Codex 项目指导\n?/, '');
  return [
    '# Codex 全局指导',
    '',
    '<!-- 本文件由 hosts/claude-code/AGENTS.md 真源渲染（render-codex-hooks.cjs --agents）。',
    '     手工修改会被下次渲染覆盖；改规则请改真源。 -->',
    '',
    body.trimEnd(),
    '',
  ].join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const checkOnly = process.argv.includes('--check');
  const agentsOnly = process.argv.includes('--agents');
  const registrations = loadRegistrations();
  const product = renderProduct(registrations);

  if (!agentsOnly) {
    const manifestErrors = checkManifestConsistency(registrations, manifestDeclaredScripts());
    if (manifestErrors.length > 0) {
      for (const e of manifestErrors) process.stderr.write(`[render-codex-hooks] ✖ manifest 不一致: ${e}\n`);
      process.exit(1);
    }
  }

  if (agentsOnly || !checkOnly) {
    // 渲染路径：hooks.json + AGENTS.md 一起出
    if (!agentsOnly) {
      fs.mkdirSync(path.dirname(TARGET), { recursive: true });
      fs.writeFileSync(TARGET, `${JSON.stringify(product, null, 2)}\n`, 'utf8');
      process.stdout.write(`[render-codex-hooks] 已渲染 ${TARGET}（${Object.keys(product.hooks).length} 事件族）\n`);
      const stale = staleTrustKeys(product);
      if (stale.length > 0) {
        process.stderr.write(`[render-codex-hooks] ⚠ trusted_hash 失配 ${stale.length} 条——hooks 变更后须在 Codex 内重新信任，否则钩子静默不执行\n`);
      } else {
        process.stdout.write('[render-codex-hooks] trusted_hash 全部匹配\n');
      }
    }
    fs.mkdirSync(path.dirname(AGENTS_TARGET), { recursive: true });
    fs.writeFileSync(AGENTS_TARGET, renderAgentsProduct(), 'utf8');
    process.stdout.write(`[render-codex-hooks] 已渲染 ${AGENTS_TARGET}\n`);
    return;
  }

  // --check：两产物都验
  let current = null;
  try { current = fs.readFileSync(TARGET, 'utf8'); } catch { /* 缺失即漂移 */ }
  const expected = `${JSON.stringify(product, null, 2)}\n`;
  let drift = false;
  if (current !== expected) {
    process.stderr.write('[render-codex-hooks] ✖ ~/.codex/hooks.json 与真源漂移（渲染: node core/engine/scripts/render-codex-hooks.cjs）\n');
    drift = true;
  }
  let agentsCurrent = null;
  try { agentsCurrent = fs.readFileSync(AGENTS_TARGET, 'utf8'); } catch { /* 缺失即漂移 */ }
  if (agentsCurrent !== renderAgentsProduct()) {
    process.stderr.write('[render-codex-hooks] ✖ ~/.codex/AGENTS.md 与规则真源漂移（渲染: node core/engine/scripts/render-codex-hooks.cjs --agents）\n');
    drift = true;
  }
  if (drift) process.exit(1);
  const stale = staleTrustKeys(product);
  if (stale.length > 0) {
    process.stderr.write(`[render-codex-hooks] ⚠ trusted_hash 失配 ${stale.length} 条——需在 Codex 内重信任 hooks\n`);
  }
  process.stdout.write('[render-codex-hooks] ✓ 零漂移（hooks.json + AGENTS.md）\n');
}

main();
