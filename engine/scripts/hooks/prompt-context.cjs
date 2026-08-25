#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const DEFAULT_CONTEXT_MAX_CHARS = 600;
const CONTEXT_TRUNCATION_MARKER = '\n...(context truncated)';

function readStdinRaw() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function additionalContext(output) {
  const value = output?.hookSpecificOutput?.additionalContext;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function mergeContextBlocks(blocks, requestedMaxChars) {
  const configured = Number.parseInt(
    requestedMaxChars ?? process.env.CLAUDE_PROMPT_CONTEXT_MAX_CHARS
      ?? DEFAULT_CONTEXT_MAX_CHARS,
    10,
  );
  const maxChars = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CONTEXT_MAX_CHARS;
  const unique = [...new Set(blocks.map((block) => String(block || '').trim()).filter(Boolean))];
  const merged = unique.join('\n\n');
  if (merged.length <= maxChars) return merged;
  if (maxChars <= CONTEXT_TRUNCATION_MARKER.length) {
    return CONTEXT_TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${merged.slice(0, maxChars - CONTEXT_TRUNCATION_MARKER.length).trimEnd()}`
    + CONTEXT_TRUNCATION_MARKER;
}

function combinePromptContext(payload = {}, deps = {}) {
  const providers = [
    {
      source: 'rule-loader',
      load: deps.ruleContext || ((input) => require('../rule-loader.cjs').retrieveContext(input)),
    },
    {
      source: 'memory-retrieve',
      load: deps.memoryContext || ((input) => require('../memory-retrieve-hook.cjs').retrieveContext(input)),
    },
    {
      source: 'frustration-detector',
      load: deps.frustrationContext || ((input) => require('./frustration-detector.cjs').retrieveContext(input)),
    },
  ];
  const blocks = [];

  for (const provider of providers) {
    try {
      const block = additionalContext(provider.load(payload));
      if (block) blocks.push(block);
    } catch (error) {
      if (typeof deps.onDiagnostic === 'function') {
        deps.onDiagnostic(provider.source, error);
      }
    }
  }

  try {
    const observe = deps.promptObserver
      || ((input) => require('../../hooks/learning/postflight-observer.cjs').handlePayload(input));
    observe(payload);
  } catch (error) {
    if (typeof deps.onDiagnostic === 'function') {
      deps.onDiagnostic('prompt-observer', error);
    }
  }

  const mergedContext = mergeContextBlocks(blocks, deps.maxContextChars);
  if (!mergedContext) return null;
  return {
    hookSpecificOutput: {
      hookEventName: payload.hook_event_name || 'UserPromptSubmit',
      additionalContext: mergedContext,
    },
  };
}

function main(deps = {}) {
  const raw = (deps.readStdinRaw || readStdinRaw)();
  const payload = parsePayload(raw);
  const output = combinePromptContext(payload, deps);
  if (output) (deps.writeStdout || process.stdout.write.bind(process.stdout))(JSON.stringify(output));
  return output;
}

if (require.main === module) {
  main();
}

module.exports = {
  readStdinRaw,
  parsePayload,
  additionalContext,
  mergeContextBlocks,
  combinePromptContext,
  main,
};
