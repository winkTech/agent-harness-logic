/**
 * hdl-coding-dag-workflow — HDL RTL 开发 DAG 工作流 v3.6.0
 *
 * 本文件是该工作流的**单一真源** (workflows/ 目录, 供 Workflow({name}) 解析)。
 * skills/workflows/hdl-coding-workflow.md 是它的方法论文档, 以本文件为准。
 *
 * v3.6 — 审计修复 (2026-07-26, 用户批准的三批升级):
 *   1. 证据门禁不再依赖从未存在的 globalThis.workflowFs 桥 —— 判定移入
 *      确定性脚本 engine/scripts/hdl-evidence-gate.cjs, 工作流派证据 agent
 *      执行它并按 schema 原样带回结果 (对齐 security-review-workflow 先例)。
 *   2. _dagExecute 修复节点失败死循环: parallel() 的 thunk 抛错只会解析为
 *      null 而不会 reject, 旧实现失败节点永不进 completed → 无限重跑。
 *   3. 可恢复 checkpoint 体系: preflight / design-review / evidence-review
 *      三个用户确认点 + verifier 自动终验。未确认 → 抛
 *      [WorkflowCheckpoint:<name>], 用户审查后带 args.checkpoints.<name>
 *      .confirmed=true 与 resumeFromRunId 重跑, 已完成的 agent 调用走缓存。
 *   4. 专业 agent 接线: 算法侧 algorithm-engineer, RTL/仿真侧 logic-engineer,
 *      审查/对抗侧 ce-correctness-reviewer / ce-api-contract-reviewer /
 *      ce-architecture-strategist / ce-performance-oracle。
 *
 * [MUST 硬约束] RTL 验证流程:
 *   Phase 4: 逐模块 RTL + 脚本化对比 — 生成 check_<module>.py + JSON 证据
 *   Phase 4.5: 证据门禁 — hdl-evidence-gate.cjs 确定性读取 JSON 证据文件，不信任 Phase 4 自述
 *   Phase 5: 全链仿真 — 通过 Phase 4.5 后才可进入
 *
 * 调用:
 *   Workflow({name: 'hdl-coding-dag-workflow', args: {
 *     modules: ['scrambler', 'equalizer'],
 *     securityModules: ['equalizer'],           // 可选，覆盖自动分类
 *     standardModules: ['fir_fixed'],           // 可选，强制标准模式
 *     projectRoot: 'd:/project/ofdm/prj',       // 可选
 *     lite: false,                              // 可选 Lite 模式
 *     confirmed: true,                          // 确认 preflight 检查点
 *     checkpoints: {                            // 逐检查点确认 (配合 resumeFromRunId)
 *       'design-review': {confirmed: true},
 *       'evidence-review': {confirmed: true},
 *     },
 *     confirmAllCheckpoints: true,              // 无人值守模式: 显式跳过全部用户检查点
 *   }})
 */

const { join: pathJoin } = { join: (...p) => p.join('/').replace(/\/+/g, '/') };

function _parseStrictJsonObject(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── 检查点 ──────────────────────────────────────────────────────────────────
// 每个检查点独立确认。历史上 args.confirmed=true 一票确认所有检查点, 这让
// "Phase 间暂停呈报" 形同虚设 —— 现在 confirmed 只覆盖 preflight;
// 后续检查点须逐个 args.checkpoints.<name>.confirmed=true (配合 resumeFromRunId
// 重跑, 已完成节点走前缀缓存), 或显式 confirmAllCheckpoints=true 走无人值守。

function _checkpointConfirmed(name) {
  if (args?.checkpoints?.[name]?.confirmed === true) return true;
  if (args?.confirmAllCheckpoints === true) return true;
  if (name === 'preflight') {
    return args?.confirmed === true || args?.userConfirmed === true || args?.acknowledged === true;
  }
  return false;
}

function _requireUserCheckpoint(name, detail) {
  if (_checkpointConfirmed(name)) return;
  throw new Error(
    `[WorkflowCheckpoint:${name}] user confirmation required before continuing. ${detail || ''}\n` +
    `确认方式: 用户审查后, 以 args.checkpoints['${name}'].confirmed=true + resumeFromRunId 重跑 ` +
    `(已完成阶段自动走缓存); 无人值守场景用 args.confirmAllCheckpoints=true。`
  );
}

// ── 证据门禁 (确定性脚本 + 证据 agent) ──────────────────────────────────────
// 判定逻辑全部在 engine/scripts/hdl-evidence-gate.cjs 里 (纯 Node, 读磁盘,
// 输出 JSON + RESULT: PASS/FAIL)。证据 agent 只负责执行命令并把输出按 schema
// 原样带回 —— 它不做任何判断。残余风险 (agent 理论上可伪造 schema 匹配的返回)
// 已在需求门禁 D6 记录; agent 的 bash 调用会进透明度账本, 且 Phase 4.5 与
// Phase 4 是相互独立的上下文, 末端 verifier 再做交叉核对。

const EVIDENCE_GATE_SCRIPT = args?.evidenceGateScript || 'engine/scripts/hdl-evidence-gate.cjs';

const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    executed: { type: 'boolean' },
    ok: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'string' } },
    gateJson: { type: 'string' },
  },
  required: ['executed', 'ok', 'failures'],
};

async function _evidenceGate(flags, label, phaseName) {
  const cmd = `node ${EVIDENCE_GATE_SCRIPT} --project-root "${projectRoot}" ${flags}`;
  const res = await agent(
    `你是**证据搬运者**。你的唯一任务是执行下面的确定性证据门禁命令, 并把它的输出原样带回。

命令:
  ${cmd}

说明:
- 脚本位于 Claude harness 根目录 (通常 ~/.claude)。相对路径找不到时改用
  ~/.claude/${EVIDENCE_GATE_SCRIPT} 的绝对路径重试一次。
- 命令会输出一个 JSON 对象和末行 RESULT: PASS 或 RESULT: FAIL。

结构化返回 (禁止改写脚本输出的任何数值):
- executed: 命令是否真的执行了 (无法执行 → false, 并把错误信息放进 failures)
- ok: 脚本 JSON 里的 ok 字段原值
- failures: 脚本 JSON 里的 failures 数组原值 (无法执行时放错误信息)
- gateJson: 脚本输出的完整 JSON 文本

你不做判定, 不解释, 不补救。脚本说 FAIL 就如实带回 FAIL。`,
    { label, phase: phaseName, schema: EVIDENCE_SCHEMA }
  );
  if (!res || res.executed !== true) {
    throw new Error(`[证据门禁] 门禁命令未能执行 (${label}): ${(res?.failures || ['agent 无返回']).join('; ')}`);
  }
  return res;
}

// ── DAG 拓扑执行器 ──────────────────────────────────────────────────────────
// 失败安全版。旧实现的教训: parallel() 的 thunk 抛错会被解析为 null 而不会
// reject, 失败节点永不进 completed → ready 里反复出现 → 无限重跑。
// 现在 run() 的成功/失败都在 thunk 内部捕获为记录, 节点必定标记完成,
// 层结束后按 fail-fast 抛出; 检查点错误保留原始消息 (含续跑指引)。
async function _dagExecute(nodes, opts) {
  const results = {};
  const completed = new Set();
  const nodeList = Object.entries(nodes);
  const logFn = opts?.log || log;
  let layerIndex = 0;

  while (completed.size < nodeList.length) {
    const ready = nodeList.filter(([name, node]) => !completed.has(name) && (node.deps || []).every(d => completed.has(d)));
    if (ready.length === 0) {
      throw new Error(`[DAG] 依赖阻塞 (循环依赖或前置失败): 未完成=${nodeList.map(([n]) => n).filter(n => !completed.has(n)).join(', ')}`);
    }
    layerIndex += 1;
    opts?.onProgress?.(layerIndex, nodeList.length, ready.map(r => r[0]));

    const settled = await parallel(ready.map(([name, node]) => () =>
      node.run(results).then(
        (data) => ({ name, status: 'ok', data }),
        (err) => ({ name, status: 'fail', error: String(err?.message || err) })
      )
    ));

    for (const record of settled.filter(Boolean)) {
      results[record.name] = record;
      completed.add(record.name);
    }
    // parallel 层面被终止的 thunk 返回 null — 对应节点标记失败, 绝不留在 ready 里空转
    for (const [name] of ready) {
      if (!completed.has(name)) {
        results[name] = { name, status: 'fail', error: 'agent terminated without result (skipped or killed)' };
        completed.add(name);
      }
    }

    const failures = ready.map(([name]) => results[name]).filter(r => r.status === 'fail');
    if (failures.length > 0) {
      for (const f of failures) logFn(`  ❌ ${f.name}: ${String(f.error).slice(0, 200)}`);
      const checkpointFailure = failures.find(f => String(f.error).includes('[WorkflowCheckpoint:'));
      if (checkpointFailure && failures.length === 1) {
        throw new Error(checkpointFailure.error); // 保留检查点原始消息与续跑指引
      }
      throw new Error(`[DAG] 节点失败: ${failures.map(f => f.name).join(', ')} — ${String(failures[0].error).slice(0, 400)}`);
    }
  }

  const nodeCount = nodeList.length;
  const maxDepth = (n, d = 0) => { const nd = nodes[n]; return nd && nd.deps && nd.deps.length ? Math.max(...nd.deps.map(dep => maxDepth(dep, d + 1)), d) : d; };
  const layerCount = Math.max(...nodeList.map(([n]) => maxDepth(n))) + 1;
  return { results, nodeCount, layerCount };
}

