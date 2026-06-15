/**
 * hdl-coding-dag-workflow — HDL RTL 开发 DAG 工作流 v3.4.0
 *
 * 本文件是从 skills/workflows/hdl-coding-dag-workflow.js 链接到 workflows/ 的副本，
 * 供 Workflow({name: 'hdl-coding-dag-workflow'}) 解析。
 *
 * 核心改进 v3.4 — 证据驱动验证:
 *   D+B: Phase 4 prompt 精简 + 强制脚本化对比 + JSON 证据制品
 *   A降维: Phase 4.5 证据门禁 — fs 读 JSON (0 token)，高安全模块追加对抗 agent
 *   C升级: Verifier 独立交叉检查 evidence JSON + architecture.yaml
 *   模块自动分类: 标准/高安全模式自适应路由
 *
 * 与 skills/workflows/hdl-coding-workflow.md 的 10 阶段对应。
 *
 * [MUST 硬约束] RTL 验证流程:
 *   Phase 4: 逐模块 RTL + 脚本化对比 — 生成 check_<module>.py + JSON 证据
 *   Phase 4.5: 证据门禁 — 独立读取 JSON 证据文件，不信任 Phase 4 自述
 *   Phase 5: 全链仿真 — 通过 Phase 4.5 后才可进入
 *
 * 调用:
 *   Workflow({name: 'hdl-coding-dag-workflow', args: {
 *     modules: ['scrambler', 'equalizer'],
 *     securityModules: ['equalizer'],           // 可选，覆盖自动分类
 *     standardModules: ['fir_fixed'],           // 可选，强制标准模式
 *     projectRoot: 'd:/project/ofdm/prj',       // 可选
 *     lite: false,                               // 可选 Lite 模式
 *   }})
 */

const dag = require('../engine/dag-engine.cjs');
const fs = require('fs');
const path = require('path');

export const meta = {
  name: 'hdl-coding-dag-workflow',
  description: 'HDL RTL 开发 DAG 工作流 v3.4 — 证据驱动验证, 逐模块脚本化对比 → 证据门禁 → 全链仿真 (Verifier终验)',
  phases: [
    { title: 'Phase 0 基础设施' },
    { title: 'Phase 1 架构设计' },
    { title: 'Phase 2 定点量化' },
    { title: 'Phase 3 TB+向量生成' },
    { title: 'Phase 4 RTL编码+脚本化对比' },
    { title: 'Phase 4.5 证据门禁' },
    { title: 'Phase 5 顶层集成+全链仿真' },
    { title: 'Phase 6 回归覆盖率' },
    { title: 'Phase 7 代码审查' },
    { title: 'Phase 8 报告+Verifier' },
  ],
};

// ── 主参数 ─────────────────────────────────────────────────────────────────

const modules = args?.modules || [];
const liteMode = args?.lite === true;
const projectRoot = args?.projectRoot || process.cwd();

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

[MUST] 按跨项目标准建目录 (knowledge/primary/cross-project-experience.md):
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
- Makefile 存在且 lint/compile/sim/clean 目标完整
- .gitignore 排除 transient
- make lint 通过

━━━ 检查点 ━━━
产出以上目录结构后暂停，用户审查确认目录合规后再进入 Phase 1。
━━━━━━━━━━━`, { label: 'p0-infra' });
    return result;
  },
};

// ── Phase 1: 架构设计 ───────────────────────────────────────────────────────

nodes.p1_arch = {
  deps: ['p0_infra'],
  run: async (ctx) => {
    const infra = ctx.p0_infra?.data || '';
    const result = await agent(`执行 HDL 工作流 Phase 1: 架构设计 (算法工程师负责)

前提: 基础设施已就绪
${String(infra).slice(0, 300)}

任务:
1. 算法文档化 + 顶层框图
2. 模块↔MATLAB Golden Model 对标
3. **微架构拆解 [MUST]**:
   a) **流水线结构**: 每级功能、延迟周期、握手方式
   b) **FSM 状态图**: 状态定义、转移条件、输出信号
   c) **数据通路**: 每级输入/输出位宽、定点 Q 格式
   d) **模块接口时序图**
