export const meta = {
  name: 'blind-audit-workflow',
  description: '双盲独立审计工作流 — 先锁定盲测预期(禁止先看实现者测试) → 隔离目录四象限实跑探针 → 实现者测试交叉对账与证据分级报告。',
  phases: [
    { title: 'Phase 1 盲测预期加封' },
    { title: 'Phase 2 隔离四象限实跑' },
    { title: 'Phase 3 测试对账与分级报告' },
  ],
  contract: {
    version: 1,
    strict: true,
    inputs: [
      'targets (待审计模块或版本范围)',
      'questions (可选，重点核查问题清单)',
      'auditDir (可选，系统临时目录下的隔离复现路径)',
    ],
    checkpoints: [
      'preflight-targets-present',
      'blind-expectations-sealed',
      'four-quadrant-isolated-probes',
      'evidence-graded-report',
    ],
    evidence: [
      'sealed blind expectation digest from blind-audit-seal.cjs before reading test suites',
      'isolated reproduction logs for bad_input_rejected / stale_artifact_rejected / interrupted_job_recovered / valid_input_accepted',
      'strict separation of live-measured, verified-historical, static-inferred, and unverified claims',
    ],
    completionCriteria: [
      'blind expectations are written and SHA-256 sealed prior to inspecting implementer test results',
      'product repository remains strictly read-only throughout the audit',
      'all four adversarial quadrants are exercised or explicitly marked unverified with cause',
      'blocking CRITICAL/HIGH defects or post-seal expectation tampering fail the workflow verdict',
    ],
  },
};

const targets = Array.isArray(args?.targets)
  ? args.targets.filter(Boolean)
  : (typeof args?.targets === 'string' && args.targets.trim() ? [args.targets.trim()] : []);
const questions = Array.isArray(args?.questions) ? args.questions.filter(Boolean) : [];
const auditDir = typeof args?.auditDir === 'string' && args.auditDir.trim() ? args.auditDir.trim() : '';

phase('Pre-flight');

if (targets.length === 0) {
  log('⚠️ 缺少 targets 参数。示例: Workflow({name: "blind-audit-workflow", args: {targets: ["core/engine/scripts/run-hdl-workflow.cjs"]}})');
  return { pass: false, reason: '缺少 targets 参数', findings: [] };
}

log(`🔒 双盲独立审计启动 — 目标 (${targets.length}): ${targets.join(', ')}`);

// ── Phase 1: 盲测预期加封 (严禁读取 test-hooks / *.test.*) ──────────────────

phase('Phase 1 盲测预期加封');

const sealStep = await agent(`你是**独立盲审员 (Phase 1 — 锁预期)**。

审计目标:
${targets.map(t => `- ${t}`).join('\n')}
重点关切问题:
${questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : '- 默认核查：自动生效范围、实测收益与样本量、坏结果/旧报告/中断恢复/好结果误伤四象限'}
隔离目录提示: ${auditDir || '在系统临时目录下创建独立隔离目录'}

【硬性盲审纪律】
1. 本阶段**严禁读取**任何 \`test-hooks/\`、\`*.test.*\`、历史评测报告或实现者自测输出；只允许阅读规格、README 和被审产品入口代码。
2. 产品仓库全程保持**严格只读**。
3. 将你对四个关键象限的可证伪预期写入隔离目录下的 \`01-blind-expectations.md\`：
   - Q1 坏结果拒收预期
   - Q2 旧报告/篡改产物拒收预期
   - Q3 中断/死作业恢复预期
   - Q4 好结果与摘要字段零误拒预期
4. 运行确定性加封脚本锁定预期哈希：
   \`node core/engine/scripts/blind-audit-seal.cjs seal --expectation <auditDir>/01-blind-expectations.md --seal-out <auditDir>/seal.json\`
5. 原样带回 \`sealPath\`、\`expectationSha256\` 与预期摘要。`, {
  label: 'blind-seal',
  phase: 'Phase 1 盲测预期加封',
  schema: {
    type: 'object',
    properties: {
      auditDir: { type: 'string' },
      sealPath: { type: 'string' },
      expectationSha256: { type: 'string' },
      readAnyImplementerTests: { type: 'boolean' },
      expectationsSummary: { type: 'array', items: { type: 'string' } },
    },
    required: ['auditDir', 'sealPath', 'expectationSha256', 'readAnyImplementerTests', 'expectationsSummary'],
  },
});

if (!sealStep?.sealPath || !/^[a-f0-9]{64}$/i.test(String(sealStep.expectationSha256 || '')) || sealStep.readAnyImplementerTests === true) {
  log('❌ Phase 1 盲测加封未满足独立性契约（缺少 SHA-256 印章或提前读取了实现者测试）');
  return { pass: false, reason: 'blind expectation seal violated or missing', findings: [] };
}
log(`✅ 盲测预期已加封: sha256=${sealStep.expectationSha256.slice(0, 16)}... (${sealStep.sealPath})`);

