#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HARNESS_ROOT } = require('../lib/harness-root.cjs');
const { parseFrontmatter } = require('../rule-loader.cjs');
const { toolInputOf } = require('../io/index.cjs');

const RULES_DIRS = [
  path.join(HARNESS_ROOT, 'core', 'rules'),
  path.join(HARNESS_ROOT, 'docs', 'rules'),
].filter((dir) => fs.existsSync(dir));
const ALLOWED_FIELDS = new Set(['command', 'file_path']);
const ALLOWED_OPERATORS = new Set(['contains', 'equals', 'prefix']);

function splitList(value) {
  return String(value || '').split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function loadPolicies(opts = {}) {
  // 规则层真源 = core/rules/（Phase 1 拆层）；旧布局 docs/rules/ 存留时一并扫
  // （兼容回退，与 rule-loader 的 RULES_DIRS 同口径）。
  const rulesDirs = opts.rulesDir
    ? [path.resolve(opts.rulesDir)]
    : RULES_DIRS;
  const policies = [];
  for (const rulesDir of rulesDirs) {
    if (!fs.existsSync(rulesDir)) continue;
    for (const name of fs.readdirSync(rulesDir).filter((item) => /^90-promoted-hrc-.*\.md$/i.test(item)).sort()) {
      const filePath = path.join(rulesDir, name);
      const { validatePromotedRuleArtifact } = require('../harness-rule-candidates.cjs');
      const validation = validatePromotedRuleArtifact(filePath, {
        ledgerPath: opts.ledgerPath || process.env.HARNESS_RULE_LEDGER,
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
  }
  return policies;
}

function valueFor(payload, runtime, field) {
  const input = toolInputOf(payload);
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
