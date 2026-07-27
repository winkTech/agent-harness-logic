'use strict';

const { HARNESS_ROOT } = require('./harness-root.cjs');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const HOME = HARNESS_ROOT;
const DEFAULT_WORKFLOW_DIR = path.join(HOME, 'workflows');

const STRICT_WORKFLOWS = new Set([
  'architecture-review-workflow',
  'code-review-workflow',
  'hdl-coding-dag-workflow',
  'rag-skill-workflow',
  'security-review-workflow',
]);

function listWorkflowFiles(workflowDir = DEFAULT_WORKFLOW_DIR) {
  if (!fs.existsSync(workflowDir)) return [];
  return fs.readdirSync(workflowDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(workflowDir, name));
}

function readWorkflow(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function workflowNameFromFile(filePath) {
  return path.basename(filePath, '.js');
}

function extractMetaName(content) {
  const match = content.match(/export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : '';
}

function extractObjectLiteralAfter(content, marker) {
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) return '';
  const start = content.indexOf('{', markerIndex + marker.length);
  if (start < 0) return '';

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let idx = start; idx < content.length; idx += 1) {
    const char = content[idx];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(start, idx + 1);
    }
  }
  return '';
}

function extractWorkflowMeta(content) {
  const literal = extractObjectLiteralAfter(content, 'export const meta');
  if (!literal) return null;
  return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
}

function activeCodeLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('*'));
}

function hasActivePattern(content, pattern) {
  return activeCodeLines(content).some((line) => pattern.test(line));
}

function hasAll(content, terms) {
  return terms.every((term) => content.includes(term));
}

