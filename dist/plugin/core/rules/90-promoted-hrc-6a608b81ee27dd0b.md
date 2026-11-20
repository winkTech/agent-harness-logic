---
name: "promoted-hrc-6a608b81ee27dd0b"
description: "Required action: run-all-tests 结果 fail>4 时禁止提交; 先单跑失败套件定位; 豁免数变化(4→5 或 5→4)都要在 commit message 说明 [candidate hrc-6a608b81ee27dd0b]"
priority: L1
trigger: "每次 run-all-tests 全量回归;bench-refactor --phase final;豁免数值变化时"
skip: ""
candidate_id: "hrc-6a608b81ee27dd0b"
enforcement: "advisory"
---

<!-- harness-rule-candidate:hrc-6a608b81ee27dd0b -->
# 已知基线失败(fail=4)必须走 baselineFailures 显式豁免记账, 新增失败先归因再修——防止基线漂移掩盖真回归

- Trigger conditions:
  - 每次 run-all-tests 全量回归
  - bench-refactor --phase final
  - 豁免数值变化时
- Required action: run-all-tests 结果 fail>4 时禁止提交; 先单跑失败套件定位; 豁免数变化(4→5 或 5→4)都要在 commit message 说明
- Root cause: 基线 4 项是行为级 backlog, 与新失败混在一起时容易漏; 但"多 1 个失败"永远是信号不是噪音
- Verified repair: bench-refactor 的 baselineFailures 机制+豁免 note 落账; 每次全量第 5 失败立即定位修复(本轮三次全中并全修)
- Behavioral evidence: behavioral_test RED via node var/tmp/rule-candidates/rc-probes.cjs baseline-discipline; GREEN via node var/tmp/rule-candidates/rc-probes.cjs baseline-discipline
- Evidence boundary: applies only to the trigger conditions above; re-verify after contract changes.