export const meta = {
  name: 'hdl-coding-dag-workflow',
  description: 'HDL RTL 开发 DAG 工作流 v3.6 — P1a(系统方案)+P1b(微架构)双阶段设计, hdl-evidence-gate.cjs 确定性证据门禁, 可恢复检查点, 专业 agent 分工 (Verifier终验)',
  phases: [
    { title: 'Phase 0 基础设施' },
    { title: 'Phase 1a 系统方案设计' },
    { title: 'Phase 1b 微架构设计' },
    { title: 'Phase 2 定点量化' },
    { title: 'Phase 3 TB+向量生成' },
    { title: 'Phase 4 RTL编码+脚本化对比' },
    { title: 'Phase 4.5 证据门禁' },
    { title: 'Phase 5 顶层集成+全链仿真' },
    { title: 'Phase 6 回归覆盖率' },
    { title: 'Phase 7 代码审查' },
    { title: 'Phase 8 报告+Verifier' },
  ],
  contract: {
    version: 2,
    strict: true,
    inputs: ['modules', 'projectRoot', 'confirmed/checkpoints.<name>.confirmed', 'confirmAllCheckpoints (无人值守)'],
    checkpoints: ['preflight', 'design-review', 'evidence-review', 'verifier'],
    evidence: [
      'engine/scripts/hdl-evidence-gate.cjs (确定性判定 + RESULT: PASS/FAIL)',
      '06_doc/architecture.yaml',
      '02_sim/check_results/*.json',
      'Phase 4.5 evidence gate',
    ],
    completionCriteria: [
      'preflight user checkpoint is confirmed',
      'design-review and evidence-review checkpoints confirmed (or confirmAllCheckpoints)',
      'hdl-evidence-gate.cjs returns ok=true for all modules',
      'verifier returns valid JSON with pass=true',
    ],
    modeContracts: {
      full: {
        allowedSkips: [],
        requiredEvidence: ['architecture.yaml', 'check_results/*.json', 'regression result'],
      },
      lite: {
        allowedSkips: ['p2_fixedpt', 'p6_regression'],
        requiredEvidence: ['architecture.yaml', 'check_results/*.json', 'verifier JSON'],
      },
    },
  },
};

// ── 主参数 ─────────────────────────────────────────────────────────────────

const modules = args?.modules || [];
const moduleOrder = args?.moduleOrder || modules;  // Cascade dependency order (input→output)
const liteMode = args?.lite === true;
const projectRoot = args?.projectRoot || '.';  // v3.5.1: process.cwd() 不可用

// ── 模块分类（自动 / 手动覆盖）─────────────────────────────────────────────

const HIGH_SECURITY_KEYWORDS = [
  'equalizer', 'equaliser', 'viterbi', 'turbo', 'ldpc',
  'fft', 'ifft', 'freq_offset', 'carrier', 'cordic',
  'feedback', 'adapt', 'kalman', 'cholesky', 'qr',
  'agc', 'power_est', 'symbol_sync', 'timing', 'costas', 'pll',
  'channel_est', 'channel_equal', 'cma', 'lms', 'rls', 'dfe',
];

function isHighSecurity(modName) {
  const name = typeof modName === 'string' ? modName.toLowerCase() : '';
  return HIGH_SECURITY_KEYWORDS.some(kw => name.includes(kw));
}

const userHighSec  = Array.isArray(args?.securityModules)  ? args.securityModules  : null;
const userStd      = Array.isArray(args?.standardModules)   ? args.standardModules   : [];

const highSecModules = userHighSec
  ? userHighSec.filter(m => modules.includes(m))
  : modules.filter(m => isHighSecurity(m) && !userStd.includes(m));
const stdModules = modules.filter(m => !highSecModules.includes(m));

// ── DAG 节点 ────────────────────────────────────────────────────────────────

const nodes = {};

// ── Phase 0: 基础设施 (无依赖) ──────────────────────────────────────────────

nodes.p0_infra = {
  deps: [],
  run: async () => {
    const result = await agent(`执行 HDL 工作流 Phase 0: 基础设施 + 建目录

[MUST] 按跨项目标准建目录 (engineering-assets/knowledge/primary/cross-project-experience.md):
<project_root>/
├── 01_src/00_hdl/      # RTL 源码 (每个模块独立子目录)
├── 01_src/01_ip/        # IP 核
├── 02_sim/              # 仿真 (含 tv/ 和 check_results/)
│   ├── tv/              # 测试向量
│   └── check_results/   # JSON 证据文件
├── 03_xdc/              # 约束 (可空)
├── 04_prj/              # 工程文件 (可空)
├── 05_bin/              # 比特流 (可空)
├── 06_doc/              # 设计文档
├── 07_mat/              # MATLAB golden model
├── 08_py/               # Python 脚本
└── README.md

2. Makefile: 必须包含 lint / compile / sim / clean 目标
   [MUST] make clean 删除: work/ transcript *.wlf vsim.wlf __pycache__/ *.vcd

3. .gitignore: 必须排除所有 transient 文件
   work/ transcript *.wlf vsim.wlf __pycache__/ *.pyc *.vcd *.vcd.lxt *.ini

4. 验证 make lint / make compile 可用

模块: ${modules.join(', ') || '项目默认'}
输出检查清单:
- 目录结构符合跨项目标准
- var/project-init/directory-contract.json 存在且记录 canonical HDL layout
- Makefile 存在且 lint/compile/sim/clean 目标完整
- .gitignore 排除 transient
- make lint 通过

━━━ 检查点 ━━━
产出以上目录结构后暂停，用户审查确认目录合规后再进入 Phase 1a。
━━━━━━━━━━━`, { label: 'p0-infra' });
    return result;
  },
};

// ── Phase 1a: 系统级方案设计 (算法工程师) ──────────────────────────────────

nodes.p1a_sys_design = {
  deps: ['p0_infra'],
  run: async () => {
    const result = await agent(`执行 HDL 工作流 Phase 1a: 系统级方案设计

前提: 基础设施已就绪, 项目目录已建。

【核心方法论 — 系统级思维】
不要在写代码前就直接拆模块。先理解系统, 再推导算法, 再对比选型, 最后才拆模块。
每一步的产出都写入 06_doc/ 目录。

=== A1 — 系统上下文分析 ===
回答并写入 06_doc/system_context.md:
- 这个算法在全局链路中的位置？前级是什么？输出给谁？
- 输入信号特性: 信噪比范围、带宽、符号率、最大/最小幅度
- 系统约束: Fclk、最大延迟(cycles)、最低吞吐(samples/s)、面积预算
- 输出要求: EVM(dB)、BER、锁定时间

=== A2 — 数学原理推导 ===
写入 06_doc/algorithm_derivation.md:
从第一性原理导出算法，不靠记忆。完整推导链。
关键的近似/简化及其误差分析。

=== A3 — 多方案对比选型 ===
写入 06_doc/tradeoff_analysis.md:
至少 2-3 候选，从性能/复杂度/存储/收敛速度/数值稳定性五维对比，表格呈现。

=== A4 — 信号链分析 ===
写入 06_doc/signal_chain_analysis.md:
每级处理后的信号形态、幅度范围、SNR变化、需要的动态余量。标注瓶颈级。

=== A5 — 定界分析 ===
写入 06_doc/performance_bounds.md:
理论性能界(CRLB/Shannon限等) vs 预期性能的差距。

=== A6 — 定点策略 ===
写入 06_doc/fixed_point_strategy.md:
每级的预期位宽范围、溢出/截断策略、Q格式草案。

=== 🔴 复位约定 (红线 — 全项目统一) ===
[MUST] 所有模块的复位信号必须为: 同步高有效, 信号名 i_rst
[MUST] 禁止使用异步复位或低有效复位 (rst_n / reset_n)
[MUST] 所有时序逻辑必须用 always_ff @(posedge clk) 触发, 在块内用 if(i_rst) 做复位

每级的预期位宽范围、溢出/截断策略、Q格式草案。

模块: ${modules.join(', ') || '项目默认'}

━━━ 检查点 (P1a 门禁) ━━━
产出 06_doc/ 下 6 份文档后暂停。

调度层将使用 engineering-assets/knowledge/primary/architecture-patterns/gate-checklist-p1a.md 检查:
  [MUST] A1 系统上下文: 链路位置+信号特性+系统约束+性能指标
  [MUST] A2 数学推导: 完整链+每步公式+近似误差
  [MUST] A3 多方案对比: ≥2 候选+4 维对比表+否选理由
  [MUST] A4 信号链: 每级形态+幅度范围+位宽+瓶颈标注
  [MUST] A5 定界: 理论界+差值 dB+瓶颈识别
  [MUST] A6 定点策略: 每级位宽+Q 格式+溢出/截断策略
  [🔴 红线] 复位约定: 全部模块必须使用同步高有效 i_rst (禁止 rst_n/reset_n)

用户审查系统方案 + 门禁通过后再进 P1b。
━━━━━━━━━━━`, { agentType: 'algorithm-engineer', label: 'p1a-system-design', phase: 'Phase 1a 系统方案设计' });
    return result;
  },
};

