---
name: "promoted-hrc-17b80b214f7f4adb"
description: "Required action: release-checklist 增加\"合入后复位清单\"; 分支切换脚本化: 切换后自动跑六渲染器 [candidate hrc-17b80b214f7f4adb]"
priority: L1
trigger: "merge 到 main;分支 checkout/切换;旧分支带回 tracked 渲染产物"
skip: ""
candidate_id: "hrc-17b80b214f7f4adb"
enforcement: "advisory"
---

<!-- harness-rule-candidate:hrc-17b80b214f7f4adb -->
# 合入/切分支后必须全渲染器重建+check——merge 会带回旧树同名 tracked 产物, gitignore 的运行时镜像(skills/)在 checkout 后残缺

- Trigger conditions:
  - merge 到 main
  - 分支 checkout/切换
  - 旧分支带回 tracked 渲染产物
- Required action: release-checklist 增加"合入后复位清单"; 分支切换脚本化: 切换后自动跑六渲染器
- Root cause: git merge 以 tracked 文件为准, 旧分支同名产物(旧版 plugin.hooks.json)会胜出; gitignore 的运行时镜像不随 checkout 迁移; marketplace sha 与 dist 树互为因果, 分开提交必断链
- Verified repair: 合入后依次跑 sync-skills/sync-workflow-mirror/render-hook-settings/render-codex-hooks/render-grok-hooks/sync-plugin-dist 再全 --check; marketplace 与 dist 产物同 commit 提交。修复后 harness-ci 六段绿(main 77801c1)
- Behavioral evidence: behavioral_test RED via node var/tmp/rule-candidates/rc-probes.cjs merge-render-reset; GREEN via node var/tmp/rule-candidates/rc-probes.cjs merge-render-reset
- Evidence boundary: applies only to the trigger conditions above; re-verify after contract changes.
