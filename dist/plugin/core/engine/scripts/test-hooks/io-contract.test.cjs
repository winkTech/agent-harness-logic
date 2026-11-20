#!/usr/bin/env node
'use strict';

/**
 * core/engine/scripts/test-hooks/io-contract.test.cjs — io/ 三通道合同测试
 *
 * Phase 2.2 验收条款：新增 12+ 条 io 合同测试。
 * 覆盖：
 *   1. normalizePayload：BOM 剥离 / 四形态 tool_input 探测 / 非法输入 fail-closed
 *   2. emitInject：hookSpecificOutput.additionalContext 协议形态
 *   3. emitTelemetry：单行 JSON + 自动 timestamp
 *   4. transcript-source：显式路径 / session_dir / sessionId DFS / cwd 近期回退
 *      / 限时预算 / 找不到返回空串
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const io = require('../io/index.cjs');
const { resolveTranscriptPath } = require('../io/transcript-source.cjs');

// ── normalizePayload ────────────────────────────────────────────────────────

test('normalizePayload: BOM 剥离后可解析', () => {
  const bom = `\uFEFF${JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })}`;
  const r = io.normalizePayload(bom);
  assert.equal(r.ok, true);
  assert.equal(r.toolName, 'Bash');
  assert.deepEqual(r.toolInput, { command: 'ls' });
});

test('normalizePayload: tool_input 四形态探测——tool_input', () => {
  const r = io.normalizePayload({ tool_name: 'Edit', tool_input: { file_path: 'a' } });
  assert.deepEqual(r.toolInput, { file_path: 'a' });
});

test('normalizePayload: tool_input 四形态探测——tool.input', () => {
  const r = io.normalizePayload({ tool_name: 'Edit', tool: { name: 'Edit', input: { file_path: 'b' } } });
  assert.deepEqual(r.toolInput, { file_path: 'b' });
});

test('normalizePayload: tool_input 四形态探测——input', () => {
  const r = io.normalizePayload({ tool_name: 'Edit', input: { file_path: 'c' } });
  assert.deepEqual(r.toolInput, { file_path: 'c' });
});

test('normalizePayload: tool_input 四形态探测——arguments', () => {
  const r = io.normalizePayload({ tool_name: 'Edit', arguments: { file_path: 'd' } });
  assert.deepEqual(r.toolInput, { file_path: 'd' });
});

test('normalizePayload: 非法 JSON fail-closed', () => {
  const r = io.normalizePayload('not json {');
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid JSON/);
});

test('normalizePayload: 非对象（数组/数字/null）fail-closed', () => {
  assert.equal(io.normalizePayload([1, 2]).ok, false);
  assert.equal(io.normalizePayload(42).ok, false);
  assert.equal(io.normalizePayload(null).ok, false);
});

test('normalizePayload: toolInput 缺席/非对象归一为空对象', () => {
  assert.deepEqual(io.normalizePayload({ tool_name: 'Read' }).toolInput, {});
  assert.deepEqual(io.normalizePayload({ tool_name: 'X', tool_input: 'string' }).toolInput, {});
});

test('normalizePayload: 对象输入直通（不重复解析）', () => {
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
  const r = io.normalizePayload(payload);
  assert.equal(r.ok, true);
  assert.equal(r.payload, payload);
});

// ── emitInject / emitTelemetry ─────────────────────────────────────────────

test('emitInject: hookSpecificOutput.additionalContext 协议形态', () => {
  const out = io.emitInject('hello context');
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'hello context');
  assert.ok(out.endsWith('\n'));
});

test('emitTelemetry: 单行 JSON + 自动 timestamp', () => {
  const line = io.emitTelemetry({ kind: 'upgrade', riskLevel: 'R2' });
  assert.equal(line.includes('\n'), true);
  assert.equal(line.trim().split('\n').length, 1);
  const parsed = JSON.parse(line);
  assert.equal(parsed.kind, 'upgrade');
  assert.ok(parsed.timestamp);
});

test('emitTelemetry: 保留显式 timestamp（幂等）', () => {
  const line = io.emitTelemetry({ timestamp: '2026-01-01T00:00:00Z' });
  assert.equal(JSON.parse(line).timestamp, '2026-01-01T00:00:00Z');
});

test('emitTelemetry: 非对象入参退化为 { event: String }', () => {
  assert.equal(JSON.parse(io.emitTelemetry('oops')).event, 'oops');
});

// ── transcript-source ───────────────────────────────────────────────────────

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'io-transcript-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('transcript: 显式 transcript_path 存在即返回', (t) => {
  const home = makeHome(t);
  const file = path.join(home, 't.jsonl');
  fs.writeFileSync(file, '{}\n');
  assert.equal(resolveTranscriptPath({ transcript_path: file }, { home }), file);
});

test('transcript: session_dir 三候选文件名', (t) => {
  const home = makeHome(t);
  const dir = path.join(home, 'sess');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'conversation.jsonl'), '{}\n');
  assert.equal(resolveTranscriptPath({ session_dir: dir }, { home }),
    path.join(dir, 'conversation.jsonl'));
});

test('transcript: sessionId DFS 命中 projects 深层', (t) => {
  const home = makeHome(t);
  const deep = path.join(home, 'projects', 'proj-a', 'sub');
  fs.mkdirSync(deep, { recursive: true });
  const file = path.join(deep, 'S-42.jsonl');
  fs.writeFileSync(file, '{}\n');
  assert.equal(resolveTranscriptPath({ session_id: 'S-42' }, { home }), file);
});

test('transcript: sessionId 大小写不敏感匹配', (t) => {
  const home = makeHome(t);
  const dir = path.join(home, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abc123.jsonl'), '{}\n');
  assert.equal(resolveTranscriptPath({ session_id: 'ABC123' }, { home }),
    path.join(dir, 'abc123.jsonl'));
});

test('transcript: cwd 近期回退（allowRecentFallback）2 分钟窗口', (t) => {
  const home = makeHome(t);
  const cwd = 'C:/work/proj';
  const slug = 'C--work-proj';
  const dir = path.join(home, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const fresh = path.join(dir, 'fresh.jsonl');
  fs.writeFileSync(fresh, '{}\n'); // mtime = now
  const found = resolveTranscriptPath(
    { cwd },
    { home, allowRecentFallback: true },
  );
  assert.equal(found, fresh);
});

test('transcript: 近期回退默认关闭（ledger 语义）', (t) => {
  const home = makeHome(t);
  const dir = path.join(home, 'projects', 'C--work-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fresh.jsonl'), '{}\n');
  const found = resolveTranscriptPath({ cwd: 'C:/work/proj' }, { home });
  assert.equal(found, '');
});

test('transcript: 找不到返回空串（不抛错）', (t) => {
  const home = makeHome(t);
  assert.equal(resolveTranscriptPath({ session_id: 'nope' }, { home }), '');
});

test('transcript: env CLAUDE_TRANSCRIPT_PATH 显式声明优先', (t) => {
  const home = makeHome(t);
  const file = path.join(home, 'env.jsonl');
  fs.writeFileSync(file, '{}\n');
  const prev = process.env.CLAUDE_TRANSCRIPT_PATH;
  process.env.CLAUDE_TRANSCRIPT_PATH = file;
  try {
    assert.equal(resolveTranscriptPath({}, { home }), file);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_TRANSCRIPT_PATH;
    else process.env.CLAUDE_TRANSCRIPT_PATH = prev;
  }
});
