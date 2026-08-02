#!/usr/bin/env node

/**
 * Code Graph Index — 代码图谱索引器 & CLI
 *
 * 双模式:
 *   无项目路径 → JSON 索引 (旧行为，索引 .claude/ 自身)
 *   有项目路径 → SQLite 索引 (新行为，索引外部项目)
 *
 * 用法:
 *   node code-graph-index.cjs index                       # 索引 .claude/ (JSON)
 *   node code-graph-index.cjs index /path/to/proj         # 索引项目 (SQLite)
 *   node code-graph-index.cjs sync /path/to/proj          # 增量同步
 *   node code-graph-index.cjs search "query" --kind module --limit 10
 *   node code-graph-index.cjs callers "模块名" --project /path
 *   node code-graph-index.cjs callees "模块名" --project /path
 *   node code-graph-index.cjs explore "sym1 sym2" --project /path
 *   node code-graph-index.cjs query "符号名"               # 旧行为: 查 JSON
 *   node code-graph-index.cjs status /path/to/proj         # 项目统计
 */

const { HARNESS_ROOT } = require('./lib/harness-root.cjs');

const p = require('node:path');
const f = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME = HARNESS_ROOT;
const INDEX_DIR = p.join(HOME, 'var', 'index');
const INDEX_FILE = p.join(INDEX_DIR, 'code-graph.json');
const LOOKUP_FILE = INDEX_FILE.replace('.json', '-lookup.json');

// ── 旧模式: JSON 索引 (向后兼容) ────────────────────────────────────────────

const SRC_DIRS = [
  p.join(HOME, 'engine'),
  p.join(HOME, 'skills'),
  p.join(HOME, 'rules'),
];

