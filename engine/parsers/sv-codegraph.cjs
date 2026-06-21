#!/usr/bin/env node

/**
 * engine/parsers/sv-codegraph.cjs — Verilog/SystemVerilog 代码图解析器。
 *
 * 两遍扫描:
 *   第一遍: 注释剥离 → 提取顶级构造（module/interface/package/function/task）
 *   第二遍: 在每个模块体中提取子构造（port/parameter/signal/instance/always/assign）
 *
 * 输出: { nodes: [], edges: [], unresolvedRefs: [], errors: [] }
 *
 * 用法:
 *   const parser = require('./engine/parsers/sv-codegraph.cjs');
 *   const result = parser.parse(content, filePath);
 */

'use strict';

// ── 节点类型常量 ────────────────────────────────────────────────────────────

const NODE_KINDS = {
  MODULE: 'module',
  PORT: 'port',
  PARAMETER: 'parameter',
  SIGNAL: 'signal',
  INSTANCE: 'instance',
  ALWAYS: 'always_block',
  ASSIGN: 'assign',
  FUNCTION: 'function',
  TASK: 'task',
  INTERFACE: 'interface',
  PACKAGE: 'package',
  GENERATE: 'generate_block',
  ASSERTION: 'assertion',
  TYPEDEF: 'typedef',
  ENUM: 'enum',
  STRUCT: 'struct',
};

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 去除注释和字符串字面量（防止匹配到注释/字符串内的内容） */
function stripComments(str) {
  let result = '';
  let inLine = false, inBlock = false, inString = false;
  for (let i = 0; i < str.length; i++) {
    if (inString) {
      if (str[i] === '"' && str[i - 1] !== '\\') inString = false;
      result += ' ';
      continue;
    }
    if (inLine) {
      if (str[i] === '\n') { inLine = false; result += '\n'; }
      else result += ' ';
      continue;
    }
    if (inBlock) {
      if (str[i] === '*' && str[i + 1] === '/') { inBlock = false; i++; result += ' '; }
      else result += ' ';
      continue;
    }
    if (str[i] === '/' && str[i + 1] === '/') { inLine = true; result += ' '; continue; }
    if (str[i] === '/' && str[i + 1] === '*') { inBlock = true; result += ' '; continue; }
    if (str[i] === '"') { inString = true; result += ' '; continue; }
    // 反引号开头的编译器指令跳过整行
    if (str[i] === '`') {
      const nl = str.indexOf('\n', i);
      i = nl !== -1 ? nl : str.length;
      result += '\n';
      continue;
    }
    result += str[i];
  }
  return result;
}

/** 计算全局行号（基于原始内容的偏移量） */
function lineAt(content, offset) {
  if (offset < 0 || offset > content.length) return 1;
  return content.slice(0, Math.min(offset, content.length)).split('\n').length;
}

/** 计算相对行号（基于 block 起点的偏移） */
function relLine(blockStartLine, blockContent, offset) {
  return blockStartLine + blockContent.slice(0, Math.min(offset, blockContent.length)).split('\n').length - 1;
}

/** 生成稳定的 ID */
function hashId(...parts) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);
}

/** 平衡括号提取: 从 pos 开始提取配对的括号内容 */
function extractBalanced(text, pos, open = '(', close = ')') {
  if (text[pos] !== open) return null;
  let depth = 0;
  let i = pos;
  for (; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  return text.slice(pos, i + 1);
}

/** 解析端口列表: "input [7:0] data, output valid" → [{direction, width, name}] */
function parsePortList(text) {
  const ports = [];
  // 按逗号分割顶层（跳过括号内的逗号）
  const items = splitTopLevel(text, ',');
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || trimmed === ';') continue;
    // direction? [signed?] [range?] type? name?
    const m = trimmed.match(
      /^(input|output|inout)\s+(\w+\s+)?(\[\s*[^\]]+\]\s+)?(\w+\s+)?(\w+)\s*(?:=(.*?))?(?:$|,|;)/
    );
    if (m) {
      ports.push({
        direction: m[1],
        width: (m[3] || '').trim(),
        type: (m[4] || '').trim() || 'wire',
        name: m[5],
        default: (m[6] || '').trim(),
      });
    } else {
      // 纯端口名（ANSI 风格）
      const simple = trimmed.match(/^\s*(\w+)\s*(?:,|;|$)/);
      if (simple) {
        ports.push({ direction: 'inout', width: '', type: 'wire', name: simple[1] });
      }
    }
  }
  return ports;
}

