/**
 * hdl-coding-dag-workflow — HDL RTL 开发 DAG 工作流 v3.3.0。
 *
 * 与 skills/workflows/hdl-coding-workflow.md 的 9 阶段对应。
 *
 * [MUST 硬约束] RTL 验证流程:
 *   Phase 4: 逐模块 RTL + MATLAB 验证 — 每模块写完后必须仿真对比 golden,
 *            通过后才能继续下一模块
 *   Phase 5: 顶层集成 + 全链仿真 — 所有子模块通过 Phase 4 后,
 *            搭建顶层, 全链逐级与 golden model 对比
 *
 * 调用:
 *   Workflow({name: 'hdl-coding-dag-workflow', args: { modules: ['scrambler', 'descrambler'] }})
 *
 * DAG 结构:
 *   Layer 0: Phase 0  基础设施
 *   Layer 1: Phase 1  架构设计 (+ 产 architecture.yaml)
 *   Layer 2: Phase 2  定点量化
 *   Layer 3: Phase 3  TB + MATLAB 向量生成
 *   Layer 4: Phase 4  逐模块 RTL + MATLAB 验证 [硬约束]
 *   Layer 5: Phase 5  顶层集成 + 全链仿真 [硬约束]
 *   Layer 6: Phase 6  回归覆盖率 (真跑 compile/sim)
 *   Layer 7: Phase 7  代码审查 (含模型一致性检查)
 *   Layer 8: Phase 8  报告输出 + Verifier (含验证矩阵检查)
 */

export const meta = {
  name: 'hdl-coding-dag-workflow',
  description: 'HDL RTL 开发 DAG 工作流 v3.3 — 逐模块RTL+MATLAB验证 → 顶层全链仿真 → 回归+审查 (Verifier终验)',
  phases: [
    { title: 'Phase 0 基础设施' },
    { title: 'Phase 1 架构设计' },
    { title: 'Phase 2 定点量化' },
    { title: 'Phase 3 TB+向量生成' },
    { title: 'Phase 4 逐模块RTL+MATLAB验证' },
    { title: 'Phase 5 顶层集成+全链仿真' },
    { title: 'Phase 6 回归覆盖率' },
    { title: 'Phase 7 代码审查' },
    { title: 'Phase 8 报告+Verifier' },
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
4. 输出 architecture.yaml (结构化模块清单), 包含:
   - 模块名 / 类型 / MATLAB 参考函数
   - 模块间数据流关系
5. 模块对称对分析:
   - 扫描模块列表, 识别所有可能成对的模块
   - 识别规则 (通用, 不限项目领域):
     a) 前缀对: <前缀1>_<名称> / <前缀2>_<名称>
        → 如 tx_scrambler / rx_scrambler, enc_data / dec_data
     b) 后缀对: <名称>_<后缀1> / <名称>_<后缀2>
        → 如 scrambler_tx / scrambler_rx
     c) de- 前缀: <名称> / de<名称>
        → 如 scrambler / descrambler, interleaver / deinterleaver
     d) 互逆词: encoder/decoder, modulator/demodulator, mapper/demapper, fft/ifft
     e) 用户可自定义规则添加到 architecture.yaml
   - 输出到 architecture.yaml:
     - pair_conventions 字段 (描述当前项目的命名模式)
     - 每模块 symmetric_with 和 symmetry_type (dataflow_inverse / identical / structural_inverse)