// ── Phase 1b: 微架构设计 (算法工程师 + 逻辑工程师) ─────────────────────────

nodes.p1b_micro_arch = {
  deps: ['p1a_sys_design'],
  run: async (ctx) => {
    const sysDesign = ctx.p1a_sys_design?.data || '';
    const sysHint = String(sysDesign).slice(0, 500);

    const [algoArch, logicArch] = await parallel([
      // ── 算法工程师: 模块分解 + 接口定义 ──────────────────────
      () => agent(`执行 HDL 工作流 Phase 1b: 微架构 (算法工程师 — 模块分解/接口)

系统方案参考:
${sysHint}

任务:
1. 划分模块: 根据信号链分析, 将系统拆为 RTL 模块
2. 模块接口定义: 每个模块的端口信号、位宽、握手协议
3. **写入 06_doc/architecture.yaml [MUST]**:
   modules:
     - name: <模块名>
       type: <datapath/control/memory>
       matlab_ref: <Golden Model 路径>
       symmetric_with: <对称模块>
       pipeline_stages:
         - {name, function, latency, bit_width, q_format}
       fsm_states:
         - {name, description, transitions}
   pair_conventions:
     - <对称对分析>
4. **写入 06_doc/interface_contract.md**: 每个端口握手协议、时序波形
5. **写入 06_doc/algorithm_spec.md**: 细化到每模块的算法步骤
6. **写入 06_doc/pipeline_diagram.md**: 流水线图 + 数据流

7. **[MUST — 红线]** 所有模块复位信号必须为 i_rst (同步高有效)，禁止 rst_n/reset_n/arst_n。所有时序 always_ff @(posedge clk) + if(i_rst)
模块: ${modules.join(', ') || '项目默认'}
微架构是 RTL 实现的刚性契约，逻辑工程师将严格按此编码。`, { agentType: 'algorithm-engineer', label: 'p1b-algo-arch', phase: 'Phase 1b 微架构设计' }),

      // ── 逻辑工程师: 架构评估 + 资源/时序预估 ────────────────
      () => agent(`执行 HDL 工作流 Phase 1b: 微架构 (逻辑工程师 — 资源/时序/CDC)

系统方案参考:
${sysHint}

任务 — 在写任何 RTL 之前完成以下分析:

=== B1 — 架构空间探索 ===
写入 06_doc/architecture_tradeoff.md:
至少 2 种微架构对比（全并行/半折叠/全串行），从面积/延迟/吞吐/预估 Fmax 四维比较。

=== B2 — 资源预算跟踪 ===
写入 06_doc/resource_budget_tracking.md:
根据算法工程师的预算(DSP48×N/LUT×M/BRAM×K)出发，预估每个数据通路的资源消耗。

=== B3 — 时序预估 ===
写入 06_doc/timing_estimate.md:
每级组合逻辑级数估算、关键路径标注、pipeline 插入策略。

=== B4 — 接口契约审查 ===
审查 06_doc/interface_contract.md（算法工程师产出），确认:
     - 握手协议可综合、背压传播可行、反压链长度可控
     - [MUST - 红线] 所有复位信号必须为 i_rst (同步高有效)，禁止异步/低有效复位。

=== B5 — 验证策略 ===
写入 06_doc/verification_strategy.md:
每模块的自检方法、关键信号可观察性、调试 hook、覆盖率收集策略。

=== B6 — 时钟域分析 ===
写入 06_doc/clock_domain.md:
时钟域图、CDC 信号清单及方案、异步 FIFO 深度计算。

模块: ${modules.join(', ') || '项目默认'}`, { agentType: 'logic-engineer', label: 'p1b-logic-arch', phase: 'Phase 1b 微架构设计' }),
    ]);

    // ── 校验 architecture.yaml 完整性 (确定性脚本判定) ─────────
    log(`🔍 校验 architecture.yaml (hdl-evidence-gate --arch)`);
    const archGate = await _evidenceGate('--arch', 'p1b-arch-evidence', 'Phase 1b 微架构设计');
    if (archGate.ok !== true) {
      throw new Error(`❌ architecture.yaml 校验失败:\n   ${archGate.failures.join('\n   ')}\n   P1b 未产出微架构文件, 请确保写入 06_doc/architecture.yaml`);
    }
    log('✅ architecture.yaml 存在 (字段完整性告警见门禁输出)');

    // ── 压缩保留块: Phase 1 架构 ──────────────────────────
    log('');
    log('📌 === 压缩保留块: Phase 1 架构 ===');
    log('保留原因: 架构方案是后续所有 RTL 的契约，压缩时丢失 = 全部重来');
    log(`模块列表: ${modules.join(', ') || '项目默认'}`);
    log('文件产出: 06_doc/architecture.yaml, 06_doc/pipeline_diagram.md, 06_doc/algorithm_spec.md');
    // (v3.5.1: 流水线级数统计委托给 P1b agent, fs 不可用)
    log('关键决策: FSM 状态图、模块接口定义、定点 Q 格式');
    log('=== 保留块结束 ===');
    log('');

    log(`━━ 检查点 (P1b 门禁) ━━
等待调度层使用 gate-checklist-p1b.md 检查:
  [MUST] B1 架构空间: ≥2 方案+4 维对比+定量数据
  [MUST] B2 资源预算: 逐级累加+vs 预算对比+超 10% 告警
  [MUST] B3 时序预估: 每级组合深度+关键路径+pipeline 方案
  [MUST] B4 接口契约: 全部端口握手+背压+错误传播+时序波形
  [MUST] B5 验证感知: 每模块自检+可观察性+覆盖率
  [MUST] B6 时钟域: 时钟域图+CDC 清单+异步 FIFO 深度计算
  🔴 红线1: 全部复位必须为 i_rst (同步高有效)
  🔴 红线2: B4接口未定义/B6 CDC漏同步

用户审查门禁后再进入 Phase 2 定点量化。`);
    return `[算法方案]
${String(algoArch).slice(0, 1500)}

[逻辑评估]
${String(logicArch).slice(0, 1500)}`;
  },
};

// ── 检查点: design-review (P1a/P1b 设计审查, 用户确认后才开工定点/TB/RTL) ──

nodes.cp_design_review = {
  deps: ['p1b_micro_arch'],
  run: async () => {
    _requireUserCheckpoint(
      'design-review',
      '请审查 06_doc/ 下的系统方案 (A1-A6) 与微架构产出 (architecture.yaml / pipeline_diagram.md / B1-B6), 按 gate-checklist-p1a.md 与 gate-checklist-p1b.md 核对。'
    );
    log('✅ [检查点] design-review 已确认 — 进入定点量化/TB 阶段');
    return 'design-review confirmed';
  },
};

// ── Phase 2: 定点量化 ───────────────────────────────────────────────────────

