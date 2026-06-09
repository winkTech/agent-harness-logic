---
name: handoff
tier: foundation
runtime: on-demand
trigger: mention
argument-hint: "(optional) focus for the next session — used to trim next_3_steps + Suggested Skills"
description: "Session wrap-up ritual: update the active plan / next-state file + write a session log + capture memory. Skipping = the next session loses context. Trigger: end / wrap up / handoff / hand over / save progress / call it for today / session end / 结束 / 收工 / 交接 / 保存进度 / 今天到这 / session结束. Skip: commit code (/commit) / start a new session (/start)."
metadata:
  source: xihe
  version: "8.0.0"
---
# /handoff — Session Wrap-Up

> Single Fast Path, target ≤ 4 tool calls. Body trimmed; templates/internals in `references/`, read on demand.
>
> The next-state file (e.g. `_NEXT.md`) is a prose block, not a yaml fence → Edit the top block directly. Memory flush runs in the background and never blocks.

## Trigger / Input

`/handoff` or `/handoff <focus>`. `<focus>` = the next session's focus → trim next_3_steps + Suggested Skills accordingly. No arg → auto-generate from session activity.

## Three threading principles (directly lowers tokens)

1. **Reference, don't duplicate** — the session log / next-state file references the **path/URL** of an existing artifact (commit sha / plan path / ADR / diff / previous session log), never inlines its content. Write **why**; git diff already has the **what**.
2. **Redact** — in the session log, mask secrets / API key / token / HMAC / PII. On a hit write `<redacted:kind>`.
3. **Suggested Skills** — the report contains a section: which skills the next agent should invoke first (per `<focus>` + current gate).

---

## Fast Path (≤ 4 tool calls)

### Step 1: Gather (1 message)

```bash
cd "$(git rev-parse --show-toplevel)" && \
echo "=LOG=" && git log --oneline -5 && \
echo "=STATUS=" && git status --short --branch && \
echo "=DIFF_STAT=" && git diff --stat "$(git rev-parse origin/main 2>/dev/null || echo HEAD~1)"..HEAD
```
\+ Read `~/.claude/var/active-task.yaml` (任务协议, YAML 格式) — the single source of current state (plan, next steps, blocked on, cognitive state).

### Step 2: Analyze (pure reasoning, 0 IO)

- **2a Summary**: feature / last_session_summary (1-2 sentences) / blocked_on / next_3_steps (verb+object; if there is a `<focus>`, align to it)
- **2b Gap**: the next-state file's original next_3_steps vs actual → DONE / PARTIAL / SKIPPED / UNPLANNED
- **2c Wisdom candidates**: only scan for explicit `wisdom: <title>` markers in the session (record only on a hit, default 0; protocol in references)
- **2d Slug**: feature → lowercase-hyphenated

### Step 3: Write (2 calls — next-state first, log second)

**3a Update task protocol (Edit)** — update `var/active-task.yaml` fields:
- `active_plan`: keep or update if focus changed
- `completed_steps`: prepend new items
- `next_3_steps`: rewrite based on current progress + optional `<focus>`
- `blocked_on`: update
- `cognitive`: update failure_count / current_mode / tried_approaches
- `recent_log`: prepend a line for this session's key decisions

Use Edit tool to update specific YAML fields. Keep the YAML structure intact — do not convert to markdown.

**3b Session Log (Write)** — `~/.claude/var/work/{date}-{slug}.md`. Template at `var/work/TEMPLATE.md`. Reference-don't-duplicate + redact.

### Step 3.4 Claim-Evidence Gate (pure reasoning, no test re-run, no script)

Scan completion-claim keywords (done/merged/deleted/fixed/passed · 完成/合并/删除/修复/通过) against Step 1's git diff-stat. No match → mark `⚠ CLAIM-UNVERIFIED: {claim}` in Step 5. No keywords → skip. Rules table in references.

### Step 4: Memory flush (1 message, background)

Run memory-track in background (non-blocking):
```bash
cd "$(git rev-parse --show-toplevel)" && ( bash ~/.claude/engine/scripts/hooks/memory-track.sh post-message > /dev/null 2>&1 & disown )
```
If memory-track.sh is not available, skip Step 4.

### Step 5: Report (≤ 15 lines)

```
## Session Handoff — {date}
### {last_session_summary}
### Gap   | # | Goal | ✅/🔸/⏭️ | Note |
### Next  1. … 2. … 3. …
### Suggested Skills   (per <focus> + gate)
- Next session first: {/start, then X}
### Wisdom (if any) — [{type}] {title}
### Claim-Evidence (only ⚠ unverified)
### {clean / suggest /commit / /verify / /review}
```
**Gate**: ≥3 source files changed → suggest `/review`; ≥5 files + cross-layer/migration → suggest `/review --release-gate`.

---

## Constraints

- Tool calls ≤ 4 (gather 1 + write 2 + flush 1); report ≤ 15 lines
- **Never auto-commit** — exception: when the user explicitly says "push"/"commit" this turn, committing the session log (docs commit) and pushing is an owner instruction, not auto
- Wisdom is triggered only by an explicit `wisdom:` marker in the session; handoff does not decide on its own
- Worktree: only write the per-branch next-state file, never touch the master one
- Memory flush never blocks (it handles empty pending / embed failure internally)
- **No abort-on-fail**: both the next-state Edit and the log Write are native tools — they error on failure and never leave partial state
- Applying the three principles (reference-not-duplicate / redact / suggested-skills) is the core of lowering tokens

---

## References (read on demand)

- `var/work/TEMPLATE.md` — session log template (Step 3b)
