'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isToolchainCommand } = require(path.join(process.env.HARNESS_ROOT, 'core/engine/scripts/lib/toolchain-health.cjs'));

// Native JSONL records are appended in step_index order. Start at EOF, so a
// recent result costs one small read. Reassemble long UTF-8 lines before decoding.
function* newestLines(fd, sizeAtOpen) {
  let offset = sizeAtOpen;
  let pieces = [];
  while (offset > 0) {
    const size = Math.min(offset, 16384);
    offset -= size;
    const block = Buffer.allocUnsafe(size);
    if (fs.readSync(fd, block, 0, size, offset) !== size) return; // rotated/truncated during read
    let end = size;
    while (end > 0) {
      const newline = block.lastIndexOf(10, end - 1);
      const start = newline + 1;
      if (start < end) pieces.push(block.subarray(start, end));
      if (newline < 0) break;
      if (pieces.length) {
        yield (pieces.length === 1 ? pieces[0] : Buffer.concat(pieces.reverse())).toString('utf8');
        pieces = [];
      }
      end = newline;
    }
  }
  if (pieces.length) yield Buffer.concat(pieces.reverse()).toString('utf8').replace(/^\uFEFF/, '');
}

function stamp(stat) {
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('/');
}

function changedSince(snapshot) {
  if (!snapshot?.length) return true;
  return snapshot.some(([file, previous]) => {
    try { return stamp(fs.statSync(file, { bigint: true })) !== previous; }
    catch (error) { return error.code !== 'ENOENT' || previous !== null; }
  });
}

function* newestRows(file, snapshot, needle) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    snapshot.push([file, stamp(stat)]);
    for (const line of newestLines(fd, Number(stat.size))) {
      if (needle && !line.includes(needle)) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // host may still be appending
      if (Number.isInteger(row?.step_index)) yield row;
    }
  } catch (error) {
    if (error.code === 'ENOENT') snapshot.push([file, null]);
  }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readStep(file, index, snapshot, following) {
  for (const row of newestRows(file, snapshot)) {
    if (row.step_index === index) return row;
    if (row.step_index < index) break;
    if (following && row.type === 'GENERIC') {
      following.set(row.step_index, row);
      if (following.size > 64) following.delete(following.keys().next().value);
    }
  }
  return null;
}

function commandRow(file, step, payload, snapshot) {
  const following = new Map();
  const row = readStep(file, step, snapshot, following);
  if (row?.type === 'GENERIC') return row;
  if (row?.type !== 'PLANNER_RESPONSE' || !Array.isArray(row.tool_calls)) return null;
  const calls = row.tool_calls.map((call, offset) => ({ call, offset }))
    .filter(({ call }) => call?.name === 'run_command');
  const id = payload.tool_use_id;
  const byId = id ? calls.filter(({ call }) => (call.id || call.tool_use_id) === id) : [];
  const command = payload.tool_input?.command;
  const matches = byId.length ? byId : calls.filter(({ call }) => {
    if (typeof command !== 'string' || (id && (call.id || call.tool_use_id))) return false;
    const text = call.args?.CommandLine ?? call.args?.command;
    if (text === command) return true;
    if (typeof text !== 'string' || !text.startsWith('"')) return false;
    try { return JSON.parse(text) === command; } catch { return false; }
  });
  if (matches.length !== 1) return null;
  const target = step + matches[0].offset + 1;
  const result = following.get(target) || readStep(file, target, snapshot);
  return result?.type === 'GENERIC' ? result : null;
}

// Only omit stdout for known ordinary commands. Unknown scripts, shell chains
// and toolchain diagnostics retain full evidence, including custom verifiers.
function needsOutput(command) {
  const text = String(command || '').trim();
  if (isToolchainCommand(text)) return true;
  if (/^(?:git\s+status(?:\s+(?:-s|-sb|--short|--branch|--porcelain(?:=v[12])?))*|git\s+rev-parse\s+HEAD|git\s+log\s+-1|pwd|whoami)$/i.test(text)) return false;
  return !/^(?:ls|dir|rg|grep|cat|echo|Get-Content)(?:[ \t]+[\w./:\\ *?=-]+)?$/i.test(text);
}