nodes.p2_fixedpt = {
  deps: ['cp_design_review'],
  run: async (ctx) => {
    const arch = ctx.p1b_micro_arch?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 2: 定点量化

架构设计: ${String(arch).slice(0, 300)}

任务:
1. 位宽扫描 (MATLAB Golden Model)
2. bit-true 定点模型
3. DSP/LUT/BRAM 预算表

模块: ${modules.join(', ') || '项目默认'}
输出: fixed_point_report + resource_estimate`, { agentType: 'algorithm-engineer', label: 'p2-fixed-point', phase: 'Phase 2 定点量化' });
    return result;
  },
};

// ── Phase 3: TB + MATLAB 向量生成 ──────────────────────────────────────────

nodes.p3_tb = {
  deps: ['cp_design_review'],
  run: async (ctx) => {
    const arch = ctx.p1b_micro_arch?.data || '';
    const [tbResult, vecResult] = await parallel([
      // ── 子任务 1: 逻辑工程师 — Testbench ─────────────────────────
      () => agent(`执行 HDL 工作流 Phase 3 (TB): 编写 Testbench (逻辑工程师)

架构设计: ${String(arch).slice(0, 300)}
模块: ${modules.join(', ') || '项目默认'}

任务:
[NEW TB 收敛规则 — 违反即阻断]
a) [MUST] 仅允许一个 tb_<module>.sv 文件。如果已有 → 读取后覆盖, 不创建新文件
b) [MUST] Testbench 必须使用 AXI-Stream VIP
c) [MUST] TB 必须有自动对比逻辑 (读 golden 向量 + scoreboard 比对 + JSON 输出)
d) [SHOULD] TB 自检通过: compile + 自动 PASS/FAIL 结论

1. 自检 Testbench (模块级, 单模块验证)
2. SVA 断言 (关键接口时序)
3. 结构化日志 + 波形配置 ($dumpvars)
4. 对比脚本骨架: 02_sim/check_<module>.py
   - 读 02_sim/tv/<module>_tv.txt (MATLAB golden 向量)
   - 读 RTL 仿真输出 02_sim/<module>_out.txt
   - 逐点数值对比 → 输出 JSON 到 02_sim/check_results/<module>.json

输出: TB 编译通过, 自检逻辑完整, 对比脚本骨架就绪`, { agentType: 'logic-engineer', label: 'p3-tb', phase: 'Phase 3 TB+向量生成' }),

      // ── 子任务 2: 算法工程师 — 向量生成 ──────────────────────────
      () => agent(`执行 HDL 工作流 Phase 3 (向量): 生成测试向量 (算法工程师)

架构设计: ${String(arch).slice(0, 300)}
模块: ${modules.join(', ') || '项目默认'}

━━━ [MUST] 第 0 步: Golden Model 自检 ━━━
先生成并运行 Golden Model 自检脚本:
   - 检查 check_<module>.py 是否存在
   - 运行 python3 check_<module>.py
   - 确认所有 check status=PASS, compared_points>0
   - 如果任何 check FAIL → 立即停止, 修复 GM 后再继续
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

任务 (GM 自检通过后):
1. MATLAB golden model 测试向量生成:
   - 从每个子模块的 MATLAB 函数提取输入/输出对
   - 存入 02_sim/tv/<module>_tv.txt
   - 每条向量标注 golden 预期值
2. 覆盖 corner case: 全零、全一、脉冲、随机、边界值、溢出
3. 向量格式: 每行 1 bit (ASCII '0'/'1'), .hex 后缀

[MUST]:
   - 必须用 MATLAB/Python golden 生成黄金参考向量
   - 禁止自闭环验证 (编码→译码对比)
   - 向量存入 02_sim/tv/ 目录

输出: 02_sim/tv/<module>_tv.txt, 覆盖所有 corner case`, { agentType: 'algorithm-engineer', label: 'p3-vectors', phase: 'Phase 3 TB+向量生成' }),
    ]);

    return `[TB]\n${tbResult}\n\n[VECTORS]\n${vecResult}`;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 4: 逐模块 RTL + 脚本化对比 — 3-stage pipeline (编码→调试循环→终验)
// ═════════════════════════════════════════════════════════════════════════════

nodes.p4_rtl = {
  deps: ['p2_fixedpt', 'p3_tb'],
  run: async (ctx) => {
    const fixedpt = ctx.p2_fixedpt?.data || '';
    const tb = ctx.p3_tb?.data || '';
    const moduleList = modules.length > 0 ? modules : ['模块_1'];
    const fixedptHint = fixedpt ? String(fixedpt).slice(0, 200) : '[Lite] 无定点报告';
    const prjRoot = projectRoot;
    const cascadeResults = {};  // modName → { stage2Pass, stage3Pass } — cascade tracking across modules

    log(`[Phase 4] 3-stage pipeline: RTL编码 → 仿真调试循环 → 独立终验`);
    log(`  模块: ${moduleList.join(', ')}`);
    log(`  Stage 2 内置 Debugger↔Verifier 双视角调试循环, max 5 次`);

    const results = await pipeline(
      moduleOrder,

      // ── Stage 1: RTL 编码 ──────────────────────────────────────────────────
      async (mod) => {
        await agent(
          `执行 RTL 编码: ${mod}

目标文件: 01_src/00_hdl/${mod}/${mod}.sv
如果文件已存在 → 读取后原地覆盖。禁止创建 ${mod}_v2.sv 等变体。

参考: architecture.yaml 中 ${mod} 的微架构方案
定点参考: ${fixedptHint}
TB: 02_sim/${mod}/tb_${mod}.sv (唯一 TB, 直接覆盖)

[MUST 完成标准]
1. 按 architecture.yaml 微架构编码 (流水线/FSM/位宽一致)
2. make lint 通过
3. make compile 通过
4. 输出 RTL 源码到目标文件`,
          { agentType: 'logic-engineer', label: `rtl-code-${mod}`, phase: 'Phase 4 RTL编码' }
        );
        return { mod, stage1: 'done' };
      },

      // ── Stage 2: 仿真调试循环 ──────────────────────────────────────────────
      async (prev, mod) => {
        let pass = false;
        let attempts = 0;
        const MAX_ATTEMPTS = 5;
        let lastError = '';
        let needUserReview = false;

        // ── Cascade context: upstream module verification status ──
        const modIndex = moduleOrder.indexOf(mod);
        const upstreamModules = moduleOrder.slice(0, Math.max(0, modIndex));
        const upstreamVerified = upstreamModules.length === 0 || upstreamModules.every(u => cascadeResults[u]?.stage2Pass === true);
        const upstreamFailedNames = upstreamModules.filter(u => cascadeResults[u] && !cascadeResults[u].stage2Pass);
        if (upstreamModules.length > 0 && !upstreamVerified) {
          log(`  🔗 ${mod}: 上游 ${upstreamModules.length} 个模块中 ${upstreamFailedNames.length} 个未通过 — 输入信号可能异常`);
        }

        // 仿真 agent 的结构化返回契约: gate_* 字段必须原样复制自
        // hdl-evidence-gate.cjs 的输出, agent 不做判定。
        const SIM_SCHEMA = {
          type: 'object',
          properties: {
            gate_executed: { type: 'boolean' },
            gate_ok: { type: 'boolean' },
            compared_points: { type: 'number' },
            log_tail: { type: 'string' },
          },
          required: ['gate_executed', 'gate_ok', 'log_tail'],
        };
        const gateCmd = `node ${EVIDENCE_GATE_SCRIPT} --project-root "${prjRoot}" --modules ${mod}`;

        while (!pass && attempts < MAX_ATTEMPTS && !needUserReview) {
          attempts++;

          // Run simulation & compare with golden
          const simRes = await agent(
            `运行仿真并对比 Golden 向量: ${mod}

1. 运行仿真 (make sim 或 vsim 命令)
2. 自动对比 golden 向量: 02_sim/tv/${mod}_tv.txt
3. 输出 JSON 证据到 02_sim/check_results/${mod}.json
   {"module":"${mod}","status":"PASS|FAIL","compared_points":N}
4. [MUST] 最后执行确定性证据门禁 (脚本在 harness 根目录, 找不到用 ~/.claude/ 前缀):
   ${gateCmd}
5. 结构化返回: gate_executed=门禁命令是否执行; gate_ok/compared_points=门禁 JSON 原值
   (禁止改写); log_tail=仿真日志尾部 (FAIL 时含错误日志前 100 行)`,
            { agentType: 'logic-engineer', label: `sim-run-${mod}-try${attempts}`, phase: 'Phase 4 仿真调试', schema: SIM_SCHEMA }
          );

          if (simRes?.gate_executed === true && simRes?.gate_ok === true && (simRes?.compared_points || 0) > 0) {
            pass = true;
            log(`  ✅ ${mod}: 仿真通过 (第${attempts}次, ${simRes.compared_points}点)`);
            // Cleanup
            await agent(`清理仿真产物: ${mod}\nrm -f wlft* transcript *.wlf vsim.wlf 2>/dev/null; true`,
              { agentType: 'logic-engineer', label: `clean-${mod}-try${attempts}`, phase: 'Phase 4 仿真调试' });
            break;
          }
          lastError = String(simRes?.log_tail || '').slice(0, 2000);

          if (attempts >= MAX_ATTEMPTS) {
            log(`  ⚠️ ${mod}: 达到最大尝试次数 ${MAX_ATTEMPTS}`);
            break;
          }

          // ── Debugger: 分析根因 + 修复 (全新 context) ─────────────────
          const debugOut = String(await agent(
            `你是 **RTL Debugger**。分析并修复仿真错误。