4. **写入文件 [MUST]**: 以下文件必须写入磁盘:
   - 06_doc/architecture.yaml — 包含必填字段:
     modules: [{name, type, matlab_ref, symmetric_with, pipeline_stages: [{name, function, latency, bit_width, q_format}], fsm_states: [{name, description, transitions}]}]
   - 06_doc/pipeline_diagram.md — 流水线图 + 数据流描述
   - 06_doc/algorithm_spec.md — 算法规范
5. 模块对称对分析:
   - 扫描模块列表, 识别所有可能成对的模块
   - 识别规则 (通用, 不限项目领域):
     a) 前缀对: <前缀1>_<名称> / <前缀2>_<名称>
     b) 后缀对: <名称>_<后缀1> / <名称>_<后缀2>
     c) de- 前缀: <名称> / de<名称>
     d) 互逆词: encoder/decoder, modulator/demodulator, mapper/demapper, fft/ifft
   - 输出到 architecture.yaml:
     - pair_conventions 字段
     - 每模块 symmetric_with 和 symmetry_type

模块: ${modules.join(', ') || '项目默认'}

━━━ 检查点 ━━━
产出以上 artifact 后暂停，等待用户审查方案后再进入 Phase 2。
━━━━━━━━━━━`, { label: 'p1-architecture' });

    // ── 校验 architecture.yaml 完整性 ─────────────────────────
    const archPath = path.join(projectRoot, '06_doc', 'architecture.yaml');
    log(`🔍 校验 architecture.yaml: ${archPath}`);
    if (!fs.existsSync(archPath)) {
      throw new Error(`❌ architecture.yaml 不存在于 ${archPath}\n   Phase 1 未产出架构文件, 请确保写入 06_doc/architecture.yaml`);
    }
    const archContent = fs.readFileSync(archPath, 'utf-8');
    const requiredFields = ['modules', 'pipeline_stages', 'fsm_states', 'bit_width', 'latency'];
    const missing = requiredFields.filter(f => !archContent.includes(f));
    if (missing.length > 0) {
      log(`⚠️ architecture.yaml 缺少以下字段: ${missing.join(', ')}`);
      log('  继续执行但建议审查后补充完整。');
    } else {
      log('✅ architecture.yaml 包含所有必填字段');
    }

    // ── 压缩保留块: Phase 1 架构 ──────────────────────────
    log('');
    log('📌 === 压缩保留块: Phase 1 架构 ===');
    log('保留原因: 架构方案是后续所有 RTL 的契约，压缩时丢失 = 全部重来');
    log(`模块列表: ${modules.join(', ') || '项目默认'}`);
    log(`文件产出: 06_doc/architecture.yaml, 06_doc/pipeline_diagram.md, 06_doc/algorithm_spec.md`);
    log(`流水线级数: ${(() => { try { return JSON.parse(fs.readFileSync(archPath,'utf8'))?.pipeline_stages?.length || '未知'; } catch { return '未知'; } })()}`);
    log(`关键决策: FSM 状态图、模块接口定义、定点 Q 格式`);
    log('=== 保留块结束 ===');
    log('');

    return result;
  },
};

// ── Phase 2: 定点量化 ───────────────────────────────────────────────────────

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

// ── Phase 3: TB + MATLAB 向量生成 ──────────────────────────────────────────

nodes.p3_tb = {
  deps: ['p1_arch'],
  run: async (ctx) => {
    const arch = ctx.p1_arch?.data || '';
    const [tbResult, vecResult] = await parallel([
      // ── 子任务 1: 逻辑工程师 — Testbench ─────────────────────────
      () => agent(`执行 HDL 工作流 Phase 3 (TB): 编写 Testbench (逻辑工程师)

架构设计: ${String(arch).slice(0, 300)}
模块: ${modules.join(', ') || '项目默认'}

