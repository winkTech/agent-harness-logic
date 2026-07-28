#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

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

  if (blocks.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: payload.hook_event_name || 'UserPromptSubmit',
      additionalContext: blocks.join('\n\n'),
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
  combinePromptContext,
  main,
};
