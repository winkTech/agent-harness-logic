#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateOutputText,
  evaluateRepairContent,
  normalizeRel,
  readSpecFile,
  validateRepairSpec,
} = require('../lib/repair-contract.cjs');
const {
  HOME,
  payloadFilePath,
  scopeFromPayload,
} = require('../lib/project-scope.cjs');

function argValue(args, name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return null;
    const text = fs.readFileSync(0, 'utf8').trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    return { __invalid: error.message };
  }
}

function defaultSpecPath(projectRoot) {
  if (process.env.CLAUDE_REPAIR_SPEC) return process.env.CLAUDE_REPAIR_SPEC;
  return path.join(projectRoot || process.cwd(), 'var', 'repair', 'repair-spec.json');
}

function result(decision, diagnostics = [], extra = {}) {
  return {
    source: 'repair-content-gate',
    decision,
    diagnostics,
    ...extra,
  };
}

function failureDiagnostics(failures, extra = {}) {
  return (failures || []).map((message) => ({
    code: 'repair-contract',
    message,
    ...extra,
  }));
}

function block(failures, extra = {}) {
  console.error(JSON.stringify({
    source: 'repair-content-gate',
    type: 'blocked',
    failures,
    ...extra,
  }, null, 2));
  process.exit(2);
}

function ok(detail = {}) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ source: 'repair-content-gate', status: 'passed', ...detail }, null, 2));
  }
  process.exit(0);
}

function cliMode(args) {
  const specPath = argValue(args, '--spec');
  const projectRoot = argValue(args, '--project-root', process.cwd());
  const outputText = argValue(args, '--output-text', '');
  if (!specPath) block(['--spec is required in CLI mode']);
  if (!fs.existsSync(specPath)) block([`repair spec not found: ${specPath}`]);

  const spec = readSpecFile(specPath);
  const validation = validateRepairSpec(spec, { projectRoot });
  if (!validation.ok) block(validation.failures);
  const content = evaluateRepairContent(spec, { projectRoot });
  if (!content.ok) block(content.failures, { checks: content.checks });
  if (outputText) {
    const output = evaluateOutputText(spec, outputText);
    if (!output.ok) block(output.failures);
  }
  ok({ checks: content.checks });
}

function payloadMode(payload) {
  const outcome = evaluate(payload);
  if (outcome.decision === 'block') {
    block(outcome.diagnostics.map((item) => item.message), outcome.meta || {});
  }
  process.exit(0);
}

function postEditContent(payload, filePath, runtime = {}) {
  if (runtime.content !== undefined) return String(runtime.content);
  const input = payload?.tool_input || payload?.tool?.input || payload?.input || payload?.arguments || {};
  if (Object.prototype.hasOwnProperty.call(input, 'content')) return String(input.content ?? '');

  const edits = Array.isArray(input.edits) ? input.edits
    : (input.old_string !== undefined
      ? [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }]
      : []);
  if (edits.length === 0) return '';

  let text;
  try {
    const readFileSync = runtime.readFileSync || fs.readFileSync.bind(fs);
    text = readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  for (const edit of edits) {
    const before = String(edit?.old_string ?? '');
    if (!before) continue;
    const after = String(edit?.new_string ?? '');
    text = edit?.replace_all ? text.split(before).join(after) : text.replace(before, after);
  }
  return text;
}

function evaluate(payload, runtime = {}) {
  if (!payload || payload.__invalid) {
    return result('block', failureDiagnostics([
      `invalid hook payload: ${payload?.__invalid || 'empty'}`,
    ]));
  }

  const eventName = String(payload.hook_event_name || payload.event || '').toLowerCase();
  const toolName = String(payload.tool_name || payload.tool?.name || payload.name || '').toLowerCase();
  if (!['pretooluse', 'posttooluse', ''].includes(eventName)
      || !['write', 'edit', 'multiedit'].includes(toolName)) {
    return result('allow');
  }

  const scope = runtime.scope || scopeFromPayload(payload);
  const filePath = runtime.filePath || payloadFilePath(payload, scope.cwd);
  if (!filePath) return result('allow');

  const specPath = runtime.specPath || defaultSpecPath(scope.projectRoot);
  if (!fs.existsSync(specPath)) return result('allow');

  let spec;
  let validation;
  try {
    spec = readSpecFile(specPath);
    validation = validateRepairSpec(spec, { projectRoot: scope.projectRoot });
  } catch (error) {
    return result('block', failureDiagnostics([`repair spec could not be read: ${error.message}`], { specPath }));
  }
  if (!validation.ok) {
    return result('block', failureDiagnostics(validation.failures, { specPath }));
  }

  const relPath = normalizeRel(path.relative(scope.projectRoot, filePath));
  const allowed = new Set(validation.allowedFiles);
  const readonly = new Set(validation.readonlyFiles);
  const failures = [];
  if (!allowed.has(relPath)) failures.push(`repair may only touch allowed files; blocked ${relPath}`);
  if (readonly.has(relPath)) failures.push(`repair attempted readonly file: ${relPath}`);

  const proposed = postEditContent(payload, filePath, runtime);
  if (proposed) {
    const required = (spec.requiredRegex || []).filter((rule) => normalizeRel(rule.file) === relPath);
    const forbidden = (spec.forbiddenRegex || []).filter((rule) => normalizeRel(rule.file) === relPath);
    for (const rule of required) {
      const pattern = new RegExp(rule.pattern, rule.flags || '');
      if (!pattern.test(proposed)) failures.push(`required pattern missing in proposed content: ${rule.description || rule.pattern}`);
    }
    for (const rule of forbidden) {
      const pattern = new RegExp(rule.pattern, rule.flags || '');
      if (pattern.test(proposed)) failures.push(`forbidden pattern present in proposed content: ${rule.description || rule.pattern}`);
    }
  }

  if (failures.length > 0) {
    const meta = { spec: spec.id, file: relPath, specPath };
    return result('block', failureDiagnostics(failures, meta), { meta });
  }
  return result('allow', [], { meta: { spec: spec.id, file: relPath, specPath } });
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) return cliMode(args);
  const payload = readStdinJson();
  if (!payload) process.exit(0);
  return payloadMode(payload);
}

if (require.main === module) main();

module.exports = {
  cliMode,
  defaultSpecPath,
  evaluate,
  postEditContent,
  payloadMode,
};