任务:
1. 自检 Testbench (模块级, 单模块验证)
2. SVA 断言 (关键接口时序)
3. 结构化日志 + 波形配置 ($dumpvars)
4. 对比脚本骨架: 02_sim/check_<module>.py
   - 读 02_sim/tv/<module>_tv.txt (MATLAB golden 向量)
   - 读 RTL 仿真输出 02_sim/<module>_out.txt
   - 逐点数值对比 → 输出 JSON 到 02_sim/check_results/<module>.json

输出: TB 编译通过, 自检逻辑完整, 对比脚本骨架就绪`, { label: 'p3-tb', phase: 'Phase 3 TB+向量生成' }),

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

输出: 02_sim/tv/<module>_tv.txt, 覆盖所有 corner case`, { label: 'p3-vectors', phase: 'Phase 3 TB+向量生成' }),
    ]);

    return `[TB]\n${tbResult}\n\n[VECTORS]\n${vecResult}`;
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Phase 4: 逐模块 RTL + 脚本化对比 [MUST]  — D+B 融合
// ═════════════════════════════════════════════════════════════════════════════

nodes.p4_rtl = {
  deps: ['p2_fixedpt', 'p3_tb'],
  run: async (ctx) => {
    const fixedpt = ctx.p2_fixedpt?.data || '';
    const tb = ctx.p3_tb?.data || '';
    const moduleList = modules.length > 0 ? modules : ['模块_1', '模块_2'];

    const fixedptHint = fixedpt ? String(fixedpt).slice(0, 300) : '[Lite 模式] 无定点报告 — 使用架构方案默认位宽';

    const result = await agent(`执行 HDL 工作流 Phase 4: 逐模块 RTL + 脚本化对比 (逻辑工程师负责)

定点报告: ${fixedptHint}
Testbench: ${String(tb).slice(0, 300)}

模块: ${moduleList.join(', ')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[MUST 硬约束] — 逐模块, 逻辑工程师独立完成
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 一次只处理一个模块。完成再下一模块。

2. 每个模块的完成标准:
   a) 按 architecture.yaml 微架构方案编码 (流水线/FSM/位宽必须一致)
   b) make lint 通过 [MUST] — 不通过不进下一步
   c) make compile 通过
   d) 确保 02_sim/check_results/ 目录存在 (不存在则创建)
   e) 生成对比脚本 02_sim/check_<module>.py:
      - 读 MATLAB golden 向量  02_sim/tv/<module>_tv.txt
      - 读 RTL 仿真输出        02_sim/<module>_out.txt (仿真在 02_sim/ 下运行)
      - 逐点数值对比
      - 输出 JSON 到 02_sim/check_results/<module>.json
      - JSON 格式: {"module":"<name>","status":"PASS|FAIL","compared_points":N,"max_error_lsb":E,"first_fail_at":null}
   f) bash 运行该脚本, 确认 exit code 为 0
   g) status=FAIL → 分析根因 → 修复 RTL → 重新对比

3. [NEW] 每模块完成后运行 make clean, 清理 work/ transcript 避免干扰下一模块

4. RTL ↔ Golden Model 对标标准:
   - RTL 每模块输出必须与定点 Golden Model 逐周期逐比特对齐
   - 允许差异: 定点精度损失（截位/饱和，须在 fixed_point_report 中标注）
   - 不允许差异: 算法方向偏离、流水线级数与架构方案不一致

5. 所有模块完成后输出验证矩阵表格

模块: ${moduleList.join(', ')}

输出:
1. 02_sim/check_results/<module>.json   (每个模块)
2. 验证矩阵表格 (Markdown)
3. 差异分析 (如有 FAIL)
4. RTL vs GM 对标报告

	━━━ 检查点 ━━━
	产出验证矩阵 + 每模块 JSON 证据文件后暂停。
	由调度层呈报用户审查后进入 Phase 4.5 证据门禁。
	━━━━━━━━━━━`, { label: 'p4-rtl-sequential' });
    // ── 压缩保留块: Phase 4 RTL ─────────────────────────────
    log('');
    log('📌 === 压缩保留块: Phase 4 RTL ===');
    log('保留原因: 每模块 JSON 证据是门禁依据，验证矩阵是准入 Phase 5 的凭证');
    log(`已验证模块: ${modules.join(', ') || '项目默认'}`);
    log(`证据文件: 02_sim/check_results/*.json (每个模块)`);
    log(`产出文件: 01_src/00_hdl/*.sv (RTL 源码), 02_sim/check_*.py (对比脚本)`);
    log(`验证标准: RTL vs Golden Model 逐周期逐比特对齐`);
    log('=== 保留块结束 ===');
    log('');

    return result;
  },
};
// ═════════════════════════════════════════════════════════════════════════════

