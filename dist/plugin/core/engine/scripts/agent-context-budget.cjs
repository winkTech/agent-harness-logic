#!/usr/bin/env node
/**
 * Agent Context Budget System
 *
 * Per-agent-type context budget definitions + smart compression orchestration.
 * Bridges ECC's agent-compress.js (definition compression) with the spawn pipeline.
 *
 * Tiers:
 *   tight   (~8k chars)   → catalog mode + no memory/entity graph
 *   normal  (~20k chars)  → summary mode + semantic only
 *   relaxed (~35k chars)  → summary mode + full memory
 *   full    (~50k chars)  → full agent body + all enrichments
 *
 * Usage:
 *   const budget = require('./agent-context-budget.cjs');
 *   const tier = budget.getTier('planner');
 *   budget.compressDefinition(agentType, { tier: 'normal' });
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { HARNESS_ROOT } = require('./lib/harness-root.cjs');
const { varPath } = require('./lib/harness-state.cjs');

// ── Budget Tiers (char limits for the assembled prompt) ──────────────────
const TIERS = {
  tight: {
    label: 'tight',
    maxPromptChars: 8_000,
    agentMode: 'catalog',       // agent-compress.js mode
    enableMemory: false,
    enableEntityGraph: false,
    skillSectionMode: 'names_only',
    enableConstitution: true,
    enableSoul: false,
    selfCompactPrompt: true,     // inject auto-compaction reminder
  },
  normal: {
    label: 'normal',
    maxPromptChars: 20_000,
    agentMode: 'summary',
    enableMemory: true,
    enableEntityGraph: false,
    skillSectionMode: 'names_only',
    enableConstitution: true,
    enableSoul: false,
    selfCompactPrompt: true,
  },
  relaxed: {
    label: 'relaxed',
    maxPromptChars: 35_000,
    agentMode: 'summary',
    enableMemory: true,
    enableEntityGraph: true,
    skillSectionMode: 'full',
    enableConstitution: true,
    enableSoul: true,
    selfCompactPrompt: true,
  },
  full: {
    label: 'full',
    maxPromptChars: 50_000,
    agentMode: 'full',
    enableMemory: true,
    enableEntityGraph: true,
    skillSectionMode: 'full',
    enableConstitution: true,
    enableSoul: true,
    selfCompactPrompt: false,
  },
};

// ── Per-Agent-Type Budget Assignments ────────────────────────────────────
// Key = agentType string from spawn-prompt-assembler
const AGENT_BUDGETS = {
  // Core dev agents — need full context
  developer:         'relaxed',
  architect:         'relaxed',
  planner:           'relaxed',
  'code-reviewer':   'relaxed',

  // Domain/specialist agents — medium context
  'algorithm-engineer': 'normal',
  'logic-engineer':     'normal',
  'python-pro':         'normal',
  'data-scientist':     'normal',
  'performance-engineer': 'normal',
  'technical-writer': 'normal',
  'general-assistant': 'normal',
  researcher:        'normal',

  // Automation/verification agents — tight context (single-purpose)
  qa:                'normal',
  'reflection-agent': 'tight',
  'context-compressor': 'tight',
  'memory-manager':   'tight',
  'code-simplifier':  'tight',
  'ce-correctness-reviewer': 'tight',
  'ce-api-contract-reviewer': 'tight',
  'ce-architecture-strategist': 'tight',
  'ce-performance-oracle': 'tight',
  'blind-auditor':    'tight',
  'advanced-debugging': 'relaxed',

  // Orchestrators — need full context for coordination
  'master-orchestrator': 'full',
};

const WORKFLOW_MODEL_TIERS = Object.freeze({
  'p1a-system-design': 'deep',
  'p1b-algo-arch': 'deep',
  'p1b-logic-arch': 'deep',
  'p2-fixed-point': 'deep',
  'p45-adversarial': 'deep',
  'p5-fix': 'deep',
  'p3-tb': 'standard',
  'p3-vectors': 'standard',
  'p5-golden': 'standard',
  'p5-verify-fix': 'standard',
  'p7-review-correctness': 'standard',
  'p7-review-contract': 'standard',
  verifier: 'standard',
  'p0-infra': 'fast',
  'p3-selftest': 'fast',
  'p5-interface': 'fast',
  'p5-datapath': 'fast',
  'p5-timing': 'fast',
  'p5-synthesis': 'fast',
  'p8-report': 'fast',
});

function resolveWorkflowModelTier(options = {}) {
  if (options && ['deep', 'standard', 'fast'].includes(options.modelTier)) return options.modelTier;
  const label = String(options?.label || '');
  if (Object.hasOwn(WORKFLOW_MODEL_TIERS, label)) return WORKFLOW_MODEL_TIERS[label];
  if (label.startsWith('debug-')) return 'deep';
  if (label.startsWith('rtl-code-')) return 'standard';
  if (label.startsWith('final-verify-')) return 'fast';
  return 'standard';
}

const DEFAULT_TIER = 'normal';
const TIER_ORDER = ['tight', 'normal', 'relaxed', 'full'];

const WORKFLOW_BUDGETS = Object.freeze({handoff:1000, repair:4000, decision:8000});

function workflowJson(value) {
  return JSON.stringify(value, function validateField(key, field) {
    const original = this[key];
    if (original && typeof original === 'object' &&
        (typeof original.toJSON === 'function' ||
         (!Array.isArray(original) && Object.prototype.toString.call(original) !== '[object Object]'))) {
      throw new TypeError('Workflow context objects must contain plain JSON data');
    }
    if (typeof field === 'undefined' || typeof field === 'function' || typeof field === 'symbol'
        || (typeof field === 'number' && !Number.isFinite(field))) {
      throw new TypeError('Workflow context fields must be losslessly representable as JSON');
    }
    return field;
  });
}

/**
 * Pack one decision for any workflow host. Required fields and evidence locators
 * always survive. Evidence summaries are optional and ordered by caller priority.
 * Full artifacts stay at ref. The token estimate covers only this emitted prompt.
 * Hosts may pass a receipt only after delivery, with historyAvailable:true and a
 * scope unique to this run, recipient and uninterrupted conversation.
 */
