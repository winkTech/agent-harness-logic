---
name: hdl-coding-workflow
description: RTL 开发全流程 — 算法分析→架构设计→定点量化→Testbench-First→增量仿真→透明调试
version: 3.0.0
agents: [developer, qa, code-reviewer]
phases: 8
complexity: high
triggers:
  - new algorithm module
  - new RTL module
  - testbench creation
  - resource evaluation
  - code review prep
---

# HDL Coding Workflow (v3)

RTL 开发全流程。核心原则：

- **自顶向下**: 先架构框图，再模块方案，再代码
- **验证左移**: 每层有检查点，仿真日志实时可读
- **不可跳越**: 阶段 N 的产出是阶段 N+1 的输入

---

## Phase 0: 基础设施统一层

**目标**: 统一 EDA 工具接口，建立可复用的构建系统，所有 Phase 不再调用厂商特定命令。

### 0.1 工具抽象层 (TAL)

所有 Phase 通过以下抽象操作执行，具体命令由 Makefile 按所选工具链解析：

| 操作 | 抽象命令 | 功能 |
|------|---------|------|
| 代码检查 | `make lint` | 调用选定工具链的 lint 引擎 |
| 编译 | `make compile` | 增量编译所有源文件 |
| 仿真 | `make sim TEST=<case>` | 运行指定测试用例 |
| 波形仿真 | `make sim_wave TEST=<case>` | 带全信号波形 dump（FAIL 时自动保留波形文件） |
| 回归 | `make regress` | 全量回归测试 |
| 覆盖率 | `make coverage` | 收集并报告覆盖率 |

**支持的 EDA 工具链映射**：

| 抽象操作 | Questa/ModelSim | Synopsys VCS | Cadence Xcelium | Verilator |
|----------|----------------|-------------|-----------------|-----------|
| Lint | `vlog -lint` | `vlogan -lint` | `xrun -status` | `verilator --lint-only` |
| 编译 | `vlog -work work` | `vlogan -sverilog` + `vcs` | `xrun -compile` | `verilator --cc --sv` |
| 仿真 | `vsim -c -work work` | `./simv` | `xrun -R` | `./obj_dir/Vtop` |
| 波形 | `vsim -c -wlf` + `log -r /*` | `./simv -ucli` | `xrun -input` | `verilator --trace` |

### 0.2 构建系统规范

**Makefile 模板**（项目根目录 `Makefile`）：

```makefile
# 工具链选择 (questa / vcs / xcelium / verilator)
TOOLCHAIN ?= questa
-include toolchains/$(TOOLCHAIN).mk

# 文件清单
RTL_SRC = $(shell cat filelist.f)
TB_SRC  = $(shell cat tb_filelist.f)

.PHONY: lint compile sim sim_wave regress coverage

lint: $(RTL_SRC) $(TB_SRC)
	$(LINT_CMD) $^

compile: $(RTL_SRC) $(TB_SRC)
	$(COMPILE_CMD) $^

sim: compile
	$(SIM_CMD) $(TEST)

sim_wave: compile
	$(SIM_WAVE_CMD) $(TEST)

regress: compile
	for t in $(TEST_LIST); do $(SIM_CMD) $$t; done
```

**工具链实现示例** — `toolchains/questa.mk`：

```makefile
LINT_CMD       = vlog -lint -work work
COMPILE_CMD    = vlog -sv -work work
SIM_CMD        = vsim -c -work work -do "source tests/$(TEST).tcl; run -all; exit" 2>&1 | tee logs/$(TEST).log
SIM_WAVE_CMD   = vsim -c -work work -wlf logs/$(TEST).wlf -do "log -r /*; source tests/$(TEST).tcl; run -all; exit"
TEST_LIST      = $(wildcard tests/*.tcl)
```

**文件清单管理** — 使用 `.f` 文件按依赖顺序排列源文件：

```bash
# filelist.f — RTL 源文件
../rtl/core_pkg.sv
../rtl/ahb_if.sv
../rtl/spi_master.sv

# tb_filelist.f — Testbench 源文件
../tb/tb_top.sv
../tb/scoreboard.sv
../tb/alignment_engine.sv
```

