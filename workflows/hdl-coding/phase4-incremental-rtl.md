# Phase 4: 增量式 RTL 编码（分层验证）

> 所属工作流: `workflows/hdl-coding-workflow.md`
> 目标: 从最小可验证单元开始，每层仿真绿灯后再推进。

## 层间依赖与 Stub 机制

**线性推进是理想情况，现实中的依赖链更复杂**：

| 模块类型 | 典型依赖方向 | 说明 |
|---------|-------------|------|
| 控制为主 | Layer 2 → Layer 3 | 控制逻辑先定义协议，数据通路随后实现 |
| 数据为主 | Layer 3 → Layer 2 | 数据通路框架先写，控制逻辑后补 |
| 系统集成 | 交织依赖 | 各 Layer 同步开发，无法严格线性 |

**Stub 机制** — 当当前层依赖未完成的邻层时：

- **上游 Stub**：用简单寄存器/计数器模拟未完成模块的输出，验证本层输入接口
- **下游 Stub**：用断言捕获本层输出，验证接口协议的正确性，不关心数据内容
- **接口契约**：先定义接口信号和时序协议（`interface` / `modport`），双方按契约独立推进

**层推进的真实规则**（非必须线性）：

```
推进 Layer X 前必须通过：
  ├─ Layer 0 (端口连通性)     — 总是最先通过
  └─ Layer Y (直接数据依赖)   — 本层需要的信号源头层

其余未完成层用 Stub 替代，不阻塞推进。
```

**示例** — AXI-S 数据通路模块，控制逻辑依赖状态信号：

```
推荐顺序：
  Layer 0 → Layer 3 (数据通路框架 + Stub 控制)
          → Layer 2 (控制逻辑) → Layer 4 (边界条件)

说明：Layer 3 写完后，Layer 2 需要的 ready/valid 已可用；
      Layer 2 写完后，Layer 4 需要的 full/error 全部就绪。
```

**重要**：Phase 1.3 的模块设计方案中的**难点与监测机制**在此阶段落地——每个模块实现时，其预定义的断言和监控点必须写入代码。

## Layer 推进中的迭代自省

### 迭代计数器机制

调试过程中隐式跟踪问题修复的迭代次数：

| 触发场景 | 视为一次迭代 |
|:---------|:------------|
| 改代码 → 仿真 FAIL → 再改 | +1 |
| 加 debug 信号后重跑发现问题 → 继续改 | +1 |
| 换实现方案（丢弃前一次） | +1 |
| 修改 RTL 后重跑全星座点 → 仍有 FAIL | +1 |

**不计数**：批量改 lint 警告、并行跑多组参数仿真、重构不改变功能。

### 3-迭代触发复盘

当同一问题的迭代次数 **≥ 3** 时，必须暂停当前工作，执行复盘：

1. **暂停**：停止继续试错，退一步分析
2. **加载复盘工作流**：`workflows/debug-retrospective.md`
3. **执行 Step 1~4**：解构根因 → 定位流程漏洞 → 更新工作流文件 → 登记教训记忆
4. **复盘完成后再继续调试**：带着新增规则回来看问题，往往第一眼就能发现

> **为什么是 3 次？**
> 第 1 次迭代是正常的 bug fix，第 2 次是补充遗漏，第 3 次说明流程本该拦截但没拦住。
> 到了第 3 次，正确的做法不是继续试第 4 次，而是停下来问"流程哪里漏了"。

## LUT/映射模块的预验证步骤

涉及星座映射、查找表、比特-符号编码的模块，在进入 Layer 3（数据通路）之前必须单独验证映射正确性。**不要在 Layer 3 中才首次检查映射结果**。

### 预验证三件套

```
Step 1: 固定序列验证
  └─ 选 3~5 个已知输入 → 手动计算预期 I/Q → 仿真检查逐个符号匹配
  
Step 2: 全星座点验证  
  └─ 所有可能索引全覆盖（如 64QAM → 64 个点全部比对）
  
Step 3: 背压验证（映射正确后添加）
  └─ 相同输入在随机反压下输出与无背压时一致
```

### 验证方法

在独立的最小验证环境中（可临时创建专用 tb 或利用 Phase 3 testbench 的 subset 模式）：

```systemverilog
// 固定序列检查示例
for (int i = 0; i < n_fixed_syms; i++) begin
  @(posedge clk);
  if (m_axis_tvalid && m_axis_tready) begin
    if (m_axis_tdata !== expected_tv[i]) begin
      $display("[MAPPING FAIL] sym=%0d exp=%08h got=%08h", i, expected_tv[i], m_axis_tdata);
      error_count++;
    end
  end
end
```

**检查点**：映射预验证 PASS 后，再进入 Layer 3 的数据通路仿真。