function parseJS(content, filePath) {
  const nodes = [];
  const edges = [];
  for (const m of content.matchAll(/(?:import\s+(?:[\w*{},]\s+from\s+)?['"])([^'"]+)(['"])|(?:require\s*\(\s*['"])([^'"]+)(['"])/g)) {
    const target = m[1] || m[3];
    if (target && !target.startsWith('.')) edges.push({ type: 'import', source: filePath, target, line: lineNum(content, m.index) });
  }
  for (const m of content.matchAll(/(?:module\.)?exports\s*[.=]\s*(\w+)|export\s+(default\s+)?(function|class|const|let|var)\s+(\w+)/g)) {
    const name = m[1] || m[4];
    if (name) nodes.push({ type: 'export', name, file: filePath, line: lineNum(content, m.index) });
  }
  for (const m of content.matchAll(/(?:function\s+)(\w+)|(?:(\w+)\s*[:=]\s*function\s*\()|(?:(\w+)\s*\([^)]*\)\s*\{)/g)) {
    const name = m[1] || m[2] || m[3];
    if (name && !['if','for','while','switch','catch','then','else'].includes(name)) nodes.push({ type: 'function', name, file: filePath, line: lineNum(content, m.index) });
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

function parseVerilogLegacy(content, filePath) {
  const nodes = [];
  for (const m of content.matchAll(/\bmodule\s+(\w+)/g)) nodes.push({ type: 'module', name: m[1], file: filePath, line: lineNum(content, m.index) });
  for (const m of content.matchAll(/(\w+)\s+#?\s*\(\s*\.\w+/g)) nodes.push({ type: 'instance', name: m[1], file: filePath, line: lineNum(content, m.index) });
  return { nodes, edges: [] };
}

function lineNum(content, index) {
  return content.slice(0, index).split('\n').length;
}

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

function cmdIndexLegacy() {
  f.mkdirSync(INDEX_DIR, { recursive: true });
  const files = walkSrc(HOME);
  const graph = { nodes: [], edges: [], files: [] };

  for (const filePath of files) {
    let content;
    try { content = f.readFileSync(filePath, 'utf8'); } catch { continue; }
    if (content.length > 50000) continue;
    const ext = p.extname(filePath).toLowerCase();
    let result;
    if (['.js', '.cjs', '.ts'].includes(ext)) result = parseJS(content, filePath);
    else if (ext === '.py') result = parsePython(content, filePath);
    else if (['.v', '.sv', '.vh'].includes(ext)) result = parseVerilogLegacy(content, filePath);
    else continue;
    if (result.nodes.length > 0) graph.nodes.push(...result.nodes);
    if (result.edges.length > 0) graph.edges.push(...result.edges);
    graph.files.push({ path: filePath.replace(HOME + p.sep, ''), ext, lines: content.split('\n').length, symbols: result.nodes.map(n => n.name).filter(Boolean) });
  }

  graph.builtAt = new Date().toISOString();
  graph.totalFiles = files.length;
  graph.totalNodes = graph.nodes.length;
  graph.totalEdges = graph.edges.length;

  const seen = new Set();
  graph.nodes = graph.nodes.filter(n => {
    const key = `${n.name}|${n.file}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  // 恢复去重后的计数
  graph.totalNodes = graph.nodes.length;

  const byName = {};
  for (const n of graph.nodes) {
    if (!n.name) continue;
    if (!Array.isArray(byName[n.name])) byName[n.name] = [];
    byName[n.name].push(n);
  }

  f.writeFileSync(INDEX_FILE, JSON.stringify({ nodes: graph.nodes, edges: graph.edges, files: graph.files, builtAt: graph.builtAt }));
  f.writeFileSync(LOOKUP_FILE, JSON.stringify(byName));
  console.error(`JSON code graph built: ${graph.totalFiles} files, ${graph.nodes.length} symbols, ${graph.edges.length} edges`);
}

function cmdQueryLegacy(name) {
  if (!f.existsSync(LOOKUP_FILE)) {
    console.error('JSON index not found. Run "code-graph-index.cjs index" first.');
    process.exit(1);
  }
  const byName = JSON.parse(f.readFileSync(LOOKUP_FILE, 'utf8'));
  const results = byName[name];
  console.log(JSON.stringify({ found: !!results, symbol: name, occurrences: results ? results.length : 0, matches: results || [] }, null, 2));
}

// ── 新模式: SQLite 项目索引 ────────────────────────────────────────────────

const { openDb } = require('../sqlite/index.cjs');
const { resolveProject, getProjectStats, searchNodes, getCallers, getCallees, getSubgraphByNames } = require('./cg-queries.cjs');
const svParser = require('../parsers/sv-codegraph.cjs');

/** 计算文件内容哈希 (SHA256 前 4096 字节 + mtime) */
function fileContentHash(filePath) {
  try {
    const fd = f.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = f.readSync(fd, buf, 0, 4096, 0);
    f.closeSync(fd);
    const hash = crypto.createHash('sha256').update(buf.slice(0, bytesRead)).digest('hex').slice(0, 16);
    const stat = f.statSync(filePath);
    return hash + '_' + stat.mtimeMs;
  } catch { return ''; }
}

/** 检测文件语言 */
function detectLanguage(ext, filePath) {
  const map = {
    '.sv': 'systemverilog', '.v': 'verilog', '.vh': 'verilog_header',
    '.svh': 'systemverilog_header',
    '.py': 'python', '.cjs': 'javascript', '.js': 'javascript',
    '.ts': 'typescript', '.mjs': 'javascript',
    '.m': 'matlab', '.tcl': 'tcl', '.do': 'tcl',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c_header',
  };
  return map[ext] || 'unknown';
}

/** 判断文件是否应被索引（跳过二进制、生成文件、大文件等） */
function shouldIndex(filePath, stat) {
  const ext = p.extname(filePath).toLowerCase();
  const name = p.basename(filePath);
  const skipDirs = ['node_modules', '.git', '.claude', '.wright', '.codegraph',
    'build', 'sim_run', 'xsim', 'modelsim', 'vsim', 'questa',
    '__pycache__', '.venv', 'env', 'venv', '.eggs', 'egg-info',
    'archive', 'backup', 'vendor', '.github', '.cursor'];
  const skipExts = ['.log', '.vcd', '.wlf', '.dcp', '.bit', '.bin', '.hex',
    '.jpg', '.png', '.gif', '.svg', '.ico', '.pdf',
    '.o', '.obj', '.exe', '.dll', '.so', '.a', '.lib',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.swp', '.swo', '.bak', '.pyc', '.pyo'];

  if (skipExts.includes(ext)) return false;
  if (name.startsWith('.')) return false;
  if (filePath.includes(p.sep + '.git' + p.sep)) return false;
  if (stat.size > 500 * 1024) return false; // >500KB
  // 只索引代码文件
  return /\.(sv|v|vh|svh|py|js|cjs|ts|mjs|m|tcl|do|c|cpp|h|json|yaml|yml|xml|cfg|hex)$/i.test(ext);
}

/**
 * 深度解析的体积兜底上限。
 *
 * 解析器全是正则实现, 一旦某条正则有歧义分支就会在大文件上灾难性回溯 —— 实测
 * xpm_memory.sv (477KB) 曾让解析 >180s 不返回 (根因已在 parsers/sv-codegraph.cjs
 * 的 instRe 修掉, 现在同一文件 54ms)。这个上限留作**兜底**: 将来再引入类似歧义
 * 时, 表现是少抽几个大文件的符号, 而不是整个索引调度卡死。
 * 超限文件仍登记进 cg_files, 跨域边照样挂得上, 只是不抽符号。
 * 与 shouldIndex 的 500KB 硬上限对齐; 可用 CLAUDE_CG_MAX_PARSE_BYTES 调整。
 */
const MAX_PARSE_BYTES = (() => {
  const raw = Number.parseInt(process.env.CLAUDE_CG_MAX_PARSE_BYTES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 512 * 1024;
})();

/** 判断文件是否应被深度索引（符号提取） */
function shouldDeepIndex(ext, stat) {
  if (stat && stat.size > MAX_PARSE_BYTES) return false;
  return /\.(sv|v|vh|svh|py|js|cjs|ts|mjs)$/i.test(ext);
}

/** 索引单个文件到 SQLite */
function indexFile(db, filePath, projectId, relativePath) {
  const ext = p.extname(filePath).toLowerCase();
  const language = detectLanguage(ext, filePath);
  const contentHash = fileContentHash(filePath);
  const stat = f.statSync(filePath);
  const fileId = crypto.createHash('sha256').update(projectId + '::' + relativePath).digest('hex').slice(0, 16);

  // 检查是否需要更新
  const existing = db.prepare('SELECT id, content_hash FROM cg_files WHERE id = ?').get(fileId);
  if (existing && existing.content_hash === contentHash) {
    return { changed: false }; // 未变，跳过
  }

  // 读取内容
  let content;
  try { content = f.readFileSync(filePath, 'utf8'); } catch { return { changed: false, error: 'read failed' }; }

  // 删除旧的节点和边
  if (existing) {
    db.prepare('DELETE FROM cg_edges WHERE project_id = ? AND source_id IN (SELECT id FROM cg_nodes WHERE file_id = ?)').run(projectId, fileId);
    db.prepare('DELETE FROM cg_edges WHERE project_id = ? AND target_id IN (SELECT id FROM cg_nodes WHERE file_id = ?)').run(projectId, fileId);
    db.prepare('DELETE FROM cg_nodes WHERE file_id = ?').run(fileId);
    // FTS5 触发器自动处理
  }

  // 更新或插入文件记录
  db.prepare(`
    INSERT OR REPLACE INTO cg_files (id, project_id, relative_path, language, content_hash, size_bytes, modified_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fileId, projectId, relativePath, language, contentHash, stat.size, stat.mtimeMs, Date.now());

  // 深度解析（仅对代码文件, 且体积在解析上限之内）
  if (shouldDeepIndex(ext, stat)) {
    let result;
    if (['.sv', '.v', '.vh', '.svh'].includes(ext)) {
      result = svParser.parse(content, filePath, projectId);
    } else if (['.py'].includes(ext)) {
      result = parsePythonToSQLite(content, filePath, projectId, fileId);
    } else if (['.js', '.cjs', '.ts', '.mjs'].includes(ext)) {
      result = parseJSToSQLite(content, filePath, projectId, fileId);
    } else {
      result = { nodes: [], edges: [], unresolvedRefs: [], errors: [] };
    }

    // 批量写入节点
    const insertNode = db.prepare(`
      INSERT OR REPLACE INTO cg_nodes (id, project_id, kind, name, qualified_name, file_id, start_line, end_line, signature, metadata, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = db.prepare(`
      INSERT OR REPLACE INTO cg_edges (id, project_id, source_id, target_id, kind, line, provenance, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const node of result.nodes) {
      try {
        insertNode.run(
          node.id || crypto.createHash('sha256').update(projectId + '::' + node.qualified_name + '::' + (node.start_line || 0)).digest('hex').slice(0, 16),
          projectId, node.kind, node.name, node.qualified_name || node.name,
          fileId, node.start_line || 0, node.end_line || 0,
          node.signature || '', node.metadata || '{}', node.visibility || 'local'
        );
      } catch (e) { /* 跳过重复节点 */ }
    }

    for (const edge of result.edges) {
      try {
        insertEdge.run(
          edge.id || crypto.createHash('sha256').update((edge.source_id || '') + (edge.target_id || '') + (edge.kind || '')).digest('hex').slice(0, 16),
          projectId, edge.source_id, edge.target_id, edge.kind,
          edge.line || 0, edge.provenance || 'regex', edge.metadata || '{}'
        );
      } catch (e) { /* 跳过重复边 */ }
    }

    // 记录未解析引用
    for (const ref of result.unresolvedRefs || []) {
      try {
        const refId = crypto.createHash('sha256').update(projectId + '::' + fileId + '::' + (ref.name || '') + '::' + (ref.line || 0)).digest('hex').slice(0, 16);
        db.prepare(`
          INSERT OR REPLACE INTO cg_unresolved (id, project_id, file_id, source_node_id, name, kind, line, context, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(refId, projectId, fileId, ref.source_node_id || '', ref.name || '', ref.kind || 'unknown', ref.line || 0, ref.context || '', Date.now());
      } catch { /* 静默 */ }
    }

    return { changed: true, nodes: result.nodes.length, edges: result.edges.length };
  }

  return { changed: true, nodes: 0, edges: 0 };
}

/** Python → SQLite 解析器 (适配旧 parsePython) */
function parsePythonToSQLite(content, filePath, projectId, fileId) {
  const nodes = [];
  const edges = [];
  const unresolvedRefs = [];
  const name = p.basename(filePath, '.py');

  // 文件本身作为一个模块节点
  const fileNodeId = crypto.createHash('sha256').update(projectId + '::' + name).digest('hex').slice(0, 16);
  nodes.push({
    id: fileNodeId, kind: 'module', name,
    qualified_name: name, file_id: fileId, start_line: 1,
    metadata: '{}', visibility: 'exported',
  });

  for (const m of content.matchAll(/^(?:import\s+(\S+)|from\s+(\S+)\s+import)/gm)) {
    const targetName = m[1] || m[2];
    if (!targetName) continue;
    unresolvedRefs.push({ source_node_id: fileNodeId, name: targetName, kind: 'imports', file_id: fileId, line: lineNum(content, m.index), context: m[0] });
  }

  for (const m of content.matchAll(/^(?:def\s+|class\s+)(\w+)/gm)) {
    const kind = content.slice(m.index, m.index + 3) === 'def' ? 'function' : 'class';
    const symName = m[1];
    const symId = crypto.createHash('sha256').update(projectId + '::' + name + '::' + symName).digest('hex').slice(0, 16);
    nodes.push({
      id: symId, kind, name: symName, qualified_name: name + '::' + symName,
      file_id: fileId, start_line: lineNum(content, m.index),
      metadata: '{}', visibility: 'local',
    });
    const edgeId = crypto.createHash('sha256').update(fileNodeId + symId + 'contains').digest('hex').slice(0, 16);
    edges.push({ id: edgeId, source_id: fileNodeId, target_id: symId, kind: 'contains', line: lineNum(content, m.index), provenance: 'regex', metadata: '{}' });
  }

  return { nodes, edges, unresolvedRefs, errors: [] };
}

/** JS/TS → SQLite 解析器 (适配旧 parseJS) */
function parseJSToSQLite(content, filePath, projectId, fileId) {
  const nodes = [];
  const edges = [];
  const unresolvedRefs = [];
  const name = p.basename(filePath).replace(/\.(js|cjs|ts|mjs)$/, '');
  const fileNodeId = crypto.createHash('sha256').update(projectId + '::' + name).digest('hex').slice(0, 16);
  nodes.push({
    id: fileNodeId, kind: 'module', name,
    qualified_name: name, file_id: fileId, start_line: 1,
    metadata: '{}', visibility: 'exported',
  });

  for (const m of content.matchAll(/(?:import\s+(?:[\w*{},]\s+from\s+)?['"])([^'"]+)(['"])|(?:require\s*\(\s*['"])([^'"]+)(['"])/g)) {
    const target = m[1] || m[3];
    if (target && !target.startsWith('.')) {
      unresolvedRefs.push({ source_node_id: fileNodeId, name: target, kind: 'imports', file_id: fileId, line: lineNum(content, m.index), context: 'import ' + target });
    }
  }

  for (const m of content.matchAll(/(?:function\s+)(\w+)|(?:(\w+)\s*[:=]\s*function\s*\()|(?:(\w+)\s*\([^)]*\)\s*\{)/g)) {
    const fnName = m[1] || m[2] || m[3];
    if (!fnName || ['if','for','while','switch','catch','then','else'].includes(fnName)) continue;
    const symId = crypto.createHash('sha256').update(projectId + '::' + name + '::' + fnName).digest('hex').slice(0, 16);
    nodes.push({
      id: symId, kind: 'function', name: fnName, qualified_name: name + '::' + fnName,
      file_id: fileId, start_line: lineNum(content, m.index),
      metadata: '{}', visibility: 'local',
    });
    const edgeId = crypto.createHash('sha256').update(fileNodeId + symId + 'contains').digest('hex').slice(0, 16);
    edges.push({ id: edgeId, source_id: fileNodeId, target_id: symId, kind: 'contains', line: lineNum(content, m.index), provenance: 'regex', metadata: '{}' });
  }

  return { nodes, edges, unresolvedRefs, errors: [] };
}

/** 任何层级都跳过的目录 (构建产物、依赖、仿真中间件)。 */
const SKIP_DIRS = ['node_modules', '.git', '.claude', '.wright', '.codegraph',
  'build', 'sim_run', '__pycache__', '.venv', 'archive', 'backup',
  'xsim', 'modelsim', 'vsim', 'questa'];

/**
 * 仅在项目**根目录**跳过的目录 —— 运行时/派生数据, 不是项目代码。
 *
 * 只在根层跳: 深层出现的同名目录 (如 rtl/var/) 可能是真代码, 不应误伤。
 * 对本 harness 而言这一条砍掉了 ~800 个文件 (var/ 513 + tasks/ 307), 那些是
 * 会话产物与临时脚本, 进了图只会污染符号搜索。
 */
const ROOT_SKIP_DIRS = ['var', 'tasks', 'projects', 'sessions', 'session-data',
  'session-env', 'shell-snapshots', 'paste-cache', 'file-history', 'backups',
  'cache', 'telemetry', 'transcript', 'ide'];

/** 扫描项目目录 */
function walkProject(dir, baseDir, files = []) {
  try {
    const atRoot = p.resolve(dir) === p.resolve(baseDir);
    for (const entry of f.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = p.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skipDirs = atRoot ? [...SKIP_DIRS, ...ROOT_SKIP_DIRS] : SKIP_DIRS;
        if (!skipDirs.includes(entry.name) && !entry.name.startsWith('.')) {
          walkProject(fullPath, baseDir, files);
        }
      } else if (entry.isFile()) {
        const relPath = p.relative(baseDir, fullPath).replace(/\\/g, '/');
        try {
          const stat = f.statSync(fullPath);
          if (shouldIndex(fullPath, stat)) {
            files.push({ fullPath, relPath, stat });
          }
        } catch { /* 跳过无法访问的文件 */ }
      }
    }
  } catch { /* 跳过无法访问的目录 */ }
  return files;
}

/** 跨文件引用解析: 将 unresolvedRefs 中的实例→模块引用转为 edges */
function resolveCrossFileRefs(db, projectId, opts = {}) {
  const refs = db.prepare(`
    SELECT u.name, u.source_node_id, u.line
    FROM cg_unresolved u
    WHERE u.project_id = ? AND u.kind = 'instantiates'
    AND u.resolved_node_id IS NULL
  `).all(projectId);

  if (refs.length === 0) return;

  let resolved = 0;
  for (const ref of refs) {
    // 找同名模块
    const target = db.prepare(`
      SELECT id FROM cg_nodes
      WHERE project_id = ? AND name = ? AND kind = 'module'
      LIMIT 1
    `).get(projectId, ref.name);

    if (target) {
      // 创建 instantiates 边
      const edgeId = crypto.createHash('sha256').update(ref.source_node_id + target.id + 'instantiates').digest('hex').slice(0, 16);
      try {
        db.prepare(`
          INSERT OR IGNORE INTO cg_edges (id, project_id, source_id, target_id, kind, line, provenance, metadata)
          VALUES (?, ?, ?, ?, 'instantiates', ?, 'resolved', '{}')
        `).run(edgeId, projectId, ref.source_node_id, target.id, ref.line || 0);
        // 标记已解析
        db.prepare('UPDATE cg_unresolved SET resolved_node_id = ? WHERE name = ? AND project_id = ? AND kind = ?')
          .run(target.id, ref.name, projectId, 'instantiates');
        resolved++;
      } catch { /* 跳过重复边 */ }
    }
  }

  if (resolved > 0 && !opts.quiet) {
    console.error(`   引用解析: ${resolved}/${refs.length} 个实例已匹配到模块定义`);
  }
}

// ── SQLite 索引命令 ────────────────────────────────────────────────────────

function cmdIndexProject(projectPath) {
  const { projectId, rootPath } = resolveProject(projectPath);
  const db = openDb().db;
  console.error(`📂 索引项目: ${rootPath}`);
  console.error(`   项目 ID: ${projectId}`);

  const startTime = Date.now();
  let totalChanged = 0, totalNodes = 0, totalEdges = 0, totalSkipped = 0;

  // 扫描文件
  const files = walkProject(rootPath, rootPath);
  console.error(`   扫描文件数: ${files.length}`);

  // 事务内处理
  let txCount = 0;
  for (const file of files) {
    if (shouldDeepIndex(p.extname(file.fullPath), file.stat)) {
      const result = indexFile(db, file.fullPath, projectId, file.relPath);
      if (result.changed && result.nodes !== undefined) {
        totalChanged++;
        totalNodes += result.nodes || 0;
        totalEdges += result.edges || 0;
      } else if (!result.changed) {
        totalSkipped++;
      }
    }
    // 非代码文件也记录到 cg_files（用于文件清单查询）
    else {
      const ext = p.extname(file.fullPath).toLowerCase();
      const contentHash = fileContentHash(file.fullPath);
      const fileId = crypto.createHash('sha256').update(projectId + '::' + file.relPath).digest('hex').slice(0, 16);
      db.prepare(`
        INSERT OR REPLACE INTO cg_files (id, project_id, relative_path, language, content_hash, size_bytes, modified_at, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fileId, projectId, file.relPath, detectLanguage(ext, file.fullPath), contentHash, file.stat.size, file.stat.mtimeMs, Date.now());
      totalSkipped++;
    }

    // 每 50 个文件输出进度
    txCount++;
    if (txCount % 50 === 0) {
      console.error(`   进度: ${txCount}/${files.length} (${totalChanged} 变更, ${totalSkipped} 跳过)`);
    }
  }

  // ── 跨文件引用解析 ──
  resolveCrossFileRefs(db, projectId);

  // 更新项目统计
  const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM cg_nodes WHERE project_id = ?').get(projectId).c;
  const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM cg_edges WHERE project_id = ?').get(projectId).c;
  const fileCount = db.prepare('SELECT COUNT(*) AS c FROM cg_files WHERE project_id = ?').get(projectId).c;

  db.prepare(`
    UPDATE cg_projects SET indexed_at = ?, file_count = ?, node_count = ?, edge_count = ?
    WHERE id = ?
  `).run(Date.now(), fileCount, nodeCount, edgeCount, projectId);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n✅ 索引完成: ${elapsed}s`);
  console.error(`   文件: ${fileCount}, 符号: ${nodeCount}, 关系: ${edgeCount}`);
  console.error(`   变更: ${totalChanged}, 跳过: ${totalSkipped}`);

  return { projectId, fileCount, nodeCount, edgeCount, elapsed };
}

function cmdSyncProject(projectPath, opts = {}) {
  const log = opts.quiet ? () => {} : (msg) => console.error(msg);
  const db = openDb().db;
  const { projectId, rootPath } = resolveProject(projectPath);
  log(`🔄 增量同步: ${rootPath}`);

  const startTime = Date.now();
  let changed = 0, skipped = 0;

  // 预算用于 hook 场景: SessionStart 的 hook 超时会直接杀进程, 与其被杀在半路,
  // 不如自己停下来把统计写完 —— 已索引的文件是持久的, 下一轮从未索引的继续。
  const deadline = opts.budgetMs > 0 ? startTime + opts.budgetMs : Infinity;
  let partial = false;

  const files = walkProject(rootPath, rootPath);

  // 批量事务: WAL 下每条 INSERT 单独提交都要 fsync, 一个文件约 10 条语句,
  // 1900 个文件就是两万次落盘 —— 实测全量同步因此跑到 500s+ 被超时杀掉。
  // 按批提交把落盘次数压到 1/BATCH。
  const BATCH = 100;
  let inTx = false;
  const beginTx = () => { if (!inTx) { try { db.exec('BEGIN'); inTx = true; } catch { /* 已在事务中 */ } } };
  const commitTx = () => { if (inTx) { try { db.exec('COMMIT'); } catch { /* 提交失败时下一批重开 */ } inTx = false; } };

  let processed = 0;
  beginTx();
  for (const file of files) {
    if (Date.now() > deadline) { partial = true; break; }
    if (++processed % BATCH === 0) { commitTx(); beginTx(); }
    if (shouldDeepIndex(p.extname(file.fullPath), file.stat)) {
      const result = indexFile(db, file.fullPath, projectId, file.relPath);
      if (result.changed) changed++;
      else skipped++;
    } else {
      // 非深度索引文件 (.m/.tcl/.json/.hex...) 也要进 cg_files。
      // 否则跨域边只能挂到 RTL/JS 上: 需求 scope 指向 MATLAB Golden Model 时
      // 一条边都建不起来 —— 而那恰恰是算法/RTL 双轨项目最需要追溯的一环。
      // (index 全量模式一直是这么做的, sync 之前漏了, 两条路径就此漂移。)
      const ext = p.extname(file.fullPath).toLowerCase();
      const fileId = crypto.createHash('sha256')
        .update(projectId + '::' + file.relPath).digest('hex').slice(0, 16);
      try {
        db.prepare(`
          INSERT OR REPLACE INTO cg_files
            (id, project_id, relative_path, language, content_hash, size_bytes, modified_at, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          fileId, projectId, file.relPath, detectLanguage(ext, file.fullPath),
          fileContentHash(file.fullPath), file.stat.size, file.stat.mtimeMs, Date.now(),
        );
      } catch { /* 单个文件登记失败不影响整轮同步 */ }
      skipped++;
    }
  }
  commitTx();

  // 跨文件引用解析
  resolveCrossFileRefs(db, projectId, { quiet: opts.quiet });

  // 更新统计
  const stats = updateProjectStats(db, projectId);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\n${partial ? '⏱ 同步超预算中断' : '✅ 同步完成'}: ${elapsed}s, 变更: ${changed}, 跳过: ${skipped}, 符号: ${stats.nodeCount}, 关系: ${stats.edgeCount}`);
  return { projectId, rootPath, changed, skipped, partial, ...stats, elapsedMs: Date.now() - startTime };
}

/** 重算并写回项目统计。 */
function updateProjectStats(db, projectId) {
  const nodeCount = db.prepare('SELECT COUNT(*) AS c FROM cg_nodes WHERE project_id = ?').get(projectId).c;
  const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM cg_edges WHERE project_id = ?').get(projectId).c;
  const fileCount = db.prepare('SELECT COUNT(*) AS c FROM cg_files WHERE project_id = ?').get(projectId).c;
  db.prepare('UPDATE cg_projects SET indexed_at = ?, file_count = ?, node_count = ?, edge_count = ? WHERE id = ?')
    .run(Date.now(), fileCount, nodeCount, edgeCount, projectId);
  return { fileCount, nodeCount, edgeCount };
}

/**
 * 单文件增量索引 —— 供 PostToolUse 钩子在写入后调用。
 *
 * 全量 sync 要遍历整个项目树; 一次编辑只脏了一个文件, 走这条路径把开销压到
 * 单文件解析 + 一次跨文件引用解析。
 *
 * @param {string} filePath — 被修改的文件绝对路径
 * @param {object} [opts]
 * @param {string} [opts.projectPath] — 项目根, 缺省由 findProjectRoot 推断
 * @param {boolean} [opts.quiet]
 * @returns {{ indexed: boolean, reason?: string, projectId?: string, relPath?: string }}
 */
function cmdSyncFile(filePath, opts = {}) {
  const log = opts.quiet ? () => {} : (msg) => console.error(msg);
  const abs = p.resolve(filePath);
  let stat;
  try { stat = f.statSync(abs); } catch { return { indexed: false, reason: 'missing_file' }; }
  if (!shouldDeepIndex(p.extname(abs), stat)) return { indexed: false, reason: 'not_deep_indexable' };
  if (!shouldIndex(abs, stat)) return { indexed: false, reason: 'excluded' };

  const { findProjectRoot } = require('./lib/project-scope.cjs');
  const projectPath = opts.projectPath || findProjectRoot(p.dirname(abs));
  if (!projectPath) return { indexed: false, reason: 'no_project_root' };

  const { projectId, rootPath } = resolveProject(projectPath);
  if (!abs.toLowerCase().startsWith(rootPath.toLowerCase())) {
    return { indexed: false, reason: 'outside_project' };
  }
  const relPath = p.relative(rootPath, abs).replace(/\\/g, '/');

  const db = openDb().db;
  const result = indexFile(db, abs, projectId, relPath);
  if (!result.changed) return { indexed: false, reason: 'unchanged', projectId, relPath };

  resolveCrossFileRefs(db, projectId, { quiet: true });
  const stats = updateProjectStats(db, projectId);
  log(`✅ 单文件索引: ${relPath} (符号 ${result.nodes || 0}, 关系 ${result.edges || 0})`);
  return { indexed: true, projectId, relPath, ...stats };
}

function cmdStatus(projectPath) {
  const { projectId, rootPath } = resolveProject(projectPath);
  const stats = getProjectStats(projectId);
  if (!stats) {
    console.error('项目未索引');
    return;
  }
  const db = openDb().db;
  const nodeByKind = db.prepare('SELECT kind, COUNT(*) AS c FROM cg_nodes WHERE project_id = ? GROUP BY kind ORDER BY c DESC').all(projectId);

  console.log(JSON.stringify({
    project: stats,
    nodesByKind: nodeByKind.map(r => ({ kind: r.kind, count: r.c })),
    unresolvedRefs: db.prepare('SELECT COUNT(*) AS c FROM cg_unresolved WHERE project_id = ?').get(projectId).c,
  }, null, 2));
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // 解析 --project /path 和 --kind module 等命名参数
  function parseFlags(argsList) {
    const flags = { positional: [] };
    for (let i = 0; i < argsList.length; i++) {
      if (argsList[i].startsWith('--')) {
        const key = argsList[i].slice(2);
        flags[key] = argsList[i + 1] && !argsList[i + 1].startsWith('--') ? argsList[i + 1] : true;
        if (flags[key] !== true) i++;
      } else {
        flags.positional.push(argsList[i]);
      }
    }
    return flags;
  }

  // 旧命令: index (无项目路径) → JSON 索引
  if (cmd === 'index' && !args[1]) {
    cmdIndexLegacy();
    return;
  }

  // 新命令: index /path → SQLite 索引
  if (cmd === 'index' && args[1]) {
    cmdIndexProject(args[1]);
    return;
  }

  // 新命令: sync /path
  if (cmd === 'sync' && args[1]) {
    cmdSyncProject(args[1]);
    return;
  }

  // 新命令: sync-file /path/to/file [--project /root]
  if (cmd === 'sync-file' && args[1]) {
    const flags = parseFlags(args.slice(2));
    const result = cmdSyncFile(args[1], { projectPath: flags.project || undefined });
    if (!result.indexed) console.error(`跳过: ${result.reason}`);
    return;
  }

  // 新命令: status [/path]
  if (cmd === 'status') {
    const projPath = args[1] || process.cwd();
    cmdStatus(projPath);
    return;
  }

  // 新命令: search "query" [--kind type] [--limit N] [--project /path]
  if (cmd === 'search') {
    const flags = parseFlags(args.slice(1));
    const query = flags.positional[0];
    if (!query) { console.error('需要提供查询词'); process.exit(1); }
    const projectPath = flags.project || process.cwd();
    const { projectId } = resolveProject(projectPath);
    const results = searchNodes(query, { projectId, kind: flags.kind, limit: parseInt(flags.limit) || 10 });
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // 新命令: callers "符号名" [--project /path] [--depth N]
  if (cmd === 'callers') {
    const flags = parseFlags(args.slice(1));
    const name = flags.positional[0];
    if (!name) { console.error('需要提供符号名'); process.exit(1); }
    const projectPath = flags.project || process.cwd();
    const { projectId } = resolveProject(projectPath);
    const result = getCallers(projectId, name, { maxDepth: parseInt(flags.depth) || 3 });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // 新命令: callees "符号名" [--project /path] [--depth N]
  if (cmd === 'callees') {
    const flags = parseFlags(args.slice(1));
    const name = flags.positional[0];
    if (!name) { console.error('需要提供符号名'); process.exit(1); }
    const projectPath = flags.project || process.cwd();
    const { projectId } = resolveProject(projectPath);
    const result = getCallees(projectId, name, { maxDepth: parseInt(flags.depth) || 3 });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // 新命令: explore <sym1> [sym2 ...] [--project /path]
  if (cmd === 'explore') {
    const flags = parseFlags(args.slice(1));
    let names = flags.positional;
    if (names.length === 0) { console.error('需要提供至少一个符号名'); process.exit(1); }
    // 如果只有一个参数且包含空格，自动拆分
    if (names.length === 1 && names[0].includes(' ')) {
      names = names[0].split(/\s+/).filter(Boolean);
    }
    const projectPath = flags.project || process.cwd();
    const { projectId } = resolveProject(projectPath);
    const result = getSubgraphByNames(projectId, names, { maxDepth: parseInt(flags.depth) || 1, maxFiles: parseInt(flags.maxFiles) || 8 });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // 旧命令: query "符号名" (JSON 查询)
  if (cmd === 'query') {
    cmdQueryLegacy(args[1]);
    return;
  }

  // ── 帮助 ──
  console.error(`
用法:
  node code-graph-index.cjs index                        # 索引 .claude/ (JSON, 旧)
  node code-graph-index.cjs index /path/to/proj           # 索引项目 (SQLite)
  node code-graph-index.cjs sync /path/to/proj            # 增量同步
  node code-graph-index.cjs sync-file /path/to/file.sv    # 单文件增量索引
  node code-graph-index.cjs status [/path]                # 项目状态
  node code-graph-index.cjs search "查询" [--kind type]   # FTS5 搜索
  node code-graph-index.cjs callers "符号" [--project /p] # 谁调用了它
  node code-graph-index.cjs callees "符号" [--project /p] # 它调用了什么
  node code-graph-index.cjs explore "s1 s2" [--project/p] # 探索符号关系
  node code-graph-index.cjs query "符号名"                # 旧 JSON 查询
`);
}

if (require.main === module) {
  main();
}

module.exports = {
  cmdIndexProject,
  cmdSyncProject,
  cmdSyncFile,
  cmdStatus,
  updateProjectStats,
  indexFile,
  resolveCrossFileRefs,
  walkProject,
  shouldIndex,
  shouldDeepIndex,
  detectLanguage,
  fileContentHash,
};
