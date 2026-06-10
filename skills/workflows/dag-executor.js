/**
 * skills/workflows/dag-executor.js — DAG 执行器原型。
 *
 * 设计为可嵌入 Workflow() 脚本的工具函数。
 * Workflow() 环境提供: agent(), parallel(), pipeline(), phase(), log()
 *
 * 用法 (嵌入 Workflow 脚本):
 *
 *   const { runDag } = require('./skills/workflows/dag-executor.js');
 *   // 或在 Workflow 中直接内联 runDag 函数体
 *
 *   const dag = {
 *     nodes: {
 *       arch:    { run: () => agent('架构设计'), deps: [] },
 *       fixedpt: { run: () => agent('定点量化'), deps: ['arch'] },
 *       tb:      { run: () => agent('Testbench'), deps: ['arch'] },
 *       rtl:     { run: () => agent('RTL编码'), deps: ['fixedpt', 'tb'] },
 *       verify:  { run: () => agent('验证结果'), deps: ['rtl'] },
 *     }
 *   };
 *   const results = await runDag(dag);
 */

/**
 * 拓扑排序: 返回节点执行顺序 (已按依赖排序)。
 * 如果存在循环依赖则抛出错误。
 */
function topoSort(nodes) {
  const sorted = [];
  const visited = new Set(); // 0=未访问, 1=访问中, 2=已完成
  const state = new Map();

  function visit(name) {
    const s = state.get(name) || 0;
    if (s === 1) throw new Error(`DAG 循环依赖: ${name}`);
    if (s === 2) return;
    state.set(name, 1);
    const node = nodes[name];
    if (!node) throw new Error(`DAG 节点未定义: ${name}`);
    for (const dep of node.deps || []) {
      visit(dep);
    }
    state.set(name, 2);
    sorted.push(name);
  }

  for (const name of Object.keys(nodes)) {
    if (!state.has(name)) visit(name);
  }

  return sorted;
}

/**
 * 按拓扑序将节点分组为"层"。
 * 同一层的节点可并行执行。
 *
 * @param {object} nodes - { name: { run: fn, deps: string[] } }
 * @returns {string[][]} 层数组, 每层是节点名数组
 */
function layerize(nodes) {
  const order = topoSort(nodes);
  const depth = {};

  for (const name of order) {
    const node = nodes[name];
    const deps = node.deps || [];
    if (deps.length === 0) {
      depth[name] = 0;
    } else {
      depth[name] = Math.max(...deps.map(d => (depth[d] ?? -1) + 1));
    }
  }

  // 按深度分组
  const layers = [];
  for (const name of order) {
    const d = depth[name];
    if (!layers[d]) layers[d] = [];
    layers[d].push(name);
  }

  return layers;
}

/**
 * 在 Workflow 脚本中运行 DAG。
 * 返回 { results: { nodeName: agentResult }, elapsed: number }
 *
 * @param {object} dag
 * @param {object} dag.nodes - { name: { run: () => Promise<any>, deps: string[] } }
 * @param {object} [opts]
 * @param {string} [opts.phasePrefix] - phase 命名前缀 (用于 phase() 调用)
 * @param {boolean} [opts.verbose] - 是否打印详细日志
 */
async function runDag(dag, opts = {}) {
  const prefix = opts.phasePrefix || 'dag';
  const layers = layerize(dag.nodes);
  const results = {};
  const start = Date.now();

  // 逐层执行 (同层并行)
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];

    if (typeof phase === 'function') {
      phase(`${prefix}-layer-${i + 1}`);
    }
    if (typeof log === 'function' && opts.verbose !== false) {
      log(`[DAG] 层 ${i + 1}/${layers.length}: ${layer.join(', ')}`);
    }

    // 同层并行运行
    const layerResults = await Promise.all(
      layer.map(async (name) => {
        try {
          const node = dag.nodes[name];
          // 向 agent() 传递上游结果 (通过 context)
          const result = await node.run(results);
          results[name] = { status: 'ok', data: result, error: null };
          return { name, status: 'ok' };
        } catch (err) {
          results[name] = { status: 'failed', data: null, error: err.message };
          if (typeof log === 'function') {
            log(`[DAG] ❌ ${name}: ${err.message}`);
          }
          return { name, status: 'failed', error: err.message };
        }
      }),
    );

    // 检查是否有失败 (可选停止)
    const failures = layerResults.filter(r => r.status === 'failed');
    if (failures.length > 0 && dag.failFast) {
      const msgs = failures.map(f => `${f.name}: ${f.error}`).join('; ');
      throw new Error(`[DAG] 层 ${i + 1} 失败: ${msgs}`);
    }
  }

  return {
    results,
    elapsed: Date.now() - start,
    layerCount: layers.length,
    nodeCount: Object.keys(dag.nodes).length,
  };
}

/**
 * 生成 Verifier DAG 节点。
 * 在 DAG 末尾追加验证步骤。
 *
 * @param {string} task - 原始任务描述
 * @param {string[]} dependsOn - 依赖的上游节点名
 * @param {object} [opts]
 * @param {string} [opts.model] - 验证模型
 * @returns {{ run: () => Promise<any>, deps: string[] }}
 */
function verifierNode(task, dependsOn, opts = {}) {
  return {
    deps: dependsOn,
    run: async (results) => {
      // 收集所有上游结果
      const summaries = Object.entries(results)
        .filter(([name]) => dependsOn.includes(name))
        .map(([name, r]) => `## ${name}\n${r.status === 'ok' ? String(r.data).slice(0, 1000) : 'FAILED: ' + r.error}`)
        .join('\n\n');

      const prompt = [
        '你是一个**校验者**。审以下任务的多步执行结果是否真正满足任务要求。',
        '逐条检查任务中的明确要求，判定结果是否满足。',
        '',
        '## 原始任务',
        task,
        '',
        '## 执行结果',
        summaries,
        '',
        '输出 JSON: { "pass": true/false, "reason": "fail时说明缺哪条要求" }',
      ].join('\n');

      if (typeof agent === 'function') {
        return agent(prompt, {
          label: 'verifier',
          ...(opts.model ? { model: opts.model } : {}),
        });
      }
      return prompt;
    },
  };
}

// ── 导出 ─────────────────────────────────────────────────────────────────

module.exports = {
  topoSort,
  layerize,
  runDag,
  verifierNode,
};
