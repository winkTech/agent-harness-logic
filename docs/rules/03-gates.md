---
name: gate-rules
description: "Requirements and verification-quality gates for new or materially changed behavior."
priority: L0
trigger: "新代码文件;新模块;新功能;接口变更;行为契约;正确行为不明;Testbench;testbench;验证方案;tb_;test_;new code file;new module;new feature;interface change;behavior contract;ambiguous behavior;verification plan"
skip: "只读;审查;review;诊断;diagnose;文档"
---

# 需求与验证质量门禁

门禁用于新资产或会改变契约的工作，不用于只读任务，也不要求对明确的已有文件小修复二次确认。

代价要说清楚：这两道门禁偏向谨慎而非速度，每次触发都要付出一轮信息提取与记录。因此触发条件写得很窄——落在条件之外时直接做，不要"为稳妥起见"自愿走一遍。过度套用和整体忽略同样是失效。

## 门禁一：需求澄清

触发条件：

- 创建新代码文件或新模块/功能；
- 修改接口、数据契约、复位、延迟、位宽或外部行为；
- 修复问题但正确行为无法从现有证据确定。

先从规格、代码、测试、Golden Model 和知识库提取以下信息。每项可标记为 `confirmed`、`assumed` 或 `na`：

```
D1 范围边界    D2 数据契约    D3 成功标准
D4 算法路径    D5 微架构      D6 风险未知
```

只有仍会实质改变实现或验收结果的未知项才询问用户；证据充分时直接记录假设并继续。

退出条件：将结果写入 `var/gates/requirements-gate.json`，`status` 为 `completed` 且作用域覆盖目标文件。新代码文件由 `requirements-gate-guard.cjs` **提示**（advisory，不阻断——见本文末「门禁的执行力」）。

## 门禁二：验证质量

触发条件：创建新 TB、Testbench、测试文件或验证方案。

先画像适用的环境信息：时钟、复位、接口、数据格式、帧结构、背压、吞吐和邻居行为。再选择适用场景：

```
S1 基础功能    S2 背压流控    S3 帧/包边界
S4 复位异常    S5 吞吐极限
```

不适用于目标的画像项或场景可标记为 `na`，但必须记录理由；适用项至少有一个可执行场景。验证从单模块开始，按风险扩展到子系统和全链路。

测试和 Golden Model 是验收证据，不是需要迎合的固定答案。不得仅为制造通过而削弱、删除或跳过测试，硬编码固定样例，或绕过检查。测试本身疑似错误时，先记录失败证据、预期契约和影响范围；只有当前任务明确包含测试修正时才修改。

Golden Model 的约束是**方向**，不是禁止修改。Golden 与需求有出入时就该改——它的职责是贴合需求，不是保持不变。禁止的是因果倒置：RTL 调不通，于是把 Golden 改成 RTL 的样子。判据在依据指向哪一侧：

- **上游依据**（规格条款、标准章节、ADR 裁决、数学推导、用户裁定）——Golden 的正当来源，照常修改。
- **下游依据**（"对齐 RTL"、"RTL 已改所以同步"、"让 cosim 通过"）——默认不成立。位真镜像一类 Golden 有意跟随 RTL 的合法特例，必须挂一次显式裁决（ADR 号或用户判定）说明为何 RTL 才是正确的一方，不能混在普通修复里。

流程方向也是硬约束：Golden 指导 RTL，不是反过来。同模块 RTL 刚改完就改 Golden，是倒置的时序指纹，此时依据必须升级到裁决级。`file-protection-guard.cjs` 按 `basis{kind,ref[,ruling]}` 判定方向并记入 `var/audit/protected-writes.jsonl`，倒置签名由模型 manifest 的 `implements_for` 与 RTL 文件 mtime 观测，不依赖自述。

退出条件：将结果写入 `var/gates/verification-quality.json`，`status` 为 `completed` 且作用域覆盖目标文件。新测试文件由 `verification-quality-guard.cjs` **提示**（advisory，不阻断）。

## 门禁的执行力

这两道门禁是 **advisory**：未完成时输出提示，但不会 `exit 2` 阻断写入。

这是刻意的。放行的唯一条件是模型自己往状态 JSON 里写 `status: "completed"`，而那份
JSON 无 schema 校验、无有效期、无写保护。在这种结构下硬阻断不会带来更强的约束，
只会训练模型伪造门禁记录，对临时脚本还会大量误报。

所以**不要把"门禁没拦住"当成放行的理由**——它的约束力来自这份规则本身，不来自退出码。
真正有牙齿的硬门禁建立在可独立复核的产物上，例见
`workflows/hdl-coding-dag-workflow.js` 的 Phase 4.5（校验 `check_results/<mod>.json`
真实存在且 `status === PASS`）。

## 门禁异常

不要直接删除状态文件。状态疑似过期或损坏时，报告原因并走经过审计的 reset/repair 路径。用户明确要求跳过时，记录 `status: "bypassed"`、原因和作用域；是否放行由 Hook 的当前策略决定。
