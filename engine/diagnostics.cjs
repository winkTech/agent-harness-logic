#!/usr/bin/env node

/**
 * engine/diagnostics.cjs — 全系统健康诊断。
 *
 * 汇总: SQLite 健康 / Hook 配置 / 文件系统 / 记忆 / 成本 / 技能
 *
 * 用法:
 *   node engine/diagnostics.cjs          # 全量诊断
 *   node engine/diagnostics.cjs --quick  # 快速 (仅 SQLite + 分数)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const HOME = path.join(os.homedir(), '.claude');

// ── 工具 ───────────────────────────────────────────────────────────────────

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

function ok(msg)    { console.log(`  ✅ ${msg}`); }
function warn(msg)  { console.log(`  ⚠️  ${msg}`); }
function fail(msg)  { console.log(`  ❌ ${msg}`); }
function info(msg)  { console.log(`   · ${msg}`); }

function formatBytes(b) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

// ── 1. SQLite 健康 ─────────────────────────────────────────────────────────

function checkSQLite() {
  section('SQLite 持久层');
  try {
    const { openDb } = require('./sqlite/index.cjs');
    const { memoryStats } = require('./sqlite/store-memory.cjs');
    const { summary } = require('./sqlite/store-costs.cjs');
    const { countByType } = require('./sqlite/store-events.cjs');
    const { report } = require('./sqlite/store-skills.cjs');

    const wDb = openDb();
    const db = wDb.db;

    const dbPath = wDb.isMemory ? ':memory:' : wDb.path;
    const dbSize = wDb.isMemory ? 0 : (fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0);
    info(`数据库: ${dbPath}`);
    info(`大小: ${formatBytes(dbSize)}`);
    info(`WAL 模式: ${wDb.isMemory ? 'N/A' : '是'}`);

    // 表完整性
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    info(`表数: ${tables.length}`);
    for (const t of tables) {
      const cnt = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get();
      info(`  ${t.name}: ${cnt.c} 行`);
    }

    // FTS5 完整性
    const mainCnt = db.prepare('SELECT COUNT(*) AS c FROM facts').get().c;
    const ftsCnt  = db.prepare('SELECT COUNT(*) AS c FROM facts_fts').get().c;
    if (mainCnt === ftsCnt) ok(`FTS5 索引完整 (${mainCnt} ↔ ${ftsCnt})`);
    else fail(`FTS5 索引不匹配: facts=${mainCnt} facts_fts=${ftsCnt}`);

    // 记忆统计
    const ms = memoryStats({ db });
    info(`记忆: ${ms.total} 条 (确认 ${ms.confirmed} / 待定 ${ms.tentative} / 低 ${ms.low})`);
    info(`命名空间: ${ms.namespaces}`);

    // 成本
    const cs = summary({ db });
    const totalCost = cs.total ? (cs.total.cost || 0).toFixed(4) : '0';
    info(`成本: ${totalCost} credits (${cs.total?.calls || 0} 次调用)`);

    // 事件
    const events = countByType({ db });
    info(`事件类型分布:`);
    for (const e of events) info(`  ${e.type}: ${e.count}`);

    // 技能
    const skills = report({ db });
    const activeSkills = skills.filter(s => s.tier !== 'tombstone').length;
    info(`技能: ${activeSkills} 个活跃`);
    for (const s of skills.slice(0, 5)) {
      info(`  ${s.tier.padEnd(10)} ${s.name.padEnd(20)} x${s.triggers}`);
    }

    wDb.close();
    return { healthy: mainCnt === ftsCnt, factCount: ms.total, skillCount: activeSkills };
  } catch (e) {
    fail(`SQLite 检查失败: ${e.message}`);
    return { healthy: false, factCount: 0, skillCount: 0 };
  }
}

// ── 2. Hook 配置 ───────────────────────────────────────────────────────────

function checkHooks() {
  section('Hook 配置');
  try {
    const cfg = require(path.join(HOME, 'settings.local.json'));
    const hooks = cfg.hooks || {};
    let total = 0, missing = 0, resolved = 0;

    const ECC = (() => {
      try { return require('./scripts/ecc-root-resolver.cjs')(); }
      catch { return null; }
    })();

    function checkPath(p) {
      total++;
      if (!p || p === '-e') return;
      // 本地文件（处理 ~/ 开头和 ~ 开头的路径）
      const normalized = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
      const localPath = path.resolve(normalized);
      if (fs.existsSync(localPath)) { resolved++; return; }
      // ECC 插件路径
      if (ECC && p.startsWith('scripts/')) {
        const eccPath = path.join(ECC, p);
        if (fs.existsSync(eccPath)) { resolved++; return; }
      }
      missing++;
      warn(`脚本不存在: ${p}`);
    }

    for (const [point, entries] of Object.entries(hooks)) {
      const arr = Array.isArray(entries) ? entries : [];
      for (const group of arr) {
        const hookList = group.hooks || [group];
        for (const h of hookList) {
          const cmd = h.command || h.run || '';
          const scripts = cmd.match(/(?:node|bash)\s+([^\s"'|]+(?:\.\w+)?)/g);
          if (scripts) scripts.forEach(s => {
            const p = s.replace(/^(?:node|bash)\s+/, '');
            checkPath(p);
          });
        }
      }
    }

    info(`当前 Hook 配置: ${Object.keys(hooks).length} 个触发点`);
    info(`脚本文件: ${total} 个引用, ${resolved} 个存在, ${missing} 个缺失`);
    if (missing === 0) ok('所有 hook 脚本文件都存在');
    else warn(`${missing} 个脚本缺失`);
    return { hookPoints: Object.keys(hooks).length, total, missing };
  } catch (e) {
    fail(`Hook 配置检查失败: ${e.message}`);
    return { hookPoints: 0, total: 0, missing: 0 };
  }
}

// ── 3. 文件系统 ─────────────────────────────────────────────────────────────

function checkFilesystem() {
  section('文件系统');
  try {
    const r = spawnSync('git', ['status', '--short'], { cwd: HOME, encoding: 'utf8', timeout: 5000, windowsHide: true });
    const dirty = r.stdout.trim().split('\n').filter(Boolean).length;
    info(`工作树: ${dirty} 个未提交变更`);

    const total = spawnSync('git', ['ls-files'], { cwd: HOME, encoding: 'utf8', timeout: 5000, windowsHide: true });
    const fileCount = total.stdout.trim().split('\n').filter(Boolean).length;
    info(`跟踪文件: ${fileCount}`);

    const pack = spawnSync('git', ['count-objects', '-v'], { cwd: HOME, encoding: 'utf8', timeout: 5000, windowsHide: true });
    const sizeMatch = pack.stdout.match(/size-pack:\s+(\d+)/);
    const packSize = sizeMatch ? parseInt(sizeMatch[1], 10) * 1024 : 0;
    info(`Git 包大小: ${formatBytes(packSize)}`);

    const disk = spawnSync('du', ['-sh', '--exclude=.git', '.'], { cwd: HOME, encoding: 'utf8', timeout: 5000, windowsHide: true });
    info(`磁盘占用(不含.git): ${disk.stdout.trim().split(/\s/)[0]}`);

    return { fileCount, dirty, packSize };
  } catch (e) {
    info(`文件系统检查: ${e.message}`);
    return { fileCount: 0, dirty: 0, packSize: 0 };
  }
}

// ── 4. FPGA 环境 ────────────────────────────────────────────────────────────

function checkFPGA() {
  section('FPGA 环境');
  try {
    const eda = require('./scripts/eda-detect.cjs');
    const tools = eda.detect({ quick: true });
    const template = require('./scripts/lib/check-templates.cjs');

    const lintTool = eda.pickLintTool(tools);
    const available = tools.filter(t => t.available);
    const total = tools.length;

    info(`EDA 工具: ${available.length}/${total} 可用`);

    if (lintTool) info(`首选 lint: ${lintTool.lintLabel}`);
    else warn('未检测到 lint 工具');

    for (const t of available.slice(0, 5)) {
      info(`  ${t.label} ${t.version ? `v${t.version}` : ''}`);
    }

    // 检查项目中是否有关注文件
    let xdcCount = 0;
    let constraintCount = 0;
    try {
      const cwd = process.cwd();
      if (fs.existsSync(cwd)) {
        // 向上找 .git
        let gitDir = cwd;
        while (gitDir && !fs.existsSync(path.join(gitDir, '.git'))) {
          const p = path.dirname(gitDir);
          if (p === gitDir) { gitDir = null; break; }
          gitDir = p;
        }
        if (gitDir) {
          xdcCount = (spawnSync('git', ['ls-files', '*.xdc'], { cwd: gitDir, encoding: 'utf8', timeout: 5000, windowsHide: true }).stdout || '').split('\n').filter(Boolean).length;
          constraintCount = (spawnSync('git', ['ls-files', 'fpga_constraints.*'], { cwd: gitDir, encoding: 'utf8', timeout: 5000, windowsHide: true }).stdout || '').split('\n').filter(Boolean).length;
        }
      }
    } catch { /* 非 git 仓库 */ }

    if (xdcCount > 0) info(`.xdc 约束文件: ${xdcCount} 个`);
    if (constraintCount > 0) info(`fpga_constraints.yaml: ${constraintCount} 个`);

    return { toolCount: available.length, lintTool: !!lintTool };
  } catch (e) {
    fail(`FPGA 环境检查失败: ${e.message}`);
    return { toolCount: 0, lintTool: false };
  }
}

