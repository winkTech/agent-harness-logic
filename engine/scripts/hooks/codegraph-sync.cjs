#!/usr/bin/env node
'use strict';

/**
 * engine/scripts/hooks/codegraph-sync.cjs — 代码图索引调度器。
 *
 * 图查询链 (cg-queries / codegraph MCP / getBlastRadius) 早就建好了, 但从来没有
 * 任何东西触发过索引 —— 实测 cg_nodes=0, cg_edges=0, 于是所有图查询恒返回空。
 * 本 hook 就是那段缺失的调度:
 *
 *   SessionStart (--session, async) → 项目级增量同步, 带节流
 *   PostToolUse  (--file,    async) → 单文件增量索引
 *
 * 两种模式都:
 *   - 只写图, 不产生任何 stdout (stdout 会被当成 hook 协议输出)
 *   - 任何异常都吞掉并以 0 退出 (索引是加速器, 不是门禁, 绝不能挡住会话)
 *   - 尊重 CLAUDE_HARNESS_NO_PERSIST / CLAUDE_NO_DIAGNOSTIC_WRITES 只读开关
 *
 * 节流状态: var/index/codegraph-sync.json (scopeId → lastSyncAt)。
 */

const fs = require('node:fs');
const path = require('node:path');

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');
const {
  findProjectRoot,
  payloadCwd,
  payloadFilePath,
  scopeId,
  updateJsonFileSync,
  readJson,
} = require('../lib/project-scope.cjs');

const STATE_FILE = process.env.CLAUDE_CG_SYNC_STATE_FILE
  || path.join(HARNESS_ROOT, 'var', 'index', 'codegraph-sync.json');

/** 会话级全量同步的最小间隔 (默认 30 分钟)。 */
const SYNC_INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.CLAUDE_CG_SYNC_INTERVAL_MS || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
})();

/** 单次会话同步的软上限, 超时后停止但保留已写入的部分。 */
const SYNC_BUDGET_MS = (() => {
  const raw = Number.parseInt(process.env.CLAUDE_CG_SYNC_BUDGET_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
})();

function readOnlyMode() {
  return process.env.CLAUDE_HARNESS_NO_PERSIST === '1'
    || process.env.CLAUDE_NO_DIAGNOSTIC_WRITES === '1';
}

const BOM = new RegExp('^' + String.fromCharCode(0xFEFF)); // UTF-8 BOM

function readPayload() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8').replace(BOM, ''); } catch { return {}; }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function lastSyncAt(key) {
  const state = readJson(STATE_FILE, {}) || {};
  const entry = state[key];
  return entry && Number.isFinite(entry.lastSyncAt) ? entry.lastSyncAt : 0;
}

function recordSync(key, rootPath, stats) {
  if (readOnlyMode()) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    updateJsonFileSync(STATE_FILE, {}, (state) => {
      state[key] = {
        rootPath,
        lastSyncAt: Date.now(),
        fileCount: stats?.fileCount ?? null,
        nodeCount: stats?.nodeCount ?? null,
        edgeCount: stats?.edgeCount ?? null,
      };
      return state;
    });
  } catch { /* 节流状态写不进去时退化为每次都同步, 不影响正确性 */ }
}

/**
 * 判断某个根路径是否值得索引。
 * 排除 HOME/系统根这类"整个磁盘"级别的目录 —— 在那上面跑全量遍历会挂死会话。
 */
function indexableRoot(rootPath) {
  if (!rootPath) return false;
  let stat;
  try { stat = fs.statSync(rootPath); } catch { return false; }
  if (!stat.isDirectory()) return false;

  const resolved = path.resolve(rootPath);
  if (path.dirname(resolved) === resolved) return false;          // 盘符根
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home && path.resolve(home) === resolved) return false;      // 用户主目录
  return true;
}

// ── 模式 1: 会话级增量同步 ──────────────────────────────────────────────────

function runSessionSync(payload, opts = {}) {
  const cwd = payloadCwd(payload, process.cwd());
  const rootPath = findProjectRoot(cwd) || cwd;
  if (!indexableRoot(rootPath)) return { synced: false, reason: 'unindexable_root' };

  const key = scopeId(rootPath);
  const now = opts.now || Date.now();
  const { indexFreshness, resolveProject } = require('../cg-queries.cjs');

  const { projectId } = resolveProject(rootPath);
  const freshness = indexFreshness(projectId, { now });
  const sinceLast = now - lastSyncAt(key);

  // 图已新鲜且刚同步过 → 跳过。空图/从未索引则无视节流, 必须先建起来。
  if (freshness.fresh && sinceLast < SYNC_INTERVAL_MS) {
    return { synced: false, reason: 'throttled', sinceLast, projectId };
  }
  if (readOnlyMode()) return { synced: false, reason: 'read_only', projectId };

  const indexer = require('../code-graph-index.cjs');
  const started = Date.now();
  const stats = indexer.cmdSyncProject(rootPath, { quiet: true, budgetMs: SYNC_BUDGET_MS });

  // 超预算中断的部分索引不写节流水位: 图还没建全, 下次会话必须接着建。
  if (!stats.partial) recordSync(key, rootPath, stats);
  const requirements = collectRequirementEdges(rootPath, projectId);

  return {
    synced: true,
    projectId,
    rootPath,
    elapsedMs: Date.now() - started,
    requirementEdges: requirements.linked,
    ...stats,
  };
}

/**
 * 需求门禁 → 文件 (traces_to) 的采集。
 *
 * 放在索引之后而不是门禁里: 建这条边需要文件已经在图里, 而门禁通过的时刻文件
 * 可能还没被索引。link 是 upsert, 因此重复调用无副作用。
 */
function collectRequirementEdges(projectRoot, projectId) {
  try {
    const gateFile = path.join(HARNESS_ROOT, 'var', 'gates', 'requirements-gate.json');
    const state = readJson(gateFile, null);
    if (!state) return { linked: 0 };
    const { collectRequirementEdges: collect } = require('../lib/graph-collectors.cjs');
    return collect(state, { projectId });
  } catch {
    return { linked: 0 };
  }
}

// ── 模式 2: 单文件增量索引 ──────────────────────────────────────────────────

function runFileSync(payload) {
  if (readOnlyMode()) return { indexed: false, reason: 'read_only' };
  const cwd = payloadCwd(payload, process.cwd());
  const filePath = payloadFilePath(payload, cwd);
  if (!filePath) return { indexed: false, reason: 'no_file_path' };

  const indexer = require('../code-graph-index.cjs');
  return indexer.cmdSyncFile(filePath, { quiet: true });
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function main(argv = process.argv.slice(2)) {
  const mode = argv.includes('--file') ? 'file' : 'session';
  const payload = readPayload();
  try {
    const result = mode === 'file' ? runFileSync(payload) : runSessionSync(payload);
    if (process.env.CLAUDE_CG_SYNC_DEBUG === '1') {
      process.stderr.write(`[codegraph-sync:${mode}] ${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    // 索引失败不得影响会话: 只在 debug 时出声
    if (process.env.CLAUDE_CG_SYNC_DEBUG === '1') {
      process.stderr.write(`[codegraph-sync:${mode}] ${error.stack || error.message}\n`);
    }
  }
}

if (require.main === module) main();

module.exports = { main, runSessionSync, runFileSync, indexableRoot, STATE_FILE };
