#!/usr/bin/env node
'use strict';

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTROLLED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'Agent', 'Task', 'Workflow']);
const MAX_TAIL_BYTES = 1024 * 1024;
const CLAUDE_HOME = HARNESS_ROOT;

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw.replace(/^\uFEFF/, '')));
  });
}

function parsePayload(raw) {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toolNameFrom(payload) {
  if (typeof payload?.tool === 'string') return payload.tool;
  return payload?.tool?.name || payload?.tool_name || payload?.name || '';
}

function resolveTranscriptPath(payload) {
  const explicit = payload?.transcript_path
    || payload?.transcriptPath
    || payload?.conversation?.transcript_path
    || payload?.session?.transcript_path
    || process.env.CLAUDE_TRANSCRIPT_PATH
    || '';
  if (explicit && fs.existsSync(explicit)) return explicit;

  const sessionDir = payload?.session_dir || process.env.CLAUDE_SESSION_DIR || '';
  if (sessionDir && fs.existsSync(sessionDir)) {
    for (const name of ['transcript.jsonl', 'conversation.jsonl', 'messages.jsonl']) {
      const candidate = path.join(sessionDir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const sessionId = payload?.session_id || payload?.sessionId || process.env.CLAUDE_SESSION_ID || '';
  if (sessionId) {
    const found = findClaudeProjectTranscript(sessionId);
    if (found) return found;
  }

  const recent = findRecentProjectTranscript(payload?.cwd || process.cwd());
  if (recent) return recent;

  return '';
}

function findClaudeProjectTranscript(sessionId) {
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  if (!fs.existsSync(projectsDir)) return '';
  const expected = `${sessionId}.jsonl`.toLowerCase();
  const stack = [projectsDir];
  const deadline = Date.now() + 500;

  while (stack.length > 0 && Date.now() < deadline) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === expected) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return '';
}

function projectSlugForCwd(cwd) {
  if (!cwd) return '';
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function findRecentProjectTranscript(cwd, maxAgeMs = 2 * 60 * 1000) {
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  const slug = projectSlugForCwd(cwd);
  if (!slug) return '';

  const preferredDir = path.join(projectsDir, slug);
  const roots = fs.existsSync(preferredDir) ? [preferredDir] : [];
  if (roots.length === 0) return '';

  const now = Date.now();
  const candidates = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(root, entry.name);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs <= maxAgeMs) {
        candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path || '';
}

function readTail(filePath) {
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

function parseJsonLines(lines) {
  const events = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      events.push({ line: idx + 1, event: JSON.parse(line) });
    } catch {
      // Partial or non-JSON lines are ignored in the tail reader.
    }
  }
  return events;
}

function messageParts(event) {
  return event?.message && Array.isArray(event.message.content) ? event.message.content : [];
}

function textFrom(parts) {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n');
}

function latestAssistantText(events) {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx].event;
    const parts = messageParts(event);
    if (event?.type !== 'assistant' && event?.message?.role !== 'assistant') continue;
    if (parts.length === 0) continue;

    const hasToolUse = parts.some((part) => part.type === 'tool_use');
    const text = textFrom(parts);
    if (text.trim()) return { line: events[idx].line, text };
    if (hasToolUse) {
      return {
        line: events[idx].line,
        text: '',
        staleReason: 'an assistant tool use occurred after the last visible checklist',
      };
    }
  }
  return { line: 0, text: '', staleReason: 'no assistant visible text found in transcript tail' };
}

function checklistStatus(text) {
  const checks = [
    ['action', /\u884c\u52a8\s*:/],
    ['userInstruction', /\u7528\u6237\u6307\u4ee4\s*:/],
    ['match', /\u5339\u914d\s*:/],
    ['gate', /\u95e8\u7981\s*:/],
    ['requirementsGate', /\u9700\u6c42\u6f84\u6e05\s*\[/],
    ['verificationGate', /\u9a8c\u8bc1\u8d28\u91cf\s*\[/],
  ];
  const missing = checks.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
  return { ok: missing.length === 0, missing };
}

function block(reason, details = {}) {
  console.error('');
  console.error('VISIBLE CHECKLIST GATE BLOCKED');
  console.error(reason);
  if (details.toolName) console.error(`tool: ${details.toolName}`);
  if (details.transcriptPath) console.error(`transcript: ${details.transcriptPath}`);
  if (details.line) console.error(`transcript line: ${details.line}`);
  if (details.missing?.length) console.error(`missing: ${details.missing.join(', ')}`);
  console.error('');
  console.error('Before every Bash/Edit/Write/Agent/Workflow tool use, output exactly:');
  console.error('行动: [要做什么]');
  console.error('用户指令: "[原文中的哪一句]"');
  console.error('匹配: ✅ / ⚠️');
  console.error('门禁: 🚦需求澄清[ ✅ / ❌ ] 🧪验证质量[ ✅ / ❌ / N/A ]');
  console.error('');
}

function strictMode() {
  const mode = String(process.env.CLAUDE_VISIBLE_CHECKLIST_GATE_MODE || 'audit').toLowerCase();
  return mode === 'strict' || mode === 'block' || process.env.CLAUDE_VISIBLE_CHECKLIST_GATE_STRICT === '1';
}

function requiredBlockLines() {
  return [
    '\u884c\u52a8: [\u8981\u505a\u4ec0\u4e48]',
    '\u7528\u6237\u6307\u4ee4: "[\u539f\u6587\u4e2d\u7684\u54ea\u4e00\u53e5]"',
    '\u5339\u914d: \u2705 / \u26a0\ufe0f',
    '\u95e8\u7981: \ud83d\udea6\u9700\u6c42\u6f84\u6e05[ \u2705 / \u274c ] \ud83e\uddea\u9a8c\u8bc1\u8d28\u91cf[ \u2705 / \u274c / N/A ]',
  ];
}

function warn(reason, details = {}) {
  console.error('');
  console.error('VISIBLE CHECKLIST GATE WARNING');
  console.error(reason);
  if (details.toolName) console.error(`tool: ${details.toolName}`);
  if (details.transcriptPath) console.error(`transcript: ${details.transcriptPath}`);
  if (details.line) console.error(`transcript line: ${details.line}`);
  if (details.missing?.length) console.error(`missing: ${details.missing.join(', ')}`);
  console.error('');
  console.error('Required visible block:');
  for (const line of requiredBlockLines()) console.error(line);
  console.error('');
  console.error('Audit mode does not block because Claude Code PreToolUse cannot reliably see same-turn visible text before transcript flush.');
  console.error('Set CLAUDE_VISIBLE_CHECKLIST_GATE_MODE=strict to restore hard blocking.');
  console.error('');
}

function finishViolation(reason, details = {}) {
  if (strictMode()) {
    block(reason, details);
    process.exit(2);
  }
  warn(reason, details);
  process.exit(0);
}

async function main() {
  if (process.env.CLAUDE_SKIP_HOOK === '1' || process.env.CLAUDE_VISIBLE_CHECKLIST_GATE_DISABLED === '1') {
    process.exit(0);
  }

  const payload = parsePayload(await readStdin());
  const toolName = toolNameFrom(payload);
  if (!CONTROLLED_TOOLS.has(toolName)) process.exit(0);

  const transcriptPath = resolveTranscriptPath(payload);
  if (!transcriptPath) {
    finishViolation('Controlled tool use cannot be verified because no transcript_path was available.', { toolName });
  }

  let events;
  try {
    events = parseJsonLines(readTail(transcriptPath));
  } catch (error) {
    finishViolation(`Controlled tool use cannot be verified because transcript could not be read: ${error.message}`, {
      toolName,
      transcriptPath,
    });
  }

  const latest = latestAssistantText(events);
  const status = checklistStatus(latest.text || '');
  if (!status.ok) {
    finishViolation(latest.staleReason || 'Latest visible assistant text lacks the required checklist.', {
      toolName,
      transcriptPath,
      line: latest.line,
      missing: status.missing,
    });
  }

  process.exit(0);
}

main();

module.exports = {
  CONTROLLED_TOOLS,
  checklistStatus,
  latestAssistantText,
  parseJsonLines,
  requiredBlockLines,
  resolveTranscriptPath,
  strictMode,
};