function buildWorkflowContext({kind, required, evidence = [], scope = ''}, options = {}) {
  if (!Object.hasOwn(WORKFLOW_BUDGETS, kind)) throw new TypeError('Unknown workflow context kind');
  if (!required || typeof required !== 'object' || Array.isArray(required) || !Object.keys(required).length) {
    throw new TypeError('A workflow decision requires named mandatory fields');
  }
  if (typeof scope !== 'string' || !Array.isArray(evidence)) throw new TypeError('Invalid workflow evidence or scope');
  const budgetTokens = options.budgetTokens ?? WORKFLOW_BUDGETS[kind];
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) throw new RangeError('Invalid workflow token budget');

  const previous = options.previous;
  const continuous = options.historyAvailable === true && scope && previous?.scope === scope && previous.kind === kind;
  const prior = new Map(continuous ? previous.shown : []);
  const summaries = new Map();
  const refs = [];
  for (const {id, ref, summary} of evidence) {
    if (typeof id !== 'string' || !id.trim() || typeof ref !== 'string' || !ref.trim()) {
      throw new TypeError('Evidence requires a nonempty id and retrievable ref');
    }
    const encoded = summary === undefined ? undefined : workflowJson(summary);
    if (summaries.has(id)) {
      const existing = summaries.get(id);
      if (existing.ref !== ref || existing.encoded !== encoded) throw new Error('Conflicting workflow evidence ID: ' + id);
      continue;
    }
    refs.push({id, ref});
    summaries.set(id, {ref, summary, encoded});
  }

  const body = {kind, required, evidence:refs};
  let utf8Bytes = Buffer.byteLength(workflowJson(body));
  const shown = [];
  for (const item of refs) {
    const {summary, encoded} = summaries.get(item.id);
    if (encoded === undefined) continue;
    const digest = createHash('sha256').update(workflowJson([item.ref, summary])).digest('hex');
    if (prior.get(item.id) !== digest) {
      const extra = Buffer.byteLength(',"summary":' + encoded);
      if (Math.ceil((utf8Bytes + extra) / 3) > budgetTokens) continue;
      utf8Bytes += extra;
      item.summary = summary;
    }
    shown.push([item.id, digest]);
  }
  const prompt = workflowJson(body);
  const estimatedInputTokens = Math.ceil(utf8Bytes / 3);
  const overBudget = estimatedInputTokens > budgetTokens;
  return {
    prompt, receipt:{kind, scope, shown},
    metrics:{budgetTokens, utf8Bytes, estimatedInputTokens, estimateMethod:'ceil(utf8Bytes/3)', overBudget,
      expansion:overBudget ? {reason:'required-fields-and-evidence-refs', effectiveBudgetTokens:estimatedInputTokens,
        additionalEstimatedTokens:estimatedInputTokens-budgetTokens, requiredFields:Object.keys(required)} : null},
  };
}

