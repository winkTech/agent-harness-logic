# 两道门禁 — Requirements + Verification Quality

> L0 优先级。合并原 rules/15 + rules/16。WiFi PHY 教训见 memory/。

---

## 门禁一：需求澄清（编码前）

**触发**: 新功能/模块需求 / 项目级需求 / 给了 MD/PDF spec / 修 bug 但正确行为不明

### 六维框架（每个维度 ✅明确 / ✅记录假设 / ✅标记不适用）

```
D1 范围边界   — 做什么？不做什么？与谁交互？
D2 数据契约   — 输入/输出格式？时序？帧边界？极端情况？
D3 成功标准   — 什么算对？有 GM 吗？怎么验证？
D4 算法路径   — 处理步骤？决策点？数据依赖？
D5 微架构     — 流水线？FSM？位宽？存储？复位？
D6 风险未知   — 不确定什么？什么可能出错？
```

### 有 Golden Model: 跑通 GM → 提取测试向量 → 确认 1:1 步骤对齐 → 编码
### 仅 MD Spec: 模糊词（适当/高速/合理/通常）→ 追问到具体值 → 每句转可验证断言

**退出**: 六维全部满足 → 写入 `var/gates/requirements-gate.json` (status: "completed")
**阻断**: Hook `requirements-gate-guard.cjs` — 新代码文件 Write 前检查 → exit 2

---

## 门禁二：验证质量（写 TB 前）

**触发**: 编写 TB/testbench / 验证方案 / `tb_*` `test_*` 文件

### Part A: 环境画像（8 项，填完才能写 TB）

时钟 / 复位 / 接口协议 / 数据格式 / 帧结构 / 背压特征 / 吞吐模式 / 邻居行为

### Part A: 最少场景集（5 类，缺一不可）

```
S1 基础功能  — 单次激励 + GM 对比
S2 背压流控  — 随机/连续/恢复/背靠背反压
S3 帧/包边界 — 单帧/连续多帧/最小/最大/帧间间隙
S4 复位异常  — 启动复位/运行中复位/帧间复位/异常输入
S5 吞吐极限  — 连续最大/最小间隔/突发模式
```

### Part B: 增量集成

```
Level 0: 单模块单元 TB → Level 1: 2-3 模块 → Level 2: 子系统 → Level 3: 全链路
```
失败时：二分法定位 → 注入已知输入 → 对比 → 修复 → 固化场景

**退出**: 画像 + 场景集完成 → 写入 `var/gates/verification-quality.json` (status: "completed")
**阻断**: Hook `verification-quality-guard.cjs` — 新 TB 文件 Write 前检查 → exit 2

---

## 绕过审计

用户明确说"跳过" → 状态文件设 `status: "bypassed"` + 记录原因。
事后审计: `memory/projects/<project>/gate-bypass-log.md`。
