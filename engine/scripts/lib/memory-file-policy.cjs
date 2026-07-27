'use strict';

const path = require('node:path');

const MEMORY_INDEX_FILES = new Set(['MEMORY.md', 'MEMORY_RULES.md', 'links.md']);
const TEMPLATE_RE = /template/i;

function slashPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function relativeSlash(rootDir, filePath) {
  if (!rootDir) return slashPath(filePath);
  return slashPath(path.relative(rootDir, filePath));
}

function hasSegment(relPath, segment) {
  return slashPath(relPath).split('/').includes(segment);
}

function hasIgnoredSegment(relPath) {
  return slashPath(relPath).split('/').some(part => part.startsWith('.') || part === '__pycache__');
}

function isMarkdown(filePath) {
  return String(filePath || '').toLowerCase().endsWith('.md');
}

function isMemoryIndexFile(filePath) {
  return MEMORY_INDEX_FILES.has(path.basename(filePath || ''));
}

function isMemoryWorkFile(filePath, opts = {}) {
  const rel = opts.memoryDir ? relativeSlash(opts.memoryDir, filePath) : slashPath(filePath);
  return rel.split('/')[0] === 'work';
}

function isAutoWorkRecord(filePath) {
  return /tool_success_|tool_error_|auto-record/i.test(path.basename(filePath || ''));
}

function shouldMigrateMemoryFile(filePath, opts = {}) {
  if (!isMarkdown(filePath)) return false;
  if (hasIgnoredSegment(opts.memoryDir ? relativeSlash(opts.memoryDir, filePath) : slashPath(filePath))) return false;
  if (isMemoryIndexFile(filePath)) return false;
  if (isMemoryWorkFile(filePath, opts)) return false;
  const rel = opts.memoryDir ? relativeSlash(opts.memoryDir, filePath) : slashPath(filePath);
  if (rel.split('/')[0] === 'archive') return false;
  return true;
}

function shouldSyncMemoryFile(filePath, opts = {}) {
  return shouldMigrateMemoryFile(filePath, opts) && !isAutoWorkRecord(filePath);
}

function shouldIndexMemoryFile(filePath, opts = {}) {
  return shouldSyncMemoryFile(filePath, opts);
}

function shouldIndexKnowledgeFile(filePath, opts = {}) {
  if (!isMarkdown(filePath)) return false;
  const kbDir = opts.knowledgeDir || (opts.home ? path.join(opts.home, 'engineering-assets', 'knowledge') : null);
  const rel = kbDir ? relativeSlash(kbDir, filePath) : slashPath(filePath);
  if (hasIgnoredSegment(rel)) return false;
  if (hasSegment(rel, 'examples')) return false;
  if (rel.startsWith('docs/templates/')) return false;
  if (rel.startsWith('archive/sources/')) return false;
  if (rel.startsWith('archive/maintenance/')) return false;
  return true;
}

function shouldIndexSemanticFile(filePath, opts = {}) {
  const home = opts.home;
  const memoryDir = opts.memoryDir || (home ? path.join(home, 'memory') : null);
  const knowledgeDir = opts.knowledgeDir || (home ? path.join(home, 'engineering-assets', 'knowledge') : null);
  const abs = path.resolve(filePath);

  if (memoryDir) {
    const memAbs = path.resolve(memoryDir);
    if (abs === memAbs || abs.startsWith(memAbs + path.sep)) {
      return shouldIndexMemoryFile(abs, { memoryDir: memAbs });
    }
  }

  if (knowledgeDir) {
    const kbAbs = path.resolve(knowledgeDir);
    if (abs === kbAbs || abs.startsWith(kbAbs + path.sep)) {
      return shouldIndexKnowledgeFile(abs, { knowledgeDir: kbAbs });
    }
  }

  return isMarkdown(filePath) && !TEMPLATE_RE.test(path.basename(filePath || ''));
}

module.exports = {
  slashPath,
  relativeSlash,
  isMemoryWorkFile,
  isAutoWorkRecord,
  shouldMigrateMemoryFile,
  shouldSyncMemoryFile,
  shouldIndexMemoryFile,
  shouldIndexKnowledgeFile,
  shouldIndexSemanticFile,
};
