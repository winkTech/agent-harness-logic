#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOME = path.join(os.homedir(), '.claude');
const MEMORY_DIR = path.join(HOME, 'memory');
const KNOWLEDGE_DIR = path.join(HOME, 'knowledge');
const STATE_DIR = path.join(HOME, 'var', 'maintenance');
const STATE_FILE = path.join(STATE_DIR, 'memory-knowledge-maintenance.json');

const DEFAULTS = {
  intervalDays: 7,
  workDays: 14,
  autoWorkDays: 7,
  abandonedWorkDays: 45,
  errorDays: 90,
  projectDays: 30,
  sourceDays: 365,
  largeSourceBytes: 250_000,
  maxSnippetChars: 240,
};

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { ...DEFAULTS, execute: false, dryRun: true, auto: false, force: false, json: false, reindex: true };
  const aliases = {
    'interval-days': 'intervalDays',
    'work-days': 'workDays',
    'auto-work-days': 'autoWorkDays',
    'abandoned-work-days': 'abandonedWorkDays',
    'error-days': 'errorDays',
    'project-days': 'projectDays',
    'source-days': 'sourceDays',
    'large-source-bytes': 'largeSourceBytes',
    'max-snippet-chars': 'maxSnippetChars',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') { opts.execute = true; opts.dryRun = false; }
    else if (a === '--dry-run') { opts.execute = false; opts.dryRun = true; }
    else if (a === '--auto') opts.auto = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--no-reindex') opts.reindex = false;
    else if (a.startsWith('--')) {
      const rawKey = a.slice(2);
      const key = aliases[rawKey] || rawKey;
      if (!Object.prototype.hasOwnProperty.call(opts, key)) continue;
      const raw = argv[++i];
      const val = Number(raw);
      if (!Number.isFinite(val)) throw new Error(`${a} expects a number`);
      opts[key] = val;
    }
  }
  return opts;
}

function todayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function parseFrontmatter(content) {
  const out = {};
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function walkMd(root, files = []) {
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkMd(full, files);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function extractDate(filePath, content) {
  const fm = parseFrontmatter(content);
  const raw = fm.updated || fm.date || fm.created || '';
  const fmMatch = String(raw).match(/\d{4}-\d{2}-\d{2}/);
  if (fmMatch) return fmMatch[0];
  const nameMatch = path.basename(filePath).match(/\d{4}-\d{2}-\d{2}/);
  if (nameMatch) return nameMatch[0];
  try { return new Date(fs.statSync(filePath).mtimeMs).toISOString().slice(0, 10); } catch { return null; }
}

function daysOld(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

function isCompleted(content) {
  return /status\s*:\s*(completed|complete|done|完成|已完成)/i.test(content);
}

function isAutoWorkRecord(filePath) {
  return /tool_success_|hook_failure_|tool_failure_|auto-record/i.test(path.basename(filePath));
}

function firstHeading(content) {
  const body = String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
  const line = body.split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith('>'));
  return (line || '').replace(/^#+\s*/, '').trim();
}

function snippet(content, max = DEFAULTS.maxSnippetChars) {
  return String(content || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function rel(filePath, root = HOME) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function shouldRun(opts, now = new Date()) {
  if (!opts.auto || opts.force) return { run: true, reason: opts.force ? 'forced' : 'manual' };
  const state = loadState();
  const last = state.lastExecutedAt || state.lastDryRunAt;
  if (!last) return { run: true, reason: 'no previous run' };
  const ageDays = (now.getTime() - Date.parse(last)) / 86_400_000;
  if (ageDays >= opts.intervalDays) return { run: true, reason: `last run ${Math.floor(ageDays)}d ago` };
  return { run: false, reason: `last run ${Math.floor(ageDays)}d ago < interval ${opts.intervalDays}d` };
}

function collectMemoryCandidates(opts, now = new Date()) {
  const candidates = [];

  const add = (filePath, kind, reason, ageDays, content) => {
    candidates.push({
      kind,
      file: rel(filePath),
      ageDays,
      reason,
      title: firstHeading(content) || path.basename(filePath, '.md'),
      snippet: snippet(content, opts.maxSnippetChars),
      absolutePath: filePath,
    });
  };

  const workDir = path.join(MEMORY_DIR, 'work');
  for (const filePath of walkMd(workDir)) {
    if (path.basename(filePath) === 'TEMPLATE.md') continue;
    const content = readText(filePath);
    const age = daysOld(extractDate(filePath, content), now);
    if (age === null) continue;
    if (isAutoWorkRecord(filePath) && age >= opts.autoWorkDays) add(filePath, 'work-auto', 'auto work record past retention', age, content);
    else if (isCompleted(content) && age >= opts.workDays) add(filePath, 'work-completed', 'completed work memory past retention', age, content);
    else if (!isCompleted(content) && age >= opts.abandonedWorkDays) add(filePath, 'work-stale-open', 'open work memory is stale; report only', age, content);
  }

  const errorsDir = path.join(MEMORY_DIR, 'errors');
  for (const filePath of walkMd(errorsDir)) {
    if (path.basename(filePath) === 'ERROR_TEMPLATE.md') continue;
    const content = readText(filePath);
    const age = daysOld(extractDate(filePath, content), now);
    if (age !== null && age >= opts.errorDays) add(filePath, 'error-old', 'error record past retention; compact to archive', age, content);
  }

  const projectsDir = path.join(MEMORY_DIR, 'projects');
  for (const filePath of walkMd(projectsDir)) {
    const content = readText(filePath);
    const age = daysOld(extractDate(filePath, content), now);
    if (age !== null && isCompleted(content) && age >= opts.projectDays) add(filePath, 'project-completed', 'completed project memory past retention', age, content);
  }

  return candidates;
}

function collectKnowledgeCandidates(opts, now = new Date()) {
  const candidates = [];
  const sourceDir = path.join(KNOWLEDGE_DIR, 'archive', 'sources');
  for (const filePath of walkMd(sourceDir)) {
    const content = readText(filePath);
    const age = daysOld(extractDate(filePath, content), now);
    const sizeBytes = fs.statSync(filePath).size;
    if ((age !== null && age >= opts.sourceDays) || sizeBytes >= opts.largeSourceBytes) {
      candidates.push({
        kind: 'literature-source',
        file: rel(filePath),
        ageDays: age,
        sizeBytes,
        reason: sizeBytes >= opts.largeSourceBytes ? 'large archived source' : 'old archived source',
        title: firstHeading(content) || path.basename(filePath, '.md'),
      });
    }
  }
  return candidates;
}

function ensureInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw new Error(`refusing path outside ${r}: ${t}`);
  }
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let i = 1; i < 1000; i++) {
    const next = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(next)) return next;
  }
  throw new Error(`cannot find unique path for ${filePath}`);
}

function moveToArchive(candidate, runId) {
  const source = candidate.absolutePath;
  ensureInside(MEMORY_DIR, source);
  const rawRoot = path.join(MEMORY_DIR, 'archive', 'maintenance', 'raw', runId);
  const target = uniquePath(path.join(rawRoot, rel(source, MEMORY_DIR)));
  ensureInside(path.join(MEMORY_DIR, 'archive'), target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  return rel(target);
}

function writeCompactionSummary(memoryCandidates, knowledgeCandidates, moved, runId, opts) {
  if (memoryCandidates.length === 0 && knowledgeCandidates.length === 0) return null;
  const outDir = path.join(MEMORY_DIR, 'archive', 'maintenance');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = uniquePath(path.join(outDir, `${runId}-memory-knowledge-compaction.md`));
  const lines = [
    '---',
    `name: memory-knowledge-compaction-${runId}`,
    `description: Periodic memory and knowledge maintenance summary (${runId})`,
    `created: ${todayStamp()}`,
    'type: maintenance',
    'tags: [maintenance, memory, knowledge, compaction]',
    '---',
    '',
    `# Memory / Knowledge Maintenance ${runId}`,
    '',
    `Mode: ${opts.execute ? 'execute' : 'dry-run'}`,
    '',
    '## Memory Candidates',
    '',
  ];

  if (memoryCandidates.length === 0) lines.push('- None');
  for (const c of memoryCandidates) {
    lines.push(`- ${c.kind}: ${c.file} (${c.ageDays}d) - ${c.reason}`);
    if (moved[c.file]) lines.push(`  - archived_to: ${moved[c.file]}`);
    if (c.title) lines.push(`  - title: ${c.title}`);
    if (c.snippet) lines.push(`  - summary: ${c.snippet}`);
  }

  lines.push('', '## Knowledge Literature Candidates', '');
  if (knowledgeCandidates.length === 0) lines.push('- None');
  for (const c of knowledgeCandidates) {
    lines.push(`- ${c.kind}: ${c.file} (${c.ageDays ?? 'unknown'}d, ${c.sizeBytes} bytes) - ${c.reason}`);
    if (c.title) lines.push(`  - title: ${c.title}`);
  }

  lines.push('');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  return rel(outPath);
}

function sqliteMaintenance(opts) {
  const result = { expiredPurged: 0, archiveFactsLowered: 0, archiveFactsHighConfidence: 0, totalFacts: null };
  try {
    const { openDb } = require('../sqlite/index.cjs');
    const { purgeExpired, memoryStats } = require('../sqlite/store-memory.cjs');
    const wDb = openDb();
    const db = wDb.db;
    result.totalFacts = memoryStats({ db }).total;
    result.archiveFactsHighConfidence = db.prepare(
      "SELECT COUNT(*) AS c FROM facts WHERE namespace = 'archive' AND confidence >= 0.3"
    ).get().c;
    if (opts.execute) {
      result.expiredPurged = purgeExpired({ db });
      const lowered = db.prepare(
        "UPDATE facts SET confidence = 0.25, updated_at = ? WHERE namespace = 'archive' AND confidence >= 0.3"
      ).run(Date.now());
      result.archiveFactsLowered = lowered.changes || 0;
    }
    wDb.close();
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

function rebuildSemanticIndex() {
  const script = path.join(HOME, 'engine', 'scripts', 'semantic-search.cjs');
  const r = spawnSync(process.execPath, [script, 'index', '--rebuild'], {
    cwd: HOME,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function run(opts = parseArgs(), now = new Date()) {
  const gate = shouldRun(opts, now);
  if (!gate.run) {
    return { skipped: true, reason: gate.reason, mode: opts.execute ? 'execute' : 'dry-run' };
  }

  const runId = `${todayStamp(now)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const memoryCandidates = collectMemoryCandidates(opts, now);
  const actionableMemory = memoryCandidates.filter(c => c.kind !== 'work-stale-open');
  const knowledgeCandidates = collectKnowledgeCandidates(opts, now);
  const sqlite = sqliteMaintenance(opts);
  const moved = {};

  if (opts.execute) {
    for (const c of actionableMemory) {
      moved[c.file] = moveToArchive(c, runId);
    }
  }

  const summaryFile = opts.execute ? writeCompactionSummary(memoryCandidates, knowledgeCandidates, moved, runId, opts) : null;
  const reindex = opts.execute && opts.reindex ? rebuildSemanticIndex() : null;

  const lastCounts = {
    memoryCandidates: memoryCandidates.length,
    actionableMemory: actionableMemory.length,
    knowledgeCandidates: knowledgeCandidates.length,
    moved: Object.keys(moved).length,
  };
  if (opts.execute) {
    const state = loadState();
    state.lastExecutedAt = now.toISOString();
    state.lastRunId = runId;
    state.lastSummaryFile = summaryFile;
    state.lastMode = 'execute';
    state.lastCounts = lastCounts;
    saveState(state);
  }

  return {
    skipped: false,
    mode: opts.execute ? 'execute' : 'dry-run',
    reason: gate.reason,
    runId,
    summaryFile,
    counts: lastCounts,
    sqlite,
    reindex,
    memoryCandidates: memoryCandidates.map(({ absolutePath, ...rest }) => rest),
    knowledgeCandidates,
    moved,
  };
}

function printHuman(result) {
  if (result.skipped) {
    console.log(`[memory-knowledge-maintenance] skipped: ${result.reason}`);
    return;
  }
  console.log(`[memory-knowledge-maintenance] ${result.mode} ${result.runId}`);
  console.log(`  memory candidates: ${result.counts.memoryCandidates} (actionable ${result.counts.actionableMemory}, moved ${result.counts.moved})`);
  console.log(`  literature candidates: ${result.counts.knowledgeCandidates}`);
  console.log(`  sqlite: expired purged=${result.sqlite.expiredPurged}, archive lowered=${result.sqlite.archiveFactsLowered}, archive high confidence=${result.sqlite.archiveFactsHighConfidence}`);
  if (result.summaryFile) console.log(`  summary: ${result.summaryFile}`);
  if (result.reindex) console.log(`  semantic index: exit=${result.reindex.status}`);
}

if (require.main === module) {
  try {
    const opts = parseArgs();
    const result = run(opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (result.reindex && result.reindex.status !== 0) process.exit(1);
  } catch (err) {
    console.error(`[memory-knowledge-maintenance] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  collectMemoryCandidates,
  collectKnowledgeCandidates,
  run,
};