模块: ${mod}
RTL 源码: 01_src/00_hdl/${mod}/${mod}.sv
仿真错误日志:
\`\`\`
${lastError.slice(0, 1500)}
\`\`\`

[级联调试上下文]
模块链位置: 第 ${modIndex + 1}/${moduleOrder.length} 级
上游模块: ${upstreamModules.length > 0 ? upstreamModules.join(' → ') : '(无)'}
上游验证状态: ${upstreamVerified ? '全部通过 ✅' : upstreamFailedNames.map(u => u + ' ❌').join(', ') + ' — 输入信号可能不可靠'}

注意: 如果上游未通过验证，本模块输入数据可能异常。
先检查输入驱动信号 (i_data, i_valid 等) 是否在合理范围内，
再分析模块内部逻辑。如果怀疑是上游问题，标记 "CASCADE_ISSUE"。

[新 context — 全新视角, 不受之前尝试影响]
1. 读取 RTL 源码, 独立分析根因
2. 读取仿真日志, 定位错误信号和时间
3. 提出修复方案并**直接修改 RTL** (原地编辑)
4. 确认 make lint 通过
5. 输出 JSON:
{"root_cause":"...","fix":"...","file":"01_src/00_hdl/${mod}/${mod}.sv","line":N}`,
            { agentType: 'logic-engineer', label: `debug-${mod}-try${attempts}`, phase: 'Phase 4 仿真调试' }
          ) || '');

          // Re-run simulation after fix
          const recheckRes = await agent(
            `重新运行仿真验证修复: ${mod}

1. make compile (确认修复后编译通过)
2. 运行仿真, 对比 golden 向量
3. 输出 JSON 证据到 02_sim/check_results/${mod}.json
4. [MUST] 最后执行确定性证据门禁:
   ${gateCmd}
5. 结构化返回: gate_executed / gate_ok / compared_points 为门禁 JSON 原值 (禁止改写);
   log_tail=仿真日志尾部 (仍 FAIL 时含错误日志前 100 行)`,
            { agentType: 'logic-engineer', label: `sim-recheck-${mod}-try${attempts}`, phase: 'Phase 4 仿真调试', schema: SIM_SCHEMA }
          );

          if (recheckRes?.gate_executed === true && recheckRes?.gate_ok === true && (recheckRes?.compared_points || 0) > 0) {
            pass = true;
            log(`  ✅ ${mod}: 修复后通过 (第${attempts}次, ${recheckRes.compared_points}点)`);
            break;
          }
          // ── 仍 FAIL → Verifier (独立视角) ────────────────────────────
          if (!pass && attempts < MAX_ATTEMPTS) {
            const errInfo = String(recheckRes?.log_tail || lastError || '').slice(0, 1000);

            const verdict = String(await agent(
              `你是 **独立 Verifier**。审查以下 RTL 修复是否正确。

模块: ${mod}
RTL 源码: 01_src/00_hdl/${mod}/${mod}.sv
仿真错误:
\`\`\`
${errInfo}
\`\`\`

Debugger 的分析和修复:
\`\`\`
${String(debugOut).slice(0, 800)}
\`\`\`

[级联上下文 — 上游模块验证状态]
上游通过: ${upstreamVerified ? '是 ✅' : '否 — ' + upstreamFailedNames.join(', ') + ' 未通过 ❌'}
如果 Debugger 的修复涉及本模块的输入驱动或上游接口，请额外审查该部分是否正确。
怀疑是上游问题 → 输出 "CASCADE_ISSUE: <上游模块名> <原因>"。

[独立判断 — 不受 Debugger 影响]
1. 独立阅读 RTL 源码
2. Debugger 的分析是否正确? 修复是否正确?
3. 输出 JSON:
{"agree":true|false,"verdict":"correct|wrong","reason":"...","alternative_fix":"..."}

重要: 你是只读审查者, 不修改任何文件。如果 agree=false, 必须在 alternative_fix
中给出具体到信号/行号的正确修复方向 (由逻辑工程师在下一轮实施)。`,
              { agentType: 'ce-correctness-reviewer', label: `verify-${mod}-try${attempts}`, phase: 'Phase 4 仿真调试' }
            ) || '');

            const vn = verdict.toLowerCase();
            if (vn.includes('"agree":true') || vn.includes('"verdict":"correct"')) {
              // Debugger + Verifier 一致 → 再跑一次最终确认
              const finalRes = await agent(
                `Debugger 与 Verifier 均同意修复方案。最终验证: ${mod}

1. make compile && make sim
2. 对比 golden 向量
3. 输出 JSON 证据到 02_sim/check_results/${mod}.json
4. [MUST] 最后执行确定性证据门禁:
   ${gateCmd}
5. 清理: rm -f wlft* transcript *.wlf vsim.wlf
6. 结构化返回: gate_executed / gate_ok / compared_points 为门禁 JSON 原值 (禁止改写)`,
                { agentType: 'logic-engineer', label: `sim-final-${mod}-try${attempts}`, phase: 'Phase 4 仿真调试', schema: SIM_SCHEMA }
              );

              if (finalRes?.gate_executed === true && finalRes?.gate_ok === true && (finalRes?.compared_points || 0) > 0) {
                pass = true;
                log(`  ✅ ${mod}: 双验证后通过 (第${attempts}次, ${finalRes.compared_points}点)`);
              }
            } else {
              log(`  ⚠️ ${mod}: Debugger 与 Verifier 分歧 (第${attempts}次), 标记需审查`);
              needUserReview = true;
            }
          }
        }

        cascadeResults[mod] = { ...(cascadeResults[mod] || {}), stage2Pass: pass };
        log(`  📋 ${mod}: 调试结束 pass=${pass}, attempts=${attempts}${needUserReview ? ', 需审查' : ''}`);
        return { mod, pass, attempts, needUserReview, error: lastError.slice(0, 500) };
      },

      // ── Stage 3: 独立终验 ──────────────────────────────────────────────────
      async (prev, mod) => {
        if (!prev || !prev.pass) {
          log(`  ⏭️ ${mod}: Stage 2 未通过, 跳过终验`);
          cascadeResults[mod] = { ...(cascadeResults[mod] || {}), stage3Pass: false };
          return { mod, pass: false, skipped: true };
        }

        // ── Cascade: skip if any upstream module failed Stage 3 ──
        const modIdx = moduleOrder.indexOf(mod);
        const upstreamFailedS3 = moduleOrder.slice(0, Math.max(0, modIdx)).some(u => !cascadeResults[u]?.stage3Pass);
        if (upstreamFailedS3 && modIdx > 0) {
          log(`  ⏭️ ${mod}: 上游模块未全部通过终验, 跳过本模块终验 (等待上游修复)`);
          cascadeResults[mod] = { ...(cascadeResults[mod] || {}), stage3Pass: false };
          return { mod, pass: false, skipped: true, upstreamFailed: true };
        }

        const finalV = String(await agent(
          `最终独立验证: ${mod}

1. 读取 JSON 证据: 02_sim/check_results/${mod}.json
2. 验证: status=PASS 且 compared_points>0
3. 读取 RTL 独立检查:
   - 禁止: initial / disable / force 语句
   - 端口命名: i_/o_ 前缀
   - 复位: i_rst (同步高有效)
4. 最终清理: rm -f wlft* transcript *.wlf vsim.wlf
5. 输出 JSON:
{"module":"${mod}","pass":true|false,"evidence_ok":true|false,"checks":["..."],"issues":["..."]}`,
          { agentType: 'ce-correctness-reviewer', label: `final-verify-${mod}`, phase: 'Phase 4 终验' }
        ) || '');

        const finalVerdict = _parseStrictJsonObject(finalV);
        const fPass = finalVerdict?.pass === true && finalVerdict?.evidence_ok === true;
        cascadeResults[mod] = { ...(cascadeResults[mod] || {}), stage3Pass: fPass };
        return { mod, pass: fPass };
      },
    );

    const passed = results.filter(r => r && r.pass).length;
    const needReview = results.filter(r => r && r.needUserReview).length;
    log(`[Phase 4 汇总] 通过: ${passed}/${moduleList.length}${needReview ? `, 需审查: ${needReview}` : ''}`);
    return `Phase 4 完成: ${passed}/${moduleList.length} (${needReview ? `${needReview} 需审查` : '全部通过'})`;
  },
};
// ═════════════════════════════════════════════════════════════════════════════

