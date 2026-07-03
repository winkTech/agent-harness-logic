/**
 * security-review-workflow — 安全审查工作流
 *
 * Phase 1: 威胁建模 — 确定资产、识别攻击面
 * Phase 2: 自动化扫描 — 代码扫描 + 依赖检查
 * Phase 3: 手动验证 — 认证/权限/输入/数据保护
 * Phase 4: 修复跟踪 — 优先级排序 + 修复建议
 *
 * 调用:
 *   Workflow({name: 'security-review-workflow', args: {targets: ['src/']}})
 *   Workflow({name: 'security-review-workflow', args: {scope: 'auth', files: ['src/auth/']}})
 */

export const meta = {
  name: 'security-review-workflow',
  description: '安全审查 — 威胁建模 → 代码扫描 → 手动验证 → 修复跟踪',
  phases: [
    { title: 'Phase 1 威胁建模' },
    { title: 'Phase 2 自动化扫描' },
    { title: 'Phase 3 手动验证' },
    { title: 'Phase 4 修复建议' },
  ],
  contract: {
    version: 1,
    strict: true,
    inputs: ['targets/files', 'scope', 'allowGlobal'],
    checkpoints: ['explicit-scope', 'deterministic-scan-evidence', 'manual-verification', 'fix-plan'],
    evidence: ['workflow-evidence-scan.cjs JSON output', 'file:line findings', 'threat model focus areas'],
    completionCriteria: [
      'targets/files are explicit unless allowGlobal=true',
      'automated scan is grounded in deterministic evidence',
      'manual verification distinguishes confirmed issues from hypotheses',
      'P0/P1/P2 fix plan includes verification steps',
    ],
  },
};

const targets = args?.targets || args?.files || [];
const scope = args?.scope || 'full';
const allowGlobal = args?.allowGlobal === true;
const evidenceScanCommand = `node engine/scripts/workflow-evidence-scan.cjs --json --targets "${targets.join(',') || '.'}"`;

phase('Phase 1 威胁建模');

if (targets.length === 0 && !allowGlobal) {
  log('⚠️ 未指定安全审查目标。安全审查默认不做全局推断，除非显式 allowGlobal=true。');
  return {
    pass: false,
    reason: '缺少 targets/files；如需全局安全审查请显式传入 allowGlobal=true',
    clarification: [
      '要审查的目录或文件是什么？',
      '安全范围是 auth、secrets、input、dependencies 还是 full？',
      '是否允许全局扫描整个仓库？',
    ],
  };
}

const threatModel = await agent(`你是**安全工程师**，执行安全审查 Phase 1: 威胁建模。

审查范围: ${scope}
目标: ${targets.length > 0 ? targets.join(', ') : '未指定具体文件 — 全局审查'}

请执行:
1. **确定资产**: 哪些数据/功能需要保护（用户数据、密钥、API token 等）
2. **识别攻击面**:
   - 认证/授权点
   - 用户输入入口
   - 外部 API 调用
   - 文件操作
   - 敏感数据持久化
3. **威胁建模**: 对每个攻击面评估:
   - 威胁类型
   - 影响
   - 已有防护
   - 缺口

输出 JSON:
{
  "assets": [{"name": "资产名", "type": "数据|功能|密钥", "sensitivity": "高|中|低"}],
  "attackSurfaces": [{"entry": "入口点", "threats": ["威胁列表"], "existingControls": ["已有防护"], "gaps": ["缺口"]}],
  "overallRisk": "low|medium|high",
  "focusAreas": ["重点审查区域"]
}`, { label: 'p1-threat-model', phase: 'Phase 1 威胁建模', schema: {
    type: 'object',
    properties: {
      assets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, sensitivity: { type: 'string' } }, required: ['name', 'type', 'sensitivity'] } },
      attackSurfaces: { type: 'array', items: { type: 'object', properties: { entry: { type: 'string' }, threats: { type: 'array', items: { type: 'string' } }, existingControls: { type: 'array', items: { type: 'string' } }, gaps: { type: 'array', items: { type: 'string' } } }, required: ['entry', 'threats'] } },
      overallRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
      focusAreas: { type: 'array', items: { type: 'string' } },
    },
    required: ['assets', 'attackSurfaces', 'overallRisk'],
  }});