模块: ${modules.join(', ') || '项目默认'}
输出: algorithm_spec + architecture.yaml + 顶层框图文档`, { label: 'p1-architecture' });
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

// Phase 3: TB + MATLAB 向量生成 (依赖 Phase 1)
nodes.p3_tb = {
  deps: ['p1_arch'],
  run: async (ctx) => {
    const arch = ctx.p1_arch?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 3: TB + MATLAB 向量生成

架构设计: ${String(arch).slice(0, 300)}

任务:
1. 自检 Testbench (模块级, 单模块验证)
2. SVA 断言 (关键接口时序)
3. 结构化日志 + 波形配置 ($dumpvars)
4. MATLAB golden model 测试向量生成:
   - 从每个子模块的 MATLAB 函数提取输入/输出对
   - 存入 02_sim/tv/<module>_tv.txt
   - 每条向量标注 golden 预期值

[MUST] 标准算法模块 (LFSR/Viterbi/CRC/FIR):
   - 必须用 MATLAB 生成黄金参考向量
   - 禁止自闭环验证 (编码→译码对比)
   - 参考向量存入 02_sim/tv/ 目录

模块: ${modules.join(', ') || '项目默认'}
输出: TB 编译通过, 自检逻辑完整, 测试向量已生成`, { label: 'p3-testbench' });
    return result;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 4: 逐模块 RTL + MATLAB 验证 [MUST 硬约束]
//
// [硬约束] 每次只处理一个模块。完成当前模块的 RTL 编码 + 仿真验证 +
//          MATLAB golden 对比后，才能开始下一个模块。
//          所有子模块通过后，输出验证矩阵供 Phase 5 消费。
// ═════════════════════════════════════════════════════════════════════════════
nodes.p4_rtl = {
  deps: ['p2_fixedpt', 'p3_tb'],
  run: async (ctx) => {
    const fixedpt = ctx.p2_fixedpt?.data || '';
    const tb = ctx.p3_tb?.data || '';
    const moduleList = modules.length > 0 ? modules : ['模块_1', '模块_2'];

    const result = await agent(`执行 HDL 工作流 Phase 4: 逐模块 RTL + MATLAB 验证

定点报告: ${String(fixedpt).slice(0, 400)}
Testbench: ${String(tb).slice(0, 400)}

模块列表: ${moduleList.join(', ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[MUST 硬约束] 逐模块验证流程 — 不可跳过，不可批量执行
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 按模块列表顺序，**一次只处理一个模块**。完成当前模块的全部
   RTL 编码 + 仿真验证 + MATLAB 对比后，才能开始下一个模块。

2. 每个模块的完成标准（缺一不可）:
   a) RTL 编码完成 — 遵循编码规范 (ri_/ro_/i_rst 同步复位)
   b) make compile 通过 (使用检测到的 EDA 工具链)
   c) 仿真结果与 MATLAB golden model 逐周期比对:
      - 关键中间信号逐一对比
      - 输出数据逐周期匹配
      - 误差 ≤ 1LSB (定点 golden 标准)
   d) 如不一致 → 分析差异根因 → 修复 RTL → 重新仿真 → 再对比
   e) 一致 → 记录到验证矩阵 → 开始下一模块

3. 禁止跳过任何模块的 MATLAB 对比验证。如果 TB/测试向量未就绪，
   必须先完成 TB/向量再继续。

4. 每模块完成后输出一行到验证矩阵:
   | 模块名 | 状态 | 对比结果 | 迭代次数 |
   |--------|------|----------|----------|
   | scrambler | ✅ | 与 scrambler.m 逐周期一致 | 2/2 |
   | equalizer | ❌ | H_est 累加器差 1LSB | - |

5. 如果某模块 FAIL 且修复超过 3 次迭代:
   → 执行 Debug Retrospective (5 Whys 根因分析)
   → 记录到 auto_lessons
   → 确认根因解决后继续

6. 必须记录 Bit-True 验证报告:
   - 定点 vs MATLAB 浮点误差 (NMSE/EVM)
   - 资源使用 (LUT/FF/DSP/BRAM)
   - 时序收敛 (Fmax)

7. 对称对复用 [效率提升]:
   - 在处理每个模块前, 检查 architecture.yaml 中的 symmetric_with 配对信息
   - 如果当前模块的配对模块**已完成**:
     → 分析对称类型 (dataflow_inverse / identical / structural_inverse)
     → 基于已完成模块的端口列表、参数、数据通路反向推导当前模块框架
     → 例: "descrambler 是 scrambler 的逆向——LFSR 相同, 数据流相反"
     → 复用框架减少重复手写, 且保持结构一致性
   - 如果配对模块**尚未完成**: 正常独立编写

📐 优先参考 skills/hdl-coding/templates/ 中的现成模板:
   comm/  : delay_sync.v, ram_2port.v
   alu/   : carry_lookahead_4bit.v, alu_16bit_7func.v, alu_4bit_16func.v
   internet/: crc.sv, crc32.v, hash_table.v, lru_counter.v, cam_cell.v,
             frame_sync.v, crossbar_cell.v, sm4_round.v

模块: ${moduleList.join(', ')}

输出格式:
1. 验证矩阵 (Markdown 表格)
2. 每模块 Bit-True 报告
3. 未通过模块的差异分析`, { label: 'p4-rtl-sequential' });
    return result;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 5: 顶层集成 + 全链仿真 [MUST 硬约束]
//
// [硬约束] Phase 4 验证矩阵必须全 ✅ 才能进入本阶段。
//          全链逐级与 MATLAB golden model 对比，任何一级不匹配 = FAIL。
// ═════════════════════════════════════════════════════════════════════════════
nodes.p5_top_integration = {
  deps: ['p4_rtl'],
  run: async (ctx) => {
    const rtlResult = ctx.p4_rtl?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 5: 顶层集成 + 全链仿真

Phase 4 输出: ${String(rtlResult).slice(0, 500)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[MUST 硬约束] 顶层集成流程 — 不可跳过
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 检查 Phase 4 产出的验证矩阵:
   - 所有模块必须标记为 ✅ (通过)
   - 有任何 ❌ → 返回 Phase 4 修复，不可继续顶层集成

2. 搭建顶层:
   a) 创建顶层模块，例化所有子模块
   b) 按数据流方向连接: TX链 → RX链 (或指定方向)
   c) 连接控制通路: 帧头/帧尾传递, 配置参数分发
   d) 确认 AXI4-Stream 握手链完整 (tvalid/tready/tdata/tlast/tuser)
   e) make compile 通过

