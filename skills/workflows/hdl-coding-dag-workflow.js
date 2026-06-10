/**
 * hdl-coding-dag-workflow — HDL RTL 开发 DAG 工作流。
 *
 * 与 skills/workflows/hdl-coding-workflow.md 的 8 阶段对应,
 * 但用 DAG 结构表达依赖关系, 使独立阶段可并行执行。
 *
 * 调用:
 *   Workflow({name: 'hdl-coding-dag-workflow', args: { modules: ['scrambler', 'descrambler'] }})
 *
 * DAG 结构:
 *   Layer 0: Phase 0  基础设施
 *   Layer 1: Phase 1  架构设计
 *   Layer 2: Phase 2  定点量化 + Phase 3 TB-First (并行)
 *   Layer 3: Phase 4  增量 RTL
 *   Layer 4: Phase 5  回归覆盖 + Phase 6 代码审查 (并行)
 *   Layer 5: Phase 7  报告输出 + Verifier
 */

export const meta = {
  name: 'hdl-coding-dag-workflow',
  description: 'HDL RTL 开发 DAG 工作流 — 并行架构/定点/TB → 增量RTL → 回归+审查 (Verifier 终验)',
  phases: [
    { title: 'Phase 0 基础设施' },
    { title: 'Phase 1 架构设计' },
    { title: 'Phase 2+3 定点+TB (并行)' },
    { title: 'Phase 4 增量 RTL' },
    { title: 'Phase 5+6 回归+审查 (并行)' },
    { title: 'Phase 7 报告+Verifier' },
  ],
};

// ── DAG 引擎（独立模块）────────────────────────────────────────────────────
// 由 engine/dag-engine.cjs 提供拓扑排序/分层/重试/超时

const dag = require('../../engine/dag-engine.cjs');

// ── 主流程 ─────────────────────────────────────────────────────────────────

const modules = args?.modules || [];

phase('Phase 0 基础设施');
log(`模块: ${modules.length > 0 ? modules.join(', ') : '未指定 (使用项目默认)'}`);

// 定义 DAG 节点
// 每个节点: { deps: string[], run: (上游结果) => Promise<输出> }
const nodes = {};

// Phase 0: 基础设施 (无依赖)
nodes.p0_infra = {
  deps: [],
  run: async () => {
    const result = await agent(`执行 HDL 工作流 Phase 0:
1. 检查/创建 Makefile, .f 文件列表
2. 验证 make lint / make compile 可用
3. 确认 EDA 工具链就绪

模块: ${modules.join(', ') || '项目默认'}
输出检查清单:
- Makefile 存在且 lint/compile/sim 目标完整
- .f 文件列出所有源文件
- make lint 通过`, { label: 'p0-infra' });
    return result;
  },
};

// Phase 1: 架构设计
nodes.p1_arch = {
  deps: ['p0_infra'],
  run: async (ctx) => {
    const infra = ctx.p0_infra?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 1: 架构设计

前提: 基础设施已就绪
${String(infra).slice(0, 300)}

任务:
1. 算法文档化 + 顶层框图
2. 模块↔MATLAB Golden Model 对标
3. 每模块方案规格 (端口/时序/接口)

模块: ${modules.join(', ') || '项目默认'}
输出: algorithm_spec + 顶层框图文档`, { label: 'p1-architecture' });
    return result;
  },
};

// Phase 2: 定点量化 (依赖 Phase 1)
nodes.p2_fixedpt = {
  deps: ['p1_arch'],
  run: async (ctx) => {
    const arch = ctx.p1_arch?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 2: 定点量化

架构设计: ${String(arch).slice(0, 300)}

任务:
1. 位宽扫描 (MATLAB Golden Model)
2. bit-true 定点模型
3. DSP/LUT/BRAM 预算表

模块: ${modules.join(', ') || '项目默认'}
输出: fixed_point_report + resource_estimate`, { label: 'p2-fixed-point' });
    return result;
  },
};

// Phase 3: TB-First (依赖 Phase 1, 与 Phase 2 并行)
nodes.p3_tb = {
  deps: ['p1_arch'],
  run: async (ctx) => {
    const arch = ctx.p1_arch?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 3: Testbench-First

架构设计: ${String(arch).slice(0, 300)}

任务:
1. 自检 Testbench
2. SVA 断言
3. 结构化日志 + 波形配置

模块: ${modules.join(', ') || '项目默认'}
输出: TB 编译通过, 自检逻辑完整`, { label: 'p3-testbench' });
    return result;
  },
};

// Phase 4: 增量 RTL (依赖 Phase 2 + Phase 3)
nodes.p4_rtl = {
  deps: ['p2_fixedpt', 'p3_tb'],
  run: async (ctx) => {
    const fixedpt = ctx.p2_fixedpt?.data || '';
    const tb = ctx.p3_tb?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 4: 增量 RTL

定点报告: ${String(fixedpt).slice(0, 300)}
Testbench: ${String(tb).slice(0, 300)}

任务:
1. Layer 0-4 分层验证
2. Stub 机制
3. 双通道日志 + 仿真轮询

📐 优先参考 skills/hdl-coding/templates/ 中的现成模板:
   comm/  : delay_sync.v, ram_2port.v
   alu/   : carry_lookahead_4bit.v, alu_16bit_7func.v, alu_4bit_16func.v
   internet/: crc.sv, crc32.v, hash_table.v, lru_counter.v, cam_cell.v,
             frame_sync.v, crossbar_cell.v, sm4_round.v

模块: ${modules.join(', ') || '项目默认'}
约束: [MUST] 输入寄存器 ri_ / 输出寄存器 ro_ / 同步复位
输出: Layer 0-4 依次通过, 日志无 FAIL`, { label: 'p4-rtl' });
    return result;
  },
};