// ── 5. 评分 ─────────────────────────────────────────────────────────────────

function score(sqlite, hooks, fs_, fpga) {
  section('健康评分');
  let score = 100;

  // SQLite
  if (!sqlite.healthy) score -= 20;
  if (sqlite.factCount === 0) score -= 5;
  if (sqlite.skillCount === 0) score -= 5;

  // Hooks
  if (hooks.missing > 0) score -= Math.min(hooks.missing * 5, 20);
  if (hooks.hookPoints < 5) score -= 10;

  // Git
  if (fs_.dirty > 10) score -= 5;
  if (fs_.packSize > 100 * 1024 * 1024) score -= 5; // >100MB

  // FPGA
  if (!fpga.lintTool) score -= 10;
  if (fpga.toolCount === 0) score -= 5;

  score = Math.max(0, Math.min(100, score));

  const grade = score >= 90 ? '🟢 优秀' : score >= 75 ? '🟡 良好' : score >= 60 ? '🟠 一般' : '🔴 需维护';
  console.log(`\n  总分: ${score}/100 — ${grade}`);
  return score;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isBench = args.includes('--bench');
  const isQuick = args.includes('--quick');
  const isTemplates = args.includes('--templates');
  const isHooks = args.includes('--hooks');

  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║   🤖 Claude Code Harness 诊断     ║`);
  console.log(`║   ${new Date().toISOString().slice(0, 19).replace('T', ' ')}           ║`);
  console.log(`╚════════════════════════════════════╝`);

  // ── 模式派发 ──────────────────────────────────────────────────────────

  if (isBench) {
    console.log(`\n📊 模式: 全量基准 (--bench)`);
    try {
      const bench = require('./scripts/lib/bench-hooks.cjs');
      await bench.main();
    } catch (e) {
      fail(`基准失败: ${e.message}`);
    }
    console.log(`\n━━━ 诊断完成 ━━━\n`);
    return;
  }

  if (isQuick) {
    console.log(`\n⚡ 模式: 快速检查 (--quick)`);
    try {
      const bench = require('./scripts/lib/bench-hooks.cjs');
      await bench.main();
    } catch (e) {
      fail(`快速检查失败: ${e.message}`);
    }
    console.log(`\n━━━ 诊断完成 ━━━\n`);
    return;
  }

  if (isTemplates) {
    section('模板检查');
    try {
      const { checkTemplates } = require('./scripts/lib/check-templates.cjs');
      await checkTemplates();
    } catch (e) {
      fail(`模板检查失败: ${e.message}`);
    }
    console.log(`\n━━━ 诊断完成 ━━━\n`);
    return;
  }

  if (isHooks) {
    section('Hook 集成测试');
    try {
      require('./scripts/hooks/test-hooks.cjs');
    } catch (e) {
      fail(`Hook 测试失败: ${e.message}`);
    }
    console.log(`\n━━━ 诊断完成 ━━━\n`);
    return;
  }

  // ── 全量诊断 ──────────────────────────────────────────────────────────

  const sqlite = checkSQLite();
  const hooks = checkHooks();
  const fs_ = checkFilesystem();
  const fpga = checkFPGA();
  score(sqlite, hooks, fs_, fpga);

  console.log(`\n━━━ 诊断完成 ━━━\n`);
}

main().catch(e => {
  console.error('[diagnostics] 失败:', e.message);
  process.exit(1);
});
