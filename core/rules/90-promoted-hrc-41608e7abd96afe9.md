---
name: "promoted-hrc-41608e7abd96afe9"
description: "Required action: 改 cbb/**/analysis|tb|rtl 前先看该资产 manifest; 任何字节级改动(含脱敏占位替换)都触发重认证; 重认证 reason 必须写明变更性质 [candidate hrc-41608e7abd96afe9]"
priority: L1
trigger: "写 engineering-assets/cbb 受保护源;编辑 cbb manifest.json"
skip: ""
candidate_id: "hrc-41608e7abd96afe9"
enforcement: "advisory"
---

<!-- harness-rule-candidate:hrc-41608e7abd96afe9 -->
# 改 engineering-assets 受保护源文件必须走证据链重认证: manifest sources[].sha256 重算(顶层数组非嵌套)→evidence-snapshot --reseal(uid 是裸名)→verify-all

- Trigger conditions:
  - 写 engineering-assets/cbb 受保护源
  - 编辑 cbb manifest.json
- Required action: 改 cbb/**/analysis|tb|rtl 前先看该资产 manifest; 任何字节级改动(含脱敏占位替换)都触发重认证; 重认证 reason 必须写明变更性质
- Root cause: certified 资产的 sha 锁在 manifest 顶层 sources[]; snapshot 又锁 manifest sha——两级锁定, 内容变更必须两级同步; asset_uid 是裸名(cp_remove)非路径形
- Verified repair: 重算 4 个 manifest sha256 → 四资产 --reseal --reason → verify-all 61 快照全绿(门禁产物差异 0, 实质证据未变) (commit da3c7cb)
- Behavioral evidence: behavioral_test RED via node var/tmp/rule-candidates/rc-probes.cjs cbb-reseal; GREEN via node var/tmp/rule-candidates/rc-probes.cjs cbb-reseal
- Evidence boundary: applies only to the trigger conditions above; re-verify after contract changes.
