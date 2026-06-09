---
name: hdl-golden-model-philosophy
description: HDL 设计的 Golden Model 绝对权威与 RTL↔MATLAB 严格对标原则
metadata:
  type: learning
  domain: hdl
---

# Golden Model 设计哲学

> 确立于 2026-06-07，源自用户对流程的强化要求。

## 核心原则

### 1. Golden Model 绝对权威

Golden Model 是设计的**唯一真实来源（Single Source of Truth）**。它描述了算法从输入到输出的完整数学行为，是一切后续工作的基础。

- 浮点 golden model → 算法行为的数学定义
- 定点 golden model → 量化后行为的精确参考
- RTL 实现 → golden model 的硬件映射

定点和 RTL 都围绕 golden model 展开，**有出入以 golden/定点模型为准**。

### 2. RTL ↔ MATLAB 严格对标

写 RTL 前，必须先对**顶层模块和每个子模块**进行完整的方案设计。RTL 的每个模块必须与 MATLAB 模型的步骤**一一对应**，不可缺斤少两。

**检查清单**：
- 顶层架构框图是否覆盖了 MATLAB 主流程的所有步骤？
- 每个子模块的接口/功能是否与 MATLAB 中的某个函数或步骤段对应？
- MATLAB 中有 N 步处理，RTL 中是否也恰恰有 N 个对应的处理阶段？

### 3. 验证一致性

模块验证时，相同输入必须产生与定点模型完全一致的输出。这是 RTL 正确性的基本判据：

```
MATLAB(输入) = 期望输出
RTL(输入)   = 实际输出
期望输出 ≡ 实际输出  → 验证通过
```

### 4. 方案设计先行

写 RTL 前必须完成的步骤（不可跳过）：
1. 顶层的方案设计（架构框图）
2. 每个子模块的方案设计（接口/功能/时序/难点）
3. 确认模块划分与 MATLAB 步骤一致

## 为什么

- **避免 RTL 与算法脱节**：如果 RTL 的模块划分和 MATLAB 步骤不匹配，定位问题时会非常困难——你不知道是 RTL 写错了，还是 MATLAB 和 RTL 的"对应关系"就有偏差
- **保证设计可追溯**：每个 RTL 模块都能追溯到 MATLAB 的某一步，review 时可以逐级比对
- **仿真调试透明化**：当 golden model 是唯一参考时，FAIL 的根因定位从"凭感觉"变成"第 N 步数据不匹配"

## 相关记忆

- [[hdl-coding-workflow]] — 8 阶段 HDL 编码工作流