function validateWorkflowFile(filePath) {
  const content = readWorkflow(filePath);
  const name = workflowNameFromFile(filePath);
  let meta = null;
  try {
    meta = extractWorkflowMeta(content);
  } catch (error) {
    meta = null;
  }
  const metaName = meta?.name || extractMetaName(content);
  const errors = [];
  const warnings = [];

  if (!content.includes('export const meta')) {
    errors.push('missing export const meta');
  }
  if (!meta) {
    errors.push('meta must be a parseable object literal');
  }
  if (!metaName) {
    errors.push('missing meta.name');
  } else if (metaName !== name) {
    errors.push(`meta.name "${metaName}" does not match file name "${name}"`);
  }
  if (!meta?.contract) {
    errors.push('missing meta.contract');
  }

  if (hasActivePattern(content, /\brequire\s*\(/)) {
    errors.push('workflow uses CommonJS require(), which the workflow engine does not support');
  }
  if (hasActivePattern(content, /\b(execSync|spawnSync|child_process)\b|shell\s*:\s*true/)) {
    errors.push('workflow contains direct shell execution primitives; use workflow evidence scripts or agents');
  }

  const isAlias = content.includes('await workflow(');
  if (!isAlias && !content.includes('phase(')) {
    errors.push('workflow has no phase() calls');
  }
  if (!isAlias && !content.includes('agent(')) {
    warnings.push('workflow has no agent() calls');
  }

  if (STRICT_WORKFLOWS.has(metaName || name)) {
    const contract = meta?.contract || {};
    if (contract.strict !== true) {
      errors.push('strict workflow contract must set contract.strict=true');
    }
    for (const field of ['inputs', 'checkpoints', 'evidence', 'completionCriteria']) {
      if (!Array.isArray(contract[field]) || contract[field].length === 0) {
        errors.push(`strict workflow contract must include non-empty contract.${field}`);
      } else {
        contract[field].forEach((item, idx) => {
          if (typeof item !== 'string' || item.trim().length === 0) {
            errors.push(`strict workflow contract.${field}[${idx}] must be a non-empty string`);
          }
        });
      }
    }
    if (Array.isArray(meta?.phases) && Array.isArray(contract.checkpoints) && contract.checkpoints.length > meta.phases.length + 2) {
      warnings.push('strict workflow has more checkpoints than phases; confirm they are intentional');
    }
  }

  if (name === 'code-review-workflow') {
    if (/return\s*\{\s*pass\s*:\s*true\b/s.test(content)) {
      errors.push('code-review-workflow returns unconditional pass:true');
    }
    if (!content.includes('workflowPassed') || !content.includes('blockingIssues')) {
      errors.push('code-review-workflow must derive pass from blockingIssues/workflowPassed');
    }
  }

  if (name === 'security-review-workflow') {
    if (!content.includes('workflow-evidence-scan.cjs')) {
      errors.push('security-review-workflow must reference deterministic workflow-evidence-scan.cjs');
    }
    if (!content.includes('allowGlobal')) {
      errors.push('security-review-workflow must require explicit allowGlobal for global scans');
    }
    if (!content.includes('args?.files')) {
      errors.push('security-review-workflow must accept args.files as documented');
    }
  }

  if (name === 'rag-skill-workflow') {
    if (content.includes('默认检索词') || content.includes('榛樿')) {
      errors.push('rag-skill-workflow must not invent a default query');
    }
    if (!content.includes('citations') && !content.includes('file:line')) {
      errors.push('rag-skill-workflow must require cited retrieval evidence');
    }
  }

  if (name === 'hdl-coding-dag-workflow') {
    if (!content.includes('WorkflowCheckpoint')) {
      errors.push('hdl-coding-dag-workflow must hard-stop on missing user checkpoints');
    }
    if (!content.includes('Phase 4.5') || !content.includes('evidence')) {
      errors.push('hdl-coding-dag-workflow must include a hard evidence gate');
    }
    const forbiddenPathHints = [
      { text: '02_sim/tb_', message: 'testbench path must be 02_sim/<module>/tb_<module>.sv, not 02_sim/tb_<module>.sv' },
      { text: '01_src/00_hdl/top.sv', message: 'top path must include a module directory, e.g. 01_src/00_hdl/top/top.sv' },
      { text: 'prj/01_src', message: 'workflow must not switch to legacy prj/ root layout' },
      { text: 'rtl/', message: 'workflow must not ask agents to create legacy rtl/ roots' },
      { text: 'tb/', message: 'workflow must not ask agents to create legacy tb/ roots' },
      { text: 'constraints/', message: 'workflow must not ask agents to create legacy constraints/ roots' },
      { text: 'reports/', message: 'workflow must not ask agents to create legacy reports/ roots' },
      { text: 'build/', message: 'workflow must not ask agents to create legacy build/ roots' },
    ];
    for (const item of forbiddenPathHints) {
      if (content.includes(item.text)) errors.push(item.message);
    }
    if (!content.includes('directory-contract.json')) {
      errors.push('hdl-coding-dag-workflow must require var/project-init/directory-contract.json evidence');
    }
  }

  return { file: filePath, name, metaName, errors, warnings };
}

function validateWorkflowSet(workflowDir = DEFAULT_WORKFLOW_DIR) {
  const files = listWorkflowFiles(workflowDir);
  const results = files.map(validateWorkflowFile);
  const names = new Map();
  const errors = [];
  const warnings = [];

  for (const result of results) {
    for (const error of result.errors) {
      errors.push(`${path.relative(HOME, result.file)}: ${error}`);
    }
    for (const warning of result.warnings) {
      warnings.push(`${path.relative(HOME, result.file)}: ${warning}`);
    }
    const key = result.metaName || result.name;
    if (names.has(key)) {
      errors.push(`duplicate workflow meta.name "${key}" in ${path.relative(HOME, names.get(key))} and ${path.relative(HOME, result.file)}`);
    }
    names.set(key, result.file);
  }

  return {
    ok: errors.length === 0,
    workflowDir,
    count: files.length,
    files,
    results,
    errors,
    warnings,
  };
}

if (require.main === module) {
  const json = process.argv.includes('--json');
  const dirArg = process.argv.includes('--dir')
    ? process.argv[process.argv.indexOf('--dir') + 1]
    : DEFAULT_WORKFLOW_DIR;
  const result = validateWorkflowSet(path.resolve(dirArg));
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Workflow contracts: ${result.ok ? 'PASS' : 'FAIL'} (${result.count} files)`);
    for (const error of result.errors) console.log(`ERROR ${error}`);
    for (const warning of result.warnings) console.log(`WARN  ${warning}`);
  }
  if (!result.ok) process.exit(1);
}

module.exports = {
  DEFAULT_WORKFLOW_DIR,
  listWorkflowFiles,
  readWorkflow,
  extractWorkflowMeta,
  validateWorkflowFile,
  validateWorkflowSet,
};
