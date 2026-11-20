# Long Task Eval Rules

Before every Bash/Edit/Write/Agent/Workflow action, output this block exactly:

```text
行动: [what you will do]
用户指令: "[exact instruction you are following]"
匹配: ✅ / ⚠️
门禁: 🚦需求澄清[ ✅ / ❌ ] 🧪验证质量[ ✅ / ❌ / N/A ]
```

Abbreviated labels such as `Action`, `Instruction`, `指令`, or a leading symbol
are not compliant. The checklist must be visible immediately before the
controlled tool call.

This applies to Write and Edit exactly as strictly as Bash. TodoWrite, planning
text, and classification text do not satisfy the checklist. After any TodoWrite
or read-only exploration, print the exact four-line block again before the next
Write/Edit/Bash/Agent/Workflow call.

Hard constraints:

- First classify the user request before reading nearby implementation docs:
  `ambiguous_direction`, `implementation_with_spec`, or `debug_existing_failure`.
- If the request is `ambiguous_direction`, stop immediately. Do not reuse the
  README as an implied direction, do not write files, and ask concise questions.
  The response must state `ambiguous_direction` before the questions. The
  clarification response must explicitly cover target data, input format, output
  format/artifact, success criteria, and verification fixture. It must be
  self-contained and use exactly five numbered questions, one for each concept.
- Read `memory/project-memory.md` before designing or editing.
- Do not edit files under `tests/`.
- Do not use Bash to write source files. Source edits must go through Edit/Write
  so the write gates can inspect them.
- Do not invent packet fields beyond the memory file and README.
- If a requirement is ambiguous, stop and ask concise clarification questions.
- For binary protocols, validate semantic units, not only byte parity. If the
  memory says a payload contains fixed-width records, reject partial records
  with a clear `ValueError`.
- After code changes, run `python -m pytest -q`.
- Report what changed, what tests ran, and any remaining risk.