// Phase 5: 回归覆盖率 (依赖 Phase 4)
nodes.p5_regression = {
  deps: ['p4_rtl'],
  run: async (ctx) => {
    const rtl = ctx.p4_rtl?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 5: 回归覆盖率

RTL 实现: ${String(rtl).slice(0, 300)}

任务:
1. make regress 全量回归
2. covergroup 全部触发
3. mandatory 覆盖点 100%

输出: make regress 全绿`, { label: 'p5-regression' });
    return result;
  },
};

// Phase 6: 代码审查 (依赖 Phase 4, 与 Phase 5 并行)
nodes.p6_review = {
  deps: ['p4_rtl'],
  run: async (ctx) => {
    const rtl = ctx.p4_rtl?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 6: 代码审查

RTL 实现: ${String(rtl).slice(0, 300)}

审查维度:
1. 时序安全 (输入寄存/输出寄存/CDC)
2. 命名规范 (ri_/ro_/i_/o_)
3. 状态机 (三段式 + default)
4. Lint 门禁 (make lint pass)
5. 位宽匹配

输出: 审查报告 PASS/FAIL + 修改建议`, { label: 'p6-code-review' });
    return result;
  },
};

// Phase 7: 报告 + Verifier (依赖 Phase 5 + Phase 6)
nodes.p7_report = {
  deps: ['p5_regression', 'p6_review'],
  run: async (ctx) => {
    const regression = ctx.p5_regression?.data || '';
    const review = ctx.p6_review?.data || '';
    const result = await agent(`生成 HDL 工作流 Phase 7: 总结报告

回归结果: ${String(regression).slice(0, 300)}
审查结果: ${String(review).slice(0, 300)}

输出:
1. 汇总实现报告
2. 文档归档
3. 经验记录`, { label: 'p7-report' });
    return result;
  },
};

// Verifier (终验节点)
nodes.verifier = {
  deps: ['p7_report'],
  run: async (ctx) => {
    const report = ctx.p7_report?.data || '';
    // 汇总所有下游结果供 Verifier 审阅
    const summary = [
      '## Phase 0 基础设施', ctx.p0_infra?.data || 'N/A',
      '## Phase 1 架构设计', ctx.p1_arch?.data || 'N/A',
      '## Phase 2 定点量化', ctx.p2_fixedpt?.data || 'N/A',
      '## Phase 3 Testbench', ctx.p3_tb?.data || 'N/A',
      '## Phase 4 增量 RTL', ctx.p4_rtl?.data || 'N/A',
      '## Phase 5 回归', ctx.p5_regression?.data || 'N/A',
      '## Phase 6 审查', ctx.p6_review?.data || 'N/A',
      '## Phase 7 报告', report,
    ].join('\n\n');

    const result = await agent(`你是一个**跨阶段校验者**。审以下 HDL 开发工作流的全链路结果是否完整满足要求。

逐条检查:
1. 所有 8 个 Phase 是否都有输出
2. Phase 4 (RTL) 是否满足 [MUST] 约束: 输入寄存/输出寄存/同步复位
3. Phase 5 (回归) 是否通过
4. Phase 6 (审查) 是否通过
5. 是否适用于模块: ${modules.join(', ') || '项目默认'}

结果摘要:
${summary.slice(0, 3000)}

输出 JSON:
{
  "pass": true/false,
  "reason": "fail 时说明缺哪条要求",
  "missing": ["缺失项列表"],
  "strongest_phase": "表现最好的阶段",
  "weakest_phase": "需改进的阶段"
}`, { label: 'verifier' });
    return result;
  },
};

// ── 执行 DAG ──────────────────────────────────────────────────────────────

const dagResult = await dag.execute(nodes, {
  onProgress: (layer, total, names) => log(`[层 ${layer}/${total}] ${names}`),
  log,
});

// ── 输出摘要 ──────────────────────────────────────────────────────────────
const verifierOutput = dagResult.results.verifier?.data || '';
log('=== DAG 工作流完成 ===');

// 尝试解析 verifier JSON
try {
  const parsed = typeof verifierOutput === 'string' ? JSON.parse(verifierOutput) : verifierOutput;
  if (parsed.pass) {
    log(`✅ Verifier: 通过 — ${parsed.reason || ''}`);
  } else {
    log(`❌ Verifier: 不通过 — ${parsed.reason || ''}`);
    if (parsed.missing) log(`缺失: ${parsed.missing.join(', ')}`);
  }
} catch {
  log('Verifier 输出 (raw): ' + String(verifierOutput).slice(0, 500));
}

return {
  nodeCount: dagResult.nodeCount,
  layerCount: dagResult.layerCount,
  results: Object.fromEntries(
    Object.entries(dagResult.results).map(([k, v]) => [k, { status: v.status }])
  ),
  verifier: verifierOutput,
};