// Normalized, per-response observations from all participants in an acceptance item.
// Adapters must separate cache hits from uncached input; cumulative session counters
// and plugin-prompt estimates cannot be used as measured per-response usage.
function summarizeWorkflowUsage(observations) {
  const fields = ['uncachedInputTokens','cachedInputTokens','outputTokens'];
  const calls = new Map();
  const reportedDispatches = new Set();
  for (const {acceptanceId, executor, callId, usage, evidenceReads, estimatedInputTokens, reason, dispatchId, provenance} of observations) {
    const identity = [acceptanceId, executor, callId];
    if (identity.some(id => typeof id !== 'string' || !id.trim())) throw new TypeError('Missing workflow usage identity');
    const key = JSON.stringify(identity);
    const call = calls.get(key) || {acceptanceId};
    if (dispatchId) {
      const dispatch = JSON.stringify([acceptanceId,dispatchId]);
      if (provenance === 'unreported-dispatch') call.placeholder = dispatch;
      else reportedDispatches.add(dispatch);
    }
    if (usage != null) {
      if (fields.some(field => !Number.isSafeInteger(usage[field]) || usage[field] < 0)) {
        throw new TypeError('Measured usage requires three disjoint non-negative token counts');
      }
      if (call.usage && fields.some(field => call.usage[field] !== usage[field])) throw new Error('Conflicting measured usage for ' + key);
      call.usage = usage;
    }
    if (estimatedInputTokens != null) {
      if (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0 ||
          (call.estimate != null && call.estimate !== estimatedInputTokens)) throw new TypeError('Invalid or conflicting prompt estimate');
      call.estimate = estimatedInputTokens;
    }
    if (evidenceReads != null) {
      if (!Number.isSafeInteger(evidenceReads) || evidenceReads < 0 ||
          (call.evidenceReads != null && call.evidenceReads !== evidenceReads)) {
        throw new TypeError('Invalid or conflicting per-response evidenceReads');
      }
      call.evidenceReads = evidenceReads;
    }
    if (reason === 'unchanged-wait') call.unchangedWait = true;
    calls.set(key, call);
  }
  const groups = new Map();
  for (const call of calls.values()) {
    if (call.placeholder && reportedDispatches.has(call.placeholder)) continue;
    const row = groups.get(call.acceptanceId) || {acceptanceId:call.acceptanceId, calls:0, unchangedWaitCalls:0,
      measuredCalls:0, measuredSubtotal:null, estimatedCalls:0, estimatedPromptSubtotal:null,
      evidenceReadsReportedCalls:0,evidenceReadsSubtotal:null};
    row.calls++;
    if (call.unchangedWait) row.unchangedWaitCalls++;
    if (call.usage) {
      row.measuredCalls++;
      row.measuredSubtotal ??= Object.fromEntries(fields.map(field => [field, 0]));
      for (const field of fields) row.measuredSubtotal[field] += call.usage[field];
    }
    if (call.estimate != null) {
      row.estimatedCalls++;
      row.estimatedPromptSubtotal = (row.estimatedPromptSubtotal ?? 0) + call.estimate;
    }
    if (call.evidenceReads != null) {
      row.evidenceReadsReportedCalls++;
      row.evidenceReadsSubtotal = (row.evidenceReadsSubtotal ?? 0) + call.evidenceReads;
    }
    groups.set(call.acceptanceId, row);
  }
  return [...groups.values()].map(row => ({...row, measuredTotal:row.calls === row.measuredCalls ? row.measuredSubtotal : null,
    evidenceReadsTotal:row.calls === row.evidenceReadsReportedCalls ? row.evidenceReadsSubtotal : null}));
}

// ── Agent Compression Bridge ─────────────────────────────────────────────
// Path to ECC's agent-compress.js
let _agentCompress = null;

