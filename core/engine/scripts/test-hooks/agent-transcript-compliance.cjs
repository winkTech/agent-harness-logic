#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTROLLED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'Agent', 'Workflow']);

function usage() {
  return [
    'Usage:',
    '  node engine/scripts/test-hooks/agent-transcript-compliance.cjs',
    '  node engine/scripts/test-hooks/agent-transcript-compliance.cjs --transcript run.jsonl',
    '  node engine/scripts/test-hooks/agent-transcript-compliance.cjs --transcript run.jsonl --expect-command "node test.cjs"',
    '',
    'Without --transcript, runs parser/compliance regression tests.',
  ].join('\n');
}

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function argValues(args, name) {
  const values = [];
  for (let idx = 0; idx < args.length; idx += 1) {
    if (args[idx] === name && args[idx + 1]) values.push(args[idx + 1]);
  }
  return values;
}

function readText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let oddNulls = 0;
  let oddBytes = 0;
  for (let idx = 1; idx < sample.length; idx += 2) {
    oddBytes += 1;
    if (sample[idx] === 0) oddNulls += 1;
  }
  const looksUtf16Le = (buffer[0] === 0xff && buffer[1] === 0xfe) || (oddBytes > 0 && oddNulls / oddBytes > 0.6);
  return buffer.toString(looksUtf16Le ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function parseJsonl(text) {
  const events = [];
  const parseErrors = [];
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('{')) continue;
    try {
      events.push({ line: i + 1, event: JSON.parse(line) });
    } catch (error) {
      parseErrors.push({ line: i + 1, error: error.message, text: line.slice(0, 200) });
    }
  }
  return { events, parseErrors };
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

function isAgentsRead(toolUse) {
  if (toolUse.name !== 'Read') return false;
  const input = toolUse.input || {};
  const filePath = input.file_path || input.path || input.file || '';
  return /(^|[\\/])AGENTS\.md$/i.test(filePath);
}

function isSourcePath(text) {
  return /(?:^|[\\/"'\s])(?:src|rtl|tb|tests?)[\\/][^"'\s]+?\.(?:py|sv|v|vh|svh|c|cc|cpp|h|hpp|js|cjs|mjs|ts|tsx|jsx)(?:$|["'\s])/i.test(text);
}

