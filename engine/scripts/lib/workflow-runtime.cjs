'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = path.join(os.homedir(), '.claude');
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
  const metaName = extractMetaName(content);
  const errors = [];
  const warnings = [];

  if (!content.includes('export const meta')) {
    errors.push('missing export const meta');
  }
  if (!metaName) {
    errors.push('missing meta.name');
  } else if (metaName !== name) {
    errors.push(`meta.name "${metaName}" does not match file name "${name}"`);
  }
  if (!content.includes('contract:')) {
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
    const requiredContractTerms = [
      'strict: true',
      'checkpoints',
      'evidence',
      'completionCriteria',
    ];
    if (!hasAll(content, requiredContractTerms)) {
      errors.push(`strict workflow contract must include ${requiredContractTerms.join(', ')}`);
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
  validateWorkflowFile,
  validateWorkflowSet,
};
