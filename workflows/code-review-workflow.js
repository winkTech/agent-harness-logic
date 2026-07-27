export const meta = {
  name: 'code-review-workflow',
  description: '两轮代码审查的多 Agent 编排版 — Pass 1 正确性(阻塞) → Pass 2 代码质量(建议)。单轮审查用 code-review 技能。',
  phases: [
    { title: 'Pass 1 正确性审查' },
    { title: 'Pass 2 代码质量审查' },
    { title: 'Pass 3 HDL 专项审查' },
    { title: '对抗验证' },
    { title: '报告合成' },
  ],
  contract: {
    version: 2,
    strict: true,
    inputs: ['files', 'lang', 'intent/requirements optional but must not be invented'],
    checkpoints: ['preflight-files-present', 'adversarial-verify', 'blocking-findings-gate', 'report-synthesis'],
    evidence: ['exact file:line for each finding', 'localized evidence snippet', 'severity and impact', 'per-finding adversarial verdict (CONFIRMED/REFUTED/UNVERIFIED)'],
    completionCriteria: [
      'every requested file is included in the review scope',
      'every CRITICAL/HIGH finding gets an adversarial verify pass (capped, unverified stays blocking)',
      'confirmed CRITICAL/HIGH Pass 1 findings make the workflow fail',
      'confirmed CRITICAL/HIGH HDL Pass 3 findings make the workflow fail',
      'summary reports blocking findings explicitly',
    ],
  },
};

// ── 两轮 + HDL 专项审查工作流 ────────────────────────────────────────────
// Pass 1: 正确性审查 (阻塞)  Pass 2: 代码质量审查 (建议)  Pass 3: HDL 专项 (4 维并行)
//   Workflow({name: 'code-review-workflow', args: {files: ['path/to/file.sv']}})

const fileList = args?.files || [];
const language = args?.lang || 'auto';

// ── 入口检查 ──────────────────────────────────────────────────────────────

phase('Pre-flight');

if (fileList.length === 0) {
  log('⚠️ 未指定审查文件。请提供 files 参数，例如:');
  log('   Workflow({name: "code-review-workflow", args: {files: ["src/file.sv"]}})');
  return { pass: false, reason: '缺少 files 参数', findings: [] };
}

log(`📋 审查文件 (${fileList.length} 个):`);
fileList.forEach(f => log(`   - ${f}`));

// ── 检测是否为 HDL 文件 ────────────────────────────────────────────────────

const hdlFiles = fileList.filter(f => /\.(sv|v|vhdl?)$/i.test(f));
const isHDL = hdlFiles.length > 0;

log(`📂 检测到 HDL 文件: ${isHDL ? hdlFiles.length + ' 个' : '无'}`);
if (isHDL) {
  log(`   HDL 文件: ${hdlFiles.join(', ')}`);
  log(`   → 将启用 4 维 HDL 专项审查 (架构/正确性/性能/接口)`);
}

// ── Pass 1: 正确性审查 ───────────────────────────────────────────────────

phase('Pass 1 正确性审查');

const pass1Result = await agent(`你是一名**代码审查员**，执行 Pass 1 正确性审查（阻塞性）。

审查以下文件：
${fileList.map(f => `- ${f}`).join('\n')}
语言: ${language}
用户需求/审查意图（不得自行补全）:
${args?.intent || args?.requirements || '未提供；仅基于文件内容、显式接口和本工作流审查规则判断，不得臆测产品需求。'}

审查四大维度（必须逐文件覆盖）：

### 1.1 规格合规
- 实现是否满足需求规格
- 接口信号/函数签名是否符合设计文档
- 参数配置是否正确

### 1.2 逻辑正确
- 算法/业务逻辑是否有缺陷
- 状态转移是否正确
- 边界条件是否处理
- 位宽/类型是否匹配

### 1.3 边界处理
- 空值/零长度输入
- 最大/最小值
- 并发/重入
- 异常/错误处理

### 1.4 安全审查
- 输入验证
- 缓冲区/数组越界
- 硬编码密码/密钥

输出格式（JSON 数组）：
[
  {
    "pass": "P1|P2",
    "severity": "CRITICAL|HIGH|MEDIUM|LOW",
    "category": "规格合规|逻辑正确|边界处理|安全审查",
    "file": "path:line",
    "title": "问题简述",
    "description": "详细说明",
    "evidence": "本地证据摘要",
    "impact": "不修复的影响",
    "suggestion": "修复建议"
  }
]

如果没有发现问题，返回空数组 []。

约束：
- CRITICAL/HIGH severity 为零阻塞 → 不通过 Pass 1
- 每条发现必须标注 severity
- 每条发现必须绑定精确 file:line，并给出 evidence 字段；没有本地证据不得报 finding
- 不确定时输出 openQuestions，不要把假设写成事实`, { label: 'p1-correctness', phase: 'Pass 1 正确性审查', schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pass: { type: 'string', enum: ['P1', 'P2'] },
            severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
            category: { type: 'string', enum: ['规格合规', '逻辑正确', '边界处理', '安全审查', '代码结构', '风格一致性', 'DRY', '命名可读性', '文档'] },
            file: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            evidence: { type: 'string' },
            impact: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: ['pass', 'severity', 'category', 'file', 'title', 'description', 'evidence'],
        },
      },
      openQuestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['findings'],
  }});

