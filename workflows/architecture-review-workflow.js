/**
 * architecture-review-workflow — 四维架构审查工作流
 *
 * Phase 1: 上下文收集 (了解代码库结构)
 * Phase 2: 架构分析 (并行) — 架构模式 + 技术债评估
 * Phase 3: 安全审查 (并行) — STRIDE 威胁建模
 * Phase 4: 建议合成 — 汇总 → 优先级排序
 *
 * 调用:
 *   Workflow({name: 'architecture-review-workflow', args: {targets: ['01_src/tx/ofdm_tx.sv']}})
 *   Workflow({name: 'architecture-review-workflow', args: {targets: ['src/'], depth: 'full'}})
 */

const path = require('path');
const fs = require('fs');

export const meta = {
  name: 'architecture-review-workflow',
  description: '四维架构审查 — 上下文 → (架构分析 ∥ 安全审查) → 建议',
  phases: [
    { title: 'Phase 1 上下文收集' },
    { title: 'Phase 2/3 并行分析' },
    { title: 'Phase 4 建议合成' },
  ],
};

const targets = args?.targets || [];
const depth = args?.depth || 'standard'; // 'quick' | 'standard' | 'full'

// ── Phase 1: 上下文收集 ───────────────────────────────────────────────────

phase('Phase 1 上下文收集');

if (targets.length === 0) {
  log('⚠️ 未指定审查目标。请提供 targets 参数，例如:');
  log('   Workflow({name: "architecture-review-workflow", args: {targets: ["src/"]}})');
  return { pass: false, reason: '缺少 targets 参数', findings: [] };
}

log(`📂 审查目标 (${targets.length} 个):`);
targets.forEach(t => log(`   - ${t}`));

const context = await agent(`你是 **Developer (探索模式)**。

任务: 了解以下代码库的结构和上下文。

审查目标:
${targets.map(t => `- ${t}`).join('\n')}
审查深度: ${depth}

请执行:
1. 探索目录结构和文件组织方式
2. 识别主要组件和技术栈
3. 列出外部依赖
4. 评估现有文档覆盖度（README、ADR、API 文档）
5. 评估代码库规模（总行数、文件数、模块数）

如有 README、架构文档、设计文档，请读取并摘要关键信息。

输出 JSON:
{
  "structure": "目录结构描述",
  "components": ["主要组件列表"],
  "techStack": ["技术栈"],
  "dependencies": ["外部依赖"],
  "docCoverage": "文档覆盖度评估 (good/fair/poor)",
  "size": "代码库规模估算",
  "keyFindings": ["初步发现"]
}`, { label: 'p1-context', phase: 'Phase 1 上下文收集', schema: {
    type: 'object',
    properties: {
      structure: { type: 'string' },
      components: { type: 'array', items: { type: 'string' } },
      techStack: { type: 'array', items: { type: 'string' } },
      dependencies: { type: 'array', items: { type: 'string' } },
      docCoverage: { type: 'string', enum: ['good', 'fair', 'poor'] },
      size: { type: 'string' },
      keyFindings: { type: 'array', items: { type: 'string' } },
    },
    required: ['structure', 'components', 'keyFindings'],
  }});

log(`📖 文档覆盖度: ${context?.docCoverage || 'unknown'}`);
log(`🧩 组件数: ${context?.components?.length || 0}`);
(context?.keyFindings || []).forEach(k => log(`   ℹ️ ${k}`));

// ── Phase 2 + Phase 3: 并行 ──────────────────────────────────────────────

phase('Phase 2/3 并行分析');

