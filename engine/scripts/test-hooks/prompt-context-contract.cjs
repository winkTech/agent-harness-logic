#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HARNESS_ROOT } = require('../lib/harness-root.cjs');

const routerPath = path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'prompt-context.cjs');
const ruleLoaderPath = path.join(HARNESS_ROOT, 'engine', 'scripts', 'rule-loader.cjs');
const memoryHookPath = path.join(HARNESS_ROOT, 'engine', 'scripts', 'memory-retrieve-hook.cjs');
const frustrationPath = path.join(HARNESS_ROOT, 'engine', 'scripts', 'hooks', 'frustration-detector.cjs');

function promptPayload() {
  return {
    hook_event_name: 'UserPromptSubmit',
    prompt: '请审计 harness memory hook。',
    cwd: HARNESS_ROOT,
    session_id: 'prompt-context-contract',
  };
}

function context(text) {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  };
}

function assertSingleParseAndMergedOutput() {
  const router = require(routerPath);
  let reads = 0;
  let ruleCalls = 0;
  let memoryCalls = 0;
  let frustrationCalls = 0;
  let observerCalls = 0;
  let stdout = '';
  let routedPayload = null;
  const payload = promptPayload();

  router.main({
    readStdinRaw() {
      reads += 1;
      return JSON.stringify(payload);
    },
    ruleContext(input) {
      ruleCalls += 1;
      routedPayload = input;
      assert.deepEqual(input, payload, 'router must parse the complete payload');
      return context('[rule-loader] Harness rule capsule:\n[ L1 ] docs/rules/05-harness.md');
    },
    memoryContext(input) {
      memoryCalls += 1;
      assert.equal(input, routedPayload, 'memory retrieval must reuse the single parsed payload object');
      return context('[memory] prior evidence [source=test; key=memory/provenance]');
    },
    frustrationContext(input) {
      frustrationCalls += 1;
      assert.equal(input, routedPayload, 'frustration detection must reuse the single parsed payload object');
      return context('[frustration-detector] 【强制模式切换】切换到 根因分析 模式。');
    },
    promptObserver(input) {
      observerCalls += 1;
      assert.equal(input, routedPayload, 'prompt observer must reuse the single parsed payload object');
      return { ok: true, actions: [] };
    },
    writeStdout(value) { stdout += value; },
  });

  assert.equal(reads, 1, 'UserPromptSubmit stdin must be read exactly once');
  assert.equal(ruleCalls, 1, 'rule context must be evaluated exactly once');
  assert.equal(memoryCalls, 1, 'memory context must be evaluated exactly once');
  assert.equal(frustrationCalls, 1, 'frustration context must be evaluated exactly once');
  assert.equal(observerCalls, 1, 'prompt observer must be evaluated exactly once in-process');
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /Harness rule capsule/,
    'rule capsule was lost during merge');
  assert.match(output.hookSpecificOutput.additionalContext, /source=test; key=memory\/provenance/,
    'memory provenance was lost during merge');
  assert.match(output.hookSpecificOutput.additionalContext, /frustration-detector.*根因分析/,
    'frustration mode-switch context was lost during merge');
}

function assertFailOpenIsolation() {
  const router = require(routerPath);
  const payload = promptPayload();
  const diagnostics = [];
  const output = router.combinePromptContext(payload, {
    ruleContext() { throw new Error('rule fixture failure'); },
    memoryContext() { return context('[memory] surviving provenance'); },
    frustrationContext() { throw new Error('frustration fixture failure'); },
    onDiagnostic(source, error) { diagnostics.push({ source, message: error.message }); },
    promptObserver() { throw new Error('observer fixture failure'); },
  });

  assert.match(output?.hookSpecificOutput?.additionalContext || '', /surviving provenance/,
    'one failed source must not suppress valid context from the other source');
  assert.ok(diagnostics.some(item => item.source === 'rule-loader'
      && item.message === 'rule fixture failure'),
  'rule provider failure must be visible and fail-open');
  assert.ok(diagnostics.some(item => item.source === 'prompt-observer'
      && item.message === 'observer fixture failure'),
  'prompt observer failure must be visible and fail-open');
  assert.ok(diagnostics.some(item => item.source === 'frustration-detector'
      && item.message === 'frustration fixture failure'),
  'frustration provider failure must be visible and fail-open');

  const empty = router.combinePromptContext(payload, {
    ruleContext() { throw new Error('rule down'); },
    memoryContext() { throw new Error('memory down'); },
    frustrationContext() { return null; },
    onDiagnostic() {},
  });
  assert.equal(empty, null, 'both failed sources must fail open without malformed hook output');
}