const p1Findings = pass1Result?.findings || [];
const blockingIssues = p1Findings.filter(f =>
  f.pass === 'P1' && (f.severity === 'CRITICAL' || f.severity === 'HIGH')
);

log(`\n📊 Pass 1 结果:`);
log(`   共 ${p1Findings.length} 条发现`);
log(`   阻塞问题: ${blockingIssues.length} 条 (CRITICAL/HIGH)`);

blockingIssues.forEach(f => {
  log(`   ❌ [${f.severity}] ${f.file}: ${f.title}`);
});

const pass1Passed = blockingIssues.length === 0;

if (!pass1Passed) {
  log('\n❌ Pass 1 未通过 — ' + blockingIssues.length + ' 个阻塞问题 (跳过 Pass 2 代码质量审查)');
  log('   Pass 3 HDL 专项审查和报告合成将继续执行。');
} else {
  log('✅ Pass 1 通过 — 零阻塞问题，进入 Pass 2');
}

// ── Pass 2: 代码质量审查 (仅在 Pass 1 通过时执行) ─────────────────────────

let p2Findings = [];

if (pass1Passed) {
  phase('Pass 2 代码质量审查');

const pass2Result = await agent(`你是一名**代码审查员**，执行 Pass 2 代码质量审查（建议性，非阻塞）。

审查以下文件 (Pass 1 已通过)：
${fileList.map(f => `- ${f}`).join('\n')}

审查五大维度：

### 2.1 代码结构
- 函数/方法长度（建议 ≤ 50 行）
- 圈复杂度（建议 ≤ 10）
- 单一职责原则
- 模块化程度

### 2.2 风格一致性
- 命名规范
- 缩进/格式
- import/include 顺序

### 2.3 DRY
- 重复代码
- 魔数抽取
- 可复用逻辑

### 2.4 命名可读性
- 语义化命名
- 动词函数名
- 无歧义缩写

### 2.5 文档
- 注释质量
- 公共 API 文档
- TODO/FIXME 标记

输出格式（JSON 数组）— 与 Pass 1 格式一致，pass 字段为 "P2"：
[
  {
    "pass": "P2",
    "severity": "MEDIUM|LOW",
    "category": "代码结构|风格一致性|DRY|命名可读性|文档",
    "file": "path:line",
    "title": "问题简述",
    "description": "详细说明",
    "evidence": "本地证据摘要",
    "suggestion": "改进建议"
  }
]

如果没有发现问题，返回空数组 []。

约束:
- 每条建议必须有精确 file:line 和 evidence 字段；没有证据不得输出`, { label: 'p2-quality', phase: 'Pass 2 代码质量审查', schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pass: { type: 'string', enum: ['P2'] },
            severity: { type: 'string', enum: ['MEDIUM', 'LOW'] },
            category: { type: 'string', enum: ['代码结构', '风格一致性', 'DRY', '命名可读性', '文档'] },
            file: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            evidence: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: ['pass', 'severity', 'category', 'file', 'title', 'description', 'evidence'],
        },
      },
    },
    required: ['findings'],
  }});

