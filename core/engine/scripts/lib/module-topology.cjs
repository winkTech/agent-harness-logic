'use strict';

/**
 * engine/scripts/lib/module-topology.cjs — 从代码图推导模块验证顺序。
 *
 * 解决的问题: hdl-coding-dag-workflow 的 moduleOrder 一直是**调用方手写**的
 * (`args.moduleOrder || modules`)。整条 cascade 门禁 (上游没过就不调下游) 都
 * 建立在这个顺序正确的前提上, 而顺序写错时没有任何东西会报错 —— 门禁会安静地
 * 按错误的上下游关系放行/拦截。
 *
 * 能从图里诚实推导出来的是**层次序**: 被例化的模块必须先于例化它的模块通过验证
 * (改子模块会让父模块的验证失效, 反之不成立)。
 *
 * 推导不出来的是**兄弟模块之间的数据流序**: 同一个父模块下的 tx_mapper 与
 * tx_ifft 在例化图上没有先后关系, 谁先谁后要看端口连线, 而当前解析器只有
 * instantiates/contains/writes 三类边, 不足以还原数据流。因此本模块对兄弟模块
 * **保留调用方给定的相对顺序**, 只在图上确有约束的地方纠正 —— 稳定拓扑排序。
 *
 * 边的形状 (实测): instantiates 从**实例节点**指向模块节点
 *   mid --contains--> u_leaf --instantiates--> leaf
 * 所以模块间依赖要穿透 contains 才能得到 mid → leaf。
 */

const { openDb } = require('../../sqlite/index.cjs');

/**
 * 构建"模块 → 它直接例化的模块集合"。
 *
 * @param {string} projectId
 * @param {object} [opts]
 * @param {object} [opts.db]
 * @returns {{ deps: Map<string, Set<string>>, moduleNames: Set<string> }}
 */
function buildModuleDeps(projectId, opts = {}) {
  const db = opts.db || openDb().db;
  const deps = new Map();
  const moduleNames = new Set();

  for (const row of db.prepare(
    "SELECT name FROM cg_nodes WHERE project_id = ? AND kind = 'module'",
  ).all(projectId)) {
    moduleNames.add(row.name);
    if (!deps.has(row.name)) deps.set(row.name, new Set());
  }

  // parent 模块 --contains--> 实例 --instantiates--> child 模块
  const rows = db.prepare(`
    SELECT parent.name AS parent, child.name AS child
    FROM cg_edges inst
    JOIN cg_nodes child     ON child.id = inst.target_id
    JOIN cg_edges own       ON own.target_id = inst.source_id AND own.kind = 'contains'
    JOIN cg_nodes parent    ON parent.id = own.source_id
    WHERE inst.kind = 'instantiates'
      AND inst.project_id = ?
      AND parent.kind = 'module'
      AND child.kind = 'module'
  `).all(projectId);

  for (const row of rows) {
    if (row.parent === row.child) continue; // 自例化: 递归模块或解析噪声, 不构成顺序约束
    if (!deps.has(row.parent)) deps.set(row.parent, new Set());
    deps.get(row.parent).add(row.child);
    moduleNames.add(row.parent);
    moduleNames.add(row.child);
  }

  return { deps, moduleNames };
}

/**
 * 稳定拓扑排序: 子模块先于父模块; 图上无约束的模块保持输入顺序。
 *
 * @param {string[]} modules — 调用方给定的模块列表 (顺序即兄弟模块的期望顺序)
 * @param {Map<string, Set<string>>} deps — 模块 → 它例化的模块
 * @returns {{ order: string[], cycles: string[][] }}
 */
function stableTopoSort(modules, deps) {
  const inScope = new Set(modules);
  const order = [];
  const state = new Map(); // 0=未访问 1=访问中 2=完成
  const cycles = [];

  function visit(name, path) {
    const current = state.get(name) || 0;
    if (current === 2) return;
    if (current === 1) {
      // 环: 记录下来, 但不抛 —— 递归/互例化的设计确实存在, 报告比崩掉有用
      const start = path.indexOf(name);
      cycles.push(path.slice(start >= 0 ? start : 0).concat(name));
      return;
    }
    state.set(name, 1);
    // 依赖 (被例化者) 先走, 且只在给定范围内排序
    const children = [...(deps.get(name) || [])].filter(child => inScope.has(child));
    // 子模块之间同样按调用方给定的相对顺序, 保证结果稳定可复现
    children.sort((a, b) => modules.indexOf(a) - modules.indexOf(b));
    for (const child of children) visit(child, path.concat(name));
    state.set(name, 2);
    order.push(name);
  }

  for (const name of modules) visit(name, []);
  return { order, cycles };
}

