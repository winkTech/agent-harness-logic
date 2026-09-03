---
name: claude-plugin-manifest-validation
description: Claude Code 插件清单校验失败时插件被静默拒绝加载（-p 输出无提示，只有 ~/.claude/debug/*.txt 有 ERROR）；agents 字段只接受 .md 文件路径；CLAUDE_PLUGIN_DATA 确实作为 env 传给 hook 进程。
metadata:
  type: feedback
  related: [[hot-path-hook-edit-atomicity]] [[harness-memory-rules]]
---

# Claude Code 插件清单校验与插件模式实测事实

**Why**: 2026-09-03 M2 首次用 `claude --plugin-dir <精简副本> -p ...` 真机验收时，插件的 hook 一条都没跑、状态目录没建，
`-p` 的 stdout/stderr 没有任何报错。翻 `~/.claude/debug/<session>.txt` 才看到
`Plugin ... has an invalid manifest file ... Validation errors: agents: Invalid string: must end with ".md"`。
`.claude-plugin/plugin.json` 里写了 `"agents": "./agents"`（目录），而校验只接受 `.md` 文件路径；一个字段不合法 → 整个插件不加载。

**How to apply**:
1. `plugin.json` 不写 `agents` 字段：`agents/` 是默认目录且**递归**发现子目录。若必须写，只能是 `.md` 路径或其数组。
2. 任何插件模式的真机验收，先看 `~/.claude/debug/` 里最新一份日志 grep `Plugin loading errors`，再看行为；
   `-p` 模式对插件加载失败是静默的，不能以"没报错"当加载成功。
3. 实测（Claude Code 2026-09 版本）hook 进程 env 里有：`CLAUDE_PLUGIN_ROOT`（插件根）、
   `CLAUDE_PLUGIN_DATA`（`~/.claude/plugins/data/<plugin-id>`，`--plugin-dir` 时 id 形如 `logical-paradox-inline`）、
   `CLAUDE_PROJECT_DIR`、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_EFFORT`。因此 harness-state 五级解析的第 4 级
   （`CLAUDE_PLUGIN_DATA`）在插件安装模式下会真实命中，状态落在 plugins/data 下而不是 `~/.logical-paradox`。
4. 结构性校验放进 `engine/scripts/test-hooks/plugin-manifest-contract.test.cjs`，CI 能抓；真机 `--plugin-dir`
   运行需要登录态，只能本机做，不进 CI。
5. `claude plugin details <name>` 只认已安装插件名，不接受路径；`--plugin-dir` 也不是它的选项。
