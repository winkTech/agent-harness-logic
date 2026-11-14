---
name: "promoted-hrc-7b078b0123fa8e6f"
description: "Required action: 新写的 spool/遥测相关测试必须显式声明隔离目录; code review 检查项: 测试代码中出现 appendToSpool( 调用时, 参数表必须含自定义 dir [candidate hrc-7b078b0123fa8e6f]"
priority: L1
trigger: "测试/冒烟代码调用 telemetry-spool.appendToSpool;契约测试断言精确 stderr 且与 spool 写入共存"
skip: ""
candidate_id: "hrc-7b078b0123fa8e6f"
enforcement: "advisory"
---

<!-- harness-rule-candidate:hrc-7b078b0123fa8e6f -->
# 探针/测试写真实遥测 spool 会污染 SessionStart drain——残留事件触发 moved>0 的 stderr 汇报行, 破坏依赖精确 stderr 断言的契约测试

- Trigger conditions:
  - 测试/冒烟代码调用 telemetry-spool.appendToSpool
  - 契约测试断言精确 stderr 且与 spool 写入共存
- Required action: 新写的 spool/遥测相关测试必须显式声明隔离目录; code review 检查项: 测试代码中出现 appendToSpool( 调用时, 参数表必须含自定义 dir
- Root cause: spool 是 append-only 快路径, 任何测试写入都持久残留; SessionStart 的 spool-drain 在下个会话启动时真实搬运(moved>0)并向 stderr 打汇报行——该行不在被测契约的预期 stderr 集内
- Verified repair: 探针一律写隔离临时目录(mkdtemp)并在用后 rmSync; 需要解除防写开关时六键全摘(HARNESS_*+CLAUDE_* 双名)。修复后 lifecycle 契约恢复绿, 全量 491 无假红 (commit 7dc5fa4)
- Behavioral evidence: behavioral_test RED via node var/tmp/rule-candidates/rc-probes.cjs spool; GREEN via node var/tmp/rule-candidates/rc-probes.cjs spool
- Evidence boundary: applies only to the trigger conditions above; re-verify after contract changes.