function assertFrustrationContextIsRequireSafeAndReadOnly() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-frustration-readonly-'));
  const stateFile = path.join(root, 'runtime-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ failureCount: 0, failureHistory: [], toolCalls: [] }), 'utf8');
  const before = fs.readFileSync(stateFile, 'utf8');
  const previous = {
    runtime: process.env.CLAUDE_RUNTIME_STATE_FILE,
    noPersist: process.env.CLAUDE_HARNESS_NO_PERSIST,
  };
  try {
    process.env.CLAUDE_RUNTIME_STATE_FILE = stateFile;
    process.env.CLAUDE_HARNESS_NO_PERSIST = '1';
    delete require.cache[require.resolve(frustrationPath)];
    const detector = require(frustrationPath);
    assert.equal(typeof detector.retrieveContext, 'function',
      'frustration detector must expose a require-safe Hook context interface');

    let writes = 0;
    let signals = 0;
    const output = detector.retrieveContext({
      hook_event_name: 'UserPromptSubmit',
      prompt: '还是不行',
      cwd: HARNESS_ROOT,
      session_id: 'prompt-frustration-readonly',
    }, {
      persist: false,
      readState: () => ({ failureCount: 0, failureHistory: [], toolCalls: [] }),
      updateState: () => { writes += 1; },
      emitSignal: () => { signals += 1; },
    });
    assert.match(output?.hookSpecificOutput?.additionalContext || '', /强制模式切换.*根因分析/,
      'frustration Hook interface did not emit the expected mode-switch context');
    assert.equal(writes, 0, 'read-only frustration retrieval wrote runtime state');
    assert.equal(signals, 0, 'read-only frustration retrieval emitted telemetry');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before,
      'requiring or invoking the read-only frustration provider changed runtime state');
    assert.equal(detector.retrieveContext({
      hook_event_name: 'UserPromptSubmit',
      prompt: '请审计 harness memory hook。',
    }, { persist: false, readState: () => ({ failureCount: 0, toolCalls: [] }) }), null,
    'neutral prompt unexpectedly emitted frustration context');
  } finally {
    if (previous.runtime === undefined) delete process.env.CLAUDE_RUNTIME_STATE_FILE;
    else process.env.CLAUDE_RUNTIME_STATE_FILE = previous.runtime;
    if (previous.noPersist === undefined) delete process.env.CLAUDE_HARNESS_NO_PERSIST;
    else process.env.CLAUDE_HARNESS_NO_PERSIST = previous.noPersist;
    delete require.cache[require.resolve(frustrationPath)];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertDiagnosticQuestionTriggersMemoryRetrieval() {
  const memoryHook = require(memoryHookPath);
  const previous = process.env.CLAUDE_HARNESS_NO_PERSIST;
  const queries = [];
  try {
    process.env.CLAUDE_HARNESS_NO_PERSIST = '1';
    const output = memoryHook.retrieveContext({
      hook_event_name: 'UserPromptSubmit',
      prompt: '认知层是不是没有生效？',
      cwd: HARNESS_ROOT,
      session_id: 'prompt-diagnostic-memory-trigger',
    }, {
      recentlyInjected: () => false,
      markInjected: () => {},
      doMemoryQuery(query, label, scope) {
        queries.push({ query, label, scope });
        return [{
          memoryId: 'cognitive-layer-routing',
          namespace: 'learnings',
          name: 'cognitive-layer-routing',
          summary: '认知层由 rule-loader、memory-retrieve 和 frustration-detector 组成。',
          confidence: 0.9,
          source: 'test',
          sourceKey: 'learnings/cognitive-layer-routing.md',
          status: 'active',
          updatedAt: Date.now(),
        }];
      },
    });
    assert.equal(queries.length, 1, 'diagnostic effectiveness question did not trigger memory retrieval');
    assert.equal(queries[0].label, 'user');
    assert.match(output?.hookSpecificOutput?.additionalContext || '', /cognitive-layer-routing/,
      'diagnostic memory result was not injected into Hook context');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_HARNESS_NO_PERSIST;
    else process.env.CLAUDE_HARNESS_NO_PERSIST = previous;
  }
}

function assertRuleContextIsRequireSafeAndReadOnly() {
  const ruleLoader = require(ruleLoaderPath);
  assert.equal(typeof ruleLoader.retrieveContext, 'function',
    'rule-loader must expose a require-safe Hook context interface');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-rule-readonly-'));
  const previous = {
    memo: process.env.CLAUDE_RULE_LOADER_MEMO_DIR,
    noPersist: process.env.CLAUDE_HARNESS_NO_PERSIST,
    signal: process.env.CLAUDE_RULE_SIGNAL_DISABLED,
  };
  try {
    process.env.CLAUDE_RULE_LOADER_MEMO_DIR = root;
    process.env.CLAUDE_HARNESS_NO_PERSIST = '1';
    process.env.CLAUDE_RULE_SIGNAL_DISABLED = '1';
    const output = ruleLoader.retrieveContext(promptPayload());
    assert.match(output?.hookSpecificOutput?.additionalContext || '', /Harness rule capsule/,
      'rule Hook interface must preserve capsule output');
    assert.deepEqual(fs.readdirSync(root), [], 'read-only mode must not write rule injection state');
  } finally {
    if (previous.memo === undefined) delete process.env.CLAUDE_RULE_LOADER_MEMO_DIR;
    else process.env.CLAUDE_RULE_LOADER_MEMO_DIR = previous.memo;
    if (previous.noPersist === undefined) delete process.env.CLAUDE_HARNESS_NO_PERSIST;
    else process.env.CLAUDE_HARNESS_NO_PERSIST = previous.noPersist;
    if (previous.signal === undefined) delete process.env.CLAUDE_RULE_SIGNAL_DISABLED;
    else process.env.CLAUDE_RULE_SIGNAL_DISABLED = previous.signal;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  assertSingleParseAndMergedOutput();
  assertFailOpenIsolation();
  assertRuleContextIsRequireSafeAndReadOnly();
  assertFrustrationContextIsRequireSafeAndReadOnly();
  assertDiagnosticQuestionTriggersMemoryRetrieval();
  process.stdout.write('PROMPT_CONTEXT_RESULT: PASS\n');
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