3. 全链仿真 — 从输入到输出逐级对比 MATLAB golden model:
   a) 从 MATLAB 注入全帧测试向量
   b) 逐级捕获中间结果并与 golden model 对比:
      - 模块 A 输出 ↔ MATLAB 模块 A 输出
      - 模块 B 输出 ↔ MATLAB 模块 B 输出
      - ... (所有中间级)
      - 最终输出 ↔ MATLAB 整体输出
   c) 各级误差标准:
      - 定点模块: 逐周期一致 (bit-true)
      - 浮点近似模块: 误差 ≤ 1LSB
   d) 如果有中间级不匹配:
      → 隔离根因模块 (定位到具体子模块)
      → 记录差异 (预期值 vs 实际值, 周期号)
      → 返回 Phase 4 修复该模块

4. 全链 PASS 标准:
   - 所有中间级输出与 MATLAB golden model 一致
   - 最终输出与 MATLAB golden model 一致
   - 任何一级不一致 = FAIL，不可妥协

模块: ${modules.join(', ') || '项目默认'}
输出:
1. top.sv 顶层模块
2. 全链仿真日志 (含所有中间级对比)
3. 全链 PASS/FAIL 报告
4. 如有 FAIL → 隔离到具体模块的差异报告`, { label: 'p5-top-integration' });
    return result;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 6: 回归覆盖率 (依赖 Phase 5)
// [增强] 必须真跑 compile/sim，不能写文字描述替代
// ═════════════════════════════════════════════════════════════════════════════
nodes.p6_regression = {
  deps: ['p5_top_integration'],
  run: async (ctx) => {
    const top = ctx.p5_top_integration?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 6: 回归覆盖率

顶层集成: ${String(top).slice(0, 400)}

任务:
1. 检查 Makefile 是否有 compile/sim/regress 目标
2. 如无 → 自动扫描 01_src/ 下 .sv/.v 文件，生成临时 compile 脚本并运行
3. 如有 → make regress 全量回归
4. covergroup 全部触发
5. mandatory 覆盖点 100%

[MUST] 必须真跑编译/仿真。如果 EDA 工具链不可用，
       至少完成 lint + 语法检查。禁止仅文字描述。
       使用 eda-detect 检测可用工具链。

输出: regress 全绿 (或真实编译/仿真日志)`, { label: 'p6-regression' });
    return result;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 7: 代码审查 (依赖 Phase 5, 与 Phase 6 并行)
