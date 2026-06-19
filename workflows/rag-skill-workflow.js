/**
 * rag-skill-workflow — 知识库深度检索工作流
 *
 * Phase 1: 检索 — 多路并行知识检索
 *
 * 调用:
 *   Workflow({name: 'rag-skill-workflow', args: {query: ['关键词']}})
 */

export const meta = {
  name: 'rag-skill-workflow',
  description: '知识库深度检索 — 调用 RAG 技能进行多轮知识检索',
  phases: [{ title: '检索', detail: '多路并行知识检索' }],
};

const query = args?.query || '默认检索词';
phase('检索');

const result = await agent(
  '你是一个 rag-skill 专家。请针对以下查询，检索知识库并给出详尽答案。\n查询: ' + query,
  { label: 'rag-search', agentType: 'claude' }
);

return { query, result };
