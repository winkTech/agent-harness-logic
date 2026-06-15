/**
 * hdl-coding-workflow — HDL 开发工作流 (别名)
 *
 * 本文件是 hdl-coding-dag-workflow 的别名，提供向后兼容。
 * 实际调用 hdl-coding-dag-workflow。
 *
 * 调用:
 *   Workflow({name: 'hdl-coding-workflow', args: {modules: ['scrambler']}})
 *   等效于:
 *   Workflow({name: 'hdl-coding-dag-workflow', args: {modules: ['scrambler']}})
 */
// 直接代理到 dag 工作流
export const meta = {
  name: 'hdl-coding-workflow',
  description: 'HDL RTL 开发全流程 (别名 → hdl-coding-dag-workflow)',
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

// 代理：调用真实 dag 工作流
const result = await workflow('hdl-coding-dag-workflow', args);
return result;
