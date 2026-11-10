---
name: hot-path-hook-edit-atomicity
description: 被 preflight-router / stop-summary 同步加载的文件改坏一半会让全机所有 Claude Code 会话的写入工具被拒（fail-closed），且 Agent 自身无法修复；改热路径文件必须 require 先行、单文件原子落盘、立即 node --check。
metadata:
  type: feedback
  related: [[harness-memory-rules]] [[cognitive-layer-routing]]
---

# 热路径 hook 文件的编辑原子性

**Why**: 2026-09-02 M1 状态分离改造中，子代理改 `engine/hooks/session/progress-watchdog.cjs` 时先把两行路径换成
`varPath(...)`、还没加 require 就停下。该文件被 `engine/scripts/hooks/preflight-router.cjs:448` 在每次非只读工具调用时
同步 `require`，也被 `stop-summary.cjs` 加载。路由把内部异常按 fail-closed 处理（`process.exitCode = 2`），于是
本机所有会话的 Edit/Write/Bash/PowerShell/Agent/Skill/ToolSearch/MCP 全部被拒，只有 `ALWAYS_READ_ONLY_TOOLS`
（Read/Grep/Glob/WebFetch/WebSearch/AskUserQuestion）可用。主会话与三个子代理都无法自救；`!` 前缀命令同样经过 hook。
唯一出路是用户在 Claude Code 之外改文件（编辑器或外部终端 `git checkout -- <file>`）。

**How to apply**:
1. 改任何被 `preflight-router.cjs`、`prompt-context.cjs`、`stop-summary.cjs`、`session-bootstrap.cjs` 直接或间接 require 的
   文件时，顺序固定：先加 require（对已存在模块的 require 无副作用）→ 再改引用行 → 立刻 `node --check`。
   任何时刻不得让文件处于引用未定义标识符的中间态。
2. 给子代理下发此类任务时，把这条顺序写进任务合同，并要求单文件改完即语法检查，不允许"先改一批再统一检查"。
3. 事故恢复的最短路径是 `git checkout -- <坏文件>`（外部终端），而不是让 Agent 反复尝试写入；
   同一假设连续两次被拒即停止重试并把这条命令交给用户。
4. 中长期防御（M4 分层时落地）：路由对"门禁自身加载失败"应区分于"门禁判定阻断"——前者按 advisory 降级并把
   错误写入遥测，只有 bash-safety 与 file-protection 这两个硬拦截保持 fail-closed（D2 决策）。
5. **2026-09-04 第二次事故（M4a E1）**：子代理在 `preflight-router.cjs` 的 `evaluateRuntime` 里插入了对尚未定义的
   `loaderFor()` 的调用。`node --check` 通过（语法合法），但每次工具调用都在运行期抛 `ReferenceError` →
   `main().catch` fatal → exit 2 → 全机所有工具（含 Read）被拒。结论：**`node --check` 不够**，语法检查看不见未定义标识符。
   新协议（M4a 起对四个热路径入口及其同步依赖强制）：
   - 不在原地编辑。先 `cp` 到 `var/tmp/hotpath/<name>.cjs`（或同目录 `.next` 后缀），在副本上改；
   - 副本改完后跑：`node --check`、`node -e "require('<副本>')"`、对副本做 `decide()` 级别的契约测试或
     `echo '<最小载荷>' | node <副本>`（至少 Read / Write / Bash 三种），全部通过；
   - 再用一次 `fs.renameSync`/`mv` 原子替换原文件；替换后立刻回放 `var/tmp/m3-baseline/replay.sh`。
   - 路由自身加**崩溃兜底**（D2）：`main().catch` 里不再直接 exit 2，而是单独加载 bash-safety 与 file-protection
     对载荷判定；任一 block → exit 2；否则写 stderr 警告并以 exit 0 放行。这样运行期异常只降级、不锁机。
     局限：模块顶层加载失败（语法错误）仍会 fatal，所以副本协议仍是第一道防线。
