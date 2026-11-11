#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/render-grok-hooks.cjs — Grok hooks 渲染器（Phase 3.2）
 *
 * 真源链：manifest hostPresets.grok（声明式剖面）+ claude settings 真源（render-hook-settings 产物）
 * （claude-code 注册真源，render-hook-settings 渲染产物）
 *   → 本渲染器（剖面投影：事件子集/长钩子 skip/async 剥离/matcher 翻译）
 *   → ~/.grok/hooks.json（Grok 兼容读取位）
 *
 * 剖面规则（全部来自 hostPresets.grok 声明，渲染器零 if-else 宿主特判）：
 *   - eventsSubset 外的事件族整体不注册（UserPromptSubmit/SubagentStop/PreCompact）
 *   - skip[] 命中的脚本（或 argPattern 命中的命令变体）不注册
 *   - dropAsync: async:true 字段剥离（Grok 按前台执行 async 条目——B1 长钩子陷阱）
 *   - matcherTranslation: SessionStart matcher startup|resume → new|load
 *
 * 用法：
 *   render-grok-hooks.cjs           渲染
 *   render-grok-hooks.cjs --check   漂移检查（exit 1 列差异）
 *
 * 会话启动延迟断言（<5s）在 hosts/grok/smoke.cjs（真机实测，四幕剧）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const MANIFEST = path.join(HARNESS_ROOT, 'core', 'engine', 'hooks', 'manifest.json');
const SOURCE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const TARGET = path.join(os.homedir(), '.grok', 'hooks.json');

function loadPreset() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const preset = manifest.hostPresets && manifest.hostPresets.grok;
  if (!preset) throw new Error('manifest hostPresets.grok 缺失');
  return preset;
}

/** 剖面投影（纯函数——check 与 render 共用；测试可注入）。 */
function applyPreset(clauseSettings, preset) {
  const subset = new Set(preset.eventsSubset || []);
  const dropAsync = Boolean(preset.dropAsync);
  const translation = preset.matcherTranslation || {};
  const skipRules = preset.skip || [];

  const shouldSkip = (command) => {
    const cmd = String(command || '');
    for (const rule of skipRules) {
      const base = path.basename(rule.script || '');
      if (base && cmd.includes(base)) {
        // argPattern 存在时：仅当命令含该参数形态才跳过（--file 增量保留）
        if (rule.argPattern) {
          if (cmd.includes(rule.argPattern)) return { skipped: true, rule };
          continue;
        }
        return { skipped: true, rule };
      }
    }
    return { skipped: false };
  };

  const out = { hooks: {} };
  const applied = { skipped: [], asyncDropped: 0, matchersTranslated: [], timeoutsCapped: [] };
  for (const [event, groups] of Object.entries(clauseSettings.hooks || {})) {
    if (!subset.has(event)) continue;
    const outGroups = [];
    for (const g of groups) {
      const hooks = [];
      let matcher = g.matcher || '*';
      if (event === 'SessionStart' && matcher !== '*') {
        const translated = matcher.split('|')
          .map((tok) => translation[tok.trim()] || tok.trim())
          .join('|');
        if (translated !== matcher) applied.matchersTranslated.push(`${matcher}→${translated}`);
        matcher = translated;
      }
      for (const hk of g.hooks || []) {
        const verdict = shouldSkip(hk.command);
        if (verdict.skipped) {
          applied.skipped.push({ command: hk.command, reason: verdict.rule.reason });
          continue;
        }
        const entry = { type: hk.type || 'command', command: hk.command };
        // grok 剖面超时上限：前台执行的条目不得长于 30s（B1 长钩子陷阱的
        // 保守边界——启动路径条目 5s 内、收尾条目最长 30s）。
        if (hk.timeout !== undefined) {
          const capped = Math.min(Number(hk.timeout) || 0, preset.maxTimeoutSeconds || 30);
          if (capped !== hk.timeout) applied.timeoutsCapped.push(`${path.basename(String(hk.command).split(' ').pop() || '')}: ${hk.timeout}→${capped}`);
          entry.timeout = capped;
        }
        if (hk.async && dropAsync) {
          applied.asyncDropped += 1; // async 剥离——不复制该字段
        } else if (hk.async) {
          entry.async = hk.async;
        }
        hooks.push(entry);
      }
      if (hooks.length) outGroups.push({ matcher, hooks });
    }
    if (outGroups.length) out.hooks[event] = outGroups;
  }
  return { product: out, applied };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const preset = loadPreset();
  const clauseSettings = JSON.parse(fs.readFileSync(SOURCE_SETTINGS, 'utf8'));
  const { product, applied } = applyPreset(clauseSettings, preset);
  const expected = `${JSON.stringify(product, null, 2)}\n`;

  if (checkOnly) {
    let current = null;
    try { current = fs.readFileSync(TARGET, 'utf8'); } catch { /* 缺失即漂移 */ }
    if (current !== expected) {
      process.stderr.write('[render-grok-hooks] ✖ ~/.grok/hooks.json 与剖面投影漂移（渲染: node core/engine/scripts/render-grok-hooks.cjs）\n');
      process.exit(1);
    }
    process.stdout.write('[render-grok-hooks] ✓ 零漂移\n');
    return;
  }

  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, expected, 'utf8');
  const n = Object.values(product.hooks).flat().reduce((a, g) => a + g.hooks.length, 0);
  process.stdout.write(`[render-grok-hooks] 已渲染 ${TARGET}（${Object.keys(product.hooks).length} 族 ${n} 条）\n`);
  for (const s of applied.skipped) {
    process.stdout.write(`[render-grok-hooks] skip: ${path.basename(String(s.command).split(' ')[1] || s.command)} — ${s.reason}\n`);
  }
  if (applied.asyncDropped > 0) process.stdout.write(`[render-grok-hooks] async 剥离 ${applied.asyncDropped} 条\n`);
  for (const t of applied.matchersTranslated) process.stdout.write(`[render-grok-hooks] matcher 翻译: ${t}\n`);
}

main();