// ── Phase 2: 隔离四象限实跑探针 ─────────────────────────────────────────────

phase('Phase 2 隔离四象限实跑');

const probeStep = await agent(`你是**独立盲审员 (Phase 2 — 隔离实跑复现)**。

已加封预期印章: ${sealStep.sealPath} (期望 SHA-256: ${sealStep.expectationSha256})
隔离工作目录: ${sealStep.auditDir}
被审目标: ${targets.join(', ')}

要求:
1. 产品代码与真实工程保持**严格只读**；所有复现工程、注入故障与状态目录均放在 \`${sealStep.auditDir}\` 内。
2. 独立构造并实跑四象限对抗探针，写入 \`${sealStep.auditDir}/probes.json\`（含 \`quadrants.{bad_input_rejected, stale_artifact_rejected, interrupted_job_recovered, valid_input_accepted}\`，每项记录 \`{executed, pass, detail}\`）：
   - \`bad_input_rejected\`: 注入错误结果/越界时序/非零退出但伪造绿状态
   - \`stale_artifact_rejected\`: 产生产物后修改上游源码或传递依赖
   - \`interrupted_job_recovered\`: 强杀守护进程或模拟超时后测试续跑恢复
   - \`valid_input_accepted\`: 真实合规输入端到端通过且摘要不因丢字段误拒
3. 运行印章与探针复核脚本：
   \`node core/engine/scripts/blind-audit-seal.cjs verify --seal "${sealStep.sealPath}" --probes "${sealStep.auditDir}/probes.json"\`
4. 现在才允许查阅实现者的测试代码与历史记录，找出实现者测试未覆盖的盲区。`, {
  label: 'isolated-probes',
  phase: 'Phase 2 隔离四象限实跑',
  schema: {
    type: 'object',
    properties: {
      sealVerified: { type: 'boolean' },
      quadrants: {
        type: 'object',
        properties: {
          bad_input_rejected: { type: 'boolean' },
          stale_artifact_rejected: { type: 'boolean' },
          interrupted_job_recovered: { type: 'boolean' },
          valid_input_accepted: { type: 'boolean' },
        },
        required: ['bad_input_rejected', 'stale_artifact_rejected', 'interrupted_job_recovered', 'valid_input_accepted'],
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
            evidenceGrade: { type: 'string', enum: ['live-measured', 'verified-historical', 'static-inferred', 'unverified'] },
            file: { type: 'string' },
            title: { type: 'string' },
            detail: { type: 'string' },
          },
          required: ['id', 'severity', 'evidenceGrade', 'file', 'title', 'detail'],
        },
      },
    },
    required: ['sealVerified', 'quadrants', 'findings'],
  },
});

if (probeStep?.sealVerified !== true) {
  log('❌ 印章复核失败：盲测预期文件在实跑阶段发生变动或探针格式不完整');
  return { pass: false, reason: 'post-seal verification failed', findings: probeStep?.findings || [] };
}

// ── Phase 3: 分级审计报告合成 ───────────────────────────────────────────────

phase('Phase 3 测试对账与分级报告');

const findings = Array.isArray(probeStep.findings) ? probeStep.findings : [];
const blockingFindings = findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');

const synthesis = await agent(`你是**独立审计主笔 (Phase 3 — 报告交付)**。

基于已加封预期（SHA-256: ${sealStep.expectationSha256}）与四象限实跑结果，生成简明严谨的最终审计报告：
- 四象限结论: ${JSON.stringify(probeStep.quadrants)}
- 发现列表 (${findings.length} 条，其中 CRITICAL/HIGH ${blockingFindings.length} 条):
${JSON.stringify(findings, null, 2)}

【交付纪律】
- 严格区分四类证据等级：**本次实跑 (live-measured)**、**已核验历史记录 (verified-historical)**、**静态推断 (static-inferred)**、**未验证项 (unverified)**。
- 给出具体样本量、适用范围与精确 \`file:line\` 引用；不得把静态推断写成实测结论。`, {
  label: 'audit-report',
  phase: 'Phase 3 测试对账与分级报告',
  schema: {
    type: 'object',
    properties: {
      executiveSummary: { type: 'string' },
      unverifiedItems: { type: 'array', items: { type: 'string' } },
    },
    required: ['executiveSummary', 'unverifiedItems'],
  },
});

const workflowPassed = blockingFindings.length === 0
  && Object.values(probeStep.quadrants || {}).every(v => v === true);

log(`\n📋 双盲审计完成: pass=${workflowPassed}, 阻塞级缺陷=${blockingFindings.length}`);

return {
  pass: workflowPassed,
  expectationSha256: sealStep.expectationSha256,
  quadrants: probeStep.quadrants,
  blockingFindings,
  findings,
  summary: synthesis?.executiveSummary || '',
  unverifiedItems: synthesis?.unverifiedItems || [],
};