p2Findings = pass2Result?.findings || [];

log(`\n📊 Pass 2 结果:`);
log(`   共 ${p2Findings.length} 条建议`);

p2Findings.forEach(f => {
  log(`   💡 [${f.severity}] ${f.file}: ${f.title}`);
});

} // end if(pass1Passed) — Pass 2

// ── Pass 3: HDL 多维专项审查 (仅在检测到 .sv/.v 时激活) ────────────────────

const p3Findings = [];

if (isHDL) {
  phase('Pass 3 HDL 专项审查');

  log('\n🔬 HDL 多维专项审查启动 (4 维度并行):');
  log('   1. 架构审查 — 流水线/FSM/CDC/复位合规');
  log('   2. 正确性审查 — 逻辑错误/位宽/时序/latch');
  log('   3. 性能审查 — Fmax/资源/吞吐/关键路径');
  log('   4. 接口审查 — valid-ready/位宽/AXI-Stream 合规');

  const hdlReviews = await Promise.all([
    agent(`你是一个 FPGA 架构审查专家 (ce-architecture-strategist)。

审查以下 HDL 文件：
${hdlFiles.map(f => '- ' + f).join('\n')}

执行架构审查，聚焦:
1. **流水线架构**: 级数匹配、背压传播、吞吐一致性
2. **状态机**: 编码方式、死锁风险、输出寄存
3. **数据通路**: 位宽与 Q 格式一致、截位策略
4. **🔴 复位红线**: 全部使用 i_rst 同步高有效
5. **时钟域**: CDC 信号清单完整、异步 FIFO 深度计算
6. **模块划分**: 边界合理、无跨层次组合逻辑

注意: 这是 FPGA/HDL 专用审查，不是软件审查。

输出格式同 code-review-workflow Pass 1 格式。`,
    { label: 'p3-architecture', phase: 'Pass 3 HDL 专项审查', schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
              category: { type: 'string', enum: ['架构-流水线', '架构-FSM', '架构-数据通路', '架构-复位红线', '架构-CDC', '架构-模块划分'] },
              file: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              evidence: { type: 'string' },
              suggestion: { type: 'string' },
            },
            required: ['severity', 'category', 'file', 'title', 'description', 'evidence'],
          },
        },
      },
      required: ['findings'],
    }}),

    agent(`你是一个 HDL 逻辑正确性审查专家 (ce-correctness-reviewer)。

审查以下 HDL 文件：
${hdlFiles.map(f => '- ' + f).join('\n')}

执行正确性审查，聚焦:
1. **位宽匹配**: 赋值两侧位宽一致，signed/unsigned 正确
2. **FSM 安全**: 无不可达状态、default 完备、无 latch 推断
3. **时序**: 组合环路检查、阻塞/非阻塞赋值混用、异步输入未同步
4. **🔴 复位**: always_ff 块第一行 if(i_rst) 检查
5. **边界条件**: FIFO 空满标志正确性、计数器溢出、背压保持

输出格式同 code-review-workflow Pass 1 格式。`,
    { label: 'p3-correctness', phase: 'Pass 3 HDL 专项审查', schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
              category: { type: 'string', enum: ['正确性-位宽', '正确性-FSM', '正确性-时序', '正确性-复位', '正确性-边界条件'] },
              file: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              evidence: { type: 'string' },
              suggestion: { type: 'string' },
            },
            required: ['severity', 'category', 'file', 'title', 'description', 'evidence'],
          },
        },
      },
      required: ['findings'],
    }}),

    agent(`你是一个 FPGA 性能/资源审查专家 (ce-performance-oracle)。

审查以下 HDL 文件：
${hdlFiles.map(f => '- ' + f).join('\n')}

执行性能审查，聚焦:
1. **关键路径**: 最长组合逻辑级数，标注路径
2. **资源**: DSP48/LUT/BRAM 使用是否合理
3. **吞吐**: 启动间隔 II=1? 背压下的有效吞吐?
4. **Pipeline 平衡**: 各级延迟是否匹配，有无瓶颈
5. **CDC 时序**: 异步 FIFO 接口的时序约束

注意: 这是 FPGA 时序/资源审查，不是软件性能审查。

输出格式同 code-review-workflow Pass 1 格式。`,
    { label: 'p3-performance', phase: 'Pass 3 HDL 专项审查', schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
              category: { type: 'string', enum: ['性能-时序', '性能-资源', '性能-吞吐', '性能-Pipeline', '性能-CDC'] },
              file: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              evidence: { type: 'string' },
              suggestion: { type: 'string' },
            },
            required: ['severity', 'category', 'file', 'title', 'description', 'evidence'],
          },
        },
      },
      required: ['findings'],
    }}),

    agent(`你是一个 HDL 接口契约审查专家 (ce-api-contract-reviewer)。

审查以下 HDL 文件：
${hdlFiles.map(f => '- ' + f).join('\n')}

执行接口审查，聚焦:
1. **握手协议**: valid-ready 时序正确 (valid 不依赖 ready)
2. **位宽匹配**: 端口位宽与 architecture.yaml 一致
3. **AXI-Stream**: tvalid/tready/tlast/tkeep 合规
4. **CDC 接口**: 跨时钟信号清单完整，同步方案合理
5. **悬空端口**: 例化时未连接的输入/输出

注意: 这是 FPGA 模块接口审查，不是软件 API 审查。

输出格式同 code-review-workflow Pass 1 格式。`,
    { label: 'p3-interface', phase: 'Pass 3 HDL 专项审查', schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
              category: { type: 'string', enum: ['接口-握手', '接口-位宽', '接口-AXI-Stream', '接口-CDC', '接口-悬空'] },
              file: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              evidence: { type: 'string' },
              suggestion: { type: 'string' },
            },
            required: ['severity', 'category', 'file', 'title', 'description', 'evidence'],
          },
        },
      },
      required: ['findings'],
    }}),
  ]);

  hdlReviews.forEach((review, i) => {
    const labels = ['架构', '正确性', '性能', '接口'];
    const findings = review?.findings || [];
    log('  📊 HDL ' + labels[i] + '审查: ' + findings.length + ' 条发现');
    findings.forEach(f => {
      const icon = f.severity === 'CRITICAL' ? '❌' : f.severity === 'HIGH' ? '⚠️' : '💡';
      log('     ' + icon + ' [' + f.severity + '] ' + f.category + ': ' + f.file + ' — ' + f.title);
    });
    p3Findings.push(...findings.map(f => ({ ...f, pass: 'P3' })));
  });

  log('\n📊 Pass 3 汇总: ' + p3Findings.length + ' 条 HDL 专项审查发现');
}

