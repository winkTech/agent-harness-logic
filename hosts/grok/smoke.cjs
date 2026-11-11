#!/usr/bin/env node
'use strict';

/**
 * hosts/grok/smoke.cjs — Grok 四幕剧冒烟（Phase 3.2）
 *
 * 检查清单（v2.1 修订 B5——验证无 stop_hook_active 宿主的死循环防护）：
 *   幕① 危险命令拦截：git push --force 经 bash-safety-guard exit 2、reason 可见
 *   幕② 技能触发：/start 经 ~/.agents/skills 零成本供给
 *   幕③ 会话恢复：SessionStart 恢复注入 briefing
 *   幕④ 小 budget 循环：loop-ctl start --budget 2——无 stop_hook_active 字段时
 *       重入防护靠 budget 正常退出、不死循环
 *
 * 用法：
 *   node hosts/grok/smoke.cjs --phase static    静态检查（注册面/剖面不变量——CI 可跑）
 *   node hosts/grok/smoke.cjs --phase live      真机四幕剧（需 Grok CLI 会话，人工配合）
 *
 * 静态段（本文件自动）：
 *   S1 ~/.grok/hooks.json 与剖面投影零漂移（调 render-grok-hooks --check）
 *   S2 剖面不变量：事件族=eventsSubset；零 async；超时 ≤ maxTimeoutSeconds；
 *      skip 条目确实缺席；matcher 已翻译（startup/resume 不残留）
 *   S3 技能供给面：~/.agents/skills 目录存在且非空
 *   S4 遥测面：spool 目录可写（H-5 快路径——grok 遥测仅走 spool）
 *
 * live 段：打印四幕剧操作清单与判定标准，配合真机会话逐幕记录结果到
 *   var/baselines/phase3/grok-smoke.json。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const GROK_HOOKS = path.join(os.homedir(), '.grok', 'hooks.json');
const AGENTS_SKILLS = path.join(os.homedir(), '.agents', 'skills');
const MANIFEST = path.join(ROOT, 'core', 'engine', 'hooks', 'manifest.json');
const RESULT_FILE = path.join(ROOT, 'var', 'baselines', 'phase3', 'grok-smoke.json');

function loadPreset() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).hostPresets.grok;
}

function staticChecks() {
  const results = [];
  const preset = loadPreset();

  // S1 零漂移
  const check = spawnSync(process.execPath,
    [path.join(ROOT, 'core/engine/scripts/render-grok-hooks.cjs'), '--check'],
    { encoding: 'utf8', timeout: 60000 });
  results.push({ id: 'S1', name: 'hooks.json 零漂移', pass: check.status === 0 });

  // S2 剖面不变量
  const product = JSON.parse(fs.readFileSync(GROK_HOOKS, 'utf8'));
  const families = Object.keys(product.hooks);
  const subsetOk = families.every((f) => preset.eventsSubset.includes(f))
    && families.length === preset.eventsSubset.length;
  let asyncLeak = false; let longTimeout = null; let staleMatcher = false;
  let allEntries = 0;
  for (const [ev, gs] of Object.entries(product.hooks)) {
    for (const g of gs) {
      if (ev === 'SessionStart' && /startup|resume/.test(g.matcher)) staleMatcher = true;
      for (const hk of g.hooks) {
        allEntries += 1;
        if (hk.async) asyncLeak = true;
        if ((hk.timeout || 0) > (preset.maxTimeoutSeconds || 30)) longTimeout = hk.command;
      }
    }
  }
  // S2d skip 语义：无 argPattern 的条目须完全缺席；带 argPattern 的条目
  // （codegraph --session）允许同脚本其它形态（--file 增量）在场，只查禁形态。
  const productStr = JSON.stringify(product);
  const skipOk = preset.skip.every((rule) => {
    if (!rule.argPattern) return !productStr.includes(path.basename(rule.script));
    // argPattern 型：命令含 basename 且含 argPattern 的组合不得出现
    for (const gs of Object.values(product.hooks)) {
      for (const g of gs) {
        for (const hk of g.hooks) {
          if (String(hk.command).includes(path.basename(rule.script))
              && String(hk.command).includes(rule.argPattern)) return false;
        }
      }
    }
    return true;
  });
  results.push({ id: 'S2a', name: `事件族=eventsSubset(${families.length}/${preset.eventsSubset.length})`, pass: subsetOk });
  results.push({ id: 'S2b', name: '零 async 残留', pass: !asyncLeak });
  results.push({ id: 'S2c', name: `超时 ≤ ${preset.maxTimeoutSeconds || 30}s`, pass: longTimeout === null, detail: longTimeout || '' });
  results.push({ id: 'S2d', name: 'skip 条目缺席', pass: skipOk });
  results.push({ id: 'S2e', name: 'matcher 已翻译（无 startup/resume 残留）', pass: !staleMatcher });

  // S3 技能供给面
  let skillsOk = false; let skillCount = 0;
  try {
    skillCount = fs.readdirSync(AGENTS_SKILLS).filter((n) => fs.existsSync(path.join(AGENTS_SKILLS, n, 'SKILL.md'))).length;
    skillsOk = skillCount > 0;
  } catch { /* 目录缺失 */ }
  results.push({ id: 'S3', name: `~/.agents/skills 供给（${skillCount} 个 SKILL.md）`, pass: skillsOk });

  // S4 spool 可写（grok 遥测唯一通道）——本段验证写路径：
  // ① 显式解除 runner 注入的防写开关（双名六键，Phase 2.4 先例）；
  // ② 探针写入隔离临时目录，不污染真实 spool（残留事件会让 SessionStart 的
  //    spool-drain 搬到真实数据 → stderr 汇报行破坏 lifecycle 契约精确断言）。
  const spool = require(path.join(ROOT, 'core/engine/scripts/io/telemetry-spool.cjs'));
  const gateKeys = [
    'HARNESS_NO_PERSIST', 'HARNESS_VERIFY_READONLY', 'HARNESS_NO_DIAGNOSTIC_WRITES',
    'CLAUDE_HARNESS_NO_PERSIST', 'CLAUDE_HARNESS_VERIFY_READONLY', 'CLAUDE_NO_DIAGNOSTIC_WRITES',
  ];
  const savedGates = Object.fromEntries(gateKeys.map((k) => [k, process.env[k]]));
  for (const k of gateKeys) delete process.env[k];
  const osMod = require('node:os');
  const probeDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'grok-smoke-spool-'));
  const probe = spool.appendToSpool(
    { type: 'grok-smoke-probe', sessionId: 'smoke' }, { dir: probeDir },
  );
  fs.rmSync(probeDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedGates)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  results.push({ id: 'S4', name: 'spool 快路径可写', pass: probe.wrote === true });

  return results;
}