## 运行方式

### 短仿真（< 30s 每层）

```bash
# 通过 Makefile 执行仿真（Phase 0 工具抽象层，自动选择工具链）
make sim TEST=short_test
# 输出示例:
#   [100ns] [PHASE] Layer 0: 端口连通性测试
#   [150ns] [PASS] data_in=32'hA5 正确通过
#   [200ns] [FAIL] ready 信号未在 3 周期内拉高
#   [300ns] === Test End: 1 errors ===
```

### 长仿真（后台运行 + 轮询输出文件）

```bash
# 仿真命令通过 Makefile 间接执行（Phase 0 工具抽象层）
make sim TEST=layer_test > logs/sim_output.log 2>&1 &

# 日志通过双通道输出（$display + $fwrite）同时写入 stdout 和文件
# 长仿真通过文件完成标记 + tail 增量读取输出：
#   === Layer 1: 寄存器读写测试 === 
#   [PASS] CSR_CTRL 写 0x3 读回 0x3
#   [PASS] CSR_STATUS 写 0x5 读回 0x5
#   Layer 1 完成，进入 Layer 2...
```

## 日志可靠性规范

**问题**：`$display` → stdout 在大仿真时被 Bash 工具截断；`$fwrite` 存在缓冲区未 flush 导致 crash 丢日志。

**双通道日志** — testbench 同时输出到 stdout 和日志文件：

```systemverilog
// 初始化日志文件
integer log_fd;
initial begin
  log_fd = $fopen("sim_output.log", "w");
end

// 日志宏：同时写 stdout + 文件
`define LOG(lvl, msg) begin                                                    \
  $display("[%t] [%s] %s", $time, lvl, msg);                                  \
  if (log_fd) $fwrite(log_fd, "[%t] [%s] %s\n", $time, lvl, msg);             \
end                                                                            

// 定期 flush 文件缓冲区（每 1ms sim time）
always #1000000 if (log_fd) $fflush(log_fd);
```

**仿真完成通知** — 长仿真通过文件标记避免超时猜测：

```systemverilog
// testbench 结束时写入完成标记并关闭文件
final begin
  if (log_fd) begin
    $fwrite(log_fd, "=== SIMULATION COMPLETE ===\n");
    $fwrite(log_fd, "Errors: %0d\n", error_count);
    $fflush(log_fd);
    $fclose(log_fd);
  end
end
```

```bash
# Bash 轮询：等待完成标记
while ! grep -q "SIMULATION COMPLETE" sim_output.log 2>/dev/null; do
  sleep 5
  tail -n 100 sim_output.log  # 增量输出最近日志
done
```

**长仿真日志读取策略**：

| 场景 | 方法 | 说明 |
|------|------|------|
| 短仿真 (< 5K 行) | stdout 直接返回 | 对话框安全显示 |
| 中仿真 | `tail -n 50000 sim_output.log` | 截取尾部 PASS/FAIL 摘要 |
| 长仿真 | 分片轮询 + 增量 offset | 每次 `tail -n +<offset>`，避免重复读取 |

## 层推进规则

| 层 | 通过条件 | 失败处理 | 迭代警戒 |
|:--|---------|---------|:--------:|
| Layer 0 | 所有 port 连通 | 检查例化/信号名 | — |
| Layer 1 | CSR 读写匹配 | 检查地址译码 | — |
| Layer 2 | 状态机按预期跳转 | 检查 next-state 逻辑 | — |
| Layer 3 | 数据输出与 golden model 一致 | ↓ 见下方迭代处理 | ⚠️ 3次触发复盘 |
| Layer 4 | 边界处理不挂死 | 检查错误处理路径 | ⚠️ 3次触发复盘 |

**Layer 3/4 失败时的迭代处理流程**：

```
仿真 FAIL
  ├─ 第1次：定位问题 → 改代码 → 重跑  (正常bug fix)
  ├─ 第2次：补充遗漏 → 检查关联改动 → 重跑  (可接受)
  └─ 第3次：→ 暂停 → 加载 `workflows/debug-retrospective.md` → 复盘
              → 定位流程漏洞 → 更新工作流 → 登记教训 → 继续
```

每次迭代在 dump 文件中记录：`iteration_N.log`（错误信息 + 修改内容 + 仿真结果）。复盘时这些日志提供根因分析素材。

## 检查点

Layer 0-4 依次通过，日志中无 FAIL。

**关联 Skill**: `hdl-coding`（FSM 模板、流水线模板、命名规范）、`debugging`（仿真异常调试）
**数据输入**: `.claude/state/hdl-coding/project-spec.json`（比对模式和端口定义）
**数据输出**: `.claude/state/hdl-coding/layer-status.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_4
```