// ── 对抗验证: 逐条复核阻塞级发现 (CRITICAL/HIGH) ──────────────────────────
// 审查 agent 的发现直接进报告会把误报当真。每条候选阻塞发现派一个独立
// 怀疑者尝试反驳; 被证伪的降级为 REFUTED (保留在报告中但不再阻塞)。
// 验证失败/无返回时保守处理: 发现保留阻塞地位 (宁可误拦不可漏放)。

phase('对抗验证');

const VERIFY_CAP = 12; // 防失控: 超出上限的发现不验证, 直接保留阻塞地位

const candidateBlocking = [
  ...p1Findings.filter(f => f.pass === 'P1' && (f.severity === 'CRITICAL' || f.severity === 'HIGH')),
  ...p3Findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH'),
];

let refutedCount = 0;
if (candidateBlocking.length > 0) {
  log(`\n🔍 对抗验证: ${candidateBlocking.length} 条 CRITICAL/HIGH 候选发现逐条复核 (上限 ${VERIFY_CAP})`);
  const toVerify = candidateBlocking.slice(0, VERIFY_CAP);
  const verdicts = await Promise.all(toVerify.map((f, i) =>
    agent(`你是**对抗验证者**。下面是一条代码审查发现, 你的任务是尝试**反驳**它。

发现:
- 位置: ${f.file}
- 严重度: ${f.severity} / 类别: ${f.category || 'N/A'}
- 标题: ${f.title}
- 描述: ${String(f.description || '').slice(0, 500)}
- 证据: ${String(f.evidence || '').slice(0, 300)}

要求:
1. 打开 ${String(f.file).split(':')[0]} 独立阅读相关代码, 不要采信发现的描述
2. 构造具体反例或指出发现引用的代码语义被误读, 才能判 refuted=true
3. 拿不准时 refuted=false (发现保留) —— 不确定不等于证伪
4. 你是只读验证者, 不修改任何文件`,
      {
        label: `verify-finding-${i}`,
        phase: '对抗验证',
        agentType: /\.(sv|v|vhdl?)(:|$)/i.test(String(f.file)) ? 'ce-correctness-reviewer' : undefined,
        schema: {
          type: 'object',
          properties: {
            refuted: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['refuted', 'reason'],
        },
      }).catch(() => null)
  ));

  toVerify.forEach((f, i) => {
    const v = verdicts[i];
    if (v && v.refuted === true) {
      f.verdict = 'REFUTED';
      f.verdictReason = String(v.reason || '').slice(0, 300);
      refutedCount += 1;
      log(`   🚫 证伪: [${f.severity}] ${f.file} — ${f.title} (${f.verdictReason.slice(0, 80)})`);
    } else {
      f.verdict = v ? 'CONFIRMED' : 'UNVERIFIED';
      if (f.verdict === 'CONFIRMED') log(`   ✅ 确认: [${f.severity}] ${f.file} — ${f.title}`);
      else log(`   ⚠️ 未验证 (验证 agent 无返回, 保守保留): [${f.severity}] ${f.file} — ${f.title}`);
    }
  });
  if (candidateBlocking.length > VERIFY_CAP) {
    log(`   ⚠️ ${candidateBlocking.length - VERIFY_CAP} 条超出验证上限, 未验证直接保留阻塞地位`);
  }
  log(`   对抗验证结果: ${refutedCount} 条被证伪并降级, ${candidateBlocking.length - refutedCount} 条保留`);
} else {
  log('\n🔍 对抗验证: 无 CRITICAL/HIGH 候选发现, 跳过');
}

// ── 报告合成 ──────────────────────────────────────────────────────────────

phase('报告合成');

const allFindings = [...p1Findings, ...p2Findings, ...p3Findings];

log('\n📋 ===== 审查总结 =====');
log(`   审查文件: ${fileList.length} 个`);
log(`   Pass 1 (正确性): ${pass1Passed ? '✅ 通过' : '❌ 未通过'} — ${p1Findings.length} 条发现, ${blockingIssues.length} 条阻塞`);
log(`   Pass 2 (代码质量): ${p2Findings.length} 条建议`);
if (isHDL) log(`   Pass 3 (HDL 专项): ${p3Findings.length} 条发现 (架构/正确性/性能/接口)`);

// 按 severity 统计
const bySeverity = {};
allFindings.forEach(f => {
  bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
});
log(`\n   按严重等级:`);
Object.entries(bySeverity).forEach(([sev, count]) => {
  log(`     ${sev}: ${count}`);
});

// 被对抗验证证伪的发现不再计入阻塞 (保留在 findings 里供人工复查)
const confirmedP1Blocking = blockingIssues.filter(f => f.verdict !== 'REFUTED');
const p3BlockingIssues = p3Findings.filter(f =>
  (f.severity === 'CRITICAL' || f.severity === 'HIGH') && f.verdict !== 'REFUTED'
);
const workflowPassed = confirmedP1Blocking.length === 0 && p3BlockingIssues.length === 0;
const allBlockingIssues = [...confirmedP1Blocking, ...p3BlockingIssues];
if (refutedCount > 0) {
  log(`\n   对抗验证后阻塞问题: ${allBlockingIssues.length} 条 (${refutedCount} 条已证伪降级)`);
}

return {
  pass: workflowPassed,
  pass1: {
    passed: pass1Passed,
    total: p1Findings.length,
    blocking: blockingIssues.length,
    findings: p1Findings,
  },
  pass2: {
    total: p2Findings.length,
    findings: p2Findings,
  },
  pass3: isHDL ? {
    passed: p3BlockingIssues.length === 0,
    total: p3Findings.length,
    blocking: p3BlockingIssues.length,
    findings: p3Findings,
  } : null,
  blockingIssues: allBlockingIssues,
  summary: {
    files: fileList,
    totalFindings: allFindings.length,
    bySeverity,
  },
};
