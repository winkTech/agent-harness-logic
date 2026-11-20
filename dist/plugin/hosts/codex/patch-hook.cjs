'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { envOf } = require('../../core/engine/scripts/io/env.cjs');

function patchInputs(payload) {
  if (payload.tool_name !== 'apply_patch') return [payload];
  const files = [];
  let file;
  let hunk;
  for (const line of String(payload.tool_input?.command || '').split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      file = { kind: header[1], name: header[2], added: [], hunks: [] };
      files.push(file);
      hunk = null;
    } else if (file && line.startsWith('*** Move to: ')) {
      file.destination = line.slice('*** Move to: '.length);
    } else if (file && line.startsWith('@@')) {
      hunk = { before: [], after: [] };
      file.hunks.push(hunk);
    } else if (file && /^[ +\-]/.test(line)) {
      if (file.kind === 'Add') file.added.push(line.slice(1));
      else {
        if (!hunk) { hunk = { before: [], after: [] }; file.hunks.push(hunk); }
        if (line[0] !== '+') hunk.before.push(line.slice(1));
        if (line[0] !== '-') hunk.after.push(line.slice(1));
      }
    }
  }
  if (!files.length) throw new Error('Cannot identify files in apply_patch input');
  return files.flatMap(file => {
    const edits = file.hunks.map(h => ({ old_string: h.before.join('\n'), new_string: h.after.join('\n') }));
    const input = file.kind === 'Add' ? { content: file.added.join('\n') + '\n' } : { edits };
    const make = (name, tool_name, body) => ({ ...payload, tool_name, tool_input: {
      ...body, file_path: path.resolve(payload.cwd || process.cwd(), name),
    } });
    const source = make(file.name, file.kind === 'Add' ? 'Write' : 'Edit', input);
    if (!file.destination) return [source];
    return [source, make(file.destination, 'Write', input)];
  });
}

function persistenceEnabled() {
  const { noPersist, noDiagnosticWrites, verifyReadonly } = envOf();
  return !noPersist && !noDiagnosticWrites && !verifyReadonly;
}

function context(payload) {
  const { combinePromptContext } = require('../../core/engine/scripts/hooks/prompt-context.cjs');
  const { retrieveContext } = require('../../core/engine/scripts/rule-loader.cjs');
  const edits = payload.tool_name === 'apply_patch' ? patchInputs(payload) : [];
  const openFiles = edits.map((event) => event.tool_input.file_path);
  const output = combinePromptContext(edits[0] || payload, {
    ruleContext: () => retrieveContext(payload, { openFiles }),
    promptObserver: (event) => {
      if (event.hook_event_name === 'UserPromptSubmit' && persistenceEnabled()) {
        require('../../core/engine/hooks/learning/postflight-observer.cjs').handlePayload(event);
      }
    },
  });
  if (output) process.stdout.write(JSON.stringify(output));
}

function observe(payload) {
  if (!persistenceEnabled()) return;
  const { handlePayload } = require('../../core/engine/hooks/learning/postflight-observer.cjs');
  const response = payload.tool_response;
  const status = response?.metadata?.exit_code ?? response?.exit_code;
  const failed = response?.is_error === true || payload.status === 'failed' || (status != null && Number(status) !== 0);
  const post = {
    ...payload,
    hook_event_name: failed ? 'PostToolUseFailure' : payload.hook_event_name,
    tool_response: status == null ? response : { ...response, exit_code: Number(status) },
  };
  if (payload.tool_name !== 'apply_patch' || failed) {
    handlePayload(post);
    return;
  }
  const edits = patchInputs(post);
  handlePayload(edits[0]);
  const { runFileSync } = require('../../core/engine/scripts/hooks/codegraph-sync.cjs');
  for (const edit of edits) runFileSync(edit, { removeMissing: true });
}

function main() {
  const mode = process.argv[2];
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (mode === 'context' || mode === 'observe') return;
    throw error;
  }
  if (mode === 'context') {
    try { context(payload); } catch (error) { console.error('[codex context] ' + error.message); }
    return;
  }
  if (mode === 'observe') {
    try { observe(payload); } catch (error) { console.error('[codex observer] ' + error.message); }
    return;
  }
  const guards = mode === 'protect' ? [require('../../core/engine/scripts/hooks/file-protection-guard.cjs')]
    : mode === 'write' ? [require('../../core/engine/scripts/hooks/hdl-gate.cjs'),
      require('../../core/engine/scripts/hooks/requirements-gate-guard.cjs'),
      require('../../core/engine/scripts/hooks/verification-quality-guard.cjs')]
    : [require('../../core/engine/scripts/hooks/verification-gate.cjs')];
  const response = payload.tool_response;
  if (mode === 'verify' && response) {
    const code = response.metadata?.exit_code ?? response.exit_code;
    if (payload.tool_name === 'apply_patch' && (response.is_error || (code != null && Number(code) !== 0))) return;
    if (payload.tool_name === 'Bash' && code != null) payload.tool_response = { ...response, exit_code: code };
  }
  for (const event of patchInputs(payload)) {
    for (const guard of guards) {
      const outcome = guard.evaluate(event);
      for (const diagnostic of outcome.diagnostics || []) console.error(diagnostic.message || diagnostic);
      if (outcome.decision === 'block') { process.exitCode = 2; return; }
      outcome.commit?.();
    }
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
module.exports = { patchInputs };
