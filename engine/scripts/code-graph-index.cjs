#!/usr/bin/env node
/**
 * Code Graph Index — L2 记忆层：代码图谱
 *
 * AST-based 调用链索引（基于正则的轻量解析），覆盖：
 *   - JS/TS: imports, requires, exports, function definitions
 *   - Python: imports, class/function definitions
 *   - Verilog/SV: module definitions, port lists, instance references
 *
 * 用法:
 *   node code-graph-index.cjs index [--rebuild]  # 构建索引
 *   node code-graph-index.cjs query "模块名/函数名"  # 查询引用点
 *
 * 索引位置: var/index/code-graph.json
 */

const p = require('node:path');
const f = require('node:fs');
const os = require('node:os');

const HOME = p.join(os.homedir(), '.claude');
const INDEX_DIR = p.join(HOME, 'var', 'index');
const INDEX_FILE = p.join(INDEX_DIR, 'code-graph.json');
const SRC_DIRS = [
  p.join(HOME, 'engine'),
  p.join(HOME, 'skills'),
  p.join(HOME, 'rules'),
];

// ── Language parsers ──────────────────────────────────────────────────────

function parseJS(content, filePath) {
  const nodes = [];
  const edges = [];

  // Import statements: import X from 'y' / import('y') / require('y')
  for (const m of content.matchAll(/(?:import\s+(?:[\w*{},]\s+from\s+)?['"])([^'"]+)(['"])|(?:require\s*\(\s*['"])([^'"]+)(['"])/g)) {
    const target = m[1] || m[3];
    if (target && !target.startsWith('.')) {
      edges.push({ type: 'import', source: filePath, target, line: lineNum(content, m.index) });
    }
  }

  // Export statements
  for (const m of content.matchAll(/(?:module\.)?exports\s*[.=]\s*(\w+)|export\s+(default\s+)?(function|class|const|let|var)\s+(\w+)/g)) {
    const name = m[1] || m[4];
    if (name) {
      nodes.push({ type: 'export', name, file: filePath, line: lineNum(content, m.index) });
    }
  }

  // Function definitions: function name(...) / name = function(...) / name: function(...)
  for (const m of content.matchAll(/(?:function\s+)(\w+)|(?:(\w+)\s*[:=]\s*function\s*\()|(?:(\w+)\s*\([^)]*\)\s*\{)/g)) {
    const name = m[1] || m[2] || m[3];
    if (name && !['if','for','while','switch','catch','then','else'].includes(name)) {
      nodes.push({ type: 'function', name, file: filePath, line: lineNum(content, m.index) });
    }
  }

  return { nodes, edges };
}

function parsePython(content, filePath) {
  const nodes = [];
  const edges = [];

  for (const m of content.matchAll(/^(?:import\s+(\S+)|from\s+(\S+)\s+import)/gm)) {
    const target = m[1] || m[2];
    if (target) edges.push({ type: 'import', source: filePath, target, line: lineNum(content, m.index) });
  }

  for (const m of content.matchAll(/^(?:def\s+|class\s+)(\w+)/gm)) {
    const type = content.slice(m.index, m.index + 4) === 'def ' ? 'function' : 'class';
    nodes.push({ type, name: m[1], file: filePath, line: lineNum(content, m.index) });
  }

  return { nodes, edges };
}

function parseVerilog(content, filePath) {
  const nodes = [];

  // module ... endmodule
  for (const m of content.matchAll(/\bmodule\s+(\w+)/g)) {
    nodes.push({ type: 'module', name: m[1], file: filePath, line: lineNum(content, m.index) });
  }

  // Instance references: module_name inst_name (...)
  for (const m of content.matchAll(/(\w+)\s+#?\s*\(\s*\.\w+/g)) {
    nodes.push({ type: 'instance', name: m[1], file: filePath, line: lineNum(content, m.index) });
  }

  return { nodes, edges: [] };
}

function lineNum(content, index) {
  return content.slice(0, index).split('\n').length;
}

// ── Walk files ────────────────────────────────────────────────────────────

function walkSrc(dir, files = []) {
  try {
    for (const entry of f.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('node_modules') && !entry.name.startsWith('.') && entry.name !== 'archive') {
          walkSrc(p.join(dir, entry.name), files);
        }
      } else if (/\.(js|cjs|ts|py|v|sv|vh)$/i.test(entry.name)) {
        files.push(p.join(dir, entry.name));
      }
    }
  } catch { /* skip */ }
  return files;
}

// ── Index ─────────────────────────────────────────────────────────────────

function cmdIndex() {
  f.mkdirSync(INDEX_DIR, { recursive: true });

  const files = walkSrc(HOME); // Full codebase under .claude
  const graph = { nodes: [], edges: [], files: [] };
  let totalNodes = 0;

  for (const filePath of files) {
    let content;
    try { content = f.readFileSync(filePath, 'utf8'); } catch { continue; }
    if (content.length > 50000) continue; // skip large binaries

    const ext = p.extname(filePath).toLowerCase();
    let result;
    if (['.js', '.cjs', '.ts'].includes(ext)) result = parseJS(content, filePath);
    else if (ext === '.py') result = parsePython(content, filePath);
    else if (['.v', '.sv', '.vh'].includes(ext)) result = parseVerilog(content, filePath);
    else continue;

    if (result.nodes.length > 0) {
      graph.nodes.push(...result.nodes);
      totalNodes += result.nodes.length;
    }
    if (result.edges.length > 0) graph.edges.push(...result.edges);

    graph.files.push({
      path: filePath.replace(HOME + p.sep, ''),
      ext,
      lines: content.split('\n').length,
      symbols: result.nodes.map(n => n.name).filter(Boolean),
    });
  }

  graph.builtAt = new Date().toISOString();
  graph.totalFiles = files.length;
  graph.totalNodes = totalNodes;
  graph.totalEdges = graph.edges.length;

  // Deduplicate nodes by (name, file)
  const seen = new Set();
  graph.nodes = graph.nodes.filter(n => {
    const key = `${n.name}|${n.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Build lookup index
  const byName = {};
  for (const n of graph.nodes) {
    if (!n.name) continue;
    if (!Array.isArray(byName[n.name])) byName[n.name] = [];
    byName[n.name].push(n);
  }

  f.writeFileSync(INDEX_FILE, JSON.stringify({ nodes: graph.nodes, edges: graph.edges, files: graph.files, builtAt: graph.builtAt }));
  f.writeFileSync(INDEX_FILE.replace('.json', '-lookup.json'), JSON.stringify(byName));

  console.error(`Code graph built: ${graph.totalFiles} files, ${graph.nodes.length} symbols, ${graph.edges.length} edges`);
}

// ── Query ─────────────────────────────────────────────────────────────────

function cmdQuery(name) {
  if (!f.existsSync(INDEX_FILE)) {
    console.error('Index not found. Run "node code-graph-index.cjs index" first.');
    process.exit(1);
  }

  const lookupFile = INDEX_FILE.replace('.json', '-lookup.json');
  if (!f.existsSync(lookupFile)) {
    console.error('Lookup index not found. Rebuild with "index" command.');
    process.exit(1);
  }

  const byName = JSON.parse(f.readFileSync(lookupFile, 'utf8'));
  const results = byName[name];
  if (!results) {
    console.log(JSON.stringify({ found: false, matches: [] }, null, 2));
    return;
  }

  console.log(JSON.stringify({ found: true, symbol: name, occurrences: results.length, matches: results }, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
switch (cmd) {
  case 'index':
    cmdIndex();
    break;
  case 'query':
    cmdQuery(process.argv[3]);
    break;
  default:
    console.error('Usage:');
    console.error('  node code-graph-index.cjs index');
    console.error('  node code-graph-index.cjs query <symbol-name>');
    process.exit(1);
}