function isBashWriteBypass(toolUse) {
  if (toolUse.name !== 'Bash') return false;
  const command = String(toolUse.input?.command || '');
  if (!isSourcePath(command)) return false;

  const writePatterns = [
    /\bopen\s*\([^)]*["'](?:w|a|x|wb|ab|xb)\b/i,
    /\bwriteFileSync\s*\(/i,
    /\bwriteFile\s*\(/i,
    /\bSet-Content\b/i,
    /\bAdd-Content\b/i,
    /\bOut-File\b/i,
    /(?:^|[^0-9])>>?\s*(?!&)\S+/,
    /\btee\b[\s\S]*\.(?:py|sv|v|vh|svh|c|cc|cpp|h|hpp|js|cjs|mjs|ts|tsx|jsx)\b/i,
  ];
  return writePatterns.some((pattern) => pattern.test(command));
}

function summarizeToolUse(toolUse) {
  const input = toolUse.input || {};
  if (toolUse.name === 'Bash') return `${toolUse.name}: ${input.command || ''}`.trim();
  if (input.file_path) return `${toolUse.name}: ${input.file_path}`;
  return toolUse.name;
}

function verifyEvents(events, parseErrors = [], options = {}) {
  const violations = [];
  const controlledToolUses = [];
  const agentsReads = [];
  let sawControlledTool = false;
  let pendingChecklist = null;

  for (const { line, event } of events) {
    const parts = messageParts(event);
    if (parts.length === 0) continue;

    const visibleText = textFrom(parts);
    if (visibleText.trim()) {
      const status = checklistStatus(visibleText);
      pendingChecklist = status.ok ? { line, text: visibleText } : null;
    }

    for (const part of parts) {
      if (part.type !== 'tool_use') continue;

      if (isAgentsRead(part)) {
        agentsReads.push({ line, tool: summarizeToolUse(part) });
        if (sawControlledTool) {
          violations.push({
            line,
            rule: 'agents-read-before-controlled-tools',
            detail: 'AGENTS.md was read after a controlled tool was already used',
            tool: summarizeToolUse(part),
          });
        }
      }

      if (!CONTROLLED_TOOLS.has(part.name)) continue;

      sawControlledTool = true;
      const sameMessage = checklistStatus(visibleText);
      const pending = pendingChecklist ? checklistStatus(pendingChecklist.text) : { ok: false, missing: ['noPendingChecklist'] };
      const hasChecklist = sameMessage.ok || pending.ok;

      controlledToolUses.push({ line, tool: summarizeToolUse(part), hasChecklist });
      if (!hasChecklist) {
        violations.push({
          line,
          rule: 'visible-pre-tool-checklist',
          detail: `controlled tool use lacks the required visible checklist (${sameMessage.missing.join(', ')})`,
          tool: summarizeToolUse(part),
        });
      }
      if (isBashWriteBypass(part)) {
        violations.push({
          line,
          rule: 'bash-write-bypass',
          detail: 'Bash command appears to write source files, bypassing Edit/Write gates',
          tool: summarizeToolUse(part),
        });
      }

      pendingChecklist = null;
    }
  }

  for (const error of parseErrors) {
    violations.push({
      line: error.line,
      rule: 'jsonl-parseable',
      detail: `unparseable JSON event: ${error.error}`,
    });
  }

  if (options.requireControlledTool && controlledToolUses.length === 0) {
    violations.push({
      line: 0,
      rule: 'controlled-tool-required',
      detail: 'expected at least one controlled tool use, but none were found',
    });
  }

  for (const expectedCommand of options.expectedCommands || []) {
    const found = controlledToolUses.some((item) => item.tool.includes(expectedCommand));
    if (!found) {
      violations.push({
        line: 0,
        rule: 'expected-command-missing',
        detail: `expected command was not observed: ${expectedCommand}`,
      });
    }
  }

  return {
    status: violations.length === 0 ? 'passed' : 'failed',
    controlledToolUses,
    agentsReads,
    violations,
  };
}

function verifyTranscript(filePath, options = {}) {
  const text = readText(filePath);
  const parsed = parseJsonl(text);
  const result = verifyEvents(parsed.events, parsed.parseErrors, options);
  if (parsed.events.length === 0) {
    result.status = 'failed';
    result.violations.push({
      line: 0,
      rule: 'jsonl-events-present',
      detail: 'transcript did not contain any parseable JSONL events',
    });
  }
  return result;
}

function assistant(parts) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: parts,
    },
  });
}

function toolUse(name, input = {}) {
  return { type: 'tool_use', name, input };
}

