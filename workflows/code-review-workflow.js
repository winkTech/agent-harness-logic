/**
 * code-review-workflow — 两轮代码审查工作流
 *
 * Pass 1: 正确性审查（阻塞性）— 规格合规 + 逻辑正确 + 边界处理 + 安全审查
 * Pass 2: 代码质量审查（建议性）— 代码结构 + 风格 + DRY + 命名 + 文档
 *
 * 调用:
 *   Workflow({name: 'code-review-workflow', args: {files: ['01_src/tx/scrambler.sv']}})
 *   Workflow({name: 'code-review-workflow', args: {files: ['src/*.py'], lang: 'python'}})
 */

const path = require('path');
const fs = require('fs');

export const meta = {
  name: 'code-review-workflow',
  description: '两轮代码审查 — Pass 1 正确性(阻塞) → Pass 2 代码质量(建议)',
  phases: [
    { title: 'Pass 1 正确性审查' },
    { title: 'Pass 2 代码质量审查' },
    { title: '报告合成' },
  ],
};

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

// ── Pass 1: 正确性审查 ───────────────────────────────────────────────────

phase('Pass 1 正确性审查');

const pass1Result = await agent(`你是一名**代码审查员**，执行 Pass 1 正确性审查（阻塞性）。

审查以下文件：
${fileList.map(f => `- ${f}`).join('\n')}
语言: ${language}

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
    "impact": "不修复的影响",
    "suggestion": "修复建议"
  }
]

如果没有发现问题，返回空数组 []。

约束：
- CRITICAL/HIGH severity 为零阻塞 → 不通过 Pass 1
- 每条发现必须标注 severity`, { label: 'p1-correctness', phase: 'Pass 1 正确性审查', schema: {
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
            impact: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: ['pass', 'severity', 'category', 'file', 'title', 'description'],
        },
      },
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
  log('\n❌ Pass 1 未通过 — 存在阻塞性问题，不进入 Pass 2');
  log('   请修复以上问题后重试。');

  return {
    pass: false,
    pass1: { passed: false, findings: p1Findings, blockingIssues },
    pass2: null,
    summary: `Pass 1 未通过: ${blockingIssues.length} 个阻塞问题`,
  };
}

log('✅ Pass 1 通过 — 零阻塞问题，进入 Pass 2');

// ── Pass 2: 代码质量审查 ─────────────────────────────────────────────────

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
    "suggestion": "改进建议"
  }
]

如果没有发现问题，返回空数组 []。`, { label: 'p2-quality', phase: 'Pass 2 代码质量审查', schema: {
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
            suggestion: { type: 'string' },
          },
          required: ['pass', 'severity', 'category', 'file', 'title', 'description'],
        },
      },
    },
    required: ['findings'],
  }});

const p2Findings = pass2Result?.findings || [];

log(`\n📊 Pass 2 结果:`);
log(`   共 ${p2Findings.length} 条建议`);

p2Findings.forEach(f => {
  log(`   💡 [${f.severity}] ${f.file}: ${f.title}`);
});

// ── 报告合成 ──────────────────────────────────────────────────────────────

phase('报告合成');

const allFindings = [...p1Findings, ...p2Findings];

log('\n📋 ===== 审查总结 =====');
log(`   审查文件: ${fileList.length} 个`);
log(`   Pass 1 (正确性): ✅ 通过 — ${p1Findings.length} 条发现, 0 阻塞`);
log(`   Pass 2 (代码质量): ${p2Findings.length} 条建议`);

// 按 severity 统计
const bySeverity = {};
allFindings.forEach(f => {
  bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
});
log(`\n   按严重等级:`);
Object.entries(bySeverity).forEach(([sev, count]) => {
  log(`     ${sev}: ${count}`);
});

return {
  pass: true,
  pass1: {
    passed: true,
    total: p1Findings.length,
    findings: p1Findings,
  },
  pass2: {
    total: p2Findings.length,
    findings: p2Findings,
  },
  summary: {
    files: fileList,
    totalFindings: allFindings.length,
    bySeverity,
  },
};
