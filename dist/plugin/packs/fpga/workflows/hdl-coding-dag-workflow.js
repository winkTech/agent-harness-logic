/**
 * hdl-coding-dag-workflow — HDL RTL 开发 DAG 工作流 v3.7.0
 *
 * 本文件是该工作流的**单一真源** (workflows/ 目录, 供 Workflow({name}) 解析)。
 * skills/workflows/hdl-coding-workflow.md 是它的方法论文档, 以本文件为准。
 * 注意: .claude/workflows/ 下有一份镜像副本, 改本文件后须同步。
 *
 * v3.7 — Xilinx 官方方法学接入 (UG901/UG949):
 *   新增 Phase 6b (p6b_vivado_check), 与 P6 回归/P7 审查并行, 汇入 P8。
 *   仿真只证明功能对, 证明不了综合器把代码变成了什么 —— 推断静默失败
 *   (BRAM 输出寄存器没吸收 / DSP 没流水 / SRL 掉成 FF 链) 不报错, 只掉性能。
 *
 * v3.7.1 — Vivado 入口收敛 (2026-07-27):
 *   原先 Phase 6b 调 packs/fpga/skills/hdl-coding/templates/tcl/ 下两个脚本
 *   (vivado_rtl_check.tcl + vivado_synth_report.tcl)。二者是 vivado-flow 技能里
 *   vivado_flow.tcl 的 rtlcheck / synth 两阶段的子集, 留两套必然漂移, 已删除。
 *   现在统一走 packs/fpga/skills/vivado-flow/scripts/vivado_flow.tcl:
 *     一条命令跑 rtlcheck → synth, 逐阶段存 DCP 可断点续跑,
 *     证据汇总为 <out>/rpt/flow_summary.json (嵌套结构, 按阶段分段)。
 *   阻断条件: 脚本 ok=false, 或 critical+errors > 0, 或 WNS < 0, 或有推断失败项。
 *   Vivado 不可用 → 如实 skipped, 不阻断, 但 P8 报告与 Verifier 必须标注
 *   "综合级结论未验证"。
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
 *     projectRoot: '[PROJECT_DIR]',       // 可选
 *     part: 'xc7a100tcsg324-2',                 // 可选，Phase 6b 目标器件 (不传则自动查找)
 *     lite: false,                              // 可选 Lite 模式
 *     confirmed: true,                          // 确认 preflight 检查点
 *     checkpoints: {                            // 逐检查点确认 (配合 resumeFromRunId)
 *       'layout-review': {confirmed: true},
 *       'system-review': {confirmed: true},
 *       'design-review': {confirmed: true},
 *       'evidence-review': {confirmed: true},
 *     },
 *     confirmAllCheckpoints: true,              // 无人值守模式: 显式跳过全部用户检查点
 *   }})
 */

const { join: pathJoin } = { join: (...p) => p.join('/').replace(/\/+/g, '/') };

function _parseStrictJsonObject(raw) {
  if (raw && typeof raw === 'object') return Array.isArray(raw) ? null : raw;
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
    `(宿主仅复用经回执校验的步骤); 无人值守场景用 args.confirmAllCheckpoints=true。`
  );
}

// Capabilities come from the workflow host, never from project arguments.
function hasAction(kind) {
  return typeof workflowAction === 'function' &&
    (typeof workflowAction.supports !== 'function' || workflowAction.supports(kind) === true);
}

function hasExplicitAction(kind) {
  return typeof workflowAction === 'function' &&
    typeof workflowAction.supports === 'function' && workflowAction.supports(kind) === true;
}

async function modelStep(instructions, options, {kind = 'handoff', required = {}, evidence = []} = {}) {
  // The host may change recipients or compact history between any two dispatches.
  const packet = {kind,scope:projectRoot,required:{instructions,...required},evidence};
  const prompt = typeof workflowContext === 'function' ? workflowContext(packet,options).prompt :
    [instructions, ...Object.entries(required).map(([key,value]) => key + ': ' + JSON.stringify(value)),
      ...evidence.map(item => [item.ref,item.summary].filter(Boolean).join(' — '))].join('\n');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Workflow context did not contain an actionable prompt');
  return agent(prompt,options);
}

const EVIDENCE_GATE_SCRIPT = args?.evidenceGateScript || 'core/engine/scripts/hdl-evidence-gate.cjs';

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