function exitCode(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+$/.test(value))) return null;
  const code = Number(value);
  return Number.isSafeInteger(code) ? code : null;
}

// A zero from another representation cannot erase an explicit failure.
function mergeExitCode(first, second) {
  if (first != null && first !== 0) return first;
  return second ?? first;
}

function envelope(row) {
  const text = typeof row?.content === 'string' ? row.content : '';
  const output = /^Command output:[ \t]*\r?(?:\n|$)/m.exec(text);
  const header = output ? text.slice(0, output.index) : text;
  const running = /^Tool is running as a background task with task id:[ \t]*(\S+)?/im.exec(header);
  if (row?.status === 'RUNNING' || running) return { kind: 'running', taskId: running?.[1] };
  if (['INVALID', 'ERROR', 'FAILED', 'CANCELED', 'CANCELLED'].includes(row?.status)) {
    return { kind: 'failed', response: { stderr: text }, error: text || row.status };
  }
  const marker = /^Command exited with code (-?\d+)\.[ \t]*\r?$/m.exec(header);
  const code = exitCode(marker?.[1]);
  if (code === null) return { kind: 'unknown' };
  const noOutput = /^No output from the command\.[ \t]*\r?$/m.test(header);
  return { kind: 'done', code, stdout: output ? text.slice(output.index + output[0].length) : noOutput ? '' : undefined };
}

function taskMessage(row, id) {
  if (row?.type !== 'SYSTEM_MESSAGE' || (row.source && row.source !== 'SYSTEM') ||
      (row.status && row.status !== 'DONE')) return null;
  const text = String(row.content || '').replace(/^(?:The following is a <SYSTEM_MESSAGE>[^\r\n]*\r?\n\s*)?<SYSTEM_MESSAGE>\r?\n/, '');
  // A task may print another task's completion text in its stdout. Only the
  // outer system envelope establishes ownership, including the native sender.
  const header = /^(?:\[Message\][ \t]+timestamp=\S+[ \t]+sender=(\S+)[ \t]+priority=\S+[ \t]+content=)?Task id "([^"\r\n]+)" finished with result:[ \t]*\r?\n/.exec(text);
  if (!header || header[2] !== id || (header[1] && header[1] !== id)) return null;
  const content = text.slice(header.index + header[0].length).trimStart()
    .replace(/\r?\n(?:\r?\nLog: file:\/\/[^\r\n]+\r?\n)?<\/SYSTEM_MESSAGE>\s*$/, '');
  const preview = row.truncated_fields?.includes('content') ||
    content.startsWith("The tool's output was truncated");
  return { parsed: envelope({ content }), preview };
}

function findTaskMessage(file, step, id, snapshot) {
  for (const row of newestRows(file, snapshot)) {
    if (row.step_index <= step) break;
    const message = taskMessage(row, id);
    if (message) return message;
  }
  return null;
}