/**
 * 由代码图推导模块验证顺序。
 *
 * @param {string} projectId
 * @param {string[]} modules
 * @param {object} [opts]
 * @returns {{
 *   order: string[], cycles: string[][], unknown: string[],
 *   constrained: Array<{ parent: string, child: string }>, derivable: boolean
 * }}
 */
function deriveModuleOrder(projectId, modules, opts = {}) {
  const list = Array.isArray(modules) ? modules.filter(Boolean) : [];
  const { deps, moduleNames } = buildModuleDeps(projectId, opts);

  // 图里根本没有的模块: 尚未编码, 或名字对不上 —— 必须显式报出来, 不能假装排好了
  const unknown = list.filter(name => !moduleNames.has(name));

  const { order, cycles } = stableTopoSort(list, deps);

  const constrained = [];
  for (const parent of list) {
    for (const child of deps.get(parent) || []) {
      if (list.includes(child)) constrained.push({ parent, child });
    }
  }

  return {
    order,
    cycles,
    unknown,
    constrained,
    // 图上一条约束都没有 = 推导不出任何东西, 调用方的顺序原样保留
    derivable: constrained.length > 0,
  };
}

/**
 * 校验调用方给定的顺序是否与代码图矛盾。
 *
 * 矛盾的定义只有一种: 父模块排在它例化的子模块**之前**。改子模块会让父模块的
 * 验证失效, 因此先验父再验子, cascade 门禁就会用过期的上游结论放行下游。
 *
 * @param {string} projectId
 * @param {string[]} providedOrder
 * @param {object} [opts]
 * @returns {{ ok: boolean, contradictions: Array<object>, suggestion: string[], unknown: string[], cycles: string[][] }}
 */
function validateModuleOrder(projectId, providedOrder, opts = {}) {
  const list = Array.isArray(providedOrder) ? providedOrder.filter(Boolean) : [];
  const derived = deriveModuleOrder(projectId, list, opts);
  const position = new Map(list.map((name, index) => [name, index]));

  const contradictions = [];
  for (const { parent, child } of derived.constrained) {
    const parentAt = position.get(parent);
    const childAt = position.get(child);
    if (parentAt === undefined || childAt === undefined) continue;
    if (parentAt < childAt) {
      contradictions.push({
        parent,
        child,
        detail: `${parent} 例化了 ${child}, 但排在它前面 (第 ${parentAt + 1} 位 vs 第 ${childAt + 1} 位)`
          + ' —— 先验父模块会拿子模块的旧结论过 cascade 门禁',
      });
    }
  }

  return {
    ok: contradictions.length === 0,
    contradictions,
    suggestion: derived.order,
    unknown: derived.unknown,
    cycles: derived.cycles,
  };
}

/**
 * 改动一批模块后, 哪些模块需要重验 (含自身)。
 * 直接复用影响面查询, 因此同样遵守"索引不新鲜就失败关闭"。
 *
 * @param {string} projectId
 * @param {string[]} changedModules
 * @param {object} [opts]
 * @returns {{ modules: string[], staleIndex: boolean, staleReason: string|null }}
 */
function impactedModules(projectId, changedModules, opts = {}) {
  const { getBlastRadius } = require('../cg-queries.cjs');
  const result = new Set();
  let staleIndex = false;
  let staleReason = null;

  for (const name of changedModules || []) {
    const radius = getBlastRadius(projectId, name, { depth: opts.depth || 4, limit: opts.limit || 60 });
    if (radius.staleIndex) {
      staleIndex = true;
      staleReason = radius.staleReason;
      break;
    }
    result.add(name);
    for (const item of radius.downstream) {
      if (item.kind === 'module') result.add(item.name);
    }
  }

  return staleIndex
    ? { modules: [], staleIndex: true, staleReason }
    : { modules: [...result], staleIndex: false, staleReason: null };
}

module.exports = {
  buildModuleDeps,
  stableTopoSort,
  deriveModuleOrder,
  validateModuleOrder,
  impactedModules,
};