function selfTest(name, fn) {
  try {
    fn();
    return { name, pass: true };
  } catch (error) {
    return { name, pass: false, detail: error.message };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runSelfTests() {
  const checklist = [
    '\u884c\u52a8: run workflow test',
    '\u7528\u6237\u6307\u4ee4: "verify workflow"',
    '\u5339\u914d: ok',
    '\u95e8\u7981: \u9700\u6c42\u6f84\u6e05[ ok ] \u9a8c\u8bc1\u8d28\u91cf[ N/A ]',
  ].join('\n');

  const tests = [
    selfTest('fails Bash without visible checklist', () => {
      const parsed = parseJsonl(assistant([toolUse('Bash', { command: 'node test.cjs' })]));
      const result = verifyEvents(parsed.events, parsed.parseErrors);
      assert(result.status === 'failed', 'missing checklist transcript passed');
      assert(result.violations.some((item) => item.rule === 'visible-pre-tool-checklist'), 'missing checklist violation');
    }),
    selfTest('passes checklist immediately before Bash', () => {
      const parsed = parseJsonl([
        assistant([{ type: 'text', text: checklist }]),
        assistant([toolUse('Bash', { command: 'node test.cjs' })]),
      ].join('\n'));
      const result = verifyEvents(parsed.events, parsed.parseErrors);
      assert(result.status === 'passed', `expected pass, got ${JSON.stringify(result.violations)}`);
    }),
    selfTest('fails missing expected command', () => {
      const parsed = parseJsonl([
        assistant([{ type: 'text', text: checklist }]),
        assistant([toolUse('Bash', { command: 'node actual.cjs' })]),
      ].join('\n'));
      const result = verifyEvents(parsed.events, parsed.parseErrors, { expectedCommands: ['node expected.cjs'] });
      assert(result.status === 'failed', 'missing expected command transcript passed');
      assert(result.violations.some((item) => item.rule === 'expected-command-missing'), 'missing expected-command violation');
    }),
    selfTest('fails AGENTS read after controlled tool', () => {
      const parsed = parseJsonl([
        assistant([{ type: 'text', text: checklist }]),
        assistant([toolUse('Bash', { command: 'node test.cjs' })]),
        assistant([toolUse('Read', { file_path: 'C:\\Users\\Lihan\\.claude\\AGENTS.md' })]),
      ].join('\n'));
      const result = verifyEvents(parsed.events, parsed.parseErrors);
      assert(result.status === 'failed', 'late AGENTS read transcript passed');
      assert(result.violations.some((item) => item.rule === 'agents-read-before-controlled-tools'), 'missing late AGENTS violation');
    }),
    selfTest('fails Bash source write bypass even with checklist', () => {
      const parsed = parseJsonl([
        assistant([{ type: 'text', text: checklist }]),
        assistant([toolUse('Bash', { command: 'python -c "open(\'src/telemetry.py\', \'w\').write(\'x\')"' })]),
      ].join('\n'));
      const result = verifyEvents(parsed.events, parsed.parseErrors);
      assert(result.status === 'failed', 'Bash source write bypass passed');
      assert(result.violations.some((item) => item.rule === 'bash-write-bypass'), 'missing bash-write-bypass violation');
    }),
    selfTest('fails non-json transcript files', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-transcript-'));
      const filePath = path.join(dir, 'transcript.txt');
      fs.writeFileSync(filePath, 'plain final answer without events', 'utf8');
      const result = verifyTranscript(filePath);
      assert(result.status === 'failed', 'plain text transcript passed');
      assert(result.violations.some((item) => item.rule === 'jsonl-events-present'), 'missing jsonl event violation');
    }),
    selfTest('reads UTF-16LE transcripts', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-transcript-'));
      const filePath = path.join(dir, 'transcript.jsonl');
      fs.writeFileSync(filePath, Buffer.from([
        assistant([{ type: 'text', text: checklist }]),
        assistant([toolUse('Bash', { command: 'node test.cjs' })]),
      ].join('\n'), 'utf16le'));
      const result = verifyTranscript(filePath);
      assert(result.status === 'passed', `utf16 transcript failed: ${JSON.stringify(result.violations)}`);
    }),
  ];

  let passed = 0;
  let failed = 0;
  console.log('\nAgent transcript compliance tests\n');
  for (const test of tests) {
    process.stdout.write(`  ${test.name.padEnd(70)} `);
    if (test.pass) {
      passed += 1;
      console.log('PASS');
    } else {
      failed += 1;
      console.log('FAIL');
      console.log(`    ${test.detail}`);
    }
  }
  console.log(`\nSummary: ${passed}/${tests.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }

  const transcript = argValue(args, '--transcript');
  if (!transcript) {
    runSelfTests();
    return;
  }

  const result = verifyTranscript(path.resolve(transcript), {
    expectedCommands: argValues(args, '--expect-command'),
    requireControlledTool: args.includes('--require-controlled-tool'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'passed') process.exit(1);
}

if (require.main === module) main();

module.exports = {
  parseJsonl,
  readText,
  argValues,
  verifyEvents,
  verifyTranscript,
};
