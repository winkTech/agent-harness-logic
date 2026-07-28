#!/usr/bin/env node
// Claude Code status line — Dracula theme (Node port of statusline.sh, no jq dependency)
// Shows: model | context bar + tokens | 5h/7d plan usage | cost | effort | dir | git branch
'use strict';

const RST = '\x1b[0m';
const C_MODEL = '\x1b[38;2;189;147;249m';
const C_CTX_OK = '\x1b[38;2;80;250;123m';
const C_CTX_WARN = '\x1b[38;2;241;250;140m';
const C_CTX_LOW = '\x1b[38;2;255;85;85m';
const C_BAR_EMPTY = '\x1b[38;2;68;71;90m';
const C_DIR = '\x1b[38;2;139;233;253m';
const C_GIT = '\x1b[38;2;255;184;108m';
const C_GIT_DIRTY = '\x1b[38;2;241;250;140m';
const C_STYLE = '\x1b[38;2;189;147;249m';
const C_COST = '\x1b[38;2;255;215;0m';
const C_EFFORT_HIGH = '\x1b[1;38;2;255;85;85m';
const C_EFFORT_MED = '\x1b[38;2;241;250;140m';
const C_EFFORT_LOW = '\x1b[38;2;80;250;123m';
const C_EFFORT_OFF = '\x1b[2;38;2;98;114;164m';
const C_SEP = '\x1b[38;2;98;114;164m';
const SEP = C_SEP + ' | ' + RST;

function pctColor(usedPct) {
  if (usedPct >= 80) return C_CTX_LOW;
  if (usedPct >= 50) return C_CTX_WARN;
  return C_CTX_OK;
}

function fmtK(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw); } catch (e) {}

  const parts = [];

  // Model
  const model = j.model && j.model.display_name;
  if (model) parts.push(C_MODEL + '◈ ' + model + RST);

  // Context bar
  const cw = j.context_window || {};
  const remaining = cw.remaining_percentage;
  if (remaining != null) {
    const used = Math.min(100, Math.max(0, Math.round(100 - remaining)));
    const filled = Math.floor(used / 5);
    const color = pctColor(used);
    let bar = C_SEP + '[' + RST;
    bar += color + '■'.repeat(filled) + RST;
    bar += C_BAR_EMPTY + '□'.repeat(20 - filled) + RST;
    bar += C_SEP + ']' + RST + ' ' + color + used + '%' + RST;
    if (cw.total_input_tokens != null && cw.context_window_size != null) {
      bar += C_SEP + ' (' + RST + color + fmtK(cw.total_input_tokens) + RST +
             C_SEP + '/' + RST + color + fmtK(cw.context_window_size) + RST + C_SEP + ')' + RST;
    }
    parts.push(bar);
  }

  // Plan usage (Claude.ai Pro/Max rate limits) — absent for API-key sessions
  const rl = j.rate_limits || {};
  const limits = [];
  if (rl.five_hour && rl.five_hour.used_percentage != null) {
    const p = Math.round(rl.five_hour.used_percentage);
    let s = pctColor(p) + '5h ' + p + '%' + RST;
    if (rl.five_hour.resets_at) {
      const d = new Date(rl.five_hour.resets_at * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      s += C_SEP + '↺' + hh + ':' + mm + RST;
    }
    limits.push(s);
  }
  if (rl.seven_day && rl.seven_day.used_percentage != null) {
    const p = Math.round(rl.seven_day.used_percentage);
    limits.push(pctColor(p) + '7d ' + p + '%' + RST);
  }
  if (limits.length) parts.push(limits.join(' '));

  // Cost (API-key sessions)
  const cost = j.cost && j.cost.total_cost_usd;
  if (cost != null && cost >= 0.005) parts.push(C_COST + '$' + cost.toFixed(2) + RST);

  // Effort level from settings (local overrides global)
  const fs = require('fs');
  const path = require('path');
  const home = process.env.HOME || process.env.USERPROFILE || '';
  let effort = '';
  for (const f of ['settings.local.json', 'settings.json']) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', f), 'utf8'));
      if (s.effortLevel) { effort = s.effortLevel; break; }
    } catch (e) {}
  }
  if (effort) {
    const e = effort.toLowerCase();
    const ec = /^(max|xhigh|high)$/.test(e) ? C_EFFORT_HIGH
             : e === 'medium' ? C_EFFORT_MED
             : /^(low|xlow|minimal)$/.test(e) ? C_EFFORT_LOW
             : C_EFFORT_OFF;
    parts.push(ec + '↯ ' + effort + RST);
  }

  // Output style
  const style = j.output_style && j.output_style.name;
  if (style && style !== 'default') parts.push(C_STYLE + '❋ ' + style + RST);

  // Directory (prefer original repo when in a worktree)
  const wt = j.worktree || {};
  const dir = wt.original_repo_dir || (j.workspace && j.workspace.current_dir) || '';
  if (dir) parts.push(C_DIR + '⌂ ' + path.basename(dir) + RST);

  // Git branch
  const cwd = (j.workspace && j.workspace.current_dir) || '';
  let branch = wt.branch || '';
  let dirty = false;
  if (process.env.CLAUDE_STATUSLINE_GIT === '1') {
    try {
      const { execSync } = require('child_process');
      const opt = { cwd: cwd || undefined, encoding: 'utf8', timeout: 750, stdio: ['ignore', 'pipe', 'ignore'] };
      if (!branch) branch = execSync('git --no-optional-locks branch --show-current', opt).trim();
      if (branch) {
        try { execSync('git --no-optional-locks diff --quiet', opt); }
        catch (e) { dirty = true; }
      }
    } catch (e) {}
  }
  if (branch) parts.push((dirty ? C_GIT_DIRTY : C_GIT) + '⎇ ' + branch + RST);

  process.stdout.write(parts.join(SEP));
});