function resolveAgentCompress() {
  if (_agentCompress) return _agentCompress;

  // Search paths for agent-compress.js
  const searchPaths = [
    varPath('plugins', 'marketplaces', 'ecc', 'scripts', 'lib', 'agent-compress.js'),
    varPath('plugins', 'marketplaces', 'everything-claude-code', 'scripts', 'lib', 'agent-compress.js'),
  ];

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      try {
        _agentCompress = require(p);
        return _agentCompress;
      } catch (_e) {
        // try next path
      }
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Get the budget tier for an agent type.
 * @param {string} agentType
 * @returns {string} tier label ('tight' | 'normal' | 'relaxed' | 'full')
 */
function getTier(agentType) {
  const key = (agentType || '').toLowerCase().trim();
  return AGENT_BUDGETS[key] || DEFAULT_TIER;
}

/**
 * Get full tier config object.
 * @param {string} agentType
 * @returns {object} tier config
 */
function getTierConfig(agentType) {
  const tier = getTier(agentType);
  return { ...TIERS[tier], name: tier };
}

/**
 * Get max prompt chars for an agent type.
 * @param {string} agentType
 * @returns {number}
 */
function getMaxChars(agentType) {
  const tier = getTier(agentType);
  return TIERS[tier].maxPromptChars;
}

/**
 * Progressive compression: if prompt exceeds budget, apply increasingly
 * aggressive compression until it fits.
 *
 * @param {string} prompt - Assembled prompt
 * @param {string} agentType
 * @param {object} [options]
 * @param {string} [options.tier] - Override tier
 * @returns {{ prompt: string, compressed: boolean, tier: string, chars: number }}
 */
function compressPrompt(prompt, agentType, options = {}) {
  const tierLabel = options.tier || getTier(agentType);
  const config = { ...TIERS[tierLabel] };
  let result = prompt;
  let compressed = false;
  const steps = [];

  // Step 1: Try current tier
  if (result.length <= config.maxPromptChars) {
    return {
      prompt: result,
      compressed: false,
      tier: tierLabel,
      chars: result.length,
    };
  }

  // Step 2: Escalate through tighter tiers
  const currentIdx = TIER_ORDER.indexOf(tierLabel);
  const escalationPath = TIER_ORDER.slice(0, currentIdx).reverse(); // tighter tiers first

  for (const tighterTier of escalationPath) {
    const tighterConfig = TIERS[tighterTier];
    let tierResult = result;

    // Remove soul section
    if (!tighterConfig.enableSoul) {
      tierResult = removeSection(tierResult, '## Agent Personality');
      tierResult = removeSection(tierResult, '## Soul');
      steps.push(`removed-soul-for-${tighterTier}`);
    }

    // Remove constitution
    if (!tighterConfig.enableConstitution) {
      tierResult = removeSection(tierResult, '## Agent Constitution');
      tierResult = removeSection(tierResult, '## Dynamic behaviour rules');
      steps.push(`removed-constitution-for-${tighterTier}`);
    }

    // Remove entity graph
    if (!tighterConfig.enableEntityGraph) {
      tierResult = removeSection(tierResult, '### Entity Graph');
      tierResult = removeSection(tierResult, '### Entity Graph (SQLite)');
      steps.push(`removed-entity-graph-for-${tighterTier}`);
    }

    // Remove memory sections
    if (!tighterConfig.enableMemory) {
      tierResult = removeSection(tierResult, '## Memory Context (Auto-Loaded)');
      tierResult = removeSection(tierResult, '### Relevant Memories');
      tierResult = removeSection(tierResult, '### Semantic Matches');
      tierResult = removeSection(tierResult, '### Task-Relevant Memory');
      steps.push(`removed-memory-for-${tighterTier}`);
    }

    // Truncate skill section to names_only
    if (tighterConfig.skillSectionMode === 'names_only') {
      tierResult = replaceSkillsSection(tierResult);
      steps.push(`skills-names-only-for-${tighterTier}`);
    }

    if (tierResult.length <= tighterConfig.maxPromptChars) {
      result = tierResult;
      compressed = true;
      steps.push(`fits-in-${tighterTier}`);
      return { prompt: result, compressed: true, tier: tighterTier, chars: result.length, steps };
    }

    result = tierResult;
  }

  // Step 3: Last resort — hard truncation at the tightest budget
  if (result.length > TIERS.tight.maxPromptChars) {
    const maxChars = TIERS.tight.maxPromptChars;
    const truncNotice = '\n\n[CONTEXT BUDGET EXCEEDED — prompt truncated]';
    const keep = Math.max(0, maxChars - truncNotice.length);
    result = result.slice(0, keep) + truncNotice;
    steps.push('hard-truncated');
  }

  return { prompt: result, compressed: true, tier: 'tight', chars: result.length, steps };
}

/**
 * Inject self-compaction instruction into agent prompt.
 * Tells the agent to manage its own context during execution.
 *
 * @param {string} prompt
 * @param {string} agentType
 * @returns {string}
 */
function injectSelfCompactInstruction(prompt, agentType) {
  const tier = getTier(agentType);
  const config = TIERS[tier];

  if (!config.selfCompactPrompt) return prompt;

  const instruction = `

## Context Budget

Your context window is limited. To avoid running out of space AND to prevent re-doing work already completed:

- **Keep a concise "已完成" log** at the top of your scratchpad: what you've tried, what worked, what didn't. Refer to it before attempting a fix.
- **Do not re-debug**: if a fix was already attempted and failed, mark it in your log and move to the next approach — do not retry the same thing without new evidence.
- **Re-read the constitution/rules** periodically: the sections \`## Agent Constitution\` and \`## Dynamic behaviour rules\` define your hard constraints. If you feel uncertain, look there first, not at the bottom of context.
- Be concise in tool calls and responses. Summarize intermediate results instead of keeping full output.
- If you receive a compaction signal, continue from the summary — your "已完成" log should survive compaction.
- Current budget tier: **${tier}** (max ${config.maxPromptChars} chars initial prompt)
`;

  return prompt + instruction;
}

/**
 * Build a compressed agent catalog string for inclusion in spawn prompts.
 * Uses ECC's agent-compress.js if available.
 *
 * @param {string} agentType - The requesting agent type (determines compression depth)
 * @returns {string} Compressed agent catalog markdown, or empty string if unavailable
 */
function buildCompressedAgentCatalog(agentType) {
  const ac = resolveAgentCompress();
  if (!ac) return '';

  const tier = getTier(agentType);
  const config = TIERS[tier];

  const agentsRoot = path.join(HARNESS_ROOT, 'skills', 'agents');
  if (!fs.existsSync(agentsRoot)) return '';

  try {
    const allAgents = [];
    const subdirs = fs.readdirSync(agentsRoot)
      .filter(f => fs.statSync(path.join(agentsRoot, f)).isDirectory());

    for (const subdir of subdirs) {
      const dirPath = path.join(agentsRoot, subdir);
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const agent = parseAgentFile(path.join(dirPath, file));
        if (agent && agent.description) allAgents.push(agent);
      }
    }

    if (allAgents.length === 0) return '';

    let compressed;
    if (config.agentMode === 'catalog') {
      compressed = allAgents.map(a => ({ name: a.name, description: a.description, tools: a.tools, model: a.model }));
    } else if (config.agentMode === 'summary') {
      compressed = allAgents.map(a => ({
        name: a.name, description: a.description, tools: a.tools, model: a.model,
        summary: ac.extractSummary(a.body, 1),
      }));
    } else {
      compressed = allAgents;
    }

    const lines = compressed.map(a => {
      const cleanDesc = String(a.description || '').trim();
      if (!cleanDesc) return null;
      const cleanSummary = String(a.summary || '').trim();
      let entry = `- **${a.name}**: ${cleanDesc}`;
      if (cleanSummary) entry += ` — ${cleanSummary}`;
      if (Array.isArray(a.tools) && a.tools.length > 0) {
        entry += ` (tools: ${a.tools.join(', ')})`;
      }
      return entry;
    }).filter(Boolean);

    return lines.length > 0
      ? `## Available Agents (Compressed)\n${lines.join('\n')}\n`
      : '';
  } catch (_e) {
    return '';
  }
}