nodes.p45_evidence_gate = {
  deps: ['p4_rtl'],
  run: async (ctx) => {
    phase('Phase 4.5 证据门禁');

    const checkDir = path.join(projectRoot, '02_sim', 'check_results');

    // ── Step 1: File Check (纯 fs, 0 agent token) ──────────────

    log('🔍 [证据门禁] 独立读取 evidence JSON 文件...');

    if (!fs.existsSync(checkDir)) {
      throw new Error(`❌ [证据门禁] 目录不存在: ${checkDir}\n   Phase 4 未产出验证证据, 请确保 Phase 4 生成了检查脚本并运行。`);
    }

    const files = fs.readdirSync(checkDir).filter(f => f.endsWith('.json'));
    const allResults = [];
    let allPass = true;

    for (const mod of modules) {
      const jsonFile = `${mod}.json`;
      const jsonPath = path.join(checkDir, jsonFile);

      if (!fs.existsSync(jsonPath)) {
        allPass = false;
        allResults.push({ module: mod, pass: false, reason: `JSON 证据文件不存在: ${jsonPath}` });
        continue;
      }

      let data;
      try {
        data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      } catch (e) {
        allPass = false;
        allResults.push({ module: mod, pass: false, reason: `JSON 解析失败: ${e.message}` });
        continue;
      }

      if (!data.status || data.status !== 'PASS') {
        allPass = false;
        allResults.push({
          module: mod,
          pass: false,
          reason: `status=${data.status || 'MISSING'}, first_fail_at=${data.first_fail_at ?? 'N/A'}`,
        });
        continue;
      }

      if (!data.compared_points || data.compared_points === 0) {
        allPass = false;
        allResults.push({
          module: mod,
          pass: false,
          reason: `compared_points=${data.compared_points} — 脚本可能未实际运行`,
        });
        continue;
      }

      allResults.push({
        module: mod,
        pass: true,
        points: data.compared_points,
        max_error: data.max_error_lsb ?? 0,
      });
    }

    for (const r of allResults) {
      if (r.pass) {
        log(`  ✅ ${r.module}: PASS (${r.points} points, max_err=${r.max_error}LSB)`);
      } else {
        log(`  ❌ ${r.module}: FAIL — ${r.reason}`);
      }
    }

    if (!allPass) {
      throw new Error(
        `❌ [证据门禁] 文件检查 FAIL:\n${
          allResults.filter(r => !r.pass).map(r => `   - ${r.module}: ${r.reason}`).join('\n')
        }\nPhase 4 验证未通过, 无法进入 Phase 5 集成。请修复后重试。`
      );
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

如果全部 pass → 只输出空数组 []。`, { label: 'p45-adversarial', phase: 'Phase 4.5 证据门禁' });

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

// ── Phase 5: 顶层集成 + 全链仿真 [MUST] ────────────────────────────────────

nodes.p5_top_integration = {
  deps: ['p45_evidence_gate'],
  run: async (ctx) => {
    const gateResult = ctx.p45_evidence_gate?.data || {};
    const isTrusted = gateResult.pass === true;

    const result = await agent(`执行 HDL 工作流 Phase 5: 顶层集成 + 全链仿真 (逻辑工程师负责)

证据门禁: ${isTrusted ? '✅ 通过 (所有模块已验证)' : '⚠️ 状态未知'}
门禁详情: ${JSON.stringify(gateResult).slice(0, 300)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[MUST 硬约束] 顶层集成 — 入口已验证
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 搭建顶层:
   a) 创建顶层模块, 例化所有子模块
   b) 按数据流方向连接
   c) 确认 AXI4-Stream 握手链完整
   d) make compile 通过

