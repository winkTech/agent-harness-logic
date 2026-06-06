---
name: hdl-coding-workflow
description: RTL 开发全流程 — 参考模型→Testbench-First→增量仿真→透明调试
version: 2.0.0
agents: [developer, qa, code-reviewer]
phases: 6
complexity: medium-high
triggers:
  - new RTL module
  - testbench creation
  - lint cleanup
  - code review prep
---

# HDL Coding Workflow (v2)

RTL 开发流程。核心原则：**验证左移，每层有检查点，仿真日志实时可读**。

把 "写完再看对不对" 改成 "写一点就验证一点，每一步都知道对错"。

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

## Phase 1: 规格 + Golden Reference Model

**目标**: 在设计 RTL 之前，先用 MATLAB/Python 产生可验证的预期输出。

1. **接口确定** — 模块端口列表（时钟/复位/数据/控制）
2. **时序规划** — 流水线级数、时钟域、握手协议
3. **状态机设计** — 状态转移图
4. **量化分析** — 位宽、资源估算、时序余量
5. **Reference Model** — MATLAB/Python 编写功能参考模型：
   - 产生 `expected_output.hex` / `.bin`
   - 包含多个测试用例（正常/边界/错误）
   - 供后续 RTL 仿真自动比对
6. **数据对齐策略** — 根据模块特性选择比对模式，解决 RTL 与参考模型之间的时序差异：
   - **周期精确 (Cycle-Accurate)**：逐 cycle 比对 `dout === expected`。适用：组合逻辑、固定延迟流水线。参考模型需输出每 cycle 预期值。
   - **事务级 (Transaction-Based)**：比对事务内容与顺序，忽略具体 timing。适用：有握手/反压的模块。参考模型输出事务序列，testbench 使用 `mailbox`/`queue` 缓存后比对。
   - **Scoreboard 累计**：累积所有输出总量，结束时一次性比对。适用：无序输出、多通道聚合。参考模型计算预期总额，testbench 累计实际值后比较。

   选定策略后在 `compare_mode` 参数中记录。建议跨 cycle 关系用 SVA `##[min:max]` 约束，不要硬编码固定延迟。

**检查点**: 参考模型运行通过，预期数据已保存。
**关联 Skill/MCP**: MATLAB MCP / Python — 运行 Golden Model 生成预期数据
**数据输出**: `.claude/state/hdl-coding/project-spec.json`（符合 `schemas/hdl-project-spec.schema.json`）
**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_1
```

---

## Phase 2: Testbench-First（自检框架 + SVA 断言）

**目标**: 先写能自动判断对错的 testbench，再写 RTL。

### 2.1 自检 Testbench 模板

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

### 2.2 SVA 断言嵌入

```systemverilog
// 每个关键属性都作为仿真时的实时检查点
assert property (@(posedge clk) valid |-> ##[1:3] ready);
assert property (@(posedge clk) fifo_full |-> !fifo_wr);
```

### 2.3 结构化日志宏

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
**数据输入**: `.claude/state/hdl-coding/project-spec.json`（Phase 1 输出，定义端口列表和比对模式）
**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_2
```

---

## Phase 3: 增量式 RTL 编码（分层验证）

**目标**: 从最小可验证单元开始，每层仿真绿灯后再推进。

```
Layer 0: 端口连通性         ← 每个 port 能正确读写
Layer 1: 寄存器/配置通路     ← CSR 读写、配置生效
Layer 2: 控制逻辑           ← 状态机跳转、握手协议
Layer 3: 数据通路           ← 单笔数据 → 流水线满负荷
Layer 4: 边界条件           ← 空/满/溢出/错误处理
```

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
**数据输出**: `.claude/state/hdl-coding/layer-status.json`（符合 `schemas/hdl-layer-status.schema.json`）
**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_3
```

---

## Phase 4: 回归 + 覆盖率

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
**数据输入**: `.claude/state/hdl-coding/layer-status.json`（Phase 3 输出，含回归历史）
**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_4
```

---

## Phase 5: 代码审查

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
2. **提交 code-review** — 用 `code-review` 的 quality 模式

**输出**: 审查通过的 RTL + 完整仿真日志 + 覆盖率报告
**关联 Skill**: `code-review`（质量审查模式）、`hdl-coding`（时序安全/命名规范核查）
**数据输入**: `.claude/state/hdl-coding/layer-status.json`
**可执行检查点**:
```bash
source .claude/checkpoints/hdl-checkpoints.sh && check_phase_5
```

---

## 仿真调试透明化对照表

| 传统方式 | v2 方式 | 区别 |
|---------|--------|------|
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
| TDD 工作流 | `skills/tdd/SKILL.md` | Testbench-First 方法论 |
| Code Review 工作流 | `workflows/code-review-workflow.md` | Phase 5 审查环节 |
| MATLAB MCP | `CLAUDE.md` | Golden model 生成与验证 |
| Project Spec Schema | `schemas/hdl-project-spec.schema.json` | Phase 1→2 数据契约（端口/时序/比对策略） |
| Layer Status Schema | `schemas/hdl-layer-status.schema.json` | Phase 3→4 数据契约（层推进状态） |
| 检查点脚本 | `.claude/checkpoints/hdl-checkpoints.sh` | 各 Phase 可执行断言 |
| Developer Agent | `agents/core/developer.md` | HDL 编码执行者（已绑定 hdl-coding skill） |
| QA Agent | `agents/core/qa.md` | 回归/覆盖率验证（已绑定 hdl-coding skill） |
| Code Reviewer Agent | `agents/specialized/code-reviewer.md` | 代码审查（已绑定 hdl-coding skill） |