function livePlaybook() {
  const steps = [
    { act: '①', op: '在 Grok 会话请求执行 git push --force', expect: 'bash-safety-guard exit 2 拦截且 reason 可见（PreToolUse Bash 拦截面）' },
    { act: '②', op: '输入 /start 触发技能', expect: '~/.agents/skills 技能加载（Agent Skills 供给面）' },
    { act: '③', op: '新开 Grok 会话（load 场景）', expect: 'SessionStart 恢复注入 briefing（state-resume/context-resume 链）+ 会话启动延迟 <5s' },
    { act: '④', op: 'loop-ctl start --budget 2 后触发循环任务', expect: '无 stop_hook_active 字段时靠 budget=2 正常退出、不死循环' },
  ];
  process.stdout.write('\n四幕剧真机操作清单（逐幕记录到 var/baselines/phase3/grok-smoke.json）：\n');
  for (const s of steps) {
    process.stdout.write(`  ${s.act} ${s.op}\n     判定: ${s.expect}\n`);
  }
  process.stdout.write('\n遥测核对: 幕①~④ 期间 var/telemetry/spool-<date>.jsonl 应有事件增长（grok 遥测仅走 spool）\n');
}

function main() {
  const phase = process.argv.includes('--phase')
    ? process.argv[process.argv.indexOf('--phase') + 1] : 'static';
  process.stdout.write('[grok-smoke] ── 静态检查 ──\n');
  const results = staticChecks();
  let failed = 0;
  for (const r of results) {
    process.stdout.write(`  ${r.name.padEnd(46)} ${r.pass ? '✅' : `❌ ${r.detail || ''}`}\n`);
    if (!r.pass) failed += 1;
  }
  if (phase === 'live' || process.argv.includes('--live')) livePlaybook();
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify({ at: new Date().toISOString(), phase, results }, null, 2)}\n`);
  process.stdout.write(`[grok-smoke] 结果已存 ${RESULT_FILE}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