// [增强] 增加模型一致性检查 + 工具链约束注入
// ═════════════════════════════════════════════════════════════════════════════
nodes.p7_review = {
  deps: ['p5_top_integration'],
  run: async (ctx) => {
    const top = ctx.p5_top_integration?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 7: 代码审查

顶层集成: ${String(top).slice(0, 400)}

审查维度:
1. 时序安全 (输入寄存/输出寄存/CDC)
2. 命名规范 (ri_/ro_/i_/o_)
3. 状态机 (三段式 + default)
4. Lint 门禁 (make lint pass)
5. 位宽匹配
6. 模型一致性检查:
   - 关键信号命名是否与 MATLAB golden model 对应变量一致?
   - 位宽/定点格式是否与 Phase 2 报告一致?
   - 模块命名是否与 architecture.yaml 一致?
7. [工具链] 如有 EDA 工具链约束 (如 ModelSim 10.6c 禁令),
   检查 RTL 是否违规

输出: 审查报告 PASS/FAIL + 修改建议`, { label: 'p7-code-review' });
    return result;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 8: 报告输出 (依赖 Phase 6 + Phase 7)
// ═════════════════════════════════════════════════════════════════════════════
nodes.p8_report = {
  deps: ['p6_regression', 'p7_review'],
  run: async (ctx) => {
    const regression = ctx.p6_regression?.data || '';
    const review = ctx.p7_review?.data || '';
    const result = await agent(`生成 HDL 工作流 Phase 8: 总结报告

回归结果: ${String(regression).slice(0, 300)}
审查结果: ${String(review).slice(0, 300)}

输出:
1. 汇总实现报告 (含全链验证矩阵)
2. 文档归档
3. 经验记录`, { label: 'p8-report' });
    return result;
  },
};

// Verifier (终验节点)
nodes.verifier = {
  deps: ['p8_report'],
  run: async (ctx) => {
    const report = ctx.p8_report?.data || '';
    // 汇总所有下游结果供 Verifier 审阅
    const summary = [
      '## Phase 0 基础设施', ctx.p0_infra?.data || 'N/A',
      '## Phase 1 架构设计', ctx.p1_arch?.data || 'N/A',
      '## Phase 2 定点量化', ctx.p2_fixedpt?.data || 'N/A',
      '## Phase 3 TB+向量生成', ctx.p3_tb?.data || 'N/A',
      '## Phase 4 逐模块RTL+MATLAB验证', ctx.p4_rtl?.data || 'N/A',
      '## Phase 5 顶层集成+全链仿真', ctx.p5_top_integration?.data || 'N/A',
      '## Phase 6 回归', ctx.p6_regression?.data || 'N/A',
      '## Phase 7 审查', ctx.p7_review?.data || 'N/A',
      '## Phase 8 报告', report,
    ].join('\n\n');

    const result = await agent(`你是一个**跨阶段校验者**。审以下 HDL 开发工作流的全链路结果是否完整满足要求。

逐条检查:
1. 所有 9 个 Phase 是否都有输出
2. Phase 4 (逐模块RTL) 验证矩阵: 所有模块是否都标记 ✅?
3. Phase 5 (顶层集成) 全链仿真各中间级与 MATLAB golden model 一致?
4. Phase 6 (回归) 是否通过 (要求真实编译/仿真, 非文字)
5. Phase 7 (审查) 是否通过
6. 是否适用于模块: ${modules.join(', ') || '项目默认'}

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
