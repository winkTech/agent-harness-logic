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

| 层 | 通过条件 | 失败处理 |
|:--|---------|---------|
| Layer 0 | 所有 port 连通 | 检查例化/信号名 |
| Layer 1 | CSR 读写匹配 | 检查地址译码 |
| Layer 2 | 状态机按预期跳转 | 检查 next-state 逻辑 |
| Layer 3 | 数据输出与 golden model 一致 | 检查数据通路组合逻辑 |
| Layer 4 | 边界处理不挂死 | 检查错误处理路径 |

## 检查点

Layer 0-4 依次通过，日志中无 FAIL。

**关联 Skill**: `hdl-coding`（FSM 模板、流水线模板、命名规范）、`debugging`（仿真异常调试）
**数据输入**: `.claude/state/hdl-coding/project-spec.json`（比对模式和端口定义）
**数据输出**: `.claude/state/hdl-coding/layer-status.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_4
```
