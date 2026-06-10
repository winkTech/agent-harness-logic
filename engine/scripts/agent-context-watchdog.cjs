#!/usr/bin/env node
/**
 * Agent Context Watchdog
 *
 * Monitors spawned agent context usage and provides:
 *   - Context size reporting (pre/post spawn)
 *   - Self-compaction instruction injection
 *   - Integration with runtime-state.json for tracking
 *   - Can be called from workflow scripts between phases
 *
 * Usage:
 *   node agent-context-watchdog.cjs report [agentType]     — report context budget
 *   node agent-context-watchdog.cjs inject <agentType>     — inject self-compact instruction (stdin)
 *   node agent-context-watchdog.cjs track <agentType>      — record spawn to runtime-state.json
 *   node agent-context-watchdog.cjs status                 — show all tracked agents
 *   node agent-context-watchdog.cjs gc                     — clean up stale entries
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HOMEDIR = require('os').homedir();
const HARNESS_DIR = path.join(HOMEDIR, '.claude');
const STATE_FILE = path.join(HARNESS_DIR, 'var', 'index', 'runtime-state.json');
const AGENTS_DIR = path.join(HARNESS_DIR, 'skills', 'agents');
const STATE_DIR = path.join(HARNESS_DIR, 'var', 'index');

const budget = require('./agent-context-budget.cjs');

// ── State Management ─────────────────────────────────────────────────────

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { spawnedAgents: [] };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { spawnedAgents: Array.isArray(raw.spawnedAgents) ? raw.spawnedAgents : [] };
  } catch (_e) {
    return { spawnedAgents: [] };
  }
}

function writeState(partial) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    let state = {};
    if (fs.existsSync(STATE_FILE)) {
      try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_e) { /* ignore */ }
    }
    Object.assign(state, partial);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (_e) {
    // best-effort
  }
}

// ── Agent Definition Loader ──────────────────────────────────────────────

