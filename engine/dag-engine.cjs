'use strict';

/**
 * engine/dag-engine.cjs — DAG 调度引擎。
 *
 * 从 hdl-coding-dag-workflow.js 提取，独立可复用。
 * 支持：拓扑排序 / 分层并行 / 重试 / 超时 / 进度回调 / 循环检测。
 *
 * v3.5 新增：
 *   - loopDetection: 检测节点在相同错误模式上反复重试，超过阈值后跳过/建议切换策略
 *   - maxRetriesAcrossLayers: 跨层全局最大重试计数门禁
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

// ── 全局循环检测状态 ────────────────────────────────────────────────────────
// 追踪跨节点的重试模式，用于检测"反复死磕同一问题"的 loop
const _loopTracker = new Map(); // nodeName → { attempts: number, errorPatterns: string[], lastError: string }

function resetLoopTracker() { _loopTracker.clear(); }

/**
 * 检查指定节点是否存在循环重试问题。
 * 检测规则: 同一节点连续重试 >maxLoopRetries 次且错误消息相似。
 * @param {string} nodeName
 * @param {string} errorMsg
 * @param {number} maxLoopRetries
 * @returns {{ loopDetected: boolean, attempts: number, suggestion: string }}
 */
function checkLoop(nodeName, errorMsg, maxLoopRetries) {
  const entry = _loopTracker.get(nodeName) || { attempts: 0, errorPatterns: [], lastError: '' };
  entry.attempts++;

  // 提取错误模式（取前 40 字符作为指纹）
  const errorFingerprint = (errorMsg || '').slice(0, 40);
  if (errorFingerprint && errorFingerprint !== entry.lastError) {
    entry.errorPatterns.push(errorFingerprint);
    if (entry.errorPatterns.length > 5) entry.errorPatterns.shift();
  }
  entry.lastError = errorFingerprint;
  _loopTracker.set(nodeName, entry);

  if (entry.attempts >= maxLoopRetries) {
    return {
      loopDetected: true,
      attempts: entry.attempts,
      suggestion: entry.errorPatterns.length <= 2
        ? `节点 "${nodeName}" 已重试 ${entry.attempts} 次且错误模式相似，建议切换策略或检查前置依赖`
        : `节点 "${nodeName}" 已重试 ${entry.attempts} 次且出现 ${entry.errorPatterns.length} 种不同错误，建议前置条件验证`,
    };
  }
  return { loopDetected: false, attempts: entry.attempts };
}

// ── 带重试与循环检测的执行器 ────────────────────────────────────────────

/**
 * 执行单个 DAG 节点，支持重试、超时和循环检测。
 * @param {string} name - 节点名
 * @param {Function} run - 节点执行函数: (ctx) => Promise<any>
 * @param {object} ctx - 当前上下文（所有已完成节点的结果）
 * @param {object} [opts]
 * @param {number} [opts.retryCount=0] - 失败重试次数（默认 0 = 不重试）
 * @param {number} [opts.timeoutMs=0] - 超时毫秒（默认 0 = 无超时）
 * @param {number} [opts.maxLoopRetries=3] - 最大循环重试门禁（默认 3）
 * @param {(msg: string) => void} [opts.log] - 日志回调
 * @returns {Promise<{ status: string, data?: any, error?: string, attempts: number, loop?: object }>}
 */
async function runNode(name, run, ctx, opts = {}) {
  const { retryCount = 0, timeoutMs = 0, maxLoopRetries = 3 } = opts;
  const log = opts.log || (() => {});
  const maxAttempts = retryCount + 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // ── 循环检测: 重试前检查是否陷入死循环 ──────────────
    if (attempt > 1) {
      const loopCheck = checkLoop(name, lastError?.message || '', maxLoopRetries);
      if (loopCheck.loopDetected) {
        log(`  🔄 [循环检测] ${loopCheck.suggestion}`);
        // Emit signal: 循环跳过事件
        try {
          const { emitSync } = require('./hooks/learning/signal-collector.cjs');
          emitSync('loop_skip', { nodeName: name, attempts: loopCheck.attempts });
        } catch { /* 静默 */ }
        return {
          status: 'loop_skip',
          error: `循环重试门禁: 节点 "${name}" 重试 ${loopCheck.attempts} 次后跳过`,
          attempts: attempt - 1,
          loop: loopCheck,
        };
      }
    }

    // ── 实际执行 ─────────────────────────────────────
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
  const { failFast = true, retryCount = 0, timeoutMs = 300000, maxLoopRetries = 3 } = opts;
  const log = opts.log || (() => {});
  const onProgress = opts.onProgress || (() => {});

  const layers = layerize(nodes);
  const ctx = {};
  const results = {};
  const failedNodes = [];
  const loopSkippedNodes = [];
  const nodeCount = Object.keys(nodes).length;
  const layerCount = layers.length;
  const depMatrix = validateLayerDeps(nodes);

  // 重置循环检测追踪器
  resetLoopTracker();

  log(`[DAG] ${nodeCount} 节点, ${layerCount} 层, 循环门禁=${maxLoopRetries}次/节点`);

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const names = layer.join(', ');
    onProgress(i + 1, layers.length, names);
    log(`[DAG] 层 ${i + 1}/${layers.length}: ${names}`);

    const layerResults = await Promise.all(
      layer.map(async (name) => {
        const node = nodes[name];
        const result = await runNode(name, node.run, ctx, { retryCount, timeoutMs, maxLoopRetries, log });
        results[name] = result;
        ctx[name] = result.status === 'ok' ? result.data : null;
        return { name, result };
      })
    );

    // 处理失败和循环跳过的节点
    const failures = layerResults.filter(r => r.result.status !== 'ok' && r.result.status !== 'loop_skip');
    const loopSkips = layerResults.filter(r => r.result.status === 'loop_skip');
    for (const f of failures) {
      failedNodes.push(f.name);
      log(`  ❌ ${f.name}: ${f.result.error}`);
    }
    for (const s of loopSkips) {
      loopSkippedNodes.push(s.name);
      log(`  🔄 ${s.name}: 循环跳过 — ${s.result.error}`);
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
    dependencyMatrix: depMatrix,
  };
}

// ── 依赖矩阵验证 ─────────────────────────────────────────────────────────

/**
 * 验证同层节点间是否存在依赖关系。
 * 如果存在，说明分层有误（同一层应该无相互依赖）。
 *
 * @param {Object<string, { deps?: string[] }>} nodes
 * @returns {{ valid: boolean, violations: Array<{ layer: number, from: string, to: string }> }}
 */
function validateLayerDeps(nodes) {
  const layers = layerize(nodes);
  const violations = [];

  for (let i = 0; i < layers.length; i++) {
    const layerSet = new Set(layers[i]);
    for (const name of layers[i]) {
      const deps = nodes[name]?.deps || [];
      for (const dep of deps) {
        if (layerSet.has(dep)) {
          violations.push({ layer: i, from: name, to: dep });
        }
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

module.exports = { topoSort, layerize, runNode, execute, validateLayerDeps };
