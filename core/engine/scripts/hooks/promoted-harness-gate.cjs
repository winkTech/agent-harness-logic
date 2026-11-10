#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');
const { parseFrontmatter } = require('../rule-loader.cjs');

const RULES_DIR = path.join(HARNESS_ROOT, 'docs', 'rules');
const ALLOWED_FIELDS = new Set(['command', 'file_path']);
const ALLOWED_OPERATORS = new Set(['contains', 'equals', 'prefix']);

function splitList(value) {
  return String(value || '').split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function loadPolicies(opts = {}) {
  const rulesDir = path.resolve(opts.rulesDir || RULES_DIR);
  if (!fs.existsSync(rulesDir)) return [];
  const policies = [];
  for (const name of fs.readdirSync(rulesDir).filter((item) => /^90-promoted-hrc-.*\.md$/i.test(item)).sort()) {
    const filePath = path.join(rulesDir, name);
    const { validatePromotedRuleArtifact } = require('../harness-rule-candidates.cjs');
    const validation = validatePromotedRuleArtifact(filePath, {
      ledgerPath: opts.ledgerPath || process.env.CLAUDE_HARNESS_RULE_LEDGER,
    });
    if (!validation.valid) continue;
    const parsed = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
    if (String(parsed.frontmatter.enforcement || '').toLowerCase() !== 'block') continue;
    const policy = {
      file: name,
      candidateId: String(parsed.frontmatter.candidate_id || ''),
      description: String(parsed.frontmatter.description || ''),
      tools: splitList(parsed.frontmatter.gate_tools).map((item) => item.toLowerCase()),
      field: String(parsed.frontmatter.gate_field || '').toLowerCase(),
      operator: String(parsed.frontmatter.gate_operator || '').toLowerCase(),
      value: String(parsed.frontmatter.gate_value || ''),
    };
    if (!policy.candidateId || policy.tools.length === 0
        || !ALLOWED_FIELDS.has(policy.field)
        || !ALLOWED_OPERATORS.has(policy.operator)
        || policy.value.length < 3) {
      throw new Error(`invalid promoted hard-gate policy: ${name}`);
    }
    policies.push(policy);
  }
  return policies;
}

function valueFor(payload, runtime, field) {
  const input = payload?.tool_input || payload?.tool?.input || {};
  if (field === 'command') return String(runtime?.command || input.command || input.cmd || '');
  return String(runtime?.filePath || input.file_path || input.path || '');
}

function predicateMatches(actual, policy) {
  const left = process.platform === 'win32' ? actual.toLowerCase() : actual;
  const right = process.platform === 'win32' ? policy.value.toLowerCase() : policy.value;
  if (policy.operator === 'equals') return left === right;
  if (policy.operator === 'prefix') return left.startsWith(right);
  return left.includes(right);
}

function evaluate(payload = {}, runtime = {}, opts = {}) {
  const tool = String(runtime.toolName || payload.tool_name || payload?.tool?.name || '').toLowerCase();
  for (const policy of loadPolicies(opts)) {
    if (!policy.tools.includes(tool)) continue;
    if (!predicateMatches(valueFor(payload, runtime, policy.field), policy)) continue;
    return {
      decision: 'block',
      diagnostics: [`${policy.candidateId}: ${policy.description || 'promoted harness rule blocked this action'}`],
      policy,
    };
  }
  return { decision: 'allow', diagnostics: [] };
}

module.exports = { evaluate, loadPolicies, predicateMatches };
