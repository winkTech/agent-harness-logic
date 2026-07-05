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
  if (!payload || payload.__invalid) {
    block([`invalid hook payload: ${payload?.__invalid || 'empty'}`]);
  }

  const scope = scopeFromPayload(payload);
  const specPath = defaultSpecPath(scope.projectRoot);
  if (!fs.existsSync(specPath)) process.exit(0);

  const spec = readSpecFile(specPath);
  const validation = validateRepairSpec(spec, { projectRoot: scope.projectRoot });
  if (!validation.ok) block(validation.failures);

  const eventName = String(payload.hook_event_name || '').toLowerCase();
  const toolName = String(payload.tool_name || payload.tool?.name || '').toLowerCase();
  if (!['pretooluse', 'posttooluse', ''].includes(eventName)) process.exit(0);
  if (!['write', 'edit', 'multiedit'].includes(toolName)) process.exit(0);

  const filePath = payloadFilePath(payload, scope.cwd);
  if (!filePath) process.exit(0);
  const relPath = normalizeRel(path.relative(scope.projectRoot, filePath));
  const allowed = new Set(validation.allowedFiles);
  const readonly = new Set(validation.readonlyFiles);

  const failures = [];
  if (!allowed.has(relPath)) failures.push(`repair may only touch allowed files; blocked ${relPath}`);
  if (readonly.has(relPath)) failures.push(`repair attempted readonly file: ${relPath}`);
  if (failures.length > 0) block(failures, { spec: spec.id, file: relPath });

  const proposed = payload?.tool_input?.content || payload?.tool?.input?.content || payload?.input?.content || '';
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

  if (failures.length > 0) block(failures, { spec: spec.id, file: relPath });
  process.exit(0);
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
  payloadMode,
};
