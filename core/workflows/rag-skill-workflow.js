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
  description: '知识库深度检索的多 Agent 编排版 — 多路并行检索后综合。单次问答用 rag-skill 技能。',
  phases: [{ title: '检索', detail: '多路并行知识检索' }],
  contract: {
    version: 1,
    strict: true,
    inputs: ['query'],
    checkpoints: ['query-present', 'citation-backed-answer'],
    evidence: ['file:line citations', 'citations list', 'open questions when retrieval is insufficient'],
    completionCriteria: [
      'query is explicit and non-empty',
      'answer cites retrieved knowledge with file:line evidence',
      'missing or ambiguous knowledge is reported instead of invented',
    ],
  },
};

const query = args?.query;
phase('检索');

if (!query || (Array.isArray(query) && query.length === 0)) {
  return {
    pass: false,
    reason: '缺少 query 参数；知识库检索不能使用默认问题或猜测用户意图',
    clarification: ['请提供要检索的问题、关键词或目标文件/模块。'],
  };
}

const result = await agent(
  '你是一个 rag-skill 专家。请针对以下查询检索知识库并给出答案。\n' +
  '硬约束: 每个关键结论必须带 file:line 引用；输出 citations 数组；知识库没有证据时必须说明缺口并提出澄清问题，不得编造。\n' +
  '查询: ' + query,
  { label: 'rag-search', agentType: 'claude' }
);

const rawCitations = Array.isArray(result?.citations) ? result.citations : [];
const citationPattern = /^(?![A-Za-z]:[\\/])(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^:\r\n]+:\d+(?:-\d+)?$/;
const citations = rawCitations
  .filter((item) => typeof item === 'string')
  .map((item) => item.trim())
  .filter((item) => citationPattern.test(item));
const invalidCitations = rawCitations.filter((item) => (
  typeof item !== 'string' || !citationPattern.test(item.trim())
));
const hasAnswer = typeof result?.answer === 'string' && result.answer.trim().length > 0;
const pass = hasAnswer && citations.length > 0 && invalidCitations.length === 0;
return {
  pass,
  reason: pass
    ? 'citation-backed retrieval completed'
    : (!hasAnswer
      ? 'missing answer; retrieval did not produce a usable response'
      : 'missing or invalid file:line citations; retrieval is not evidence-backed'),
  query,
  result,
  citations,
  invalidCitations,
};