/**
 * Parse agent file frontmatter.
 * Pre-processes YAML block scalars (folded >-, >+, literal |-) into inline values,
 * then delegates to ECC's simple parser for the remaining flat key-value pairs.
 */
function parseAgentFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const bodyMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
    if (!bodyMatch) return null;

    let yamlText = bodyMatch[1];
    const body = (bodyMatch[2] || '').trim();
    const fileName = path.basename(filePath, '.md');

    // Normalize line endings and strip trailing spaces
    yamlText = yamlText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Step 1: Flatten folded block scalars (>- / >+ / >) and literal blocks (|- / |+ / |)
    // Pattern: key: >-\n  continuation\n  more
    // Regex matches block scalar header then indented continuation lines until a non-indented line
    yamlText = yamlText.replace(
      /^(\s*[\w-]+):\s*(>-|>\+|>|\|-|\|\+|\|)\s*\n((?:(?![^\n]*:)[^\n]*\n?)*)/gm,
      (match, key, indicator, continuation) => {
        if (!continuation) return `${key}: ''`;
        // Only keep lines that are indented by at least 2 spaces (the block scalar content)
        const contentLines = continuation.split('\n')
          .filter(line => /^\s{2,}/.test(line))
          .map(line => line.trimEnd());
        if (contentLines.length === 0) return `${key}: ''`;
        const folded = contentLines.join(' ').replace(/\s+/g, ' ').trim();
        return `${key}: ${folded}`;
      }
    );

    // Step 2: Simple flat key:value parser (no nested structures)
    const frontmatter = {};
    for (const line of yamlText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      // Handle YAML lists (tools: → - Read\n - Write) - skip list items
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1 || colonIdx === 0) continue;
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        try { value = JSON.parse(value); } catch (_e) { /* keep string */ }
      }
      frontmatter[key] = value;
    }

    return {
      fileName,
      name: frontmatter.name || fileName,
      description: String(frontmatter.description || ''),
      tools: Array.isArray(frontmatter.tools) ? frontmatter.tools : [],
      model: frontmatter.model || 'sonnet',
      body,
      byteSize: Buffer.byteLength(content, 'utf8'),
    };
  } catch (_e) {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function removeSection(text, header) {
  if (!text.includes(header)) return text;
  const start = text.indexOf(header);
  // Find next section at same or higher level
  const nextSection = text.indexOf('\n## ', start + header.length);
  if (nextSection === -1) {
    return text.slice(0, start).trimEnd();
  }
  return (text.slice(0, start) + '\n' + text.slice(nextSection)).trim();
}

function replaceSkillsSection(text) {
  // Find the skills section and replace with compact version
  const skillsStart = text.indexOf('## AVAILABLE_SKILLS');
  if (skillsStart === -1) return text;

  const skillsEnd = text.indexOf('## ', skillsStart + '## AVAILABLE_SKILLS'.length);
  if (skillsEnd === -1) return text;

  return text.slice(0, skillsStart) +
    '## AVAILABLE_SKILLS (Compact)\nSee `packs/fpga/engineering-assets/knowledge/references/skills-catalog.md` for full list.\n' +
    text.slice(skillsEnd);
}

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'tier':
      console.log(getTierConfig(args[1] || ''));
      break;
    case 'max-chars':
      console.log(getMaxChars(args[1] || ''));
      break;
    case 'list':
      console.log(JSON.stringify(AGENT_BUDGETS, null, 2));
      break;
    case 'workflow-usage': {
      const inputs = args.length > 1 ? args.slice(1) : ['-'];
      const observations = inputs.flatMap(file => fs.readFileSync(file === '-' ? 0 : file, 'utf8')
        .split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)));
      console.log(JSON.stringify(summarizeWorkflowUsage(observations), null, 2));
      break;
    }
    case 'compress': {
      // Read prompt from stdin, compress and output
      let input = '';
      try {
        input = fs.readFileSync(0, 'utf8');
      } catch (_e) {
        input = '';
      }
      const agentType = args[1] || 'developer';
      const result = compressPrompt(input, agentType, { tier: args[2] });
      if (args.includes('--stats')) {
        console.log(JSON.stringify({ chars: result.chars, tier: result.tier, compressed: result.compressed }));
      } else {
        process.stdout.write(result.prompt);
      }
      break;
    }
    case 'catalog': {
      const agentType = args[1] || 'developer';
      const catalog = buildCompressedAgentCatalog(agentType);
      if (catalog) {
        const stats = { lines: catalog.split('\n').length };
        if (args.includes('--stats')) {
          console.log(JSON.stringify({ content: catalog, ...stats }));
        } else {
          console.log(catalog);
        }
      }
      break;
    }
    default:
      console.log(`Usage:
  node agent-context-budget.cjs tier <agentType>       — show budget config
  node agent-context-budget.cjs max-chars <agentType>  — show max chars
  node agent-context-budget.cjs list                    — list all budgets
  node agent-context-budget.cjs compress <type> [tier]  — compress prompt from stdin
  node agent-context-budget.cjs catalog <type>          — build compressed catalog
  node agent-context-budget.cjs workflow-usage [jsonl ...] — aggregate per-response observations by acceptance item`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildWorkflowContext,
  summarizeWorkflowUsage,
  WORKFLOW_MODEL_TIERS,
  resolveWorkflowModelTier,
  TIERS,
  AGENT_BUDGETS,
  getTier,
  getTierConfig,
  getMaxChars,
  compressPrompt,
  injectSelfCompactInstruction,
  buildCompressedAgentCatalog,
  resolveAgentCompress,
};