nodes.p45_evidence_gate = {
  deps: ['p4_rtl'],
  run: async (ctx) => {
    phase('Phase 4.5 证据门禁');

    // ── Step 1: 确定性证据门禁 (hdl-evidence-gate.cjs 读磁盘判定) ──────────

    log('🔍 [证据门禁] 运行 hdl-evidence-gate.cjs 校验 evidence JSON...');

    let allResults = [];
    if (modules.length === 0) {
      log('⚠️ [证据门禁] 模块列表为空 — 无模块级证据可查, 仅在初始化空项目时可接受。');
    } else {
      const gateRes = await _evidenceGate(`--modules ${modules.join(',')}`, 'p45-evidence', 'Phase 4.5 证据门禁');
      const gateReport = _parseStrictJsonObject(gateRes.gateJson) || {};
      allResults = Array.isArray(gateReport.modules) ? gateReport.modules : [];

      for (const r of allResults) {
        if (r.pass) {
          log(`  ✅ ${r.module}: PASS (${r.compared_points} points, max_err=${r.max_error_lsb ?? 0}LSB)`);
        } else {
          log(`  ❌ ${r.module}: FAIL — ${r.reason}`);
        }
      }

      if (gateRes.ok !== true) {
        throw new Error(
          `❌ [证据门禁] hdl-evidence-gate FAIL:\n${
            gateRes.failures.map(f => `   - ${f}`).join('\n')
          }\nPhase 4 验证未通过, 无法进入 Phase 5 集成。请修复后重试。`
        );
      }
    }

    log('✅ [证据门禁] 文件检查全部通过。所有模块已验证并与 MATLAB golden 一致。');

    // ── Step 2: 高安全模式 — 对抗验证 (仅高安全模块) ──────────

    const activeHighSec = highSecModules.filter(m => modules.includes(m));

    if (activeHighSec.length > 0 && !liteMode) {
      log(`⚠️ [高安全模式] 以下模块需要独立对抗验证: ${activeHighSec.join(', ')}`);
      log('    将独立读取 RTL + MATLAB golden 源码进行逻辑差异分析...');

      const advResult = await agent(`你是**对抗验证者**。以下模块声称已与 MATLAB golden model 逐周期一致。

你的任务: 独立找茬。读 RTL 源码, 读 MATLAB golden, 找任何逻辑差异。

高安全模块: ${activeHighSec.join(', ')}

逐模块检查:
1. RTL 关键数据通路 ↔ MATLAB 对应步骤
2. 位宽/定点格式是否与 Phase 2 报告一致
3. 条件分支/状态机 → 算法步骤映射
4. 反馈环路/累加器/自适应逻辑

输出 JSON 数组:
[
  {"module":"<name>","pass":true},
  {"module":"<name>","pass":false,"issue":"具体差异描述","rtl_file":"<路径>","golden_file":"<路径>"}
]

如果全部 pass → 只输出空数组 []。`, { agentType: 'ce-correctness-reviewer', label: 'p45-adversarial', phase: 'Phase 4.5 证据门禁' });

      try {
        const issues = typeof advResult === 'string' ? JSON.parse(advResult) : advResult;
        if (Array.isArray(issues) && issues.length > 0) {
          const fails = issues.filter(i => i.pass === false);
          if (fails.length > 0) {
            throw new Error(
              `❌ [对抗验证] 发现 ${fails.length} 个不一致:\n${
                fails.map(f => `   - ${f.module}: ${f.issue} (RTL: ${f.rtl_file}, Golden: ${f.golden_file})`).join('\n')
              }`
            );
          }
          log(`✅ [对抗验证] ${activeHighSec.length} 个模块全部通过逻辑检查`);
        } else {
          log(`✅ [对抗验证] 全部通过`);
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          log(`⚠️ [对抗验证] JSON 解析失败, 原始输出:\n${String(advResult).slice(0, 500)}`);
        } else {
          throw e;
        }
      }
    } else if (activeHighSec.length > 0 && liteMode) {
      log(`ℹ️ [高安全模块] Lite 模式跳过对抗验证, 仅文件检查。`);
    } else {
      log(`ℹ️ [标准模式] 所有模块为标准模块, 脚本化对比 + 文件检查已足够。`);
    }

    return {
      pass: true,
      fileCheck: allResults,
      highSecChecked: activeHighSec,
    };
  },
};

// ── 检查点: evidence-review (证据门禁结果呈报, 用户确认后才搭顶层) ──────────