log(`📊 风险评估: ${threatModel?.overallRisk || 'N/A'}`);
log(`   ${(threatModel?.assets || []).length} 项资产, ${(threatModel?.attackSurfaces || []).length} 个攻击面`);

// ── Phase 2: 自动化扫描 ─────────────────────────────────────────────────

phase('Phase 2 自动化扫描');

const scanResult = await agent(`你是**安全工程师**，执行安全审查 Phase 2: 自动化扫描。

审查范围: ${scope}
目标: ${targets.length > 0 ? targets.join(', ') : '全局'}

重点区域: ${(threatModel?.focusAreas || []).join(', ')}

必须先运行确定性证据扫描，并把输出作为 automatedEvidence 引用；不要只凭记忆或自述扫描:
${evidenceScanCommand}

请执行:
1. **代码扫描** — 搜索以下模式:
   - 硬编码密钥/密码: api_key, secret, password, token 等硬编码
   - SQL 注入: 字符串拼接查库
   - 危险函数: eval, exec, shell=true 配置
   - 文件路径遍历
   - 不安全的反序列化

2. **依赖检查** — 评估依赖安全风险

3. **配置检查**:
   - 调试模式在生产环境未关闭
   - CORS 配置过于宽松
   - HTTPS 未强制

输出 JSON:
{
  "hardcodedSecrets": [{"file": "路径", "pattern": "匹配模式", "severity": "HIGH|MEDIUM"}],
  "injectionRisks": [{"file": "路径", "type": "SQL|Command|Path", "severity": "HIGH|MEDIUM"}],
  "dangerousCalls": [{"file": "路径", "function": "函数名", "severity": "HIGH|MEDIUM|LOW"}],
  "configIssues": [{"issue": "问题描述", "severity": "HIGH|MEDIUM|LOW"}],
  "dependencyIssues": [{"package": "包名", "issue": "问题", "severity": "HIGH|MEDIUM|LOW"}],
  "automatedEvidence": {"command": "实际运行命令", "filesScanned": 0, "issueCount": 0},
  "scanSummary": "扫描总结"
}`, { label: 'p2-scan', phase: 'Phase 2 自动化扫描', schema: {
    type: 'object',
    properties: {
      hardcodedSecrets: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, pattern: { type: 'string' }, severity: { type: 'string' } }, required: ['file', 'severity'] } },
      injectionRisks: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, type: { type: 'string' }, severity: { type: 'string' } }, required: ['file', 'type', 'severity'] } },
      dangerousCalls: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, function: { type: 'string' }, severity: { type: 'string' } }, required: ['file', 'function', 'severity'] } },
      configIssues: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, severity: { type: 'string' } }, required: ['issue', 'severity'] } },
      dependencyIssues: { type: 'array', items: { type: 'object', properties: { package: { type: 'string' }, issue: { type: 'string' }, severity: { type: 'string' } }, required: ['package', 'issue', 'severity'] } },
      automatedEvidence: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          filesScanned: { type: 'number' },
          issueCount: { type: 'number' },
        },
        required: ['command', 'filesScanned', 'issueCount'],
      },
      scanSummary: { type: 'string' },
    },
    required: ['automatedEvidence', 'scanSummary'],
  }});

const totalScanIssues = (scanResult?.hardcodedSecrets?.length || 0) +
  (scanResult?.injectionRisks?.length || 0) +
  (scanResult?.dangerousCalls?.length || 0);

log(`🔍 扫描发现: ${totalScanIssues} 个问题`);
log(`   硬编码密钥: ${scanResult?.hardcodedSecrets?.length || 0}`);
log(`   注入风险: ${scanResult?.injectionRisks?.length || 0}`);

// ── Phase 3: 手动验证 ───────────────────────────────────────────────────

phase('Phase 3 手动验证');