const [archResult, secResult] = await parallel([
  // ── Phase 2: 架构分析 ────────────────────────────────────────────
  () => agent(`你是 **Architect**。

基于以下上下文，执行架构分析:

代码库结构: ${context?.structure || ''}
组件: ${(context?.components || []).join(', ')}
技术栈: ${(context?.techStack || []).join(', ')}

审查深度: ${depth}

请分析:
1. **架构模式**: 分层/六边形/微服务? 是否符合 SolID 原则?
2. **质量指标**: 耦合度、内聚性、模块化程度
3. **技术债评估**:
   - 代码债: 遗留代码、TODO 堆积
   - 设计债: 架构偏离、模式误用
   - 文档债: 缺失文档、过期文档
   - 基础设施债: 构建/测试/部署问题
4. **风险识别**: 架构层面的风险点

输出 JSON:
{
  "patterns": ["使用的架构模式"],
  "quality": "质量评估 (good/fair/poor)",
  "coupling": "耦合度评估 (high/medium/low)",
  "cohesion": "内聚性评估 (high/medium/low)",
  "techDebt": {
    "code": "代码债评估",
    "design": "设计债评估",
    "documentation": "文档债评估",
    "infrastructure": "基础设施债评估"
  },
  "risks": [{"risk": "风险描述", "severity": "HIGH|MEDIUM|LOW", "impact": "影响"}],
  "recommendations": [{"title": "建议", "priority": "HIGH|MEDIUM|LOW", "effort": "S|M|L"}]
}`, { label: 'p2-architecture', phase: 'Phase 2/3 并行分析', schema: {
    type: 'object',
    properties: {
      patterns: { type: 'array', items: { type: 'string' } },
      quality: { type: 'string', enum: ['good', 'fair', 'poor'] },
      coupling: { type: 'string', enum: ['high', 'medium', 'low'] },
      cohesion: { type: 'string', enum: ['high', 'medium', 'low'] },
      techDebt: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          design: { type: 'string' },
          documentation: { type: 'string' },
          infrastructure: { type: 'string' },
        },
      },
      risks: { type: 'array', items: { type: 'object', properties: { risk: { type: 'string' }, severity: { type: 'string' }, impact: { type: 'string' } }, required: ['risk', 'severity'] } },
      recommendations: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, priority: { type: 'string' }, effort: { type: 'string' } }, required: ['title', 'priority'] } },
    },
    required: ['patterns', 'quality', 'risks'],
  }}),

  // ── Phase 3: 安全审查 ────────────────────────────────────────────
  () => agent(`你是 **Security Architect**。

基于以下上下文，执行安全审查:

代码库结构: ${context?.structure || ''}
组件: ${(context?.components || []).join(', ')}

审查深度: ${depth}

请执行:
1. STRIDE 威胁建模 (Spoofing/Tampering/Repudiation/Info Disclosure/DoS/Elevation)
2. OWASP Top 10 检查
3. 依赖安全（已知 CVE）
4. 敏感数据泄露风险
5. 认证/授权机制评估

输出 JSON:
{
  "strideFindings": [{"threat": "威胁类型", "component": "受影响组件", "severity": "HIGH|MEDIUM|LOW", "mitigation": "缓解措施"}],
  "owaspFindings": [{"category": "OWASP 类别", "finding": "发现", "severity": "HIGH|MEDIUM|LOW"}],
  "dependencyRisks": ["风险依赖"],
  "dataExposureRisks": ["数据泄露风险"],
  "overallRisk": "整体风险 (low/medium/high)"
}`, { label: 'p3-security', phase: 'Phase 2/3 并行分析', schema: {
    type: 'object',
    properties: {
      strideFindings: { type: 'array', items: { type: 'object', properties: { threat: { type: 'string' }, component: { type: 'string' }, severity: { type: 'string' }, mitigation: { type: 'string' } }, required: ['threat', 'severity'] } },
      owaspFindings: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, finding: { type: 'string' }, severity: { type: 'string' } }, required: ['category', 'severity'] } },
      dependencyRisks: { type: 'array', items: { type: 'string' } },
      dataExposureRisks: { type: 'array', items: { type: 'string' } },
      overallRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['strideFindings', 'overallRisk'],
  }}),
]);

// ── 日志中间结果 ──────────────────────────────────────────────────────────

log(`\n🏗️ 架构质量: ${archResult?.quality || 'N/A'}`);
log(`   耦合度: ${archResult?.coupling || 'N/A'}, 内聚性: ${archResult?.cohesion || 'N/A'}`);
log(`   架构风险: ${(archResult?.risks || []).length} 项`);

log(`\n🔒 安全风险等级: ${secResult?.overallRisk || 'N/A'}`);
log(`   STRIDE 发现: ${(secResult?.strideFindings || []).length} 项`);
log(`   OWASP 发现: ${(secResult?.owaspFindings || []).length} 项`);

// ── Phase 4: 建议合成 ────────────────────────────────────────────────────

phase('Phase 4 建议合成');

const synthesis = await agent(`你是一名 **Code Reviewer**，负责汇总架构审查结果并生成优先级建议。

## 架构分析结果
架构模式: ${(archResult?.patterns || []).join(', ')}
质量: ${archResult?.quality || 'N/A'}
耦合: ${archResult?.coupling || 'N/A'}, 内聚: ${archResult?.cohesion || 'N/A'}
技术债: ${JSON.stringify(archResult?.techDebt || {})}
风险: ${JSON.stringify((archResult?.risks || []).slice(0, 5))}

## 安全审查结果
整体风险: ${secResult?.overallRisk || 'N/A'}
STRIDE: ${JSON.stringify((secResult?.strideFindings || []).slice(0, 5))}
OWASP: ${JSON.stringify((secResult?.owaspFindings || []).slice(0, 5))}

审查深度: ${depth}

请汇总所有发现，按以下维度排序输出:

1. **立即修复** (HIGH severity, 安全漏洞)
2. **短期改进** (架构风险, 技术债)
3. **长期路线图** (代码质量, 文档)

输出 JSON:
{
  "immediate": [{"title": "事项", "category": "架构|安全|技术债", "detail": "说明"}],
  "shortTerm": [{"title": "事项", "category": "架构|安全|技术债|质量", "detail": "说明"}],
  "roadmap": [{"title": "事项", "detail": "说明"}],
  "overallHealth": "整体健康度 (good/fair/poor/critical)"
}`, { label: 'p4-synthesis', phase: 'Phase 4 建议合成', schema: {
    type: 'object',
    properties: {
      immediate: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, category: { type: 'string' }, detail: { type: 'string' } }, required: ['title', 'category'] } },
      shortTerm: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, category: { type: 'string' }, detail: { type: 'string' } }, required: ['title', 'category'] } },
      roadmap: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title'] } },
      overallHealth: { type: 'string', enum: ['good', 'fair', 'poor', 'critical'] },
    },
    required: ['immediate', 'shortTerm', 'overallHealth'],
  }});

// ── 输出总结 ──────────────────────────────────────────────────────────────

log('\n📋 ===== 架构审查总结 =====');
log(`   整体健康度: ${synthesis?.overallHealth || 'N/A'}`);
log(`   🔴 立即修复: ${(synthesis?.immediate || []).length} 项`);
(synthesis?.immediate || []).forEach(i => log(`      - [${i.category}] ${i.title}`));
log(`   🟡 短期改进: ${(synthesis?.shortTerm || []).length} 项`);
log(`   🟢 路线图: ${(synthesis?.roadmap || []).length} 项`);

return {
  pass: synthesis?.overallHealth !== 'critical',
  context,
  architecture: archResult,
  security: secResult,
  synthesis,
  depth,
};
