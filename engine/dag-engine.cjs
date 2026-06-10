'use strict';

/**
 * engine/dag-engine.cjs — DAG 调度引擎。
 *
 * 从 hdl-coding-dag-workflow.js 提取，独立可复用。
 * 支持：拓扑排序 / 分层并行 / 重试 / 超时 / 进度回调。
 *
 * 用法:
 *   const dag = require('./engine/dag-engine.cjs');
 *
 *   const nodes = {
 *     a: { deps: [], run: async (ctx) => 'result-a' },
 *     b: { deps: ['a'], run: async (ctx) => 'result-b' },
 *     c: { deps: ['a'], run: async (ctx) => 'result-c' }, // 与 b 并行
 *     d: { deps: ['b', 'c'], run: async (ctx) => 'result-d' },
 *   };
 *
 *   const results = await dag.execute(nodes, {
 *     onProgress: (layer, total, names) => console.log(`层 ${layer}/${total}: ${names}`),
 *     retryCount: 2,
 *     timeoutMs: 120000,
 *   });
 *
 * 节点定义:
 *   { deps: string[], run: (ctx: object) => Promise<any> }
 *   其中 ctx 包含所有已完成的节点结果（按节点名索引）。
 */

// ── 拓扑排序 ───────────────────────────────────────────────────────────────

/**
 * 对有向无环图进行拓扑排序。
 * @param {Object<string, { deps?: string[] }>} nodes - DAG 节点集合
 * @returns {string[]} 拓扑序的节点名列表
 * @throws {Error} 如果存在循环依赖
 */
function topoSort(nodes) {
  const sorted = [];
  const state = new Map(); // 0=未访问, 1=访问中, 2=已访问

  function visit(name) {
    const s = state.get(name) || 0;
    if (s === 1) throw new Error(`[DAG] 循环依赖: ${name}`);
    if (s === 2) return;
    state.set(name, 1);
    for (const dep of (nodes[name]?.deps || [])) visit(dep);
    state.set(name, 2);
    sorted.push(name);
  }

  for (const name of Object.keys(nodes)) {
    if (!state.has(name)) visit(name);
  }
  return sorted;
}

// ── 分层 ───────────────────────────────────────────────────────────────────

/**
 * 按依赖深度将节点分层。同层节点无相互依赖，可安全并行执行。
 * @param {Object<string, { deps?: string[] }>} nodes
 * @returns {string[][]} 层数组，layers[0] 为无依赖的根节点
 * @throws {Error} 如果存在循环依赖
 */
function layerize(nodes) {
  const order = topoSort(nodes);
  const depth = {};

  for (const name of order) {
    const deps = nodes[name]?.deps || [];
    depth[name] = deps.length === 0 ? 0 : Math.max(...deps.map(d => (depth[d] ?? -1) + 1));
  }

  const layers = [];
  for (const name of order) {
    const d = depth[name];
    if (!layers[d]) layers[d] = [];
    layers[d].push(name);
  }

  return layers;
}

// ── 带重试的执行器 ─────────────────────────────────────────────────────────

/**
 * 执行单个 DAG 节点，支持重试和超时。
 * @param {string} name - 节点名
 * @param {Function} run - 节点执行函数: (ctx) => Promise<any>
 * @param {object} ctx - 当前上下文（所有已完成节点的结果）
 * @param {object} [opts]
 * @param {number} [opts.retryCount=0] - 失败重试次数（默认 0 = 不重试）
 * @param {number} [opts.timeoutMs=0] - 超时毫秒（默认 0 = 无超时）
 * @param {(msg: string) => void} [opts.log] - 日志回调
 * @returns {Promise<{ status: string, data?: any, error?: string, attempts: number }>}
 */
async function runNode(name, run, ctx, opts = {}) {
  const { retryCount = 0, timeoutMs = 0 } = opts;
  const log = opts.log || (() => {});
  const maxAttempts = retryCount + 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let timeoutHandle;
      const runPromise = run(ctx);

      const result = timeoutMs > 0
        ? await Promise.race([
            runPromise,
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error(`[DAG] ${name} 超时 (${timeoutMs}ms)`)), timeoutMs);
            }),
          ])
        : await runPromise;

      clearTimeout(timeoutHandle);
      return { status: 'ok', data: result, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        log(`  ⚠ ${name} 第 ${attempt} 次失败: ${err.message.slice(0, 80)}，重试...`);
      }
    }
  }

  return { status: 'fail', error: lastError.message, attempts: maxAttempts };
}

// ── DAG 执行 ────────────────────────────────────────────────────────────────

/**
 * 全 DAG 执行：分层 → 逐层并行 → 返回结果。
 *
 * @param {Object<string, { deps: string[], run: (ctx: object) => Promise<any> }>} nodes
 * @param {object} [opts]
 * @param {number} [opts.retryCount=0] - 节点失败重试次数
 * @param {number} [opts.timeoutMs=0] - 单节点超时
 * @param {boolean} [opts.failFast=true] - true=某节点失败立即中止，false=尽量执行完
 * @param {(layer: number, total: number, names: string) => void} [opts.onProgress]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{
 *   success: boolean,
 *   results: Object<string, { status: string, data?: any, error?: string, attempts: number }>,
 *   layerCount: number,
 *   nodeCount: number,
 *   failedNodes: string[]
 * }>}
 */
async function execute(nodes, opts = {}) {
  const { failFast = true, retryCount = 0, timeoutMs = 0 } = opts;
  const log = opts.log || (() => {});
  const onProgress = opts.onProgress || (() => {});

  const layers = layerize(nodes);
  const ctx = {};
  const results = {};
  const failedNodes = [];
  const nodeCount = Object.keys(nodes).length;
  const layerCount = layers.length;

  log(`[DAG] ${nodeCount} 节点, ${layerCount} 层`);

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const names = layer.join(', ');
    onProgress(i + 1, layers.length, names);
    log(`[DAG] 层 ${i + 1}/${layers.length}: ${names}`);

    const layerResults = await Promise.all(
      layer.map(async (name) => {
        const node = nodes[name];
        const result = await runNode(name, node.run, ctx, { retryCount, timeoutMs, log });
        results[name] = result;
        ctx[name] = result.status === 'ok' ? result.data : null;
        return { name, result };
      })
    );

    const failures = layerResults.filter(r => r.result.status !== 'ok');
    for (const f of failures) {
      failedNodes.push(f.name);
      log(`  ❌ ${f.name}: ${f.result.error}`);
    }

    if (failFast && failedNodes.length > 0) {
      throw new Error(`[DAG] 层 ${i + 1} 节点失败: ${failedNodes.join(', ')}`);
    }
  }

  return {
    success: failedNodes.length === 0,
    results,
    layerCount,
    nodeCount,
    failedNodes,
  };
}

module.exports = { topoSort, layerize, runNode, execute };
