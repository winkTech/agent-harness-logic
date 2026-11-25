#!/usr/bin/env node

/**
 * core/engine/mcp/codegraph-server.cjs — 代码图 MCP 服务器。
 *
 * MCP stdio 协议实现。暴露 5 个工具给 AI 代理：
 *   harness_cg_explore  — 符号袋搜索+源码+关系（主入口）
 *   harness_cg_node     — 符号体+调用者/被调用者轨迹
 *   harness_cg_search   — FTS5 快速符号搜索
 *   harness_cg_callers  — 谁实例化/调用了此模块
 *   harness_cg_callees  — 此模块实例化了什么
 *
 * 注册到 .mcp.json:
 * {
 *   "mcpServers": {
 *     "codegraph": {
 *       "command": "node",
 *       "args": ["core/engine/mcp/codegraph-server.cjs"]
 *     }
 *   }
 * }
 *
 * 协议: MCP stdio JSON-RPC (逐行)
 *   请求:  {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
 *   响应:  {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
 */

'use strict';

const path = require('node:path');
const {
  resolveProject, searchNodes, getNode, getCallers, getCallees, getSubgraphByNames, getBlastRadius,
} = require('../scripts/cg-queries.cjs');
const consoleBackend = require('./harness-console-backend.cjs');

// ── 工具定义 ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'harness_workflows_list',
    description: '查当前插件实际包含的工作流。返回用途、脚本路径、输入和检查点，供宿主选择并调用。查询本身只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'harness_knowledge_query',
    description: '检索插件内的工程知识，定位脚本和原文，核对资产的当前版本、签核范围与已知限制。',
    inputSchema: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: '用户的完整问题' },
      asset: { type: 'string', description: '上下文已经明确的资产 ID，可省略' },
    } },
  },
  {
    name: 'harness_cg_explore',
    description: `按符号名或查询浏览代码。返回源码位置、层次关系、调用/实例化路径。
这是代码图的主要入口——一次调用替代多次 Read/Grep。
例如传递 "ofdm_tx scrambler interleaver" 查看这些模块间的关系。
HDL 项目传模块名、实例名、信号名。`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要探索的符号名或简短代码术语，空格分隔多个名称。如 "ofdm_tx scrambler u_fft"',
        },
        projectPath: {
          type: 'string',
          description: '项目根路径。省略则自动检测当前工作目录。',
        },
        maxDepth: {
          type: 'number',
          description: '关系扩展深度 (默认: 1, 最大: 3)',
          default: 1,
        },
        maxFiles: {
          type: 'number',
          description: '返回的最大文件数 (默认: 8)',
          default: 8,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'harness_cg_node',
    description: `获取一个符号的详细信息：定义位置、源码行号、签名、调用者/被调用者概览。
类似 "go to definition"。对于 HDL 模块，显示端口和参数列表。`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '符号名称 (模块名/函数名/信号名/实例名)',
        },
        file: {
          type: 'string',
          description: '文件名或路径（同名符号歧义消除）',
        },
        projectPath: {
          type: 'string',
          description: '项目根路径',
        },
        includeCallers: {
          type: 'boolean',
          description: '是否包含调用者列表',
          default: true,
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'harness_cg_search',
    description: `按名称快速搜索符号。返回匹配的位置、种类和文件。
使用 FTS5 全文搜索，支持模糊和前缀匹配。
搜到结果后用 harness_cg_node 查看详情。`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '符号名称或部分名称。如 "scrambler", "fft", "data_out"',
        },
        kind: {
          type: 'string',
          description: '按种类过滤: module|port|signal|instance|function|parameter|always_block|assign',
          enum: ['module', 'port', 'signal', 'instance', 'function', 'parameter', 'always_block', 'assign', 'interface', 'package'],
        },
        limit: {
          type: 'number',
          description: '最大结果数 (默认: 10)',
          default: 10,
        },
        projectPath: {
          type: 'string',
          description: '项目根路径',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'harness_cg_callers',
    description: `找出谁调用/实例化了指定符号。
HDL 场景：找出哪些模块实例化了指定模块。Python/JS：找出哪些函数调用了指定函数。`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '符号名称',
        },
        file: {
          type: 'string',
          description: '文件名（同名符号歧义消除）',
        },
        maxDepth: {
          type: 'number',
          description: '递归跟踪深度 (默认: 1, 最大: 5)',
          default: 1,
        },
        limit: {
          type: 'number',
          description: '最大结果数 (默认: 20)',
          default: 20,
        },
        projectPath: {
          type: 'string',
          description: '项目根路径',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'harness_cg_callees',
    description: `找出指定符号调用/实例化了什么。
HDL 场景：找出某模块内部实例化了哪些子模块。`,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '符号名称',
        },
        file: {
          type: 'string',
          description: '文件名（同名符号歧义消除）',
        },
        maxDepth: {
          type: 'number',
          description: '递归跟踪深度 (默认: 1, 最大: 5)',
          default: 1,
        },
        limit: {
          type: 'number',
          description: '最大结果数 (默认: 20)',
          default: 20,
        },
        projectPath: {
          type: 'string',
          description: '项目根路径',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'harness_cg_blast_radius',
    description: `改动影响面: 给定一个模块/函数/文件, 返回受影响的下游符号、因此失效的证据、
需要重跑的门禁、相关的需求与既往经验。

用在动手改之前 (评估波及范围) 与改完之后 (决定重验清单)。
索引不新鲜时返回 staleIndex 而不给结果 —— 拿过期的图算影响面比不算更危险。`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '模块名/函数名/相对文件路径',
        },
        depth: {
          type: 'number',
          description: '反向依赖遍历深度 (默认: 3, 最大: 5)',
          default: 3,
        },
        limit: {
          type: 'number',
          description: '最大下游结果数 (默认: 40)',
          default: 40,
        },
        projectPath: {
          type: 'string',
          description: '项目根路径',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'harness_console',
    title: 'Harness Console',
    description: '打开 Logical Paradox Harness 交互式维护与门禁控制台（展示记忆健康度、消费者水位、待验证门禁与插件 ACL 状态）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: {
      ui: { resourceUri: consoleBackend.APP_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Harness Console' },
          { type: 'global', title: 'Harness' },
        ],
      },
    },
  },
  {
    name: 'harness_ui_refresh',
    title: 'Refresh Console',
    description: 'App-only refresh for Harness Console.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'harness_ui_signoff',
    title: 'Human R3 Signoff',
    description: 'App-only human signoff for a pending R3 risk scope.',
    inputSchema: {
      type: 'object',
      properties: {
        scopeKey: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['scopeKey'],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'harness_ui_reset_gate',
    title: 'Human Reset Gate',
    description: 'App-only human reset for verify-gate.json pending/risk state.',
    inputSchema: {
      type: 'object',
      properties: {
        scopeKey: { type: 'string' },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'harness_ui_maintain',
    title: 'Run Maintenance',
    description: 'App-only dry-run or execute for periodic memory maintenance.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['dry-run', 'execute'] },
        force: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['app'] } },
  },
];

// ── 工具处理程序 ─────────────────────────────────────────────────────────────

function resolveProjectPath(params) {
  const projectPath = params?.projectPath || process.cwd();
  return resolveProject(projectPath);
}

function handleToolCall(name, args, opts = {}) {
  if (name === 'harness_workflows_list') {
    const workflows = require('../scripts/lib/workflow-runtime.cjs').workflowCatalog();
    return { content: [{ type: 'text', text: JSON.stringify({ workflows }) }] };
  }
  if (name === 'harness_knowledge_query') {
    const result = require('../scripts/knowledge-answer.cjs').answer(args?.query, { asset: args?.asset });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
  if (name === 'harness_console' || name === 'harness_ui_refresh') {
    const snapshot = consoleBackend.buildConsoleSnapshot(opts);
    return {
      content: [{ type: 'text', text: consoleBackend.formatConsoleSummary(snapshot) }],
      structuredContent: snapshot,
    };
  }
  if (name === 'harness_ui_signoff') {
    const res = consoleBackend.signoffRisk(args || {}, opts);
    return {
      isError: !res.ok,
      content: [{ type: 'text', text: res.ok ? `Signed off ${args?.scopeKey}` : (res.error || 'signoff failed') }],
      structuredContent: res,
    };
  }
  if (name === 'harness_ui_reset_gate') {
    const res = consoleBackend.resetGate(args || {}, opts);
    return {
      content: [{ type: 'text', text: `Reset ${res.removed.length} gate entry(s)` }],
      structuredContent: res,
    };
  }
  if (name === 'harness_ui_maintain') {
    const res = consoleBackend.runMaintenance(args || {}, opts);
    return {
      content: [{ type: 'text', text: `Maintenance ${res.mode} exit=${res.exitCode}` }],
      structuredContent: res,
    };
  }
  const { projectId } = resolveProjectPath(args || {});

  switch (name) {
    case 'harness_cg_explore': {
      const query = (args?.query || '').trim();
      if (!query) return { isError: true, content: [{ type: 'text', text: '需要提供查询词' }] };
      const names = query.split(/\s+/).filter(Boolean);
      const result = getSubgraphByNames(projectId, names, {
        maxDepth: Math.min(args?.maxDepth || 1, 3),
        maxFiles: args?.maxFiles || 8,
      });
      return formatExploreResult(result, names);
    }

    case 'harness_cg_node': {
      const symbol = (args?.symbol || '').trim();
      if (!symbol) return { isError: true, content: [{ type: 'text', text: '需要提供符号名' }] };
      const node = getNode(projectId, symbol);
      if (!node) return { content: [{ type: 'text', text: `未找到符号 "${symbol}"。试试 harness_cg_search 模糊搜索。` }] };

      let callersList = [];
      let calleesList = [];
      if (args?.includeCallers !== false) {
        callersList = require('../scripts/cg-queries.cjs').getIncomingEdges(node.id, null, 10);
        calleesList = require('../scripts/cg-queries.cjs').getOutgoingEdges(node.id, null, 10);
      }

      return formatNodeResult(node, callersList, calleesList);
    }

    case 'harness_cg_search': {
      const query = (args?.query || '').trim();
      if (!query || query.length < 2) return { isError: true, content: [{ type: 'text', text: '搜索词至少 2 个字符' }] };
      const results = searchNodes(query, {
        projectId,
        kind: args?.kind,
        limit: Math.min(args?.limit || 10, 50),
      });
      return formatSearchResults(results, query);
    }

    case 'harness_cg_callers': {
      const symbol = (args?.symbol || '').trim();
      if (!symbol) return { isError: true, content: [{ type: 'text', text: '需要提供符号名' }] };
      const result = getCallers(projectId, symbol, {
        file: args?.file,
        maxDepth: Math.min(args?.maxDepth || 1, 5),
        limit: Math.min(args?.limit || 20, 100),
      });
      return formatCallersCalleesResult(result, 'callers');
    }

    case 'harness_cg_callees': {
      const symbol = (args?.symbol || '').trim();
      if (!symbol) return { isError: true, content: [{ type: 'text', text: '需要提供符号名' }] };
      const result = getCallees(projectId, symbol, {
        file: args?.file,
        maxDepth: Math.min(args?.maxDepth || 1, 5),
        limit: Math.min(args?.limit || 20, 100),
      });
      return formatCallersCalleesResult(result, 'callees');
    }

    case 'harness_cg_blast_radius': {
      const target = (args?.target || '').trim();
      if (!target) return { isError: true, content: [{ type: 'text', text: '需要提供 target' }] };
      const result = getBlastRadius(projectId, target, {
        depth: Math.min(args?.depth || 3, 5),
        limit: Math.min(args?.limit || 40, 100),
      });
      return formatBlastRadiusResult(result, target);
    }

    default:
      return { isError: true, content: [{ type: 'text', text: `未知工具: ${name}` }] };
  }
}

// ── 输出格式化 ───────────────────────────────────────────────────────────────

function formatExploreResult(result, queryNames) {
  if (!result.nodes || result.nodes.length === 0) {
    return { content: [{ type: 'text', text: `未找到与 "${queryNames.join(' ')}" 匹配的代码符号。` }] };
  }

  const lines = [];
  lines.push(`## 代码图探索: ${queryNames.join(', ')}`);
  lines.push(`\n找到 ${result.nodes.length} 个符号，${result.files.length} 个文件`);

  // 根符号
  const roots = result.nodes.filter(n => n.is_root);
  if (roots.length > 0) {
    lines.push('\n### 匹配符号');
    for (const n of roots) {
      lines.push(`- **${n.kind}** \`${n.name}\` → ${n.file}:${n.start_line}${n.signature ? ' — ' + n.signature.slice(0, 100) : ''}`);
    }
  }

  // 关系
  if (result.edges.length > 0) {
    lines.push('\n### 关系');
    for (const e of result.edges) {
      lines.push(`- ${e.source_name} (${e.source_kind}) ──${e.kind}──→ ${e.target_name} (${e.target_kind})${e.line ? ' :' + e.line : ''}`);
    }
  }

  // 按文件分组的符号
  lines.push('\n### 文件分布');
  for (const f of result.files) {
    lines.push(`\n📄 ${f.file}`);
    for (const s of f.symbols) {
      lines.push(`  ${s.kind === 'module' ? '📦' : s.kind === 'instance' ? '🔌' : s.kind === 'signal' ? '🔷' : '  '} ${s.kind} \`${s.name}\` L${s.line}`);
    }
  }

  // 使用建议
  lines.push('\n---\n💡 提示: 用 `harness_cg_node` 查看某个符号详情，`harness_cg_callers` 追踪调用者。');

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function formatNodeResult(node, callers, callees) {
  const lines = [];
  lines.push(`## ${node.kind}: ${node.name}`);
  lines.push(`**文件**: ${node.file}:${node.start_line}${node.end_line && node.end_line !== node.start_line ? '-' + node.end_line : ''}`);
  if (node.signature) {
    lines.push(`**签名**: ${node.signature.slice(0, 300)}`);
  }

  // metadata
  if (node.metadata && Object.keys(node.metadata).length > 0) {
    const meta = node.metadata;
    if (meta.direction) lines.push(`**方向**: ${meta.direction}`);
    if (meta.width) lines.push(`**宽度**: ${meta.width}`);
    if (meta.type) lines.push(`**类型**: ${meta.type}`);
    if (meta.target_module) lines.push(`**目标模块**: ${meta.target_module}`);
    if (meta.ports && Array.isArray(meta.ports)) {
      lines.push(`**端口** (${meta.ports.length}):`);
      for (const p of meta.ports.slice(0, 15)) {
        lines.push(`  ${p.direction} ${p.width ? '[' + p.width + '] ' : ''}${p.name}`);
      }
    }
  }

  if (callers.length > 0) {
    lines.push(`\n**被引用** (${callers.length}):`);
    for (const e of callers.slice(0, 10)) {
      lines.push(`  ← ${e.source_kind} \`${e.source_name}\` (${e.source_file || '?'}:${e.line || '?'}) [${e.kind}]`);
    }
  }

  if (callees.length > 0) {
    lines.push(`\n**引用了** (${callees.length}):`);
    for (const e of callees.slice(0, 10)) {
      lines.push(`  → ${e.target_kind} \`${e.target_name}\` (${e.target_file || '?'}:${e.line || '?'}) [${e.kind}]`);
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function formatSearchResults(results, query) {
  if (results.length === 0) {
    return { content: [{ type: 'text', text: `未找到匹配 "${query}" 的符号。试试更短的词或部分匹配。` }] };
  }

  const lines = [];
  lines.push(`## 符号搜索: "${query}"`);
  lines.push(`找到 ${results.length} 个匹配`);

  const byKind = {};
  for (const r of results) {
    if (!byKind[r.kind]) byKind[r.kind] = [];
    byKind[r.kind].push(r);
  }

  for (const [kind, items] of Object.entries(byKind)) {
    lines.push(`\n### ${kind} (${items.length})`);
    for (const item of items) {
      lines.push(`- \`${item.name}\` → ${item.file}:${item.line}${item.signature ? ' — ' + item.signature.slice(0, 80) : ''}`);
    }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function formatCallersCalleesResult(result, direction) {
  if (!result.node) {
    return { content: [{ type: 'text', text: '未找到指定符号。试试 harness_cg_search 搜索。' }] };
  }

  const lines = [];
  const label = direction === 'callers' ? '调用者/实例化者' : '被调用者/子模块';

  lines.push(`## ${label}: ${result.node.name}`);
  lines.push(`**${result.node.kind}** → ${result.node.file}:${result.node.start_line}`);

  const items = direction === 'callers' ? result.callers : result.callees;
  const edges = result.edges;

  if (items.length > 0) {
    lines.push(`\n**递归跟踪** (${items.length}):`);
    for (const item of items) {
      const indent = '  '.repeat((item.depth || 1) - 1);
      lines.push(`${indent}- L${item.depth} ${item.kind} \`${item.name}\` → ${item.file}:${item.line}`);
    }
  } else if (edges.length > 0) {
    lines.push(`\n**直接关系** (${edges.length}):`);
    for (const e of edges.slice(0, 20)) {
      const name = direction === 'callers' ? e.source_name : e.target_name;
      const kind = direction === 'callers' ? e.source_kind : e.target_kind;
      lines.push(`  ${direction === 'callers' ? '←' : '→'} ${kind} \`${name}\` [${e.kind}]${e.line ? ' :' + e.line : ''}`);
    }
  } else {
    lines.push('\n无直接关系。');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function formatBlastRadiusResult(result, target) {
  if (result.staleIndex) {
    return {
      content: [{
        type: 'text',
        text: `## 影响面: 索引不可信 (${result.staleReason})\n\n`
          + '拿过期的图算影响面比不算更危险, 因此不返回结果。\n'
          + '先重建索引: `node core/engine/scripts/code-graph-index.cjs sync <项目路径>`',
      }],
    };
  }
  if (!result.target) {
    return { content: [{ type: 'text', text: `未在代码图中找到 "${target}"。试试 harness_cg_search。` }] };
  }

  const lines = [`## 改动影响面: ${result.target.name || target}`];
  lines.push(`**${result.target.kind}** → ${result.target.file || '(未知文件)'}`);

  lines.push(`\n### 下游受影响符号 (${result.downstream.length})`);
  if (result.downstream.length === 0) lines.push('- 无 (没有其他符号依赖它)');
  for (const item of result.downstream.slice(0, 20)) {
    lines.push(`- L${item.depth} ${item.kind} \`${item.name}\` → ${item.file}:${item.line}`);
  }

  lines.push(`\n### 因此失效的证据 (${result.staleEvidence.length})`);
  if (result.staleEvidence.length === 0) lines.push('- 无已登记证据指向这些文件');
  for (const item of result.staleEvidence.slice(0, 10)) {
    lines.push(`- \`${item.evidenceSha}\` ${item.command || '(无命令记录)'} → ${item.target}`);
  }

  if (result.gatesToRerun.length > 0) {
    lines.push(`\n### 需要重跑的门禁 (${result.gatesToRerun.length})`);
    for (const gate of result.gatesToRerun) lines.push(`- ${gate}`);
  }
  if (result.requirements.length > 0) {
    lines.push(`\n### 相关需求 (${result.requirements.length})`);
    for (const item of result.requirements.slice(0, 5)) {
      lines.push(`- ${item.requirement} → ${item.target}`);
    }
  }
  if (result.relatedFacts.length > 0) {
    lines.push(`\n### 相关既往经验 (${result.relatedFacts.length}, 低置信度提示)`);
    for (const item of result.relatedFacts.slice(0, 5)) {
      lines.push(`- fact:${item.factId} (confidence=${item.confidence})`);
    }
  }

  lines.push(`\n受影响文件 (${result.files.length}): ${result.files.slice(0, 12).join(', ')}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── MCP 协议引擎 ─────────────────────────────────────────────────────────────

function handleRequest(request, emit = respond, opts = {}) {
  if (!request || request.jsonrpc !== '2.0') return;

  const id = request.id;
  const method = request.method;

  try {
    switch (method) {
      case 'tools/list':
        emit(id, { tools: TOOLS });
        break;

      case 'tools/call': {
        const toolName = request.params?.name;
        const toolArgs = request.params?.arguments || {};
        const result = handleToolCall(toolName, toolArgs, opts);
        emit(id, result);
        break;
      }

      case 'resources/list':
        emit(id, {
          resources: [{
            uri: consoleBackend.APP_URI,
            name: 'Harness Maintenance Console',
            description: 'Interactive Harness verification gate, memory health, and plugin ACL console.',
            mimeType: 'text/html;profile=mcp-app',
            _meta: { ui: { prefersBorder: false } },
          }],
        });
        break;

      case 'resources/read': {
        const uri = String(request.params?.uri || '');
        if (uri !== consoleBackend.APP_URI) {
          emit(id, { isError: true, content: [{ type: 'text', text: `未知资源: ${uri}` }] });
          break;
        }
        emit(id, {
          contents: [{
            uri: consoleBackend.APP_URI,
            mimeType: 'text/html;profile=mcp-app',
            text: consoleBackend.loadConsoleHtml(),
            _meta: { ui: { prefersBorder: false } },
          }],
        });
        break;
      }

      case 'initialize': {
        emit(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'codegraph-server', version: '1.1.0' },
        });
        break;
      }

      case 'notifications/initialized':
        // 静默确认
        break;

      default:
        emit(id, { isError: true, content: [{ type: 'text', text: `不支持的方法: ${method}` }] });
    }
  } catch (err) {
    emit(id, { isError: true, content: [{ type: 'text', text: `错误: ${err.message}` }] });
  }
}

function respond(id, result) {
  const response = { jsonrpc: '2.0', id };
  if (result.isError) {
    response.error = { code: -32000, message: result.content?.[0]?.text || 'Unknown error' };
  } else {
    response.result = result;
  }
  process.stdout.write(JSON.stringify(response) + '\n');
}

// ── 启动 ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // 逐行读取 stdin 的 JSON-RPC 请求
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const request = JSON.parse(trimmed);
      handleRequest(request);
    } catch (err) {
      // 解析错误 — 静默忽略格式错误的 JSON
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });

  // 启动时输出日志到 stderr（不干扰 stdout 的 MCP 协议）
  process.stderr.write('[codegraph-server] 启动完成，等待 MCP 请求...\n');
}

module.exports = { TOOLS, handleToolCall, handleRequest };
