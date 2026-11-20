---
name: "promoted-hrc-bf58b1ff89362118"
description: "Required action: 改根 README/SETUP/规则入口文档前, 先 grep 该文档名在 test-hooks/*.cjs 的断言; 文档契约变更走测试先行 [candidate hrc-bf58b1ff89362118]"
priority: L1
trigger: "重写或大改根 README;新增/修改文档入口文件"
skip: ""
candidate_id: "hrc-bf58b1ff89362118"
enforcement: "advisory"
---

<!-- harness-rule-candidate:hrc-bf58b1ff89362118 -->
# 根 README 受 workflow-contracts 9 项内容契约约束(05-harness 引用/三脚本点名/hook 拓扑表逐行/dormant 标注/Dream 候选须批准)——重写 README 前必须先读契约

- Trigger conditions:
  - 重写或大改根 README
  - 新增/修改文档入口文件
- Required action: 改根 README/SETUP/规则入口文档前, 先 grep 该文档名在 test-hooks/*.cjs 的断言; 文档契约变更走测试先行
- Root cause: 文档内容也被契约测试守护(防自主规则学习误导等语义要求); 精简重写天然会丢契约要求的引用面
- Verified repair: 先读 workflow-contracts.cjs L1665-1702 断言清单再动笔, 逐项在架构叙事中保留; 修后 32/32 全过 (commit 72b68f9)
- Behavioral evidence: behavioral_test RED via node var/tmp/rule-candidates/rc-probes.cjs readme-contract; GREEN via node var/tmp/rule-candidates/rc-probes.cjs readme-contract
- Evidence boundary: applies only to the trigger conditions above; re-verify after contract changes.