function loadAgentDef(agentType) {
  if (!agentType) return null;
  const filePath = path.join(AGENTS_DIR, `${agentType}.md`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;

    const frontmatter = {};
    for (const line of fmMatch[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return {
      name: frontmatter.name || agentType,
      description: frontmatter.description || '',
      model: frontmatter.model || '',
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  } catch (_e) {
    return null;
  }
}

// ── Report ───────────────────────────────────────────────────────────────

function reportContextBudget(agentType) {
  const tierConfig = budget.getTierConfig(agentType);
  const agentDef = loadAgentDef(agentType);

  const report = {
    agentType,
    tier: tierConfig.name,
    maxPromptChars: tierConfig.maxPromptChars,
    maxPromptTokens: Math.round(tierConfig.maxPromptChars / 4),
    agentMode: tierConfig.agentMode,
    enableMemory: tierConfig.enableMemory,
    enableEntityGraph: tierConfig.enableEntityGraph,
    enableConstitution: tierConfig.enableConstitution,
    enableSoul: tierConfig.enableSoul,
    selfCompactPrompt: tierConfig.selfCompactPrompt,
  };

  if (agentDef) {
    report.definitionBytes = agentDef.bytes;
    report.definitionTokens = Math.round(agentDef.bytes / 4);
    report.model = agentDef.model;
  }

  return report;
}

// ── Track Spawn ──────────────────────────────────────────────────────────

function trackAgentSpawn(agentType, extra = {}) {
  const state = readState();
  const entry = {
    agentType,
    tier: budget.getTier(agentType),
    maxChars: budget.getMaxChars(agentType),
    timestamp: new Date().toISOString(),
    ...extra,
  };

  state.spawnedAgents = state.spawnedAgents || [];
  state.spawnedAgents.push(entry);

  // Keep last 50 entries
  if (state.spawnedAgents.length > 50) {
    state.spawnedAgents = state.spawnedAgents.slice(-50);
  }

  writeState({ spawnedAgents: state.spawnedAgents });
  return entry;
}

// ── Inject Self-Compact Instruction ──────────────────────────────────────

function injectSelfCompact(agentType, inputPrompt) {
  return budget.injectSelfCompactInstruction(inputPrompt, agentType);
}

// ── Status ───────────────────────────────────────────────────────────────

function showStatus() {
  const state = readState();
  const agents = state.spawnedAgents || [];

  const summary = {
    totalSpawned: agents.length,
    last10: agents.slice(-10).map(a => ({
      agentType: a.agentType,
      tier: a.tier,
      at: a.timestamp,
    })),
    byType: {},
  };

  for (const a of agents) {
    summary.byType[a.agentType] = (summary.byType[a.agentType] || 0) + 1;
  }

  return summary;
}

// ── Health — Human-readable context health summary ────────────────────────

function showHealth() {
  const state = readState();
  const agents = state.spawnedAgents || [];
  const now = Date.now();

  // Stats
  const total = agents.length;
  const last24h = agents.filter(a => now - new Date(a.timestamp).getTime() < 86400000).length;
  const byType = {};
  for (const a of agents) byType[a.agentType] = (byType[a.agentType] || 0) + 1;
  const topTypes = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Recent activity (last 10 min)
  const recent = agents.filter(a => now - new Date(a.timestamp).getTime() < 600000);
  const recentByTier = {};
  for (const a of recent) recentByTier[a.tier] = (recentByTier[a.tier] || 0) + 1;

  const lines = [
    '━━━ Agent Context Health ━━━',
    `  Total spawned:     ${total} (${last24h} in last 24h)`,
    `  Recent (10min):    ${recent.length} spawns`,
    `  Top agent types:   ${topTypes.map(([t, c]) => `${t}(${c})`).join(', ')}`,
    '',
    '  Recent tier distribution:',
  ];

  if (Object.keys(recentByTier).length > 0) {
    for (const [tier, count] of Object.entries(recentByTier)) {
      const bar = '█'.repeat(Math.min(count, 20));
      const budgetCfg = budget.TIERS[tier];
      const maxC = budgetCfg ? budgetCfg.maxPromptChars : '?';
      lines.push(`    ${tier.padEnd(10)} ${String(count).padStart(3)} ${bar}  (max ${maxC} chars)`);
    }
  } else {
    lines.push('    (none — no agents spawned recently)');
  }

  if (total === 0) {
    lines.push('');
    lines.push('  ⚠ No agents tracked yet. Run a workflow to generate data.');
  } else {
    lines.push('');
    lines.push(`  Run \`node agent-context-watchdog.cjs status\` for JSON detail`);
    lines.push(`  Run \`node agent-context-budget.cjs tier <type>\` to check per-type budget`);
  }

  return lines.join('\n');
}

// ── GC — Remove stale entries (older than 24h) ───────────────────────────

function gc() {
  const state = readState();
  const agents = state.spawnedAgents || [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const before = agents.length;
  const filtered = agents.filter(a => new Date(a.timestamp).getTime() > cutoff);
  writeState({ spawnedAgents: filtered });
  return { removed: before - filtered.length, remaining: filtered.length };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case 'report':
      console.log(JSON.stringify(reportContextBudget(args[1] || 'developer'), null, 2));
      break;

    case 'inject': {
      const agentType = args[1] || 'developer';
      let input = '';
      try { input = fs.readFileSync(0, 'utf8'); } catch (_e) { input = ''; }
      process.stdout.write(injectSelfCompact(agentType, input));
      break;
    }

    case 'track':
      console.log(JSON.stringify(trackAgentSpawn(args[1] || 'developer', { source: args[2] || 'workflow' })));
      break;

    case 'status':
      console.log(JSON.stringify(showStatus(), null, 2));
      break;

    case 'health':
      console.log(showHealth());
      break;

    case 'gc':
      console.log(JSON.stringify(gc()));
      break;

    default:
      console.log(`Usage:
  node agent-context-watchdog.cjs report <agentType>    — show budget for agent type
  node agent-context-watchdog.cjs inject <agentType>    — read stdin, add self-compact instruction
  node agent-context-watchdog.cjs track <agentType>     — record agent spawn
  node agent-context-watchdog.cjs status                — show all tracked agents (JSON)
  node agent-context-watchdog.cjs health                — human-readable context health summary
  node agent-context-watchdog.cjs gc                    — clean stale entries (24h)`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  reportContextBudget,
  trackAgentSpawn,
  injectSelfCompact,
  showStatus,
  gc,
  loadAgentDef,
};