2. 全链仿真 — 输入到输出逐级对比 MATLAB golden:
   a) MATLAB 注入全帧测试向量
   b) 逐级捕获中间结果对比
   c) 定点模块: 逐周期 bit-true
   d) 不一致 → 隔离根因模块

3. [NEW] RTL ↔ Golden Model 最终对齐标准:
   - 最终输出必须与定点 Golden Model 逐比特对齐
   - 允许: 定点精度损失 (截位/饱和，须在报告中注明)
   - 不允许: 算法方向偏离、使用容差掩盖逻辑差异
   - 验证报告必须包含: compared_points, max_error_lsb, 算法方向一致性结论

模块: ${modules.join(', ') || '项目默认'}
输出:
1. top.sv 顶层模块
2. 全链仿真日志 (含逐级对比表)
3. RTL vs GM 对比报告 (compared_points + max_error_lsb + 算法方向一致性)

━━━ 检查点 ━━━
产出全链仿真日志 + 对比报告后暂停，由调度层呈报用户审查。
━━━━━━━━━━━`, { label: 'p5-top-integration' });

    // ── 压缩保留块: Phase 5 顶层集成 ───────────────────────
    log('');
    log('📌 === 压缩保留块: Phase 5 顶层集成 ===');
    log('保留原因: 全链仿真结果是 RTL 与 Golden Model bit-true 对齐的最终证据');
    log('产出文件: top.sv (顶层), 全链仿真日志, RTL vs GM 对比报告');
    log(`模块: ${modules.join(', ') || '项目默认'}`);
    log('验证标准: 最终输出与定点 Golden Model 逐比特对齐');
    log('允许误差: 定点精度损失（截位/饱和），已在报告中注明');
    log('=== 保留块结束 ===');
    log('');

    return result;
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

输出: regress 全绿 (或真实编译/仿真日志)`, { label: 'p6-regression' });
    return result;
  },
};

// ── Phase 7: 代码审查 ──────────────────────────────────────────────────────

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
      '## Phase 1 架构设计',     ctx.p1_arch?.data || 'N/A',
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

  log('   依赖链: P0→P1→P3→P4→P45→P5→P7→P8→Verifier');
  log('   (跳过节点: P2 定点量化, P6 覆盖率回归)');
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
  '📋 检查点流程 (NEW):',
  '  此工作流在 Phase 1/2/3/4.5/5/7 完成后产出 artifact',
  '  调度层将暂停并呈报审查 → 用户确认后继续',
  '  未确认不跨 Phase',
  '',
  'DAG 依赖链:',
  liteMode
    ? '  P0→P1→P3→P4→P45→P5→P7→P8→Verifier (跳过 P2,P6)'
    : '  P0→P1→P2/P3并行→P4→P45→P5→P6/P7并行→P8→Verifier',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
].join('\n');

log(preflightSummary);

if (modules.length === 0) {
  log('⚠️ 警告: 模块列表为空。如果是有意初始化新项目请忽略此警告。');
  log('   如果是执行已有模块的开发流程，请传入 modules 参数。');
}

// ── 执行 DAG ──────────────────────────────────────────────────────────────

phase('DAG 执行');
const dagResult = await dag.execute(nodes, {
  onProgress: (layer, total, names) => log(`[层 ${layer}/${total}] ${names}`),
  log,
});

// ── 输出摘要 ──────────────────────────────────────────────────────────────

const verifierOutput = dagResult.results.verifier?.data || '';
log('=== DAG 工作流完成 ===');

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
  verifier: verifierOutput,
};
