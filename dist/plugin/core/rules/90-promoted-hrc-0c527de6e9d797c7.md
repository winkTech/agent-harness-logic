---
name: "promoted-hrc-0c527de6e9d797c7"
description: "Required action: 超 3 行或含正则/模板串/反斜杠的 node 脚本禁止 -e 内联; 直接写文件 [candidate hrc-0c527de6e9d797c7]"
priority: L1
trigger: "node -e 含 regex/反引号/模板串/多行;shell 内联转义超两层"
skip: ""
candidate_id: "hrc-0c527de6e9d797c7"
enforcement: "advisory"
---

<!-- harness-rule-candidate:hrc-0c527de6e9d797c7 -->
# node -e 内联含正则/反斜杠/反引号/中文字符的脚本在 bash 里必炸——写临时 .cjs 文件执行, 用后删

- Trigger conditions:
  - node -e 含 regex/反引号/模板串/多行
  - shell 内联转义超两层
- Required action: 超 3 行或含正则/模板串/反斜杠的 node 脚本禁止 -e 内联; 直接写文件
- Root cause: bash 双引号内 node -e 的多层转义(shell→node 字符串→正则)在含特殊字符时不可预测; Windows Git Bash 还有路径斜杠叠加
- Verified repair: 全部改为 Write 工具写 var/tmp/*.cjs → node 执行 → rm; 本轮所有复杂脚本一次通过
- Behavioral evidence: behavioral_test RED via node var/tmp/rule-candidates/rc-probes.cjs node-e-inline; GREEN via node var/tmp/rule-candidates/rc-probes.cjs node-e-inline
- Evidence boundary: applies only to the trigger conditions above; re-verify after contract changes.
