---
name: gate-rules
description: "Requirements and verification-quality gates for new or materially changed behavior."
priority: L0
trigger: "新代码文件;新模块;新功能;接口变更;行为契约;正确行为不明;Testbench;testbench;验证方案;tb_;test_;new code file;new module;new feature;interface change;behavior contract;ambiguous behavior;verification plan"
skip: "只读;审查;review;诊断;diagnose;文档"
---

# 需求与验证质量门禁

门禁用于新资产或会改变契约的工作，不用于只读任务，也不要求对明确的已有文件小修复二次确认。

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

退出条件：将结果写入 `var/gates/requirements-gate.json`，`status` 为 `completed` 且作用域覆盖目标文件。新代码文件由 `requirements-gate-guard.cjs` 检查。

## 门禁二：验证质量

触发条件：创建新 TB、Testbench、测试文件或验证方案。

先画像适用的环境信息：时钟、复位、接口、数据格式、帧结构、背压、吞吐和邻居行为。再选择适用场景：

```
S1 基础功能    S2 背压流控    S3 帧/包边界
S4 复位异常    S5 吞吐极限
```

不适用于目标的画像项或场景可标记为 `na`，但必须记录理由；适用项至少有一个可执行场景。验证从单模块开始，按风险扩展到子系统和全链路。

测试和 Golden Model 是验收证据，不是需要迎合的固定答案。不得仅为制造通过而削弱、删除或跳过测试，修改 Golden Model，硬编码固定样例，或绕过检查。测试本身疑似错误时，先记录失败证据、预期契约和影响范围；只有当前任务明确包含测试修正时才修改。

退出条件：将结果写入 `var/gates/verification-quality.json`，`status` 为 `completed` 且作用域覆盖目标文件。新测试文件由 `verification-quality-guard.cjs` 检查。

## 门禁异常

不要直接删除状态文件。状态疑似过期或损坏时，报告原因并走经过审计的 reset/repair 路径。用户明确要求跳过时，记录 `status: "bypassed"`、原因和作用域；是否放行由 Hook 的当前策略决定。