nodes.cp_evidence_review = {
  deps: ['p45_evidence_gate'],
  run: async (ctx) => {
    const gate = ctx.p45_evidence_gate?.data || {};
    log(`[检查点] 证据门禁结果: ${JSON.stringify(gate).slice(0, 400)}`);
    _requireUserCheckpoint(
      'evidence-review',
      '请审查 Phase 4.5 证据门禁报告 (各模块 compared_points / max_error_lsb / 对抗验证结论), 确认后进入顶层集成。'
    );
    log('✅ [检查点] evidence-review 已确认 — 进入顶层集成');
    return 'evidence-review confirmed';
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 5: 顶层集成 + 全链仿真 [MUST] — 多 Agent 发散聚合
// ═════════════════════════════════════════════════════════════════════════════

nodes.p5_top_integration = {
  deps: ['cp_evidence_review'],
  run: async (ctx) => {
    const gateResult = ctx.p45_evidence_gate?.data || {};
    const isTrusted = gateResult.pass === true;
    const modList = modules;

    log(`[Phase 5] 多 Agent 发散聚合: 接口/数据通路/Golden/时序 → 合成`);
    log(`  证据门禁: ${isTrusted ? '✅ 通过' : '⚠️ 状态未知'}`);
    log(`  模块: ${modList.join(', ') || '项目默认'}`);

    // ── Step 1: 并行发散 4 路 Agent ──────────────────────────────────────
    log('  Step 1: 并行分析 (接口/数据通路/Golden/时序)...');

    const [interfaceR, dataPathR, goldenR, timingR] = await parallel([
      // Agent 1: 接口检查 (只读审查 — 顶层缺失由 Agent 3 负责创建, 这里如实报 fail)
      () => agent(
        `[顶层接口检查] 检查所有子模块的接口连接正确性。

模块列表: ${modList.join(', ')}
顶层文件: 01_src/00_hdl/top/top.sv (如果不存在 → 输出 status=fail 说明缺失, 不要创建)

检查项:
1. 每个子模块的端口连接是否完整 (无悬空/漏连)
2. valid/ready 握手链是否贯穿所有模块
3. 位宽匹配: 所有模块间连接信号位宽一致
4. CDC 边界: 跨时钟域信号是否已同步
5. 复位信号: 所有模块使用 i_rst (同步高有效)

输出 JSON 数组:
[{"interface":"<模块A→模块B>","status":"pass|fail|warn","detail":"..."}]`,
        { agentType: 'ce-api-contract-reviewer', label: 'p5-interface', phase: 'Phase 5 顶层集成' }
      ),

      // Agent 2: 数据通路追踪
      () => agent(
        `[顶层数据通路追踪] 从顶层输入到顶层输出追踪数据流。

模块列表: ${modList.join(', ')}
顶层文件: 01_src/00_hdl/top/top.sv

任务:
1. 读取 top.sv 和每个子模块的端口定义
2. 逐级追踪数据流: 顶层输入 → 模块A → 模块B → ... → 顶层输出
3. 每级检查:
   - 数据格式/位宽传递正确
   - 截断/扩展点已标注
   - 流水线延迟对齐
4. 标注首个数据格式变化的点

输出 JSON:
[{"stage":"input→${modList[0] || 'mod1'}","status":"pass|warn","width":N,"format":"...","notes":"..."}]`,
        { agentType: 'ce-architecture-strategist', label: 'p5-datapath', phase: 'Phase 5 顶层集成' }
      ),

      // Agent 3: Golden Model 比对
      () => agent(
        `[顶层 Golden 比对] 检查全链仿真与 Golden Model 的一致性。

模块列表: ${modList.join(', ')}
顶层文件: 01_src/00_hdl/top/top.sv
Golden Model 参考: 07_mat/ 或 08_py/

任务:
1. 创建顶层模块 (top.sv), 例化所有子模块
2. 确认 AXI4-Stream 握手链完整
3. make compile 通过
4. 运行全链仿真, 注入测试向量
5. 逐级捕获中间结果并与 Golden Model 对比
6. 定位: 第一个偏差出现在哪一级?什么信号?什么时间?

[级联追踪 — MUST]
模块链顺序 (从输入到输出): ${modList.join(' → ') || '(未知)'}
从模块 0 (${modList[0] || '首级'}) 开始向前逐级追踪:
  - 如果模块 N 输出错误 → 先检查模块 N-1 的输出是否正确
  - 第一个偏差出现的位置 = 真正的根因模块
  - 下游模块的错误很可能是上游偏差传播的结果
记录 first_deviation.stage 为实际出错的模块名, 而不是最后一级。

7. RTL vs Golden Model 最终对齐:
   - 最终输出必须与定点 Golden Model 逐比特对齐
   - 允许: 定点精度损失 (截位/饱和, 须在报告中注明)
   - 不允许: 算法方向偏离、使用容差掩盖逻辑差异
8. 输出 JSON:
{"overall":"pass|fail","first_deviation":{"stage":"...","signal":"...","time":N,"expected":"...","got":"..."},"compared_points":N,"max_error_lsb":N,"algo_consistent":true|false}

如果没有 EDA 工具环境, 至少检查 architecture.yaml 中的 pipeline 定义与顶层连接的一致性。`,
        { agentType: 'logic-engineer', label: 'p5-golden', phase: 'Phase 5 顶层集成' }
      ),

      // Agent 4: 资源/时序预估
      () => agent(
        `[顶层资源/时序预估] 评估顶层集成的资源和时序风险。

模块列表: ${modList.join(', ')}
顶层文件: 01_src/00_hdl/top/top.sv

任务:
1. 读取每个子模块接口, 估算顶层总资源
2. 检查关键路径: longest combinational path
3. 复位域/时钟域拓扑:
   - 是否存在跨时钟域路径未同步?
   - 所有模块复位一致 (i_rst 同步高有效)?
4. 流水线完整性: 各级延迟是否匹配?
5. 输出 JSON:
{"resource":{"lut_est":N,"dsp_est":N,"bram_est":N},"timing":{"critical_path":"...","fmax_est":"...MHz"},"cdc_issues":["..."],"pipeline_issues":["..."]}`,
        { agentType: 'ce-performance-oracle', label: 'p5-timing', phase: 'Phase 5 顶层集成' }
      ),
    ]);

    // ── Step 2: 合成分析 ─────────────────────────────────────────────────
    log('  Step 2: 合成分析结果...');

    const synthesis = String(await agent(
      `[顶层集成合成分析] 聚合以下 4 路分析结果, 锁定根因。

===== 接口检查 =====
${String(interfaceR || 'N/A').slice(0, 1000)}
===== 数据通路 =====
${String(dataPathR || 'N/A').slice(0, 1000)}
===== Golden 比对 =====
${String(goldenR || 'N/A').slice(0, 1000)}
===== 资源/时序 =====
${String(timingR || 'N/A').slice(0, 1000)}

任务:
1. 评估以上 4 路结果
2. 如果有问题 → 锁定根因模块/信号/接口
3. 区分: "接口连接错误" vs "模块逻辑错误" vs "Golden 模型不一致"

[级联根因分析 — MUST]
模块链: ${modList.join(' → ') || '(未知)'}
当多个级联模块同时出现错误时:
  - 最可能的根因是链中首个出错的模块 (离输入最近)
  - 下游模块的"错误"通常是上游错误传播的结果
  - 在 issues 中标注每个问题是 "根因" 还是 "传播性错误"
root_cause 必须指向链中最上游的故障模块。

4. 输出 JSON:
{
  "overall":"pass|fail|warn",
  "issues":[{"severity":"critical|warning","module":"...","signal":"...","description":"..."}],
  "root_cause":"...",
  "fix_suggestion":"..."
}`,
      { label: 'p5-synthesis', phase: 'Phase 5 顶层集成' }
    ) || '');

    // ── Step 3: 定向修复 (如果发现问题) ──────────────────────────────────
    const synthLower = synthesis.toLowerCase();

    if (synthLower.includes('"overall":"fail"') || synthLower.includes('"overall":"warn"')) {
      log('  Step 3: 发现顶层问题, 执行定向修复...');

      const fixOut = String(await agent(
        `[顶层定向修复] 根据合成分析的根因定位, 只修复问题模块。

合成分析 (根因):
${synthesis.slice(0, 1500)}

任务:
1. 只修复报告中指出的问题模块/信号
2. 不要修改无关模块 (fix-in-place 原则)
3. 修改后 make compile 验证
4. 输出 JSON:
{"fixed":true|false,"modules_changed":["..."],"changes":["..."],"compile_pass":true|false}`,
        { agentType: 'logic-engineer', label: 'p5-fix', phase: 'Phase 5 顶层集成' }
      ) || '');

      // 修复验证
      const verifyFix = String(await agent(
        `[修复验证] 验证顶层修复是否生效。

修复内容:
${fixOut.slice(0, 1000)}

1. make compile 检查是否编译通过
2. 运行全链仿真 (make sim_top)
3. 对比 Golden Model
4. 检查之前发现的问题是否解决
5. 输出 JSON: {"pass":true|false,"evidence_ok":true|false,"reason":"..."}`,
        { agentType: 'logic-engineer', label: 'p5-verify-fix', phase: 'Phase 5 顶层集成' }
      ) || '');

      const verifyFixVerdict = _parseStrictJsonObject(verifyFix);
      const verifyFixPass = verifyFixVerdict?.pass === true && verifyFixVerdict?.evidence_ok === true;
      log(`  修复验证: ${verifyFixPass ? '✅ 通过' : '⚠️ 可能需要再次迭代'}`);
    } else {
      log('  ✅ 顶层分析通过, 无需修复');
    }

    // ── 压缩保留块: Phase 5 顶层集成 ────────────────────────────
    log('');
    log('📌 === 压缩保留块: Phase 5 顶层集成 ===');
    log('保留原因: 全链仿真结果是 RTL 与 Golden Model bit-true 对齐的最终证据');
    log('分析维度: 接口检查 / 数据通路 / Golden 比对 / 资源时序');
    log(`模块: ${modList.join(', ') || '项目默认'}`);
    log('合成结论: ' + (synthLower.includes('"overall":"pass"') ? '✅ 通过' : '⚠️ 见问题列表'));
    log('=== 保留块结束 ===');
    log('');

    return synthesis;
  },
};

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

输出: regress 全绿 (或真实编译/仿真日志)`, { agentType: 'logic-engineer', label: 'p6-regression', phase: 'Phase 6 回归覆盖率' });
    return result;
  },
};

// ── Phase 7: 代码审查 (双专业审查员并行: 正确性 + 接口契约) ─────────────────

nodes.p7_review = {
  deps: ['p5_top_integration'],
  run: async (ctx) => {
    const top = ctx.p5_top_integration?.data || '';
    const [correctness, contract] = await parallel([
      () => agent(`执行 HDL 工作流 Phase 7: 代码审查 (正确性维度)

顶层集成: ${String(top).slice(0, 400)}

审查维度:
1. 时序安全 (输入寄存/输出寄存/CDC)
2. 命名规范 (ri_/ro_/i_/o_)
3. 状态机 (三段式 + default)
4. Lint 门禁 (make lint pass)
5. 位宽匹配 / latch 推断 / 组合环路
6. 模型一致性检查:
   - 关键信号命名是否与 MATLAB golden model 对应变量一致?
   - 位宽/定点格式是否与 Phase 2 报告一致?
   - 模块命名是否与 architecture.yaml 一致?
7. [工具链] 如有 EDA 工具链约束 (如 ModelSim 10.6c 禁令),
   检查 RTL 是否违规

输出: 审查报告 PASS/FAIL + 修改建议`, { agentType: 'ce-correctness-reviewer', label: 'p7-review-correctness', phase: 'Phase 7 代码审查' }),

      () => agent(`执行 HDL 工作流 Phase 7: 代码审查 (接口契约维度)

顶层集成: ${String(top).slice(0, 400)}

审查维度:
1. valid-ready 握手时序 (valid 不得依赖 ready)
2. 端口位宽与 architecture.yaml / interface_contract.md 一致
3. AXI-Stream 合规 (tvalid/tready/tlast/tkeep)
4. CDC 边界完整性 (跨时钟信号清单 vs clock_domain.md)
5. 例化悬空端口

输出: 审查报告 PASS/FAIL + 修改建议`, { agentType: 'ce-api-contract-reviewer', label: 'p7-review-contract', phase: 'Phase 7 代码审查' }),
    ]);

    return `[正确性审查]\n${String(correctness || 'N/A').slice(0, 1200)}\n\n[接口契约审查]\n${String(contract || 'N/A').slice(0, 1200)}`;
  },
};

// ── Phase 8: 报告输出 ──────────────────────────────────────────────────────

nodes.p8_report = {
  deps: ['p6_regression', 'p7_review'],
  run: async (ctx) => {
    const regression = ctx.p6_regression?.data || '';
    const review = ctx.p7_review?.data || '';
    const result = await agent(`生成 HDL 工作流 Phase 8: 总结报告 + 清理

回归结果: ${String(regression).slice(0, 300)}
审查结果: ${String(review).slice(0, 300)}

输出:
1. 汇总实现报告 (含全链验证矩阵)
2. 文档归档
3. 经验记录

━━━ 清理 [MUST] ━━━
4. 运行 make clean 删除以下 transient 文件:
   - wlft*           (ModelSim 随机名波形文件)
   - transcript      (ModelSim 日志)
   - *.wlf vsim.wlf  (波形文件)
   - vish_stacktrace.vstf vsim_stacktrace.vstf
   - 02_sim/work*/   (Vivado 仿真缓存)
   - work/           (ModelSim 编译库)
   - transcript      (ModelSim 日志)
   - *.wlf vsim.wlf  (波形文件)
   - *.vcd *.vcd.lxt (VCD dump)
   - __pycache__/ *.pyc (Python 缓存)
5. 确认仅保留: 01_src/ 02_sim/tv/ 02_sim/check_results/ 06_doc/ 07_mat/ 08_py/ 下的必要文件
━━━━━━━━━━━━`, { label: 'p8-report' });
    return result;
  },
};

// ── Verifier (终验节点) ────────────────────────────────────────────────────

nodes.verifier = {
  deps: ['p8_report'],
  run: async (ctx) => {
    const report = ctx.p8_report?.data || '';
    const gateResult = ctx.p45_evidence_gate?.data || {};

    const summary = [
      '## Phase 0 基础设施',     ctx.p0_infra?.data || 'N/A',
      '## Phase 1a 系统方案',   ctx.p1a_sys_design?.data?.slice(0, 300) || 'N/A',
      '## Phase 1b 微架构',     ctx.p1b_micro_arch?.data || 'N/A',
      '## Phase 2 定点量化',     ctx.p2_fixedpt?.data || 'N/A',
      '## Phase 3 TB+向量生成',  ctx.p3_tb?.data || 'N/A',
      '## Phase 4 RTL+脚本对比', ctx.p4_rtl?.data || 'N/A',
      '## Phase 4.5 证据门禁',   JSON.stringify(gateResult).slice(0, 500) || 'N/A',
      '## Phase 5 全链仿真',     ctx.p5_top_integration?.data || 'N/A',
      '## Phase 6 回归',         ctx.p6_regression?.data || 'N/A',
      '## Phase 7 审查',         ctx.p7_review?.data || 'N/A',
      '## Phase 8 报告',         report,
    ].join('\n\n');

    const result = await agent(`你是一个**跨阶段校验者**。审以下 HDL 开发工作流的全链路结果是否满足要求。

逐条检查:
1. 所有 10 个 Phase 是否都有输出
2. Phase 4 验证矩阵: 所有模块 ✅?
3. **Phase 4.5 证据门禁**: check_results/*.json 文件:
   - 所有模块都有对应 .json 文件?
   - 所有 status==PASS?
   - compared_points > 0?
4. Phase 5 全链仿真各中间级与 MATLAB golden model 一致?
5. Phase 6 回归是否通过 (要求真实编译/仿真)
6. Phase 7 审查是否通过
7. **对照 architecture.yaml 模块列表**: 有没有模块遗漏验证?
8. 是否适用于模块: ${modules.join(', ') || '项目默认'}

结果摘要:
${summary.slice(0, 3000)}

输出 JSON:
{
  "pass": true/false,
  "reason": "通过 或 说明缺哪条要求",
  "missing": ["缺失项列表"],
  "strongest_phase": "表现最好的阶段",
  "weakest_phase": "需改进的阶段"
}`, { label: 'verifier' });
    return result;
  },
};

// ── Lite 模式：重写依赖链 ──────────────────────────────────────────────────

if (liteMode) {
  nodes.p4_rtl.deps = ['p3_tb'];
  nodes.p8_report.deps = ['p7_review'];

  nodes.p2_fixedpt.run = async () => '[SKIPPED] Lite 模式 — 定点量化跳过';
  nodes.p6_regression.run = async () => '[SKIPPED] Lite 模式 — 覆盖率回归跳过';

  log('   依赖链: P0→P1a→P1b→CP(design)→P3→P4→P45→CP(evidence)→P5→P7→P8→Verifier');
  log('   (跳过节点: P2 定点量化, P6 覆盖率回归; 检查点保留)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pre-flight 检查
// ═══════════════════════════════════════════════════════════════════════════════

phase('Pre-flight 检查');

const preflightSummary = [
  '━━━ Pre-flight 任务理解检查 ━━━',
  `模块列表: ${modules.join(', ') || '(空 — 将使用项目默认模块)'}`,
  `模式: ${liteMode ? 'Lite (跳过定点+覆盖率回归)' : '完整'}`,
  `项目根目录: ${projectRoot}`,
  `高安全模块: ${highSecModules.length > 0 ? highSecModules.join(', ') : '(无)'}`,
  `标准模块: ${stdModules.length > 0 ? stdModules.join(', ') : '(无)'}`,
  '',
  '请在开始前确认:',
  '  1. 以上模块列表是否完整且正确?',
  '  2. 模块间数据流关系是否清楚?',
  '  3. MATLAB Golden Model 是否就位?',
  '  4. 项目目录结构是否符合预期 (01_src/02_sim/...)?',
  '  5. 如果任一答案是否 → 请先澄清，不要直接开始。',
  '',
  '📋 检查点体系 (每个未确认时工作流暂停, 带确认参数 + resumeFromRunId 续跑):',
  '  preflight       — 本清单 (args.confirmed=true)',
  '  design-review   — P1a/P1b 设计产出审查, 按 gate-checklist-p1a/p1b.md 核对',
  '                    (args.checkpoints["design-review"].confirmed=true)',
  '  evidence-review — Phase 4.5 证据门禁报告审查',
  '                    (args.checkpoints["evidence-review"].confirmed=true)',
  '  verifier        — 末端自动终验 (pass=true 才算完成, 无需用户确认)',
  '  无人值守: args.confirmAllCheckpoints=true 显式跳过全部用户检查点',
  '  Phase 4.5 判定由确定性脚本 engine/scripts/hdl-evidence-gate.cjs 完成',
  '',
  'DAG 依赖链:',
  liteMode
    ? '  P0→P1a→P1b→CP(design)→P3→P4→P45→CP(evidence)→P5→P7→P8→Verifier (跳过 P2,P6)'
    : '  P0→P1a→P1b→CP(design)→P2/P3并行→P4→P45→CP(evidence)→P5→P6/P7并行→P8→Verifier',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
].join('\n');

log(preflightSummary);

_requireUserCheckpoint(
  'preflight',
  'Review the preflight summary, clarify any ambiguity with the user, then rerun with args.confirmed=true or args.checkpoints.preflight.confirmed=true.'
);

if (modules.length === 0) {
  log('⚠️ 警告: 模块列表为空。如果是有意初始化新项目请忽略此警告。');
  log('   如果是执行已有模块的开发流程，请传入 modules 参数。');
}

// ── 执行 DAG ──────────────────────────────────────────────────────────────

phase('DAG 执行');
const dagResult = await _dagExecute(nodes, {
  onProgress: (layer, total, names) => log(`[层 ${layer}/${total}] ${names}`),
  log,
});

// ── 输出摘要 ──────────────────────────────────────────────────────────────

const verifierOutput = dagResult.results.verifier?.data || '';
log('=== DAG 工作流完成 ===');

let parsedVerifier;
try {
  parsedVerifier = typeof verifierOutput === 'string' ? JSON.parse(verifierOutput) : verifierOutput;
} catch (e) {
  throw new Error(`Verifier output must be valid JSON. parse_error=${e.message}; raw=${String(verifierOutput).slice(0, 500)}`);
}

if (parsedVerifier.pass) {
  log(`✅ Verifier: 通过 — ${parsedVerifier.reason || ''}`);
} else {
  log(`❌ Verifier: 不通过 — ${parsedVerifier.reason || ''}`);
  if (parsedVerifier.missing) log(`缺失: ${parsedVerifier.missing.join(', ')}`);
  throw new Error(`Verifier failed: ${parsedVerifier.reason || 'missing pass=true'}`);
}

if (stdModules.length > 0) {
  log(`📦 标准模式模块 (${stdModules.length}): ${stdModules.join(', ')} — 脚本对比+文件门禁`);
}
if (highSecModules.length > 0) {
  log(`🔒 高安全模式模块 (${highSecModules.length}): ${highSecModules.join(', ')} — 脚本对比+文件门禁+对抗验证`);
}

return {
  nodeCount: dagResult.nodeCount,
  layerCount: dagResult.layerCount,
  results: Object.fromEntries(
    Object.entries(dagResult.results).map(([k, v]) => [k, { status: v.status, dataLength: String(v.data || '').length }])
  ),
  moduleClassification: {
    standard: stdModules,
    highSecurity: highSecModules,
  },
  verifier: parsedVerifier,
};