**增量编译原则**：仅修改过的文件及其下游依赖重编译。通过 Makefile 的自动依赖追踪生成 `.d` 文件实现。

**检查点**: 选定工具链，Makefile + filelists 创建完成，`make lint` 和 `make compile` 通过。

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_0
```

---

## Phase 1: 算法分析与架构设计

**目标**: 在写任何代码之前，把算法文档化、设计架构框图、分析每模块难点与风险。

### 1.1 算法文档化
- 数学推导、关键公式、信号流图
- 参数空间、数据率、时钟频率、延迟约束
- 区分"必须满足"和"可以权衡"两类约束
- 输出: `algorithm_spec.md`（`docs/templates/algorithm_spec_template.md` 参考）

### 1.2 RTL 顶层架构框图
- 绘制模块级框图：功能单元划分、数据流向、接口信号
- 标注时钟域、位宽、流水线级数
- **模块与 MATLAB 函数对标**：每个 RTL 模块对应哪个 MATLAB 函数，确保模型和硬件一一对应
- 输出: 架构图（放入 `06_doc/`）

### 1.3 模块设计方案（每个模块逐一分析）

| 项目 | 内容 |
|:-----|:------|
| 接口定义 | 端口列表、协议时序 |
| 实现方案 | 算法→硬件映射（LUT/BRAM/DSP 选择及理由） |
| 难点与风险 | 该模块实现中最难的部分、可能出什么问题 |
| 解决方案 | 针对每个难点的具体对策 |
| 监测机制 | 仿真中如何观测该模块是否正确（断言、计数值、状态监控） |
| 鲁棒性 | 边界输入、反压、溢出、非法状态的处理策略 |

### 1.4 资源约束识别
- 目标器件资源上限（LUT/FF/BRAM/DSP）
- 如有严格资源要求，明确每模块预算上限
- 输出: 初步资源预算表（精确数字在 Phase 2 产出）

### 1.5 浮点参考模型
- MATLAB/Python golden model 构建
- 函数划分对应 RTL 模块架构（与 1.2 框图一致）
- 输出: `golden_model/` 脚本包（`golden_model/src/`, `golden_model/tests/`）

### 1.6 测试向量生成
- 常规数据 / 边界值 / 随机数据 / 特殊模式
- 导出 `.bin` / `.hex` 供 testbench 加载
- 输出: `vectors/*`

### 1.7 性能基线
- 浮点 BER/EVM/NMSE 曲线
- 作为后续定点退化的比对基准

**检查点**: algorithm_spec + 架构框图 + 所有模块方案完成 + golden_model 运行通过。
**参考**: `skills/hdl-coding/references/alg-flow-verilog.md`（代码模板）, `docs/templates/algorithm_spec_template.md`
**输出**: `.claude/state/hdl-coding/project-spec.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_1
```

---

## Phase 2: 定点量化与资源评估

**目标**: 用数据驱动的方式确定位宽、量化策略和资源预算，杜绝经验估算。

### 2.1 资源目标确认
- 基于 Phase 1.4 的初步预算，确认各模块资源上限
- 如有严格资源要求，在量化阶段就纳入约束

### 2.2 位宽扫描与量化分析
- 各节点从高到低逐级缩减位宽，观察 BER/EVM 退化
- 统计各节点动态范围，确定整数位宽
- 量化策略选择比较：截断(truncation) / 四舍五入(rounding) / 饱和(saturation)
- 量化误差报告：各节点 SNR 退化、最大误差、MSE 汇总

### 2.3 Bit-true 定点模型
- MATLAB `fi()` 重构定点模型
- 与浮点基线逐比特对齐（bit-true）

### 2.4 资源评估
- DSP/LUT/BRAM 预算表（基于定点结果 + 架构框图，非经验估算）
- 若超标 → 回退 2.2 调整位宽，或回退 Phase 1 调整架构
- 输出架构缩放建议

**检查点**: fixed_point_report + resource_estimate 完成，资源预算在约束内。
**参考**: `skills/hdl-coding/references/alg-flow-verilog.md`（Python 定点函数）, `docs/templates/fixed_point_report_template.md`, `docs/templates/resource_estimate_template.md`
**输出**: `fixed_point_report.md`, `resource_estimate.md`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_2
```

---

## Phase 3: Testbench-First（自检框架 + SVA + 数据对齐）

**目标**: 先写能自动判断对错的 testbench，再写 RTL。

### 3.1 比对策略选定（来自 Phase 1 的数据对齐规划）

根据模块特性选择比对模式，解决 RTL 与参考模型之间的时序差异：

| 模式 | 适用场景 | 说明 |
|:-----|:---------|:------|
| **周期精确** | 组合逻辑、固定延迟流水线 | 逐 cycle 比对 `dout === expected`。参考模型输出每 cycle 预期值 |
| **事务级** | 有握手/反压的模块 | 比对事务内容与顺序，忽略具体 timing。用 `mailbox`/`queue` 缓存后比对 |
| **Scoreboard 累计** | 无序输出、多通道聚合 | 累积所有输出总量，结束时一次性比对 |

选定策略后在 `compare_mode` 参数中记录。建议跨 cycle 关系用 SVA `##[min:max]` 约束，不要硬编码固定延迟。

### 3.2 自检 Testbench 模板

```systemverilog
module tb_module;
  // 时钟/复位生成
  // DUT 例化
  // 激励产生
  // 预期输出加载（来自 Phase 1 的 .hex）

  integer cycle_count;
  always @(posedge clk) begin
    if (compare_enable) begin
      if (dout !== expected_dout) begin
        $display("[FAIL] cycle=%0d dout=%h expected=%h",
                 cycle_count, dout, expected_dout);
        error_count++;
      end else begin
        $display("[PASS] cycle=%0d dout=%h", cycle_count, dout);
      end
      cycle_count++;
    end
  end

  initial begin
    $display("=== Test Start ===");
    // 运行测试
    #1000;
    $display("=== Test End: %0d errors ===", error_count);
    $finish;
  end
endmodule
```

### 3.3 SVA 断言嵌入

```systemverilog
// 每个关键属性都作为仿真时的实时检查点
assert property (@(posedge clk) valid |-> ##[1:3] ready);
assert property (@(posedge clk) fifo_full |-> !fifo_wr);
```

### 3.4 结构化日志宏

```systemverilog
`define LOG(lvl, msg) \
  $display("[%t] [%s] %s", $time, lvl, msg)

// 使用
`LOG("PHASE", "Layer 0: 端口连通性测试")
`LOG("CHECK", "data_in=%h data_out=%h", din, dout)
`LOG("PASS", "FIFO 读写测试通过")
`LOG("FAIL", "状态机预期状态=%s 实际=%s", EXPECTED, current)
```

**检查点**: testbench 编译通过，自检逻辑完整，SVA 无编译错误。
**关联 Skill**: `hdl-coding`（Testbench 结构模板、SVA 编写参考）
**数据输入**: `.claude/state/hdl-coding/project-spec.json`（Phase 1 输出，含端口列表和比对策略）

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_3
```

---

## Phase 4: 增量式 RTL 编码（分层验证）

**目标**: 从最小可验证单元开始，每层仿真绿灯后再推进。

### 层间依赖与 Stub 机制

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

### 运行方式（实时输出到对话框）

**短仿真（< 30s 每层）** — 直接 run，输出一次返回：

```bash
# 通过 Makefile 执行仿真（Phase 0 工具抽象层，自动选择工具链）
make sim TEST=short_test
# 输出示例:
#   [100ns] [PHASE] Layer 0: 端口连通性测试
#   [150ns] [PASS] data_in=32'hA5 正确通过
#   [200ns] [FAIL] ready 信号未在 3 周期内拉高
#   [300ns] === Test End: 1 errors ===
```

**长仿真** — 后台运行 + 轮询输出文件：

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

### 日志可靠性规范

**问题**：`$display` → stdout 在大仿真（> 数万行）时被 Bash 工具截断；`$fwrite` → 文件存在缓冲区未 flush 导致 crash 丢日志。

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

### 层推进规则

| 层 | 通过条件 | 失败处理 |
|:--|---------|---------|
| Layer 0 | 所有 port 连通 | 检查例化/信号名 |
| Layer 1 | CSR 读写匹配 | 检查地址译码 |
| Layer 2 | 状态机按预期跳转 | 检查 next-state 逻辑 |
| Layer 3 | 数据输出与 golden model 一致 | 检查数据通路组合逻辑 |
| Layer 4 | 边界处理不挂死 | 检查错误处理路径 |

**检查点**: Layer 0-4 依次通过，日志中无 FAIL。
**关联 Skill**: `hdl-coding`（FSM 模板、流水线模板、命名规范）、`debugging`（仿真异常调试）
**数据输入**: `.claude/state/hdl-coding/project-spec.json`（比对模式和端口定义）
**数据输出**: `.claude/state/hdl-coding/layer-status.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_4
```

---

## Phase 5: 回归 + 覆盖率

**目标**: 确保改动不破坏已有功能，覆盖关键功能场景。

1. **回归测试** — 全量运行所有已通过的 Layer
   - 通过 `make regress` 执行
   - 回归前确认 baseline clean（`git stash` 未提交修改后再跑）
2. **覆盖率收集** — 功能覆盖点（covergroup）触发率
   - covergroup 编写时标注 **mandatory**（核心功能路径）vs **informative**（边界/异常路径）
   - mandatory 覆盖点要求 100% 触发
   - informative 覆盖点提供覆盖率趋势参考，不阻塞审查
3. **红线规则**:
   - 已有 PASS 的 case 回归不能变 FAIL
   - Mandatory 覆盖点 < 100% 不能进审查
   - 总体功能覆盖率 < 90% 提示"需评估风险"，不强制阻塞
4. **Golden Model 覆盖率映射** — 将参考模型的测试用例映射到 covergroup：
   - 每个测试用例标注覆盖了哪些 covergroup
   - 回归报告中显示 "golden model coverage gap"（参考模型跑了但 covergroup 未覆盖的路径）
   - 减少"仿真全绿但覆盖率空洞"的风险

**检查点**: 回归全绿 + mandatory covergroup 全部触发 + 覆盖率报告已审查。
**关联 Skill/MCP**: `matlab` MCP（Golden Model 覆盖率映射验证）
**数据输入**: `.claude/state/hdl-coding/layer-status.json`（Phase 4 输出，含回归历史）

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_5
```

---

## Phase 6: 代码审查

**目标**: 确认代码质量、风格、以及流程合规性。

1. **自审查清单**:
   - [ ] 构建系统：Makefile + filelist 已创建，`make lint` / `make compile` 通过
   - [ ] 工具链：所有仿真/编译命令使用抽象接口（`make sim` 而非 vsim/vcs 硬编码）
   - [ ] 数据对齐：已选定比对模式（周期精确/事务级/Scoreboard），testbench 正确实现
   - [ ] 日志可靠：双通道日志（stdout + 文件）+ 完成标记 + 定期 flush
   - [ ] 无组合环路
   - [ ] 多驱动检查
   - [ ] CDC 同步器（两级 reg / 握手 / FIFO）
   - [ ] 复位极性一致性
   - [ ] 无 lint warning
   - [ ] 所有 SVA 断言已启用
   - [ ] 参考模型对比通过
   - [ ] Layer 间 Stub（如果有）已标注 TODO，后续替换为完整实现
   - [ ] Phase 1 模块设计方案中预见的难点已解决
2. **提交 code-review** — 用 `code-review` 的 quality 模式

**输出**: 审查通过的 RTL + 完整仿真日志 + 覆盖率报告。
**关联 Skill**: `code-review`（质量审查模式）、`hdl-coding`（时序安全/命名规范核查）
**数据输入**: `.claude/state/hdl-coding/layer-status.json`

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_6
```

---

## Phase 7: 报告输出

**目标**: 汇总各阶段文档，形成可交付的完整设计包，记录经验教训。

1. **实现报告**: `report_*_fpga_implementation.md`
   - 架构框图决策说明
   - 定点量化结果汇总（位宽表、量化误差）
   - 资源评估结果（DSP/LUT/BRAM 实际 vs 预算）
   - 性能指标（BER/EVM 退化率）
   - 难点解决方案回顾
2. **文档归档**: 所有阶段文档整理链接
   - `algorithm_spec.md` → Phase 1
   - `golden_model/` → Phase 1
   - `fixed_point_report.md` → Phase 2
   - `resource_estimate.md` → Phase 2
   - RTL 源码 → Phase 4
   - 仿真日志 → Phase 3-5
   - 覆盖率报告 → Phase 5
3. **经验记录**: 关键决策、踩坑记录
   - 记录到 `memory/learnings/` 或项目文档
   - 供后续算法模块参考

**检查点**: 报告完成，文档归档，经验已记录。
**参考**: `docs/templates/` 各阶段模板

**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_7
```

---

## 仿真调试透明化对照表

| 传统方式 | v3 方式 | 区别 |
|---------|--------|------|
| 直接写 RTL | 先架构框图+模块方案+难点分析 | 代码前已有完整设计规划 |
| 凭经验估算定点位宽 | Phase 2 定点扫描驱动位宽选择 | 量化决策有数据支撑 |
| 资源靠猜 | Phase 2 基于定点+架构框图的资源评估 | 资源预算可追踪可验证 |
| 写完再仿真 | 写一段仿一段 | 故障定位从小时级→分钟级 |
| 人工看波形 | 自动比对 golden model | 发现错误从"感觉不对"→"第 N 个 cycle 数据不匹配" |
| testbench 一次性写 | Testbench-First 分层写 | 每层是独立检查点，不互相阻塞 |
| 仿真沉默运行 | `$display` + `$fwrite` 双通道日志 | 崩溃不丢日志，长仿真可靠轮询 |
| 单一工具链绑定 | 工具抽象层（TAL）+ Makefile | 切换 Questa/VCS/Xcelium 只需改一行变量 |
| 线性层推进 | 依赖图 + Stub 机制 | 复杂依赖不阻塞增量开发 |
| 周期精确固定比对 | 三种比对模式可选 | 适应流水线延迟、握手反压、无序输出 |
| 功能覆盖率 90% 硬红线 | mandatory 必须 100% + informative 趋势参考 | 覆盖率有区分，不因不可能的组合阻塞审查 |
| 最终 PASS/FAIL 一行 | 逐层进度 + 每 cycle 比对 | 看到"走到哪了、哪一步错了" |

## 关联资源

| 资源 | 路径 | 用途 |
|------|------|------|
| HDL 编码规范 | `skills/hdl-coding/SKILL.md` | 命名规则、时序安全、lint 门禁 |
| 算法→Verilog 参考 | `skills/hdl-coding/references/alg-flow-verilog.md` | 代码模板、NMSE 判定、常见问题排查 |
| TDD 工作流 | `skills/tdd/SKILL.md` | Testbench-First 方法论 |
| Code Review 工作流 | `workflows/code-review-workflow.md` | Phase 6 审查环节 |
| MATLAB MCP | `CLAUDE.md` | Golden model 生成与验证 |
| Project Spec Schema | `schemas/hdl-project-spec.schema.json` | Phase 1→3 数据契约（端口/时序/比对策略） |
| Layer Status Schema | `schemas/hdl-layer-status.schema.json` | Phase 4→5 数据契约（层推进状态） |
| 检查点脚本 | `.claude/checkpoints/hdl-checkpoints.sh` | 各 Phase 可执行断言 |
| Developer Agent | `agents/core/developer.md` | HDL 编码执行者（已绑定 hdl-coding skill） |
| QA Agent | `agents/core/qa.md` | 回归/覆盖率验证（已绑定 hdl-coding skill） |
| Code Reviewer Agent | `agents/specialized/code-reviewer.md` | 代码审查（已绑定 hdl-coding skill） |