/** 按顶层逗号分割（跳过括号/方括号/花括号内的逗号） */
function splitTopLevel(text, sep = ',') {
  const parts = [];
  let depthParen = 0, depthBracket = 0, depthBrace = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen--;
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket--;
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace--;
    else if (ch === sep && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** 提取一组匹配的 end 关键字 */
function extractBlock(text, startIdx) {
  const keywords = ['module', 'function', 'task', 'interface', 'package', 'generate', 'case', 'begin', 'fork', 'primitive', 'covergroup', 'specify', 'table', 'checker', 'property', 'sequence'];
  const endKeywords = ['endmodule', 'endfunction', 'endtask', 'endinterface', 'endpackage', 'endgenerate', 'endcase', 'end', 'join', 'endprimitive', 'endgroup', 'endspecify', 'endtable', 'endchecker', 'endproperty', 'endsequence'];

  // 策略: 跟踪 begin...end 嵌套，找到匹配的 endXXX
  // 这是一个简化版本: 使用 begin/end 栈 + endXXX 匹配
  let depth = 0;
  let beginDepth = 0;
  let i = startIdx;

  // 先找到 block 开始的关键字
  let blockMatch = null;
  for (const kw of keywords) {
    const re = new RegExp('\\b' + kw + '\\b');
    const m = text.slice(startIdx).match(re);
    if (m && m.index === 0) { blockMatch = kw; break; }
  }
  if (!blockMatch) return null;

  const endKw = endKeywords[keywords.indexOf(blockMatch)];
  // 对于 module: 寻找 endmodule 在顶层
  if (blockMatch === 'module' || blockMatch === 'function' || blockMatch === 'task' ||
      blockMatch === 'interface' || blockMatch === 'package') {
    // 跳过匹配关键字本身
    const re = new RegExp('\\b(end' + blockMatch.slice(blockMatch === 'module' ? 0 : 0) + ')\\b', 'i');
    // 更精确: endmodule 直接匹配
    const endRe = new RegExp('\\b' + endKw + '\\b');
    let searchFrom = startIdx;
    let beginCount = 0;
    while (searchFrom < text.length) {
      // 检查 begin/end
      const beginMatch = text.slice(searchFrom).match(/\bbegin\b/);
      const endMatch = text.slice(searchFrom).match(/\bend\b/);
      const targetMatch = text.slice(searchFrom).match(endRe);

      // 检查 begin
      if (beginMatch && (!endMatch || beginMatch.index < endMatch.index) && (!targetMatch || beginMatch.index < targetMatch.index)) {
        beginCount++;
        searchFrom += beginMatch.index + 5;
        continue;
      }
      if (endMatch && (!beginMatch || endMatch.index < beginMatch.index) && (!targetMatch || endMatch.index < targetMatch.index)) {
        beginCount--;
        searchFrom += endMatch.index + 3;
        if (beginCount < 0) break; // 不匹配
        continue;
      }
      if (targetMatch) {
        if (beginCount <= 0) {
          return { end: searchFrom + targetMatch.index + targetMatch[0].length, keyword: blockMatch };
        }
        searchFrom += targetMatch.index + targetMatch[0].length;
        continue;
      }
      break;
    }
  }

  // fallback: 找下一个 endXXX
  const fallback = text.slice(startIdx).search(new RegExp('\\b' + endKw + '\\b'));
  if (fallback !== -1) {
    return { end: startIdx + fallback + endKw.length, keyword: blockMatch };
  }
  return null;
}

// ── 主解析逻辑 ──────────────────────────────────────────────────────────────

/**
 * 解析 Verilog/SystemVerilog 源码，返回节点、边和引用。
 *
 * @param {string} content     — 源码全文
 * @param {string} filePath    — 文件路径（用于节点定位）
 * @param {string} [projectId] — 项目 ID
 * @returns {{ nodes: object[], edges: object[], unresolvedRefs: object[], errors: string[] }}
 */
function parse(content, filePath, projectId = '') {
  const nodes = [];
  const edges = [];
  const unresolvedRefs = [];
  const errors = [];

  const cleaned = stripComments(content);
  if (!cleaned.trim()) return { nodes, edges, unresolvedRefs, errors };

  const fileId = projectId ? hashId(projectId, filePath) : '';

  // ── 第一遍: 提取顶级构造 ────────────────────────────────────────────

  const topPatterns = [
    // module name [ #(params) ] (ports);
    { kind: NODE_KINDS.MODULE, re: /\bmodule\s+(\w+)/ },
    // interface name (ports);
    { kind: NODE_KINDS.INTERFACE, re: /\binterface\s+(\w+)/ },
    // package name;
    { kind: NODE_KINDS.PACKAGE, re: /\bpackage\s+(\w+)/ },
    // function [type] name (...);
    { kind: NODE_KINDS.FUNCTION, re: /\bfunction\s+(?:\w+\s+)?(\w+)\s*\(/ },
    // task name (...);
    { kind: NODE_KINDS.TASK, re: /\btask\s+(\w+)/ },
  ];

  let searchPos = 0;
  while (searchPos < cleaned.length) {
    // 找下一个顶级关键字
    let bestMatch = null;
    let bestPos = cleaned.length;
    for (const pat of topPatterns) {
      const m = cleaned.slice(searchPos).match(pat.re);
      if (m) {
        const absPos = searchPos + m.index;
        if (absPos < bestPos) {
          bestPos = absPos;
          bestMatch = { ...pat, match: m, absPos };
        }
      }
    }

    if (!bestMatch) break; // 没有更多顶级构造

    const { kind, match, absPos } = bestMatch;
    const name = match[1];
    const lineNum = lineAt(content, absPos);

    // 提取剩下的部分直到 endXXX
    const restStart = absPos + match[0].length;
    const rest = cleaned.slice(restStart);

    // 如果是 module，提取参数列表和端口列表
    let paramsList = '';
    let portsList = '';
    let bodyStart = restStart;

    if (kind === NODE_KINDS.MODULE || kind === NODE_KINDS.INTERFACE) {
      // 参数列表: #( ... )
      let afterModule = rest;
      let scanPos = 0;
      // 跳过空白和注释(已经 stripped)
      const bodyBeforeTrim = afterModule;
      afterModule = afterModule.replace(/^\s+/, '');
      scanPos = bodyBeforeTrim.length - afterModule.length;

      if (afterModule[0] === '#') {
        const parenStart = afterModule.indexOf('(');
        if (parenStart !== -1) {
          const parenBlock = extractBalanced(afterModule, parenStart);
          if (parenBlock) {
            paramsList = parenBlock.slice(1, -1).trim();
            scanPos += parenStart + parenBlock.length;
            afterModule = afterModule.slice(parenStart + parenBlock.length).replace(/^\s+/, '');
          }
        }
      }
      // 端口列表: ( ... ) 或 ( ... );
      // 跳过空白后找第一个 (
      const cleanForPorts = afterModule.replace(/^\s+/, '');
      const trimOffset = afterModule.length - cleanForPorts.length;
      if (cleanForPorts[0] === '(') {
        const parenBlock = extractBalanced(cleanForPorts, 0);
        if (parenBlock) {
          portsList = parenBlock.slice(1, -1).trim();
          scanPos += trimOffset + parenBlock.length;
          afterModule = cleanForPorts.slice(parenBlock.length);
        }
      }
      // 跳过分号（如果有）
      afterModule = afterModule.replace(/^\s*;\s*/, '');
      const consumed = rest.length - afterModule.length;
      bodyStart = restStart + consumed;
    }

    // 找到 endmodule/endinterface/endpackage/etc.
    const endKW = kind === NODE_KINDS.MODULE ? 'endmodule'
      : kind === NODE_KINDS.INTERFACE ? 'endinterface'
      : kind === NODE_KINDS.PACKAGE ? 'endpackage'
      : kind === NODE_KINDS.FUNCTION ? 'endfunction'
      : 'endtask';

    const endRe = new RegExp('\\b' + endKW + '\\b');
    const endMatch = cleaned.slice(bodyStart).match(endRe);
    const endPos = endMatch ? bodyStart + endMatch.index + endMatch[0].length : cleaned.length;
    const bodyContent = cleaned.slice(bodyStart, endMatch ? bodyStart + endMatch.index : cleaned.length);

    // 构建节点
    const qName = name;
    const nodeId = projectId ? hashId(projectId, qName, filePath, String(lineNum)) : `node_${nodes.length}`;

    // 提取端口详情
    let portDetails = [];
    if (portsList) {
      portDetails = parsePortList(portsList);
    }

    nodes.push({
      id: nodeId,
      kind,
      name,
      qualified_name: qName,
      file_id: fileId,
      file: filePath,
      start_line: lineNum,
      end_line: lineAt(content, endPos),
      signature: portsList ? portsList.slice(0, 200) : '',
      metadata: JSON.stringify({
        params: paramsList.slice(0, 200),
        portCount: portDetails.length,
        ports: portDetails.slice(0, 20), // 限制避免太大
      }),
      visibility: 'exported',
    });

    // 在模块体内提取子构造
    if ((kind === NODE_KINDS.MODULE || kind === NODE_KINDS.INTERFACE) && bodyContent.trim()) {
      scanModuleBody(bodyContent, bodyStart, nodeId, name, filePath, fileId, projectId, content, nodes, edges, unresolvedRefs);
    }

    // 函数/任务体内提取子构造
    if ((kind === NODE_KINDS.FUNCTION || kind === NODE_KINDS.TASK) && bodyContent.trim()) {
      // 简单起见: 提取入参作为端口
      if (portsList) {
        portDetails = parsePortList(portsList);
        for (const pd of portDetails) {
          const pName = pd.name;
          const pLine = lineAt(content, restStart + match[0].length);
          const pId = projectId ? hashId(projectId, nodeId, pName) : `node_${nodes.length}`;
          nodes.push({
            id: pId, kind: NODE_KINDS.PORT, name: pName,
            qualified_name: qName + '::' + pName,
            file_id: fileId, file: filePath,
            start_line: pLine,
            signature: pd.width ? pd.width + ' ' + pd.name : pd.name,
            metadata: JSON.stringify({ direction: pd.direction, width: pd.width, type: pd.type }),
            visibility: 'local',
          });
          edges.push({
            id: projectId ? hashId(projectId, nodeId, pId, 'contains') : '',
            source_id: nodeId, target_id: pId, kind: 'contains',
            line: pLine,
          });
        }
      }
    }

    searchPos = endPos;
  }

  // ── 第三遍: 跨文件引用解析（实例 → 模块） ──────────────────────────
  // 在当前解析器内完成: 对于 instance 节点，查找相同 projectId 下同名的 module 节点
  // 这是简化版本，完整版本需要数据库查询
  for (const inst of nodes.filter(n => n.kind === NODE_KINDS.INSTANCE)) {
    const targetModuleName = JSON.parse(inst.metadata || '{}').target_module;
    if (targetModuleName) {
      unresolvedRefs.push({
        source_node_id: inst.id,
        name: targetModuleName,
        kind: 'instantiates',
        file_id: fileId,
        file: filePath,
        line: inst.start_line,
        context: `instance ${inst.name} of ${targetModuleName}`,
      });
    }
  }

  return { nodes, edges, unresolvedRefs, errors };
}

/**
 * 扫描模块体: 提取 port/parameter/signal/instance/always/assign 等。
 */
function scanModuleBody(body, bodyOffset, parentNodeId, parentName, filePath, fileId, projectId, origContent, nodes, edges, unresolvedRefs) {
  // 端口声明: input/output/inout [signed] [range] [type] name;
  const portRe = /^\s*(input|output|inout)\s+(?:(wire|reg|logic|uwire)\s+)?(?:\[([^\]]*)\]\s+)?(\w+)\s*(?:;|,)/gm;
  let m;
  while ((m = portRe.exec(body)) !== null) {
    const direction = m[1];
    const type = m[2] || 'wire';
    const width = m[3] || '';
    const name = m[4];
    if (!name || name === 'endmodule') continue;
    const line = relLine(bodyOffset, body, m.index) + 1;
    const actualLine = lineAt(origContent, bodyOffset + m.index);
    const qName = parentName + '::' + name;
    const nodeId = projectId ? hashId(projectId, qName, String(actualLine)) : `node_${nodes.length}`;

    nodes.push({
      id: nodeId, kind: NODE_KINDS.PORT, name,
      qualified_name: qName, file_id: fileId, file: filePath,
      start_line: actualLine,
      signature: width ? width + ' ' + name : name,
      metadata: JSON.stringify({ direction, width, type }),
      visibility: 'local',
    });
    edges.push({ id: projectId ? hashId(projectId, parentNodeId, nodeId, 'contains', String(actualLine)) : '',
      source_id: parentNodeId, target_id: nodeId, kind: 'contains', line: actualLine });
  }

  // 参数声明: parameter/localparam [type] [range] name = default;
  const paramRe = /\b(parameter|localparam)\s+(?:(\w+)\s+)?(?:\[([^\]]*)\]\s+)?(\w+)\s*(?:=\s*([^;,]+))?\s*(?:;|,)/gm;
  while ((m = paramRe.exec(body)) !== null) {
    const name = m[4];
    const type = m[2] || '';
    const width = m[3] || '';
    const defaultValue = m[5] ? m[5].trim() : '';
    if (!name) continue;
    const actualLine = lineAt(origContent, bodyOffset + m.index);
    const qName = parentName + '::' + name;
    const nodeId = projectId ? hashId(projectId, qName, String(actualLine)) : `node_${nodes.length}`;
    nodes.push({
      id: nodeId, kind: NODE_KINDS.PARAMETER, name,
      qualified_name: qName, file_id: fileId, file: filePath,
      start_line: actualLine,
      signature: defaultValue ? name + ' = ' + defaultValue.slice(0, 80) : name,
      metadata: JSON.stringify({ type, width, default: defaultValue.slice(0, 200), is_local: m[1] === 'localparam' }),
      visibility: 'local',
    });
    edges.push({ id: projectId ? hashId(projectId, parentNodeId, nodeId, 'contains', String(actualLine)) : '',
      source_id: parentNodeId, target_id: nodeId, kind: 'contains', line: actualLine });
  }

  // 信号声明: wire/reg/logic [signed] [range] name [, name2, ...];
  const signalRe = /^\s*(wire|reg|logic|tri|wand|wor|trireg|uwire)\s+(?:\w+\s+)?(?:\[([^\]]*)\]\s+)?(\w[\w,]*(?:\s*,\s*\w[\w,]*)*)\s*(?:;|=)/gm;
  while ((m = signalRe.exec(body)) !== null) {
    const type = m[1];
    const width = m[2] || '';
    const names = m[3].split(',').map(s => s.trim()).filter(Boolean);
    for (const name of names) {
      if (!name || name === 'endmodule') continue;
      const actualLine = lineAt(origContent, bodyOffset + m.index);
      const qName = parentName + '::' + name;
      const nodeId = projectId ? hashId(projectId, qName, String(actualLine)) : `node_${nodes.length}`;
      nodes.push({
        id: nodeId, kind: NODE_KINDS.SIGNAL, name,
        qualified_name: qName, file_id: fileId, file: filePath,
        start_line: actualLine,
        signature: width ? width + ' ' + name : name,
        metadata: JSON.stringify({ type, width }),
        visibility: 'local',
      });
      edges.push({ id: projectId ? hashId(projectId, parentNodeId, nodeId, 'contains', String(actualLine)) : '',
        source_id: parentNodeId, target_id: nodeId, kind: 'contains', line: actualLine });
    }
  }

  // 实例化: module_name #(params) inst_name (port_connections);
  const instRe = /(\w+)\s+(?:#\s*\((?:[^()]*|\([^()]*\))*\)\s+)?(\w+)\s*\((\s*(?:\.\w+\s*\([^()]*\)\s*,?\s*)*\s*)\)\s*;/gm;
  while ((m = instRe.exec(body)) !== null) {
    const targetModule = m[1];
    const instName = m[2];
    // 排除关键字
    if (['if', 'case', 'for', 'while', 'begin', 'end', 'module', 'always', 'assign', 'initial', 'generate', 'function', 'task', 'assert', 'assume', 'cover', 'property', 'expect', 'wait', 'assertion', 'logic', 'wire', 'reg', 'input', 'output', 'inout', 'parameter', 'localparam'].includes(targetModule)) continue;
    if (/^[A-Z_][A-Z0-9_]*$/.test(targetModule) && !/[a-z]/.test(targetModule)) continue; // 全大写常量
    if (targetModule.length > 40) continue; // 不太可能是模块名
    const actualLine = lineAt(origContent, bodyOffset + m.index);
    const qName = parentName + '::' + instName;
    const nodeId = projectId ? hashId(projectId, qName, String(actualLine)) : `node_${nodes.length}`;
    nodes.push({
      id: nodeId, kind: NODE_KINDS.INSTANCE, name: instName,
      qualified_name: qName, file_id: fileId, file: filePath,
      start_line: actualLine,
      signature: targetModule + ' ' + instName,
      metadata: JSON.stringify({ target_module: targetModule }),
      visibility: 'local',
    });
    edges.push({ id: projectId ? hashId(projectId, parentNodeId, nodeId, 'contains', String(actualLine)) : '',
      source_id: parentNodeId, target_id: nodeId, kind: 'contains', line: actualLine });
    // 指向目标模块的待解析引用
    unresolvedRefs.push({
      source_node_id: nodeId,
      name: targetModule,
      kind: 'instantiates',
      file_id: fileId,
      line: actualLine,
      context: targetModule + ' ' + instName + '(...)',
    });
  }

  // Always 块: always_ff @(posedge clk) / always_comb / always @(...)
  const alwaysRe = /\b(always_ff|always_comb|always_latch|always)\s*(?:@\s*\(([^)]*)\))?/gm;
  while ((m = alwaysRe.exec(body)) !== null) {
    const type = m[1];
    const sensitivity = m[2] || '';
    const actualLine = lineAt(origContent, bodyOffset + m.index);
    const qName = parentName + '::always_' + actualLine;
    const nodeId = projectId ? hashId(projectId, qName) : `node_${nodes.length}`;
    nodes.push({
      id: nodeId, kind: NODE_KINDS.ALWAYS, name: 'always_' + actualLine,
      qualified_name: qName, file_id: fileId, file: filePath,
      start_line: actualLine,
      signature: type + (sensitivity ? ' @(' + sensitivity + ')' : ''),
      metadata: JSON.stringify({ always_type: type, sensitivity }),
      visibility: 'local',
    });
    edges.push({ id: projectId ? hashId(projectId, parentNodeId, nodeId, 'contains', String(actualLine)) : '',
      source_id: parentNodeId, target_id: nodeId, kind: 'contains', line: actualLine });
  }

  // Assign: assign name = expression;
  const assignRe = /\bassign\s+(\w+)\s*=/gm;
  while ((m = assignRe.exec(body)) !== null) {
    const name = m[1];
    const actualLine = lineAt(origContent, bodyOffset + m.index);
    const qName = parentName + '::assign_' + name;
    const nodeId = projectId ? hashId(projectId, qName, String(actualLine)) : `node_${nodes.length}`;
    nodes.push({
      id: nodeId, kind: NODE_KINDS.ASSIGN, name: 'assign_' + name,
      qualified_name: qName, file_id: fileId, file: filePath,
      start_line: actualLine,
      signature: 'assign ' + name + ' = ...',
      metadata: JSON.stringify({ target: name }),
      visibility: 'local',
    });
    edges.push({ id: projectId ? hashId(projectId, parentNodeId, nodeId, 'contains', String(actualLine)) : '',
      source_id: parentNodeId, target_id: nodeId, kind: 'contains', line: actualLine });
    // assign 写目标信号
    const targetNode = nodes.find(n => n.kind === NODE_KINDS.SIGNAL && n.name === name && n.file_id === fileId);
    if (targetNode) {
      edges.push({ id: projectId ? hashId(projectId, nodeId, targetNode.id, 'writes', String(actualLine)) : '',
        source_id: nodeId, target_id: targetNode.id, kind: 'writes', line: actualLine });
    }
  }

  // 类型定义: typedef struct/union/enum
  const typedefRe = /\btypedef\s+(struct|union|enum)\s+(\w+\s+)?\{/gm;
  while ((m = typedefRe.exec(body)) !== null) {
    // 简化的类型定义提取
    const typeKind = m[1];
    const actualLine = lineAt(origContent, bodyOffset + m.index);
    const qName = parentName + '::typedef_' + actualLine;
    const nodeId = projectId ? hashId(projectId, qName) : `node_${nodes.length}`;
    nodes.push({
      id: nodeId, kind: NODE_KINDS.TYPEDEF, name: 'typedef_' + actualLine,
      qualified_name: qName, file_id: fileId, file: filePath,
      start_line: actualLine,
      metadata: JSON.stringify({ typedef_kind: typeKind }),
      visibility: 'local',
    });
    edges.push({ id: projectId ? hashId(projectId, parentNodeId, nodeId, 'contains', String(actualLine)) : '',
      source_id: parentNodeId, target_id: nodeId, kind: 'contains', line: actualLine });
  }

  // `include 指令
  const includeRe = /`include\s+["<]([^">]+)[">]/gm;
  while ((m = includeRe.exec(body)) !== null) {
    const included = m[1];
    const actualLine = lineAt(origContent, bodyOffset + m.index);
    unresolvedRefs.push({
      source_node_id: parentNodeId,
      name: included,
      kind: 'includes',
      file_id: fileId,
      line: actualLine,
      context: '`include ' + included,
    });
  }

  // generate 块（简化的）
  const genRe = /\bgenerate\b/gm;
  while ((m = genRe.exec(body)) !== null) {
    const actualLine = lineAt(origContent, bodyOffset + m.index);
    const qName = parentName + '::generate_' + actualLine;
    const nodeId = projectId ? hashId(projectId, qName) : `node_${nodes.length}`;
    nodes.push({
      id: nodeId, kind: NODE_KINDS.GENERATE, name: 'generate_' + actualLine,
      qualified_name: qName, file_id: fileId, file: filePath,
      start_line: actualLine,
      metadata: JSON.stringify({}),
      visibility: 'local',
    });
    edges.push({ id: projectId ? hashId(projectId, parentNodeId, nodeId, 'contains', String(actualLine)) : '',
      source_id: parentNodeId, target_id: nodeId, kind: 'contains', line: actualLine });
  }
}

// ── 独立运行 ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法: node sv-codegraph.cjs <file.sv>');
    process.exit(1);
  }
  const filePath = require('node:path').resolve(args[0]);
  const fs = require('node:fs');
  const content = fs.readFileSync(filePath, 'utf8');
  const result = parse(content, filePath, 'test');
  console.log(JSON.stringify({
    nodes: result.nodes.map(n => ({ kind: n.kind, name: n.name, line: n.start_line, sig: (n.signature || '').slice(0, 60) })),
    edges: result.edges.map(e => ({ kind: e.kind, line: e.line })),
    unresolved: result.unresolvedRefs.map(u => ({ name: u.name, kind: u.kind })),
    errors: result.errors,
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { parse, NODE_KINDS };