const manualResult = await agent(`你是**安全工程师**，执行安全审查 Phase 3: 手动验证。

审查范围: ${scope}

威胁模型指出重点关注: ${(threatModel?.focusAreas || []).join(', ')}

自动化扫描发现:
${scanResult?.scanSummary || '无自动化扫描结果'}

请手动验证以下方面:

1. **认证机制**:
   - Token 存储和传输安全
   - 会话过期和刷新
   - 密码策略

2. **权限控制**:
   - 水平权限越界
   - 垂直权限提升

3. **输入验证**:
   - 所有用户输入是否经过校验/清理
   - 文件上传类型/大小/路径限制

4. **数据保护**:
   - 传输中加密 (HTTPS/TLS)
   - 存储加密
   - 日志中敏感信息泄露

输出 JSON:
{
  "authIssues": [{"issue": "问题", "severity": "CRITICAL|HIGH|MEDIUM|LOW", "detail": "详细说明"}],
  "permissionIssues": [{"issue": "问题", "severity": "HIGH|MEDIUM", "detail": "详细说明"}],
  "inputValidationIssues": [{"issue": "问题", "severity": "HIGH|MEDIUM|LOW", "detail": "详细说明"}],
  "dataProtectionIssues": [{"issue": "问题", "severity": "HIGH|MEDIUM", "detail": "详细说明"}],
  "overallAssessment": "整体评估"
}`, { label: 'p3-manual', phase: 'Phase 3 手动验证', schema: {
    type: 'object',
    properties: {
      authIssues: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, severity: { type: 'string' }, detail: { type: 'string' } }, required: ['issue', 'severity'] } },
      permissionIssues: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, severity: { type: 'string' }, detail: { type: 'string' } }, required: ['issue', 'severity'] } },
      inputValidationIssues: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, severity: { type: 'string' }, detail: { type: 'string' } }, required: ['issue', 'severity'] } },
      dataProtectionIssues: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, severity: { type: 'string' }, detail: { type: 'string' } }, required: ['issue', 'severity'] } },
      overallAssessment: { type: 'string' },
    },
    required: ['overallAssessment'],
  }});

// ── Phase 4: 修复建议 ───────────────────────────────────────────────────

phase('Phase 4 修复建议');

const allHighCritical = [
  ...(scanResult?.hardcodedSecrets || []).filter(s => s.severity === 'HIGH'),
  ...(scanResult?.injectionRisks || []).filter(s => s.severity === 'HIGH'),
  ...(manualResult?.authIssues || []).filter(s => s.severity === 'CRITICAL' || s.severity === 'HIGH'),
  ...(manualResult?.permissionIssues || []).filter(s => s.severity === 'HIGH'),
  ...(manualResult?.dataProtectionIssues || []).filter(s => s.severity === 'HIGH'),
];

const fixPlan = await agent(`你是**安全工程师**，基于以下发现生成修复计划。

威胁风险: ${threatModel?.overallRisk || 'N/A'}
扫描结果: ${scanResult?.scanSummary || '无'}
手动验证: ${manualResult?.overallAssessment || '无'}
高严重性问题数: ${allHighCritical.length}

请按优先级输出:

1. **P0 立即修复** — 安全漏洞, 数据泄露风险
2. **P1 短期修复** — 重要安全改进
3. **P2 长期改进** — 安全加固

输出 JSON:
{
  "p0": [{"title": "修复项", "detail": "具体操作", "effort": "S|M|L"}],
  "p1": [{"title": "修复项", "detail": "具体操作", "effort": "S|M|L"}],
  "p2": [{"title": "修复项", "detail": "具体操作", "effort": "S|M|L"}],
  "verificationSteps": ["验证步骤"],
  "summary": "安全审查总结"
}`, { label: 'p4-fix-plan', phase: 'Phase 4 修复建议', schema: {
    type: 'object',
    properties: {
      p0: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, effort: { type: 'string' } }, required: ['title', 'detail'] } },
      p1: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, effort: { type: 'string' } }, required: ['title', 'detail'] } },
      p2: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, effort: { type: 'string' } }, required: ['title', 'detail'] } },
      verificationSteps: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['p0', 'p1', 'p2', 'summary'],
  }});

log('\n📋 ===== 安全审查总结 =====');
log(`   整体风险: ${threatModel?.overallRisk || 'N/A'}`);
log(`   🔴 P0 立即修复: ${(fixPlan?.p0 || []).length} 项`);
(fixPlan?.p0 || []).forEach(i => log(`      - ${i.title} (${i.effort})`));
log(`   🟡 P1 短期修复: ${(fixPlan?.p1 || []).length} 项`);
log(`   🟢 P2 长期改进: ${(fixPlan?.p2 || []).length} 项`);

return {
  threatModel,
  automatedScan: scanResult,
  manualVerification: manualResult,
  fixPlan,
  summary: fixPlan?.summary || '',
};