function readTaskLog(file, taskId, snapshot) {
  const name = taskId.split('/').pop();
  if (!/^task-\d+$/.test(name) || path.basename(path.dirname(file)) !== 'logs') return;
  const log = path.join(path.dirname(file), '..', 'tasks', name + '.log');
  let fd;
  try {
    fd = fs.openSync(log, 'r');
    snapshot.push([log, stamp(fs.fstatSync(fd, { bigint:true }))]);
    return fs.readFileSync(fd, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') snapshot.push([log, null]);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function backgroundCompletion(file, row, id, ordinary, snapshot) {
  const compact = findTaskMessage(file, row.step_index, id, snapshot);
  let message = compact;
  if (!compact || compact.parsed.kind !== 'done' || (compact.preview && !(ordinary && compact.parsed.code === 0))) {
    const full = findTaskMessage(path.join(path.dirname(file), 'transcript_full.jsonl'), row.step_index, id, snapshot);
    if (full?.parsed.kind === 'done') message = full;
  }
  if (message?.parsed.kind !== 'done') return null;
  const code = mergeExitCode(compact?.parsed.code, message.parsed.code);
  const { stdout } = message.parsed;
  if (ordinary && code === 0) return { code };
  if (!message.preview && stdout !== undefined) return { code, stdout };
  const body = readTaskLog(file, id, snapshot);
  if (body === undefined && code === 0) return null;
  return { code, stdout: body ?? stdout };
}

function resolveCommand(payload, file, step, snapshot = []) {
  const input = typeof payload.tool_response === 'string' ? { stdout: payload.tool_response } : payload.tool_response;
  const inlineCode = exitCode(input?.exit_code ?? input?.exitCode ?? input?.status);
  const background = input?.backgroundRunning === true || /^(running|background)$/i.test(input?.status || '');
  // Running inline metadata describes the original notification only. On a later
  // hook the same result step may have acquired a terminal record.
  if (background && !file) return { kind: 'running' };
  if (input?.interrupted || input?.signal || input?.error || /^(failed|error|invalid|cancelled|canceled)$/i.test(input?.status || '')) {
    return { kind: 'failed', response: input, error: input.stderr || input.error || 'Command ' + (input.signal || input.status || 'interrupted') };
  }
  const partial = input?.truncated || input?.truncated_fields?.includes('stdout');
  const hasBody = typeof input?.stdout === 'string' && !partial;
  const ordinary = !needsOutput(payload.tool_input?.command);
  function completed(code, stdout) {
    const response = { ...(input && typeof input === 'object' ? input : {}), exit_code: code, status: code };
    if (stdout !== undefined) response.stdout = stdout;
    const error = code !== 0 && (response.stderr || response.stdout);
    return { kind: code === 0 ? 'done' : 'failed', response, error: error ? String(error).slice(0, 1000) : undefined };
  }
  if (!background && inlineCode !== null && (hasBody || (ordinary && inlineCode === 0) || (!file && !partial))) {
    return completed(inlineCode);
  }
  const row = file && Number.isInteger(step) ? commandRow(file, step, payload, snapshot) : null;
  let parsed = envelope(row);
  if (parsed.kind === 'failed') return parsed;
  if (parsed.kind === 'running') {
    const terminal = parsed.taskId && backgroundCompletion(file, row, parsed.taskId, ordinary, snapshot);
    if (terminal) return completed(mergeExitCode(background ? null : inlineCode, terminal.code), terminal.stdout);
    return inlineCode !== null && !background ? completed(inlineCode) : parsed;
  }
  const terminalInline = background ? null : inlineCode;
  const code = mergeExitCode(terminalInline, parsed.code);
  const wantBody = !hasBody && (code !== 0 || !ordinary);
  if (row?.truncated_fields?.includes('content') && (parsed.kind === 'unknown' || wantBody)) {
    const full = readStep(path.join(path.dirname(file), 'transcript_full.jsonl'), row.step_index, snapshot);
    if (full?.type === 'GENERIC' && !full.truncated_fields?.includes('content')) {
      const detailed = envelope(full);
      if (detailed.kind === 'failed') return detailed;
      if (detailed.kind === 'done') parsed = detailed;
      else if (code == null || code === 0) return detailed;
    } else if (code === 0 && wantBody) {
      return { kind: 'unknown' }; // incomplete output cannot discharge verification
    }
  }
  const finalCode = mergeExitCode(code, parsed.code);
  if (finalCode == null) return { kind: background ? 'running' : 'unknown' };
  if (finalCode === 0 && !ordinary && parsed.stdout === undefined && !hasBody && (file || partial)) return { kind: 'unknown' };
  return completed(finalCode, !hasBody && (finalCode !== 0 || !ordinary) ? parsed.stdout : undefined);
}

function lastUserStep(file, upperBound) {
  for (const row of newestRows(file, [], '"USER_INPUT"')) {
    if (row.type === 'USER_INPUT' && (!row.source || row.source === 'USER_EXPLICIT') &&
        (!Number.isInteger(upperBound) || row.step_index <= upperBound)) return row.step_index;
  }
}

module.exports = { changedSince, lastUserStep, resolveCommand };