async function _evidenceGate(argv, label, phaseName) {
  const flags = argv.map((value,i) => argv[i-1] === '--modules' ? "'" + value + "'" : value).join(' ');
  const cmd = `node "${EVIDENCE_GATE_SCRIPT}" --project-root "${projectRoot}" ${flags}`;
  const res = hasAction('evidence') ? await workflowAction({kind:'evidence',projectRoot,label,argv}) : await agent(
    `你是**证据搬运者**。你的唯一任务是执行下面的确定性证据门禁命令, 并把它的输出原样带回。

命令:
  ${cmd}

说明:
- 从本次工作流所在插件根目录解析脚本，项目根目录使用实际项目绝对路径。以独立字面参数调用 Node。
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

// ── 模块顺序: 由代码图核对, 而不是信手写的 ─────────────────────────────────
//
// moduleOrder 决定 Phase 4 的 cascade 门禁 (上游没过就不调下游)。它一直是调用方
// 手写的, 写错了没有任何东西会报错 —— 门禁会按错误的上下游关系安静地放行。
// 代码图里有真实的例化层次, 拿它核对: 父模块不得排在它例化的子模块之前。
//
// 工作流跑在受限 JS 沙箱 (没有 require/fs), 所以查询由 CLI 承担, 这里只搬运结果。
const MODULE_ORDER_SCRIPT = args?.moduleOrderScript || 'core/engine/scripts/module-order.cjs';

const TOPOLOGY_SCHEMA = {
  type: 'object',
  properties: {
    executed: { type: 'boolean' },
    ok: { type: 'boolean' },
    staleIndex: { type: 'boolean' },
    suggestion: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    unknown: { type: 'array', items: { type: 'string' } },
    raw: { type: 'string' },
  },
  required: ['executed', 'ok'],
};

/**
 * 用代码图核对 moduleOrder。
 * @param {string} label
 * @param {string} phaseName
 * @param {boolean} reindex — 先跑一次增量索引 (Phase 4 之后 RTL 才存在)
 */
async function _checkModuleOrder(label, phaseName, reindex) {
  if (modules.length === 0) return { skipped: true, reason: 'no_modules' };

  const syncCmd = reindex
    ? `node core/engine/scripts/code-graph-index.cjs sync "${projectRoot}" && `
    : '';
  const cmd = `${syncCmd}node ${MODULE_ORDER_SCRIPT} --project "${projectRoot}" `
    + `--modules ${moduleOrder.join(',')} --check`;

  const res = hasAction('module-order') ? await workflowAction({kind:'module-order',projectRoot,label,modules:[...moduleOrder],reindex}) : await agent(
    `你是**命令搬运者**。执行下面的命令, 把输出原样带回, 不做任何判断。

命令:
  ${cmd}

说明:
- 脚本在 Claude harness 根目录 (通常 ~/.claude)。相对路径找不到时改用绝对路径重试一次。
- 命令输出一个 JSON 对象。顺序有矛盾时退出码为 1, 这**不是**你的错, 照实带回。

结构化返回 (禁止改写脚本输出的任何值):
- executed: 命令是否真的执行了 (执行不了 → false)
- ok: JSON 里的 ok 原值
- staleIndex: JSON 里的 staleIndex 原值 (没有该字段则 false)
- suggestion: JSON 里的 suggestion 数组原值 (没有则空数组)
- contradictions: JSON 里 contradictions 每项的 detail 字符串 (没有则空数组)
- unknown: JSON 里的 unknown 数组原值 (没有则空数组)
- raw: 完整 JSON 文本`,
    { label, phase: phaseName, schema: TOPOLOGY_SCHEMA }
  );

  if (!res || res.executed !== true) {
    // 拓扑核对是助推器不是门禁: 查不了就照原顺序走, 但必须说出来
    log(`⚠ [模块顺序] 核对命令未能执行, 沿用调用方给定顺序: ${moduleOrder.join(' → ')}`);
    return { skipped: true, reason: 'not_executed' };
  }
  if (res.staleIndex === true) {
    log('⚠ [模块顺序] 代码图索引不新鲜, 未做核对 (拿过期的图排验证顺序比手写更危险)');
    return { skipped: true, reason: 'stale_index' };
  }
  if ((res.unknown || []).length > 0) {
    log(`ℹ [模块顺序] 图中尚无这些模块 (还没编码或名字不符): ${res.unknown.join(', ')}`);
  }
  if (res.ok === true) {
    log(`✅ [模块顺序] 与代码图例化层次一致: ${moduleOrder.join(' → ')}`);
    return { ok: true, order: moduleOrder.slice() };
  }

  for (const item of res.contradictions || []) log(`❌ [模块顺序] ${item}`);
  const suggestion = (res.suggestion || []).filter(name => modules.includes(name));
  if (suggestion.length === modules.length) {
    const before = moduleOrder.join(' → ');
    moduleOrder = suggestion;
    log(`🔁 [模块顺序] 已按代码图纠正: ${before}  ⇒  ${moduleOrder.join(' → ')}`);
    return { ok: false, corrected: true, order: moduleOrder.slice() };
  }
  log('⚠ [模块顺序] 图给出的建议顺序不完整, 保持原顺序, 但上面的矛盾必须人工确认');
  return { ok: false, corrected: false, order: moduleOrder.slice() };
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
      const checkpointFailure = failures.find(f => String(f.error).includes('[WorkflowCheckpoint:'));
      if (checkpointFailure && failures.length === 1) {
        logFn(`  暂停: ${checkpointFailure.error}`);
        throw new Error(checkpointFailure.error); // 保留检查点原始消息与续跑指引
      }
      for (const f of failures) logFn(`  ❌ ${f.name}: ${String(f.error).slice(0, 200)}`);
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
  description: 'HDL RTL 开发 DAG 工作流 v3.7 — P1a(系统方案)+P1b(微架构)双阶段设计, hdl-evidence-gate.cjs 确定性证据门禁, P6b Vivado 综合体检 (UG901/UG949 方法学证据), 可恢复检查点, 专业 agent 分工 (Verifier终验)',
  phases: [
    { title: 'Phase 0 基础设施' },
    { title: 'Phase 1a 系统方案设计' },
    { title: 'Phase 1b 微架构设计' },
    { title: 'Phase 2 定点量化' },
    { title: 'Phase 3 TB+向量生成' },
    { title: 'Phase 4 RTL编码+脚本化对比' },
    { title: 'Phase 4.4 层次回查' },
    { title: 'Phase 4.5 证据门禁' },
    { title: 'Phase 5 顶层集成+全链仿真' },
    { title: 'Phase 6 回归覆盖率' },
    { title: 'Phase 6b Vivado 综合体检' },
    { title: 'Phase 7 代码审查' },
    { title: 'Phase 8 报告+Verifier' },
  ],
  contract: {
    version: 2,
    strict: true,
    inputs: ['modules', 'projectRoot', 'goldenBaseline: {entry, cases, tools?, limits?} (原入口、必测工况、必需工具、逐工况的实测数值约束)', 'stopAfter: p3 (仅授权 P2/P3 准备时设置)', 'resourceLimits: {DSP?, LUT?, BRAM?} (已确认的 P2 硬上限，按项目统一单位)', 'confirmed/checkpoints.<name>.confirmed', 'confirmAllCheckpoints (无人值守)'],
    checkpoints: ['preflight', 'layout-review', 'system-review', 'design-review', 'evidence-review', 'verifier'],
    evidence: [
      'core/engine/scripts/hdl-evidence-gate.cjs (确定性判定 + RESULT: PASS/FAIL)',
      '06_doc/architecture.yaml',
      '02_sim/check_results/*.json',
      'Phase 4.5 evidence gate',
      '04_prj/rpt/flow_summary.json (Phase 6b, Vivado 可用时; 由 vivado-flow 技能产出)',
    ],
    completionCriteria: [
      'preflight user checkpoint is confirmed',
      'layout-review, system-review, design-review and evidence-review checkpoints confirmed (or confirmAllCheckpoints)',
      'hdl-evidence-gate.cjs returns ok=true for all modules',
      'Phase 6b: Vivado 可用时 critical+errors=0 且 WNS>=0; 不可用时报告显式标注未验证',
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
    toolDegradation: {
      p6b_vivado_check: 'Vivado 不可用时如实返回 skipped, 不阻断流程; 但报告与 Verifier 必须标注综合级结论未验证',
    },
  },
};

// ── 主参数 ─────────────────────────────────────────────────────────────────

const modules = args?.modules || [];
// Cascade dependency order。调用方给的是初值, Phase 0 与 Phase 4.4 会用代码图的
// 例化层次核对并在矛盾时纠正 (见 _checkModuleOrder), 所以这里必须是 let。
let moduleOrder = args?.moduleOrder || modules;
const liteMode = args?.lite === true;
if (args?.stopAfter !== undefined && args.stopAfter !== 'p3') throw new Error('stopAfter must be p3 when limiting execution to verification preparation');
const preparationOnly = args?.stopAfter === 'p3';
let verifiedFixedPointDigest;
const resourceLimits = args?.resourceLimits ?? {};
if (typeof resourceLimits !== 'object' || Array.isArray(resourceLimits) ||
    Object.entries(resourceLimits).some(([name, limit]) => !['DSP', 'LUT', 'BRAM'].includes(name) || !Number.isFinite(limit) || limit < 0)) {
  throw new Error('resourceLimits must contain nonnegative numeric DSP, LUT or BRAM limits');
}
const limitFlags = Object.entries(resourceLimits).flatMap(([name, limit]) => ['--hard-limit',name+'='+limit]);
if (liteMode && limitFlags.length) throw new Error('P2 hard resource limits require full mode; Lite skips P2');
function checkedHardLimits(report) {
  return Object.entries(resourceLimits).every(([name, limit]) => report?.hardLimits?.[name] === limit);
}
function checkedBaselineScope(report) {
  const expected = args?.goldenBaseline;
  if (!expected) return true;
  const scope = report?.fixedBaseline;
  return scope?.entry === expected.entry && expected.cases.every(name => scope.cases?.includes(name))
    && (expected.limits ?? []).every(l => scope.limits?.some(s => s.case === l.case && s.metric === l.metric
      && s.min === l.min && s.max === l.max));
}
const projectRoot = args?.projectRoot || '.';  // v3.5.1: process.cwd() 不可用
const fpgaPart = args?.part || args?.device || '';  // v3.7: Phase 6b Vivado 体检的目标器件

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

// ── Phase 0: 模块顺序核对 (无依赖, 与基础设施并行) ──────────────────────────
//
// 对全新设计, 此时 RTL 还不存在, 图里查不到模块 → 只会打一行 "图中尚无这些模块",
// 不产生任何干扰。有价值的是**在既有代码上继续干**的场景: 顺序写反会让 Phase 4
// 的 cascade 门禁拿子模块的旧结论去放行父模块。
nodes.p0_topology = {
  deps: [],
  run: async () => _checkModuleOrder('p0-module-order', 'Phase 0 基础设施', false),
};

// ── Phase 0: 基础设施 (无依赖) ──────────────────────────────────────────────

nodes.p0_infra = {
  deps: [],
  run: async () => {
    if (hasExplicitAction('infra')) {
      const receipt = await workflowAction({kind:'infra',projectRoot,label:'p0-infra',modules});
      if (!receipt || receipt.executed !== true || receipt.ok !== true) {
        throw new Error('P0 deterministic infra failed: ' + (receipt?.reason || 'missing contract receipt'));
      }
      return receipt.summary || 'canonical HDL layout verified';
    }
    const result = await modelStep(`Phase 0 基础设施 (${modules.join(', ') || '项目默认'}):
1. 建标准目录: 01_src/{00_hdl,01_ip} 02_sim/{tv,check_results} 03_xdc 04_prj 05_bin 06_doc 07_mat 08_py README.md，写 var/project-init/directory-contract.json。
2. Makefile 含 lint/compile/sim/clean (clean 删 work/ transcript *.wlf vsim.wlf *.wdb xsim.dir/ __pycache__/ *.vcd)；.gitignore 排除上述瞬态物。
3. 临时正/反 HDL 探针验 lint/compile (不写项目 RTL；缺 RTL 根报错；空工程记“无设计源文件”)。Git 工程在隔离检出核对目录恢复与冻结 Golden 摘要。
返回目录清单、工具探针结果与源码状态。`, { label: 'p0-infra', modelTier: 'fast' });
    return result;
  },
};

// ── Phase 1a: 系统级方案设计 (算法工程师) ──────────────────────────────────

nodes.p1a_sys_design = {
  // 依赖 p0_topology 只是为了保证顺序纠正发生在 Phase 4 读取 moduleOrder 之前
  deps: ['p0_infra', 'p0_topology'],
  run: async () => {
    _requireUserCheckpoint('layout-review', 'Review the P0 directory manifest and build entry points before system design.');
    const result = await modelStep(`Phase 1a 系统方案设计 (${modules.join(', ') || '项目默认'}) — 产出 06_doc/ 六份文档并满足 gate-checklist-p1a.md:
- A1 system_context.md: 链路位置、前后级、输入特性(SNR/带宽/符号率/幅度)、约束(Fclk/延迟/吞吐/面积)、指标(EVM/BER/锁定时间)
- A2 algorithm_derivation.md: 第一性原理完整推导与近似误差分析
- A3 tradeoff_analysis.md: ≥2 候选方案在性能/复杂度/存储/收敛/数值稳定性五维表格对比及否选理由
- A4 signal_chain_analysis.md: 逐级信号形态、幅度、SNR、动态余量与瓶颈标注
- A5 performance_bounds.md: 理论界(CRLB/Shannon等)与预期差值 dB
- A6 fixed_point_strategy.md: 逐级位宽、Q 格式草案、溢出/截断策略
[红线] 全项目统一同步高有效复位 i_rst (always_ff @(posedge clk) if (i_rst))，禁 rst_n/异步复位。`,
      { agentType: 'algorithm-engineer', label: 'p1a-system-design', phase: 'Phase 1a 系统方案设计', modelTier: 'deep' });
    return result;
  },
};

// ── Phase 1b: 微架构设计 (算法工程师 + 逻辑工程师) ─────────────────────────

nodes.p1b_micro_arch = {
  deps: ['p1a_sys_design'],
  run: async (ctx) => {
    _requireUserCheckpoint('system-review', 'Review the six P1a design documents against the system checklist before microarchitecture.');
    const sysDesign = ctx.p1a_sys_design?.data || '';
    const sysHint = String(sysDesign).slice(0, 400);
    const sysEvidence = sysHint ? [{id:'p1a-summary',ref:'06_doc/system_context.md',summary:sysHint}] : [{id:'p1a-summary',ref:'06_doc/system_context.md'}];

    const [algoArch, logicArch] = await parallel([
      // ── 算法工程师: 模块分解 + 接口定义 ──────────────────────
      () => modelStep(`Phase 1b 微架构-算法 (${modules.join(', ') || '项目默认'}):
1. 按信号链拆模块并定义端口/位宽/握手；全模块统一同步高有效 i_rst。
2. 写 06_doc/architecture.yaml [MUST]: modules[{name,type,matlab_ref,symmetric_with,pipeline_stages[{name,function,latency,bit_width,q_format}],fsm_states[{name,description,transitions}]}], pair_conventions。
3. 写 06_doc/interface_contract.md (握手与时序)、06_doc/algorithm_spec.md (逐模块步骤)、06_doc/pipeline_diagram.md。`,
        { agentType: 'algorithm-engineer', label: 'p1b-algo-arch', phase: 'Phase 1b 微架构设计', modelTier: 'deep' },
        { required: { modules }, evidence: sysEvidence }),

      // ── 逻辑工程师: 架构评估 + 资源/时序预估 ────────────────
      () => modelStep(`Phase 1b 微架构-逻辑 (${modules.join(', ') || '项目默认'}) — 满足 gate-checklist-p1b.md:
- B1 06_doc/architecture_tradeoff.md: ≥2 架构(并行/折叠/串行)四维定量对比(面积/延迟/吞吐/Fmax)
- B2 06_doc/resource_budget_tracking.md: DSP/LUT/BRAM 逐级预估与预算核对
- B3 06_doc/timing_estimate.md: 组合级数、关键路径与流水插入策略
- B4 审 06_doc/interface_contract.md: 握手可综合、反压可行、输出均可由实际输入/本地存储推导(禁靠 scoreboard 补输入)、统一同步高有效 i_rst
- B5 06_doc/verification_strategy.md + var/workflow/p3-plan.json (记 strategySha256、modules 场景 ID、interfaceContractSha256；缺失来源退回 design-review)
- B6 06_doc/clock_domain.md: 时钟域图、CDC 方案与异步 FIFO 深度`,
        { agentType: 'logic-engineer', label: 'p1b-logic-arch', phase: 'Phase 1b 微架构设计', modelTier: 'deep' },
        { required: { modules }, evidence: sysEvidence }),
    ]);

    // ── 校验 architecture.yaml 完整性 (确定性脚本判定) ─────────
    log(`🔍 校验 architecture.yaml (hdl-evidence-gate --arch)`);
    const archGate = await _evidenceGate(['--arch'], 'p1b-arch-evidence', 'Phase 1b 微架构设计');
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
    const arch = String(ctx.p1b_micro_arch?.data || '').slice(0, 300);
    const archEv = arch ? [{id:'arch',ref:'06_doc/architecture.yaml',summary:arch}] : [{id:'arch',ref:'06_doc/architecture.yaml'}];
    const result = await modelStep(`Phase 2 定点量化 (${modules.join(', ') || '项目默认'}):
1. 位宽扫描与 bit-true 定点模型；DSP/LUT/BRAM 预算表 (硬上限: ${JSON.stringify(resourceLimits)})。
2. 按 workflows/hdl-coding/phase2-fixed-point.md 写 var/workflow/p2-fixed-point.json: 实跑独立参考与位真模型，记录位宽试验、误差上限、选定位宽、舍入/溢出及依赖文件 SHA-256。
输出: 06_doc/fixed_point_report.md + resource_estimate`,
      { agentType: 'algorithm-engineer', label: 'p2-fixed-point', phase: 'Phase 2 定点量化', modelTier: 'deep' },
      { required: { modules, hardLimits: resourceLimits }, evidence: archEv });
    if (!modules.length || modules.some(mod => typeof mod !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(mod))) throw new Error('P2 requires explicit target modules');
    const evidence = await _evidenceGate(['--fixed-point', ...(args?.goldenBaseline ? ['--with-baseline'] : []),
      ...limitFlags, '--modules', modules.join(',')], 'p2-evidence', 'Phase 2 定点量化');
    const json = _parseStrictJsonObject(evidence.gateJson);
    if (!evidence.ok || json?.gate !== 'hdl-evidence-gate' || json.ok !== true || json.mode !== 'full'
        || !checkedHardLimits(json) || !checkedBaselineScope(json) || json.withBaseline !== Boolean(args?.goldenBaseline) || JSON.stringify(json.fixedPoint) !== JSON.stringify(modules)) throw new Error('P2 evidence: ' + (evidence.failures || []).join('; '));
    if (!/^[0-9a-f]{64}$/.test(json.fixedPointReceiptSha256 || '')) throw new Error('P2 evidence: missing verified receipt digest');
    verifiedFixedPointDigest = json.fixedPointReceiptSha256;
    return result;
  },
};

// ── Phase 3: TB + MATLAB 向量生成 ──────────────────────────────────────────

nodes.p3_tb_build = {
  deps: hasExplicitAction('p3-selftest') ? ['p3_vectors'] : ['cp_design_review'],
  run: async (ctx) => {
    const arch = String(ctx.p1b_micro_arch?.data || '').slice(0, 300);
    const archEv = arch ? [{id:'arch',ref:'06_doc/architecture.yaml',summary:arch}] : [{id:'arch',ref:'06_doc/architecture.yaml'}];
    const inlineProbeHint = hasExplicitAction('p3-selftest')
      ? '\n5. 向量已就位: 顺带用替身驱动完成正确/注入故障双试验，按 workflows/hdl-coding/phase3-testbench.md 写妥 var/workflow/p3/<module>.json (模式=' + (liteMode ? 'lite' : 'full') + ')。'
      : '';
    return modelStep(`Phase 3 编写 Testbench (${modules.join(', ') || '项目默认'}):
1. 唯一 02_sim/<mod>/tb_<mod>.sv (已有则原地覆盖): 含 SVA 握手断言、反压/帧界覆盖、$dumpvars、读 02_sim/tv/<mod>_tv.txt 自动 scoreboard 比对。
2. 对比脚本 02_sim/check_<mod>.py: 比对 02_sim/<mod>_out.txt 与 golden 向量并输出 02_sim/check_results/<mod>.json。${inlineProbeHint}`,
      { agentType: 'logic-engineer', label: 'p3-tb', phase: 'Phase 3 TB+向量生成', modelTier: 'standard' },
      { required: { modules, mode: liteMode ? 'lite' : 'full' }, evidence: archEv });
  },
};

nodes.p3_vectors = {
  deps: liteMode ? ['cp_design_review'] : ['p2_fixedpt'],
  run: async (ctx) => {
    const arch = String(ctx.p1b_micro_arch?.data || '').slice(0, 300);
    const archEv = arch ? [{id:'arch',ref:'06_doc/architecture.yaml',summary:arch}] : [{id:'arch',ref:'06_doc/architecture.yaml'}];
    return modelStep(`Phase 3 生成测试向量 (${modules.join(', ') || '项目默认'}):
1. 先跑 Golden 自检 (对照独立参考/已知向量，记录比较点数；失败立即停止修复 GM；不读未生成的 RTL 输出)。
2. 从已核验 P2 位真模型 (Lite 从指定独立 Golden) 生成 02_sim/tv/<module>_tv.txt，覆盖全零/全一/脉冲/随机/边界/溢出，禁编码→译码自闭环。`,
      { agentType: 'algorithm-engineer', label: 'p3-vectors', phase: 'Phase 3 TB+向量生成', modelTier: 'standard' },
      { required: { modules, mode: liteMode ? 'lite' : 'full' }, evidence: archEv });
  },
};

nodes.p3_tb = {
  deps: ['p3_tb_build', 'p3_vectors'],
  run: async () => {
    if (hasExplicitAction('p3-selftest')) {
      const check = await workflowAction({
        kind:'p3-selftest',projectRoot,label:'p3-selftest',modules,
        lite:liteMode,withBaseline:Boolean(args?.goldenBaseline),limitFlags,
      });
      if (check?.ok === true) return check.summary || 'P3 selftest verified on disk';
    }
    return modelStep(`P3 验证环境自检 (${modules.join(', ')}, 模式=${liteMode ? 'lite' : 'full'}):
用隔离替身或回放驱动 TB 与 check_<mod>.py，实跑正确输出与注入故障双试验，记录比较点数/错点数/退出码，按 workflows/hdl-coding/phase3-testbench.md 写 var/workflow/p3/<module>.json (不创建产品 RTL)。`,
      { agentType: 'logic-engineer', label: 'p3-selftest', phase: 'Phase 3 TB+向量生成', modelTier: 'fast' });
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 4: 逐模块 RTL + 脚本化对比 — 3-stage pipeline (编码→调试循环→终验)
// ═════════════════════════════════════════════════════════════════════════════

async function verifyRtlReadiness() {
  if (!moduleOrder.length || moduleOrder.some(mod => typeof mod !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(mod))
      || moduleOrder.length !== new Set(moduleOrder).size || moduleOrder.length !== modules.length
      || modules.some(mod => !moduleOrder.includes(mod))) throw new Error('P4 requires an explicit order covering every target module');
  const modeFlags = liteMode ? ['--lite'] : args?.goldenBaseline ? ['--with-baseline'] : [];
  const ready = await _evidenceGate(['--rtl-ready',...modeFlags,...limitFlags,'--modules',moduleOrder.join(',')],
    'rtl-ready', preparationOnly ? 'Phase 3 TB+向量生成' : 'Phase 4 RTL编码');
  const readyJson = _parseStrictJsonObject(ready.gateJson);
  if (ready.ok && !liteMode && readyJson?.fixedPointReceiptSha256 !== verifiedFixedPointDigest) {
    throw new Error('RTL prerequisites: P2 changed after the qualified fixed-point run; revalidate P2 and its dependent vectors');
  }
  const signedInterface = args?.checkpoints?.['design-review']?.interfaceContractSha256;
  if (ready.ok && (signedInterface !== undefined || (readyJson?.interfaceContractSha256 && args?.confirmAllCheckpoints !== true))
      && (!signedInterface || readyJson?.interfaceContractSha256 !== signedInterface)) {
    throw new Error('RTL prerequisites: design-review interface digest differs or is missing; supply checkpoints["design-review"].interfaceContractSha256 from the accepted snapshot');
  }
  if (!ready.ok || readyJson?.gate !== 'hdl-evidence-gate' || readyJson.ok !== true
      || (!liteMode && (!checkedHardLimits(readyJson) || !checkedBaselineScope(readyJson))) || readyJson.mode !== (liteMode ? 'lite' : 'full') || readyJson.withBaseline !== Boolean(!liteMode && args?.goldenBaseline)
      || JSON.stringify(readyJson.rtlReady) !== JSON.stringify(moduleOrder)) {
    throw new Error('RTL prerequisites: ' + (ready.failures || []).join('; '));
  }
  return readyJson;
}

const preparationNodes = { ...nodes, p3_ready: { deps: ['p3_tb'], run: verifyRtlReadiness } };
nodes.p4_rtl = {
  deps: ['p2_fixedpt', 'p3_tb'],
  run: async (ctx) => {
    await verifyRtlReadiness();
    const moduleList = modules.length > 0 ? modules : ['模块_1'];
    const signedInterface = args?.checkpoints?.['design-review']?.interfaceContractSha256 ?? null;
    const prjRoot = projectRoot;
    const cascadeResults = {};  // modName → { stage2Pass, stage3Pass } — cascade tracking across modules

    log(`[Phase 4] 3-stage pipeline: RTL编码 → 仿真调试循环 → 独立终验`);
    log(`  模块: ${moduleList.join(', ')}`);
    log('  Stage 2 按新证据复验，单模块最多五次仿真；Stage 3 独立签核。');

    const results = await pipeline(
      moduleOrder,

      // ── Stage 1: RTL 编码 ──────────────────────────────────────────────────
      async (mod) => {
        await modelStep(
          `RTL 编码: ${mod} -> 01_src/00_hdl/${mod}/${mod}.sv (原地覆盖，禁变体；TB: 02_sim/${mod}/tb_${mod}.sv)
1. 严格按 06_doc/architecture.yaml 流水/FSM/位宽与已核验 P2 舍入编码，make lint/compile 通过。
2. UG949 推断防退化: BRAM 读/输出寄存器、DSP 内部流水、SRL 链禁加复位且禁多扇出，无效数据由带 i_rst 的 valid 屏蔽并标 "// [复位豁免]"；禁门控时钟与 NBA 左值函数下标。`,
          { agentType: 'logic-engineer', affinityKey: `rtl-${mod}`, label: `rtl-code-${mod}`, phase: 'Phase 4 RTL编码', modelTier: 'standard' },
          {required:{module:mod,signedInterface,hardLimits:resourceLimits,authorization:'仅本模块 RTL；不得改变已签收接口或验收工况。'},
           evidence:[{id:'design',ref:'06_doc/interface_contract.md'},{id:'verification',ref:`var/workflow/p3/${mod}.json`}] }
        );
        return { mod, stage1: 'done' };
      },

      // ── Stage 2: 仿真调试循环 ──────────────────────────────────────────────
      async (prev, mod) => {
        const MAX_ATTEMPTS = 5;
        const native = hasAction('simulate');
        const redlineLocal = hasExplicitAction('redline');
        const gateCmd = `node "${EVIDENCE_GATE_SCRIPT}" --project-root "${prjRoot}" --modules '${mod}'`;
        const simSchema = {type:'object',properties:{
          gate_executed:{type:'boolean'},gate_ok:{type:'boolean'},compared_points:{type:'number'},log_tail:{type:'string'},
          failureKind:{type:'string'},failureSignature:{type:'string'},inputSha256:{type:'string'},evidencePath:{type:'string'},
        },required:['gate_executed','gate_ok','log_tail']};
        let previous;
        const rejected = [];
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const label = `sim-run-${mod}-try${attempt}`;
          let sim = native ? await workflowAction({kind:'simulate',projectRoot,label,module:mod,attempt}) :
            await agent(`执行已有的 ${mod} 编译、仿真、Golden 比较入口。留存本次编译/仿真日志和 02_sim/check_results/${mod}.json。执行门禁 ${gateCmd}，按原值返回 gate_executed、gate_ok、compared_points。失败时返回首个错误、日志引用、失败类别（functional/environment/invalid/insufficient）和可用的输入摘要。仅清理可确认归属本次运行的临时文件，保留证据。`,
              {agentType:'logic-engineer',label,phase:'Phase 4 仿真调试',schema:simSchema,modelTier:'fast'});
          const simPassed = !sim?.failureKind && sim?.gate_executed === true && sim.gate_ok === true && Number.isInteger(sim.compared_points) &&
              (sim.compared_points || 0) > 0 && (!native || (sim.verified === true && sim.evidencePath));
          let redlineClean = false;
          if (simPassed && redlineLocal) {
            const red = await workflowAction({kind:'redline',projectRoot,label:`redline-${mod}-try${attempt}`,modules:[mod]});
            if (red?.ok === true) {
              redlineClean = true;
            } else {
              const redMsg = (red?.failures || ['static redline violation']).join('; ');
              sim = {...sim, failureKind:'functional', gate_ok:false, log_tail:redMsg, failureSignature:'redline:'+redMsg,
                inputSha256:sim.inputSha256 || '0'.repeat(64)};
            }
          }
          if (simPassed && (!redlineLocal || redlineClean)) {
            cascadeResults[mod] = {stage2Pass:true};
            return {mod,pass:true,attempts:attempt,comparedPoints:sim.compared_points,evidencePath:sim.evidencePath,redlineVerified:redlineClean};
          }
          const kind = sim?.failureKind || (!native && sim?.gate_executed && sim.gate_ok === false ? 'functional' : 'insufficient');
          const detail = String(sim?.log_tail || sim?.reason || sim?.failureSignature || '').trim().slice(0,600);
          const failure = String(sim?.failureSignature || detail).trim();
          if (kind !== 'functional' || !failure || (native && !/^[a-f0-9]{64}$/i.test(sim?.inputSha256 || ''))) {
            throw new Error(`[${mod}] ${kind}: ${detail || 'missing qualified simulation evidence'} ${sim?.evidencePath || ''}`);
          }
          if (previous) {
            if (previous.input && previous.input === sim.inputSha256 && previous.failure === failure) {
              throw new Error(`[${mod}] simulation inputs and failure are unchanged: ${detail}`);
            }
            rejected.push({hypothesis:previous.hypothesis,failure,detail});
            if (rejected.filter(row => row.hypothesis === previous.hypothesis && row.failure === failure).length >= 2) {
              throw new Error(`[${mod}] repeated hypothesis without progress: ${previous.hypothesis}; evidence: ${sim.evidencePath || failure.slice(0,300)}`);
            }
          }
          if (attempt === MAX_ATTEMPTS) throw new Error(`[${mod}] repair budget exhausted: ${detail}`);
          const repair = await modelStep('诊断首个偏差，给出可证伪假设并直接修复授权范围内的 RTL。返回 {hypothesis,change}。如需改变签收的接口或 Golden，返回 {needsDecision:true,reason} 并停止。验证由本轮后的统一仿真执行。',
            {agentType:'logic-engineer',affinityKey:`rtl-${mod}`,label:`debug-${mod}-try${attempt}`,phase:'Phase 4 仿真调试',modelTier:'deep'},
            {kind:'repair',required:{module:mod,attempt,firstFailure:detail,previousHypotheses:rejected,
              target:`01_src/00_hdl/${mod}/${mod}.sv`,passCriterion:'门禁通过且比较点 > 0',signedInterface,
              authorization:'保持已签收接口、数据格式及流水延迟；不得改 Golden、TB 或验收阈值。'},
             evidence:[{id:'simulation',ref:sim.evidencePath || `02_sim/check_results/${mod}.json`,summary:String(sim.log_tail || '').slice(0,900)}]});
          const finding = typeof repair === 'string' ? _parseStrictJsonObject(repair) : repair;
          const hypothesis = String(finding?.hypothesis || finding?.root_cause || '').trim();
          if (finding?.needsDecision || !hypothesis || !(finding?.change || finding?.fix)) {
            throw new Error(`[${mod}] repair needs a decision: ${finding?.reason || 'no concrete hypothesis and change'}`);
          }
          previous = {input:sim.inputSha256,hypothesis,failure};
        }
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
        const upstreamFailedS3 = moduleOrder.slice(0, Math.max(0, modIdx)).some(u => cascadeResults[u]?.stage3Pass === false);
        if (upstreamFailedS3 && modIdx > 0) {
          log(`  ⏭️ ${mod}: 上游模块未全部通过终验, 跳过本模块终验 (等待上游修复)`);
          cascadeResults[mod] = { ...(cascadeResults[mod] || {}), stage3Pass: false };
          return { mod, pass: false, skipped: true, upstreamFailed: true };
        }

        // 标准模块且已通过本地仿真收据 + 静态红线扫描时，无假阴性放行风险，语义审查交由 P5 集成审查与 P7 双盲审查统一执行；高安全模块仍保留逐模块独立模型终验
        if (!highSecModules.includes(mod) && prev.redlineVerified === true && hasAction('simulate')) {
          cascadeResults[mod] = { ...(cascadeResults[mod] || {}), stage3Pass: true };
          return { mod, pass: true, deterministicStage3: true };
        }

        const finalV = String(await modelStep(
          `独立终验 ${mod}: 核对 02_sim/check_results/${mod}.json (status=PASS, compared_points>0) 与 RTL (initial 仅限阵列、i_/o_ 前缀、i_rst 同步高有效及豁免注释)。输出 JSON: {"module":"${mod}","pass":true|false,"evidence_ok":true|false,"checks":["..."],"issues":["..."]}`,
          { agentType: 'ce-correctness-reviewer', label: `final-verify-${mod}`, phase: 'Phase 4 终验', modelTier: 'fast' },
          {kind:'decision',required:{module:mod,signedInterface,authorization:'独立只读终验。证据缺失或不匹配必须返回 pass=false。'},
           evidence:[{id:'verification',ref:prev.evidencePath || `02_sim/check_results/${mod}.json`}] }
        ) || '');

        const finalVerdict = _parseStrictJsonObject(finalV);
        const fPass = finalVerdict?.module === mod && finalVerdict?.pass === true && finalVerdict?.evidence_ok === true;
        cascadeResults[mod] = { ...(cascadeResults[mod] || {}), stage3Pass: fPass };
        return { mod, pass: fPass };
      },
    );

    const passed = results.filter(r => r && r.pass).length;
    if (passed !== moduleList.length) throw new Error(`Phase 4 独立终验未通过: ${passed}/${moduleList.length}`);
    return `Phase 4 完成: ${passed}/${moduleList.length}`;
  },
};
// ═════════════════════════════════════════════════════════════════════════════

// ── Phase 4.4: 用真实 RTL 的例化层次回查验证顺序 ─────────────────────────────
//
// 这一次才真正有牙: Phase 4 之后 RTL 落盘了, 代码图能看到真实的例化层次。
// 如果它和 Phase 4 一路用的 moduleOrder 矛盾, 说明 cascade 门禁刚才是按错误的
// 上下游关系放行的 —— 必须在证据门禁之前把这件事摆出来。
// 不硬阻断 (工作流对顾问型检查一贯如此), 但纠正后的顺序会传给 Phase 5 集成。
nodes.p44_topology_recheck = {
  deps: ['p4_rtl'],
  run: async () => {
    phase('Phase 4.4 层次回查');
    const result = await _checkModuleOrder('p44-module-order', 'Phase 4.4 层次回查', true);
    if (result?.ok === false) {
      log('⚠️ [层次回查] Phase 4 的 cascade 门禁是按上面这个**错误顺序**执行的 —— '
        + '受影响模块的上游结论需要人工复核, 不要当作已验证。');
    }
    return result;
  },
};

nodes.p45_evidence_gate = {
  deps: ['p4_rtl', 'p44_topology_recheck'],
  run: async (ctx) => {
    phase('Phase 4.5 证据门禁');

    // ── Step 1: 确定性证据门禁 (hdl-evidence-gate.cjs 读磁盘判定) ──────────

    log('🔍 [证据门禁] 运行 hdl-evidence-gate.cjs 校验 evidence JSON...');

    let allResults = [];
    if (modules.length === 0) {
      log('⚠️ [证据门禁] 模块列表为空 — 无模块级证据可查, 仅在初始化空项目时可接受。');
    } else {
      const gateRes = await _evidenceGate(['--modules',modules.join(',')], 'p45-evidence', 'Phase 4.5 证据门禁');
      const gateReport = _parseStrictJsonObject(gateRes.gateJson) || {};
      allResults = Array.isArray(gateReport.modules) ? gateReport.modules : [];

      for (const r of allResults) {
        if (r.pass) {
          log(`  ✅ ${r.module}: PASS (${r.compared_points} points, max_err=${r.max_error_lsb ?? 0}LSB)`);
        } else {
          log(`  ❌ ${r.module}: FAIL — ${r.reason}`);
        }
      }

      if (gateRes.ok !== true || gateReport.gate !== 'hdl-evidence-gate' || gateReport.ok !== true ||
          allResults.length !== modules.length || !modules.every(mod => allResults.some(row =>
            row.module === mod && row.pass === true && Number.isInteger(row.compared_points) && row.compared_points > 0))) {
        throw new Error(
          `❌ [证据门禁] hdl-evidence-gate FAIL:\n${
            (gateRes.failures || []).map(f => `   - ${f}`).join('\n')
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

      const advResult = await modelStep(`你是**对抗验证者**。以下模块声称已与 MATLAB golden model 逐周期一致。

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
        if (!Array.isArray(issues) || issues.some(i => !activeHighSec.includes(i?.module) || typeof i.pass !== 'boolean')) {
          throw new Error('独立审查缺少有效的结构化结论');
        }
        if (issues.length > 0) {
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
        throw new Error('[对抗验证] ' + e.message);
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

    // ── 单模块确定性快速集成 (无跨模块级联接线时免除 5 路冗余评审) ──
    let synthesis = '';
    if (modList.length === 1 && hasExplicitAction('single-top')) {
      const singleTop = await workflowAction({kind:'single-top',projectRoot,label:'p5-single-top',modules:modList});
      if (singleTop?.ok === true) {
        synthesis = JSON.stringify({overall:'pass',issues:[],root_cause:'none',fix_suggestion:'none'});
      } else if (singleTop && Array.isArray(singleTop.issues)) {
        synthesis = JSON.stringify({
          overall:singleTop.overall || 'fail',
          issues:singleTop.issues,
          root_cause:singleTop.root_cause || modList[0],
          fix_suggestion:singleTop.fix_suggestion || 'fix single-module top wrapper or redline issue',
        });
      }
    }

    if (!synthesis) {
      // ── Step 1: 并行发散 4 路 Agent ──────────────────────────────────────
      log('  Step 1: 并行分析 (接口/数据通路/Golden/时序)...');

      const [interfaceR, dataPathR, goldenR, timingR] = await parallel([
        // Agent 1: 接口检查 (只读审查)
        () => modelStep(
          `顶层接口检查 (${modList.join(', ')}, 01_src/00_hdl/top/top.sv; 缺失则报 fail 不创建): 核查端口悬空/漏连、valid/ready 贯穿、位宽匹配、CDC 同步与 i_rst 同步高有效。输出 JSON 数组: [{"interface":"<A→B>","status":"pass|fail|warn","detail":"..."}]`,
          { agentType: 'ce-api-contract-reviewer', label: 'p5-interface', phase: 'Phase 5 顶层集成', modelTier: 'fast' }
        ),

        // Agent 2: 数据通路追踪
        () => modelStep(
          `顶层数据通路追踪 (${modList.join(' → ')}, top.sv): 逐级核查位宽/格式传递、截断扩展标注与流水延迟对齐。输出 JSON: [{"stage":"input→${modList[0] || 'mod1'}","status":"pass|warn","width":N,"format":"...","notes":"..."}]`,
          { agentType: 'ce-architecture-strategist', label: 'p5-datapath', phase: 'Phase 5 顶层集成', modelTier: 'fast' }
        ),

        // Agent 3: Golden Model 比对
        () => modelStep(
          `顶层全链对拍 (${modList.join(' → ')}): 创建/验证 01_src/00_hdl/top/top.sv, 编译并跑全链仿真对标 07_mat|08_py 定点 Golden; 按链路从首级向前定位首个偏差模块(first_deviation.stage)。输出 JSON: {"overall":"pass|fail","first_deviation":{"stage":"...","signal":"...","time":N,"expected":"...","got":"..."},"compared_points":N,"max_error_lsb":N,"algo_consistent":true|false}`,
          { agentType: 'logic-engineer', label: 'p5-golden', phase: 'Phase 5 顶层集成', modelTier: 'standard' }
        ),

        // Agent 4: 资源/时序预估
        () => modelStep(
          `顶层资源与时序评估 (${modList.join(', ')}, top.sv): 汇总资源、关键组合路径、跨时钟同步与流水对齐。输出 JSON: {"resource":{"lut_est":N,"dsp_est":N,"bram_est":N},"timing":{"critical_path":"...","fmax_est":"...MHz"},"cdc_issues":["..."],"pipeline_issues":["..."]}`,
          { agentType: 'ce-performance-oracle', label: 'p5-timing', phase: 'Phase 5 顶层集成', modelTier: 'fast' }
        ),
      ]);

      // ── Step 2: 确定性快速聚合 (4 路结构化全绿时免除 LLM 汇总调用) ──────
      const parseJsonAny = (raw) => {
        if (raw && typeof raw === 'object') return raw;
        try { return JSON.parse(String(raw || '').trim()); } catch { return null; }
      };
      const ifArr = parseJsonAny(interfaceR);
      const dpArr = parseJsonAny(dataPathR);
      const gdObj = _parseStrictJsonObject(goldenR);
      const tmObj = _parseStrictJsonObject(timingR);
      const allCleanJson = Array.isArray(ifArr) && ifArr.length > 0 && ifArr.every(x => x?.status === 'pass') &&
        Array.isArray(dpArr) && dpArr.length > 0 && dpArr.every(x => x?.status === 'pass') &&
        gdObj?.overall === 'pass' && gdObj.algo_consistent === true && Number.isFinite(gdObj.compared_points) && gdObj.compared_points > 0 &&
        tmObj && Array.isArray(tmObj.cdc_issues) && tmObj.cdc_issues.length === 0 &&
        Array.isArray(tmObj.pipeline_issues) && tmObj.pipeline_issues.length === 0;

      if (allCleanJson) {
        log('  Step 2: 4 路结构化结论全绿，本地确定性聚合通过 (免除 p5-synthesis 模型调用)');
        synthesis = JSON.stringify({overall:'pass',issues:[],root_cause:'none',fix_suggestion:'none'});
      } else {
        log('  Step 2: 合成分析结果...');
        synthesis = String(await modelStep(
          `顶层集成根因合成 (${modList.join(' → ')}, 级联故障指向最上游根因模块):
接口=${String(interfaceR || 'N/A').slice(0, 800)}
通路=${String(dataPathR || 'N/A').slice(0, 800)}
Golden=${String(goldenR || 'N/A').slice(0, 800)}
时序=${String(timingR || 'N/A').slice(0, 800)}
输出 JSON: {"overall":"pass|fail|warn","issues":[{"severity":"critical|warning","module":"...","signal":"...","description":"..."}],"root_cause":"...","fix_suggestion":"..."}`,
          { label: 'p5-synthesis', phase: 'Phase 5 顶层集成', modelTier: 'fast' }
        ) || '');
      }
    }

    // ── Step 3: 定向修复 (如果发现问题) ──────────────────────────────────
    const integration = _parseStrictJsonObject(synthesis);
    if (!['pass','warn','fail'].includes(integration?.overall) || !Array.isArray(integration.issues)) {
      throw new Error('Phase 5 requires a structured top integration verdict');
    }

    if (integration.overall !== 'pass') {
      log('  Step 3: 发现顶层问题, 执行定向修复...');

      const fixOut = String(await modelStep(
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
      const verifyFix = String(await modelStep(
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
      if (!verifyFixPass) throw new Error('Phase 5 top integration fix unverified: ' + (verifyFixVerdict?.reason || 'missing evidence'));
      return '顶层修复经全链验证通过: ' + String(verifyFixVerdict.reason || '');
    } else {
      log('  ✅ 顶层分析通过, 无需修复');
    }

    // ── 压缩保留块: Phase 5 顶层集成 ────────────────────────────
    log('');
    log('📌 === 压缩保留块: Phase 5 顶层集成 ===');
    log('保留原因: 全链仿真结果是 RTL 与 Golden Model bit-true 对齐的最终证据');
    log('分析维度: 接口检查 / 数据通路 / Golden 比对 / 资源时序');
    log(`模块: ${modList.join(', ') || '项目默认'}`);
    log('合成结论: ' + integration.overall);
    log('=== 保留块结束 ===');
    log('');

    return synthesis;
  },
};

nodes.p6_regression = {
  deps: ['p5_top_integration'],
  run: async (ctx) => {
    const top = ctx.p5_top_integration?.data || '';
    if (hasAction('regression')) {
      const receipt = await workflowAction({kind:'regression',projectRoot,label:'p6-regression',modules,fresh:true});
      if (receipt?.executed !== true || receipt.verified !== true || receipt.ok !== true || !receipt.evidencePath ||
          !Number.isInteger(receipt.compared_points) || receipt.compared_points <= 0 || receipt.coverageComplete !== true) {
        throw new Error('Full regression unverified: ' + (receipt?.reason || 'missing comparison or coverage evidence'));
      }
      return receipt;
    }
    const result = await modelStep(`执行 HDL 工作流 Phase 6: 回归覆盖率

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

// ── Phase 6b: Vivado 综合体检 (UG901/UG949 方法学证据) ─────────────────────
// 仿真只证明功能对，证明不了"综合器把代码变成了什么"。推断静默失败 (BRAM 输出寄存器
// 没吸收 / DSP 没流水 / SRL 掉成 FF 链) 不会报错, 只会让 Fmax 掉一半、面积翻几倍。
// 本节点跑真工具拿报告; 无 Vivado 环境时如实降级为 skipped, 不允许把静态推断写成结论。

nodes.p6b_vivado_check = {
  deps: ['p5_top_integration'],
  run: async () => {
    const VIVADO_SCHEMA = {
      type: 'object',
      properties: {
        tool_available: { type: 'boolean' },
        flow_ran: { type: 'boolean' },
        ok: { type: 'boolean' },
        stages_run: { type: 'array', items: { type: 'string' } },
        critical: { type: 'number' },
        errors: { type: 'number' },
        wns_ns: { type: ['number', 'null'] },
        whs_ns: { type: ['number', 'null'] },
        resources: { type: 'object' },
        blocking_items: { type: 'array', items: { type: 'string' } },
        waived_items: { type: 'array', items: { type: 'string' } },
        skipped_reports: { type: 'array', items: { type: 'string' } },
        summary_json: { type: 'string' },
        skip_reason: { type: 'string' },
      },
      required: ['tool_available', 'flow_ran', 'blocking_items'],
    };

    const partHint = fpgaPart
      ? `目标器件: ${fpgaPart}`
      : `目标器件: 未由 args.part 指定 — 先从 03_xdc/*.xdc、04_prj/ 工程或 06_doc/ 中找器件型号; 仍找不到就只跑到 rtlcheck 阶段 (它也需要 -part, 可用同系列任一型号做方法学检查并在 skip_reason 里注明)。`;

    const localVivado = hasAction('vivado');
    const res = localVivado ? await workflowAction({kind:'vivado',projectRoot,label:'p6b-vivado-check',part:fpgaPart,modules}) :
      await agent(`执行 HDL 工作流 Phase 6b: Vivado 综合体检 (证据收集, 不做判定改写)

项目根: ${projectRoot}
模块: ${modules.join(', ') || '项目默认'}
${partHint}

执行入口: 当前安装的 vivado-flow 技能 (插件 skills/vivado-flow/SKILL.md，源码 packs/fpga/skills/vivado-flow/SKILL.md)
规范依据: packs/fpga/skills/hdl-coding/references/ug949-rtl-methodology.md (§4 Know What You Infer)

━━━ 步骤 ━━━
1. 探测工具链:
   node core/engine/scripts/eda-detect.cjs --json
   (以下工具和技能均从当前插件根解析绝对路径，工程输入输出从项目根解析。)
   vivado 不可用 → tool_available=false, skip_reason 写明, 其余字段置 0/空, **直接结束**。
   [MUST] 禁止在无 Vivado 时凭读代码给出资源/时序/推断结论。

2. 跑 rtlcheck → synth (**一条命令覆盖两个阶段, 脚本自动分趟处理 elaborate 与综合**):
   vivado -mode batch -nojournal -nolog \\
     -source <vivado-flow技能目录>/scripts/vivado_flow.tcl \\
     -tclargs -top top -part <part> -src 01_src/00_hdl -xdc 03_xdc \\
              -out 04_prj -from rtlcheck -to synth
   读 04_prj/rpt/flow_summary.json

3. 推断核查 (UG949 §4) — 对照 06_doc/resource_budget_tracking.md, 用 synth 段的资源数:
   - 设计里有存储器但 synth.bram=0 且 synth.uram=0 → BRAM 推断失败, 列进 blocking_items
   - 设计里有乘加但 synth.dsp=0 → DSP 推断失败, 列进 blocking_items
   - 有延时线/移位链但 synth.srl=0 且 synth.ff 远超预算 → SRL 掉成 FF 链, 列进 blocking_items
   - 关键路径起点是 BRAM 组合输出 → 输出寄存器未吸收, 列进 blocking_items

4. 用解析器复核数字 (禁止从 .rpt 里用眼睛抄):
   node packs/fpga/engine/fpga-util-parser.cjs   04_prj/rpt/synth_utilization.rpt --json
   node packs/fpga/engine/fpga-timing-parser.cjs 04_prj/rpt/synth_timing_summary.rpt --json
   (报告文件名以 flow_summary.json 的 report_dir 下实际存在的为准)

━━━ 结构化返回 (字段全部取自 flow_summary.json 原值, 禁止改写或估算) ━━━
- ok / stages_run          ← 顶层同名字段
- wns_ns / whs_ns          ← synth.wns / synth.whs (没跑到 synth 则为 null)
- resources                ← synth 段的 {lut, ff, bram, uram, dsp, srl, control_sets}
- critical / errors        ← rtlcheck 与 synth 两段 critical / error 之和
- blocking_items           ← 顶层 blocking[] + 步骤 3 发现的推断失败项
- waived_items             ← 各阶段 waived[] (如未绑引脚的 NSTD-1/UCIO-1, 如实带回但不算阻断)
- skipped_reports          ← 顶层同名字段 (本机 Vivado 版本不支持而跳过的报告, 不算失败)
- summary_json             ← flow_summary.json 完整文本
你不做通过/不通过的最终裁决, 只如实搬运证据。`,
      { agentType: 'logic-engineer', label: 'p6b-vivado-check', phase: 'Phase 6b Vivado 综合体检', schema: VIVADO_SCHEMA }
    );

    if (res?.tool_available === false && res.flow_ran !== true && res.executed !== true && res.exitCode == null &&
        !res.failureKind && !res.blocking_items?.length && typeof res.skip_reason === 'string' && res.skip_reason.trim()) {
      const why = res.skip_reason;
      log(`⏭️ [Phase 6b] 跳过 Vivado 综合体检 — ${why}`);
      log('   ⚠️ 本次运行**没有**综合级证据: 资源/Fmax/时序/推断成功与否均为未验证。');
      return { skipped: true, reason: why, toolAvailable: false };
    }

    const evidencePath = localVivado ? res?.evidencePath : '04_prj/rpt/flow_summary.json';
    const raw = localVivado ? res?.report : _parseStrictJsonObject(res?.summary_json);
    const stages = Array.isArray(raw?.stages_run) ? raw.stages_run : [];
    const timedStage = stages.includes('route') ? 'route' : 'synth';
    const timed = raw?.[timedStage];
    const checkedStages = ['rtlcheck','synth','route'].filter(stage => stages.includes(stage));
    const optionalStages = ['opt','place'].filter(stage => stages.includes(stage));
    const validCount = count => Number.isInteger(count) && count >= 0;
    if (res?.tool_available !== true || res.flow_ran !== true || res.failureKind || (res.exitCode != null && res.exitCode !== 0) ||
        typeof evidencePath !== 'string' || !evidencePath.trim() || typeof raw?.top !== 'string' || !raw.top.trim() ||
        typeof raw.part !== 'string' || !raw.part.trim() || (fpgaPart && fpgaPart !== raw.part) || typeof raw.ok !== 'boolean' ||
        !stages.includes('synth') || ![timed?.wns,timed?.whs].every(Number.isFinite) ||
        !Array.isArray(raw.blocking) || !Array.isArray(res.blocking_items) ||
        ![res.critical,res.errors].every(validCount) ||
        !checkedStages.every(stage => validCount(raw[stage]?.critical) && validCount(raw[stage]?.error)) ||
        !optionalStages.every(stage => (raw[stage]?.critical === undefined || validCount(raw[stage]?.critical)) &&
          (raw[stage]?.error === undefined || validCount(raw[stage]?.error)))) {
      throw new Error('Vivado evidence insufficient: ' + (res?.reason || 'missing completed stage, scope, setup/hold or diagnostics') +
        ' ' + (evidencePath || res?.logPath || ''));
    }
    const allStages = [...checkedStages,...optionalStages];
    const crit = Math.max(res.critical,allStages.reduce((n,stage) => n + (raw[stage]?.critical || 0),0));
    const errs = Math.max(res.errors,allStages.reduce((n,stage) => n + (raw[stage]?.error || 0),0));
    const wns = timed.wns;
    const whs = timed.whs;
    const blockers = [...new Set([...raw.blocking,...res.blocking_items])];
    const waived = Array.isArray(res.waived_items) ? res.waived_items : [];

    log(`[Phase 6b] vivado_flow 阶段: ${stages.join(' → ') || '(未报告)'}  脚本判定 ok=${res.ok}`);
    log(`  违规: error=${errs}, critical=${crit}`);
    log(`  时序: ${timedStage}.wns=${wns}ns, ${timedStage}.whs=${whs}ns`);
    if (res.resources) log(`  资源: ${JSON.stringify(res.resources)}`);
    for (const w of waived.slice(0, 10)) log(`  ⚠️ 豁免(不阻断): ${w}`);
    for (const s of (res.skipped_reports || []).slice(0, 10)) log(`  ℹ️ 跳过的报告: ${s}`);
    for (const b of blockers.slice(0, 20)) log(`  ❌ ${b}`);

    const timingFail = wns < 0 || whs < 0;
    // 脚本自身的门禁判定 (ok) 与本节点的独立复核取"或"—— 任一判失败即阻断
    const scriptFail = res.ok !== true || raw.ok !== true;
    if (scriptFail || crit + errs > 0 || timingFail || blockers.length > 0) {
      throw new Error(
        `❌ [Phase 6b Vivado 体检] 未通过: script_ok=${res.ok}, error=${errs}, critical=${crit}` +
        (timingFail ? `, WNS=${wns}ns, WHS=${whs}ns` : '') +
        (blockers.length ? `\n   阻断项:\n   - ${blockers.slice(0, 20).join('\n   - ')}` : '') +
        `\n   完整证据: ${evidencePath}` +
        `\n   处理指引: methodology/DRC 违规家族对照见 ug949-rtl-methodology.md §8.1;` +
        ` 推断失败见 §4; 复位豁免细则见 vivado-synthesis-ug901.md §5.1。` +
        `\n   修完后可从检查点续跑, 不必重综合: vivado_flow.tcl -from opt -to route`
      );
    }

    log('✅ [Phase 6b] Vivado 综合体检通过 (无 Critical/Error, 时序满足)');
    const report = {top:raw.top,part:raw.part,ok:raw.ok,stages_run:stages};
    for (const key of ['tool','vivado_version','aborted','constrained','io_constrained','report_dir']) {
      if (raw[key] !== undefined) report[key] = raw[key];
    }
    if (Array.isArray(raw.blocking)) report.blocking = raw.blocking;
    for (const stage of stages.filter(s => ['rtlcheck','synth','opt','place','route'].includes(s))) {
      if (!raw[stage] || typeof raw[stage] !== 'object') continue;
      report[stage] = {};
      for (const field of ['wns','whs','lut','ff','bram','uram','dsp','srl','control_sets','critical','error','cdc_critical','waived']) {
        const value = raw[stage]?.[field];
        if (Number.isFinite(value) || (field === 'waived' && Array.isArray(value))) report[stage][field] = value;
      }
    }
    if (Array.isArray(raw.skipped_reports) && raw.skipped_reports.length) report.skipped_reports = raw.skipped_reports;
    return {pass:true,toolAvailable:true,evidencePath,report};
  },
};

// ── Phase 7: 代码审查 (双专业审查员并行: 正确性 + 接口契约) ─────────────────

nodes.p7_review = {
  deps: ['p5_top_integration'],
  run: async (ctx) => {
    const top = String(ctx.p5_top_integration?.data || '').slice(0, 300);
    const topEv = top ? [{id:'top',ref:'06_doc/architecture.yaml',summary:top}] : [{id:'top',ref:'06_doc/architecture.yaml'}];
    const schema = {type:'object',properties:{pass:{type:'boolean'},summary:{type:'string'},
      evidence:{type:'array',items:{type:'string'}}},required:['pass','summary','evidence']};
    const [correctness, contract] = await parallel([
      () => modelStep(`Phase 7 正确性审查 (${modules.join(', ') || '项目默认'}):
核查 (1) ri_/ro_ 寄存与 CDC (ASYNC_REG/XPM) (2) 命名规范 (3) 三段式 FSM+default (4) lint/位宽/无锁存器/无组合环 (5) 与 Golden/P2/architecture.yaml 一致 (6) 工具链禁令(NBA 左值禁函数下标) (7) UG949: 禁门控时钟；未复位寄存器仅限 BRAM/DSP/SRL 且须带 "// [复位豁免]"；综合属性须带理由注释。
输出 pass、简要事实与证据定位(file:line)；任何阻断项 pass=false。`,
        { agentType: 'ce-correctness-reviewer', label: 'p7-review-correctness', phase: 'Phase 7 代码审查', schema, modelTier: 'standard' },
        { required: { modules }, evidence: topEv }),

      () => modelStep(`Phase 7 接口契约审查 (${modules.join(', ') || '项目默认'}):
核查 (1) valid/ready 握手(valid 不依赖 ready) (2) 端口位宽与 architecture.yaml/interface_contract.md 一致 (3) AXI-Stream 合规 (4) CDC 边界对齐 clock_domain.md (5) 无例化悬空端口。
输出 pass、简要事实与证据定位(file:line)；任何阻断项 pass=false。`,
        { agentType: 'ce-api-contract-reviewer', label: 'p7-review-contract', phase: 'Phase 7 代码审查', schema, modelTier: 'standard' },
        { required: { modules }, evidence: topEv }),
    ]);

    const reviews = {correctness:_parseStrictJsonObject(correctness),contract:_parseStrictJsonObject(contract)};
    for (const [name,result] of Object.entries(reviews)) {
      if (result?.pass !== true || typeof result.summary !== 'string' || !result.summary.trim() ||
          !Array.isArray(result.evidence) || !result.evidence.length || result.evidence.some(ref => typeof ref !== 'string' || !ref.trim())) {
        throw new Error(`P7 ${name} review blocked: ${result?.summary || 'missing independent review evidence'}`);
      }
    }
    return reviews;
  },
};

// ── Phase 8: 报告输出 ──────────────────────────────────────────────────────

nodes.p8_report = {
  deps: ['p6_regression', 'p6b_vivado_check', 'p7_review'],
  run: async (ctx) => {
    const regression = ctx.p6_regression?.data || '';
    const reviews = ctx.p7_review.data;
    const vivado = ctx.p6b_vivado_check?.data || {};
    if (hasExplicitAction('report')) {
      const rep = await workflowAction({
        kind:'report',projectRoot,label:'p8-report',modules,
        mode:liteMode ? 'lite' : 'full',
        hardLimits:resourceLimits,
        moduleComparisons:ctx.p45_evidence_gate?.data?.fileCheck || [],
        regressionPath:regression?.evidencePath || '02_sim/',
        regressionSummary:typeof regression === 'string' ? regression.slice(0,240) : 'verified receipt',
        synthesis:vivado,
        reviews,
      });
      if (rep?.executed === true && rep.ok === true) return rep.summary || '06_doc/workflow-verification.md generated';
    }
    const result = await modelStep('汇总实现报告到 06_doc/workflow-verification.md。逐项列出验收标准、已测范围、指标、证据文件及复用来源。引用完整的回归/审查报告。综合级结论说明资源实测与预算、建立/保持时序和 DRC；未运行则标注未验证。保留复验日志、检查点与签收产物，临时文件归其运行者管理。',
      {label:'p8-report', modelTier:'fast'},
      {kind:'decision',required:{modules,mode:liteMode ? 'lite' : 'full',hardLimits:resourceLimits,
        synthesis:vivado.toolAvailable === true ? vivado.report :
          {unverified:true,reason:vivado.reason || 'no synthesis receipt'}},
       evidence:[...(vivado.evidencePath ? [{id:'synthesis',ref:vivado.evidencePath}] : []),
         ...Object.entries(reviews).flatMap(([name,result]) =>
         result.evidence.map((ref,index) => ({id:`review-${name}-${index}`,ref,summary:result.summary}))),
         {id:'regression',ref:regression?.evidencePath || '02_sim/',summary:typeof regression === 'string' ? regression.slice(0,400) : '读取回执'},
         ...modules.map(mod=>({id:'sim-'+mod,ref:`02_sim/check_results/${mod}.json`}))]});
    return result;
  },
};

// ── Verifier (终验节点) ────────────────────────────────────────────────────

nodes.verifier = {
  deps: ['p8_report'],
  run: async (ctx) => {
    const report = ctx.p8_report?.data || '';
    const gateResult = ctx.p45_evidence_gate?.data || {};

    const synthesis = ctx.p6b_vivado_check?.data || {};
    const required = {modules,mode:liteMode ? 'lite' : 'full',hardLimits:resourceLimits,
      signedInterface:args?.checkpoints?.['design-review']?.interfaceContractSha256 ?? null,
      moduleComparisons:(gateResult.fileCheck || []).map(row=>({module:row.module,points:row.compared_points,passed:row.pass})),
      synthesis:synthesis.skipped ? {unverified:true,reason:synthesis.reason} : synthesis.report};
    const evidence = [
      {id:'report',ref:'06_doc/workflow-verification.md',summary:String(report).slice(0,500)},
      {id:'design',ref:'06_doc/architecture.yaml'},{id:'contracts',ref:'06_doc/interface_contract.md'},
      ...modules.map(mod=>({id:'sim-'+mod,ref:`02_sim/check_results/${mod}.json`})),
    ];
    if (ctx.p6_regression?.data?.evidencePath) evidence.push({id:'regression',ref:ctx.p6_regression.data.evidencePath});
    if (!synthesis.skipped) evidence.push({id:'synthesis',ref:synthesis.evidencePath});

    const result = await modelStep(`跨阶段终验 (${modules.join(', ') || '项目默认'}):
核对 (1) 各阶段产物齐备且与 architecture.yaml 模块一致无遗漏 (2) P4/P4.5 全部模块 check_results/*.json status=PASS 且 compared_points>0 (3) P5 全链与 Golden 对齐 (4) P6 真实回归通过(非 Lite) (5) P6b: toolAvailable=true 时 critical+errors=0 且 WNS/WHS>=0；skipped=true 时报告须明写“无 EDA 环境, 综合级结论未验证”，禁把静态推断当结论 (6) P7 双审通过。
输出 JSON: {"pass":true|false,"reason":"...","missing":[...],"strongest_phase":"...","weakest_phase":"..."}`,
      { label: 'verifier', modelTier: 'standard' }, {kind:'decision',required,evidence});
    return result;
  },
};

// ── Lite 模式：重写依赖链 ──────────────────────────────────────────────────

if (liteMode) {
  nodes.p4_rtl.deps = ['p3_tb'];
  nodes.p8_report.deps = ['p6b_vivado_check', 'p7_review'];

  nodes.p2_fixedpt.run = async () => '[SKIPPED] Lite 模式 — 定点量化跳过';
  nodes.p6_regression.run = async () => '[SKIPPED] Lite 模式 — 覆盖率回归跳过';

  log('   依赖链: P0→CP(layout)→P1a→CP(system)→P1b→CP(design)→P3→P4→P45→CP(evidence)→P5→P6b/P7并行→P8→Verifier');
  log('   (跳过节点: P2 定点量化, P6 覆盖率回归; P6b Vivado 体检保留 — 成本低且是唯一的综合级证据)');
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
  '  layout-review   — P0 目录与构建入口确认后才派发 P1a',
  '  system-review   — P1a 系统方案审查后才派发 P1b',
  '  design-review   — P1a/P1b 设计产出审查, 按 gate-checklist-p1a/p1b.md 核对',
  '                    (args.checkpoints["design-review"].confirmed=true，有接口契约时同时传入签收的 interfaceContractSha256)',
  '  evidence-review — Phase 4.5 证据门禁报告审查',
  '                    (args.checkpoints["evidence-review"].confirmed=true)',
  '  verifier        — 末端自动终验 (pass=true 才算完成, 无需用户确认)',
  '  无人值守: args.confirmAllCheckpoints=true 显式跳过全部用户检查点',
  '  Phase 4.5 判定由确定性脚本 engine/scripts/hdl-evidence-gate.cjs 完成',
  '',
  'DAG 依赖链:',
  preparationOnly
    ? '  P0→P1a→P1b→CP(design)→验证准备→rtl-ready，结束本次执行'
    : liteMode
    ? '  P0→CP(layout)→P1a→CP(system)→P1b→CP(design)→P3→P4→P45→CP(evidence)→P5→P6b/P7并行→P8→Verifier (跳过 P2,P6)'
    : '  P0→CP(layout)→P1a→CP(system)→P1b→CP(design)→P2/P3并行→P4→P45→CP(evidence)→P5→P6/P6b/P7并行→P8→Verifier',
  '',
  `Vivado 综合体检 (P6b): 目标器件=${fpgaPart || '(未指定 — 传 args.part 可省去自动查找)'}`,
  '  Vivado 不可用时该节点如实降级为 skipped, 综合级结论一律标注"未验证"',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
].join('\n');

log(preflightSummary);

if (args?.goldenBaseline !== undefined) {
  const baseline = args.goldenBaseline;
  const names = value => Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim()) && new Set(value).size === value.length;
  if (!baseline || typeof baseline.entry !== 'string' || !baseline.entry.trim() || !names(baseline.cases)
      || !baseline.cases.length || !names(baseline.tools ?? []) || !Array.isArray(baseline.limits ?? [])) {
    throw new Error('goldenBaseline requires entry, named cases and optional tools/limits arrays');
  }
  const goldenAction = hasAction('golden');
  const summary = goldenAction ? await workflowAction({kind:'golden',projectRoot,label:'golden-preflight-run',baseline}) :
    await agent(`在项目 ${projectRoot} 对现有 Golden 做开工预检，仅运行原模型和必要工具的小例程，保留原模型。
将本次调用给定的范围逐字保存为 var/workflow/golden-scope.json，然后按此范围运行：${JSON.stringify(baseline)}
写 var/workflow/golden-preflight.json，包含 entry (项目相对路径)、实跑时入口文件的 entrySha256、原入口的 exitCode 和 entryLog，
cases 逐项覆盖必测工况，每项含 name、source（正常路径 normal）、oracleInputs、实际 compared 样本数、验收条件 criterion、实测是否达标 passed 和 log。
检查运行时数据来源。oracleInputs 列出被测链路内部实际使用的外部真值（例如已知帧起点、从发端取得而应由接收机解出的 MCS 或长度）；纯 scoreboard 参考和规格定义的模块输入不计入。独立运行时填空数组。附加的注入或旁路实验单列 diagnostics。
tools 数组每项含 name、实际小例程的 exitCode 和 log；日志使用项目内相对路径。保留失败和无样本的工况。
各工况的 metrics 写实测数值，供 limits 中的 {case,metric,min?,max?} 核对，不能用配置值代填。
返回供用户审核的报告，逐项列出原入口/替代入口、判据、实测值、日志、工具实跑阶段及开工建议。
对通信接收机列出发/收帧、星座图、EVM 参照、BER 分子与分母。涉及噪声时列出配置 SNR 与测得 SNR、测量位置和功率口径。单列注入诊断；零分母写“无样本”。`,
    { label: 'golden-preflight-run', phase: 'Pre-flight 检查', agentType: 'algorithm-engineer' });
  if (goldenAction && (summary?.executed !== true || summary.ok !== true)) {
    throw new Error('Golden preflight blocked: ' + (summary?.reason || 'missing execution receipt'));
  }
  log(goldenAction ? [summary.summary,summary.evidencePath].filter(Boolean).join(' ') : String(summary));
  const evidence = await _evidenceGate(['--golden'], 'golden-preflight-evidence', 'Pre-flight 检查');
  const json = _parseStrictJsonObject(evidence.gateJson);
  const actual = json?.golden;
  const missing = (expected, seen) => expected.filter(name => !Array.isArray(seen) || !seen.includes(name));
  const gaps = [...missing(baseline.cases, actual?.passedCases), ...missing(baseline.tools ?? [], actual?.passedTools)];
  for (const limit of baseline.limits ?? []) {
    if (!limit || !actual?.checkedLimits?.some(l => l.case === limit.case && l.metric === limit.metric
        && l.min === limit.min && l.max === limit.max)) gaps.push('unchecked measurement: ' + JSON.stringify(limit));
  }
  if (!evidence.ok || json?.gate !== 'hdl-evidence-gate' || json.ok !== true || actual?.entry !== baseline.entry || gaps.length) {
    throw new Error('Golden preflight blocked: ' + [...(evidence.failures || []), ...gaps].join('; ') + '\n' + String(summary));
  }
}

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
const dagResult = await _dagExecute(preparationOnly ? preparationNodes : nodes, {
  onProgress: (layer, total, names) => log(`[层 ${layer}/${total}] ${names}`),
  log,
});
if (preparationOnly) {
  log('P3 验证准备已通过，已达到本次授权的结束阶段。');
  return { completedThrough: 'p3', rtlReady: true, evidence: 'validated-on-disk', modules: moduleOrder };
}

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
