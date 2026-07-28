#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const stateResume = require('../state-resume.cjs');
const contextResume = require('../context-resume.cjs');
const dreamStartup = require('../dream-startup-inject.cjs');
const isolation = require('./isolation-check.cjs');

const SUPPORTED_SOURCES = Object.freeze(['startup', 'resume', 'clear', 'compact', 'fork']);

function defaultIo(opts = {}) {
  return {
    stdout: typeof opts.stdout === 'function'
      ? opts.stdout
      : line => process.stdout.write(`${String(line)}\n`),
    stderr: typeof opts.stderr === 'function'
      ? opts.stderr
      : line => process.stderr.write(`${String(line)}\n`),
  };
}

function contextInjectOutput() {
  const result = contextResume.resume();
  if (result.injectPrompt) {
    return {
      source: 'context-resume',
      type: 'context-restore',
      injectPrompt: result.injectPrompt,
      summary: result.summary,
    };
  }
  return { source: 'context-resume', type: 'context-restore', injectPrompt: '', summary: '无状态' };
}

function defaultComponents() {
  return {
    stateResume() {
      const output = stateResume.main({ emit: false });
      const context = output?.handoffBrief
        ? `[state-resume] ${output.handoffBrief}${output.taskSummary ? ` ${output.taskSummary}` : ''}`
        : '';
      return { exitCode: 0, output, context };
    },
    contextResumeInject() {
      const output = contextInjectOutput();
      return { exitCode: 0, output, context: output.injectPrompt || '' };
    },
    dreamStartup(payload) {
      const output = dreamStartup.runStartup({ payload });
      return { exitCode: 0, output, context: output?.brief || '' };
    },
    isolationCheck() {
      return isolation.main();
    },
  };
}

function normalizeExitCode(result) {
  const value = Number(result?.exitCode || 0);
  return Number.isInteger(value) && value >= 0 ? value : 1;
}

function sessionSource(payload) {
  return String(payload?.source || payload?.session_source || payload?.sessionSource || '').trim().toLowerCase();
}

function runSessionBootstrap(raw, opts = {}) {
  const io = defaultIo(opts);
  const parse = typeof opts.parse === 'function' ? opts.parse : JSON.parse;
  let payload = {};
  try {
    if (String(raw || '').trim()) payload = parse(String(raw));
  } catch (error) {
    io.stderr(JSON.stringify({
      source: 'session-bootstrap',
      type: 'warning',
      message: `invalid hook json: ${error.message}`,
    }));
    return { exitCode: 0, payload: {}, source: '', componentsRun: [] };
  }

  if (typeof opts.onParsed === 'function') opts.onParsed(payload);
  const source = sessionSource(payload);
  if (!SUPPORTED_SOURCES.includes(source)) {
    return { exitCode: 0, payload, source, componentsRun: [] };
  }

  const components = opts.components || defaultComponents();
  const route = ['stateResume', 'contextResumeInject', 'dreamStartup'];
  if (source === 'startup') route.push('isolationCheck');

  let exitCode = 0;
  const contextBlocks = [];
  for (const name of route) {
    const component = components[name];
    if (typeof component !== 'function') {
      io.stderr(JSON.stringify({
        source: 'session-bootstrap',
        type: 'error',
        component: name,
        message: 'component is not callable',
      }));
      exitCode = Math.max(exitCode, 1);
      continue;
    }
    try {
      const result = component(payload, io);
      exitCode = Math.max(exitCode, normalizeExitCode(result));
      if (typeof result?.context === 'string' && result.context.trim()) {
        contextBlocks.push(result.context.trim());
      }
    } catch (error) {
      io.stderr(JSON.stringify({
        source: 'session-bootstrap',
        type: 'warning',
        component: name,
        message: error.message,
      }));
    }
  }

  if (contextBlocks.length > 0) {
    io.stdout(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: contextBlocks.join('\n\n'),
      },
    }));
  }

  return { exitCode, payload, source, componentsRun: route, contextBlocks };
}

function readStdin() {
  try {
    if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
  return '';
}

function main() {
  const result = runSessionBootstrap(readStdin());
  if (result.exitCode) process.exitCode = result.exitCode;
  return result;
}

if (require.main === module) main();

module.exports = {
  SUPPORTED_SOURCES,
  runSessionBootstrap,
  sessionSource,
};
