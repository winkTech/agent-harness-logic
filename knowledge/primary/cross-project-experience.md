---
title: "跨项目经验复用"
domain: fpga
tags: [cross-project, experience, reuse, templates]
created: 2026-06-01
updated: 2026-06-01
difficulty: intermediate
---

# 跨项目经验复用

## 概述

本文档建立跨项目经验复用机制，将成功经验模板化，便于新项目快速启动。

---

## 一、项目模板

### 1. FPGA 项目模板

```
prj/
├── 00_comm/           # 全局脚本、配置文件（JSON等）
├── 01_src/            # 源代码目录
│   ├── 00_hdl/        # HDL 代码（按模块功能划分）
│   │   ├── 00_com/    # 全局通用模块、头文件
│   │   ├── 01_xx0/    # xx0 模块相关文件
│   │   └── ...        # 根据项目架构扩展
│   └── 01_ip/         # IP 核文件（按模块功能划分）
│       ├── 00_xx0/    # xx0 模块 IP
│       ├── 01_xx1/    # xx1 模块 IP
│       └── ...        # 根据项目架构扩展
├── 02_sim/            # 仿真文件（按测试模块分类）
│   ├── <module_name>/ # 与 01_src/00_hdl/ 下的模块同名
│   │   ├── tb_*.v     # 测试平台
│   │   ├── tc_*.v     # 测试用例
│   │   └── data/      # 测试数据
│   ├── ...            # 每个模块一个目录
├── 03_xdc/            # 约束文件（XDC）
├── 04_prj/            # Vivado 工程文件
├── 05_bin/            # 比特流文件、版本说明
├── 06_doc/            # 设计文档、接口文档
├── 07_mat/            # MATLAB 代码
│   ├── 00_fx/         # 函数文件
│   ├── 01_conf/       # 配置常量
│   └── 02_script/     # 模型代码、计算模块
├── 08_py/             # Python 代码
│   ├── 00_utils/      # 工具函数
│   ├── 01_sim/        # 仿真脚本
│   ├── 02_plot/       # 绘图脚本
│   ├── 03_test/       # 测试脚本
│   └── ...            # 根据项目需要扩展
├── README.md          # 项目介绍
└── .claude/           # Claude Code 配置
```

**使用规则**：
- 只在有明确新建项目的要求时，添加以下设计目录
- 在已有目录下，没有明确地文件夹改动指令时，路径下的文件夹不做任何改动

**目录命名规范**：
- 编号前缀：00-08，便于排序
- 小写字母 + 下划线：如 `00_hdl`、`01_ip`
- 模块目录：按功能命名，如 `fifo`、`uart`、`ctrl`

**文件组织原则**：
- 每个模块一个目录
- 相关文件放在一起
- 测试文件与源文件对应

**仿真目录命名规则**：
- 02_sim/ 下的目录名与 01_src/00_hdl/ 下的模块目录名一致
- 例如：源代码 `01_src/00_hdl/fifo/` 对应仿真 `02_sim/fifo/`
- 测试平台统一使用 `tb_<module>.v` 命名
- 测试用例统一使用 `tc_<module>_<test>.v` 命名

### 项目初始化脚本

```bash
#!/bin/bash
# init_project.sh - 项目初始化脚本

PROJECT_NAME=$1

if [ -z "$PROJECT_NAME" ]; then
    echo "用法: ./init_project.sh <项目名称>"
    exit 1
fi

echo "创建项目: $PROJECT_NAME"

# 创建目录结构
mkdir -p prj/{00_comm,01_src/{00_hdl/00_com,01_ip},02_sim,03_xdc,04_prj,05_bin,06_doc,07_mat/{00_fx,01_conf,02_script},08_py,.claude}

# 创建 README
cat > README.md << EOF
# $PROJECT_NAME

## 项目简介
[项目描述]

## 目录结构
- prj/00_comm/ - 全局脚本
- prj/01_src/ - 源代码
- prj/02_sim/ - 仿真文件
- prj/03_xdc/ - 约束文件
- prj/04_prj/ - 工程文件
- prj/05_bin/ - 比特流文件
- prj/06_doc/ - 文档
- prj/07_mat/ - MATLAB 代码
- prj/08_py/ - Python 代码

## 开发环境
- Vivado: [版本]
- MATLAB: [版本]
- Python: [版本]

## 使用说明
[使用说明]
EOF

echo "项目创建完成！"
echo "目录结构已创建"
```

### 2. 模块模板

#### 2.1 基础模块模板

```verilog
//=============================================================================
// 模块名称: module_name
// 功能描述: 简要描述模块功能
// 输入: clk, rst_n, data_in, valid_in
// 输出: data_out, valid_out
//=============================================================================
module module_name #(
    parameter DATA_WIDTH = 8,
    parameter ADDR_WIDTH = 4
)(
    // 系统信号
    input  wire                    clk,
    input  wire                    rst_n,

    // 输入接口
    input  wire [DATA_WIDTH-1:0]   data_in,
    input  wire                    valid_in,

    // 输出接口
    output reg  [DATA_WIDTH-1:0]   data_out,
    output reg                     valid_out
);

// 内部信号
reg [DATA_WIDTH-1:0] r_data;
reg r_valid;

// 输入寄存
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        r_data <= {DATA_WIDTH{1'b0}};
        r_valid <= 1'b0;
    end
    else begin
        r_data <= data_in;
        r_valid <= valid_in;
    end
end

// 输出寄存
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        data_out <= {DATA_WIDTH{1'b0}};
        valid_out <= 1'b0;
    end
    else begin
        data_out <= r_data;
        valid_out <= r_valid;
    end
end

endmodule
```

#### 2.2 状态机模块模板

```verilog
//=============================================================================
// 模块名称: fsm_module
// 功能描述: 三段式状态机
//=============================================================================
module fsm_module #(
    parameter DATA_WIDTH = 8
)(
    input  wire                    clk,
    input  wire                    rst_n,
    input  wire                    start,
    input  wire [DATA_WIDTH-1:0]   data_in,
    output reg  [DATA_WIDTH-1:0]   data_out,
    output reg                     done
);

// 状态定义
localparam [2:0]
    S_IDLE = 3'b000,
    S_CALC = 3'b001,
    S_DONE = 3'b010;

// 状态寄存器
reg [2:0] r_state, r_next;

// 1. 状态寄存器
always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
        r_state <= S_IDLE;
    else
        r_state <= r_next;
end

// 2. 次态逻辑
always @(*) begin
    case (r_state)
        S_IDLE: r_next = start ? S_CALC : S_IDLE;
        S_CALC: r_next = S_DONE;
        S_DONE: r_next = S_IDLE;
        default: r_next = S_IDLE;
    endcase
end

// 3. 输出逻辑
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        data_out <= {DATA_WIDTH{1'b0}};
        done <= 1'b0;
    end
    else begin
        case (r_next)
            S_CALC: begin
                data_out <= data_in + 1;
                done <= 1'b0;
            end
            S_DONE: begin
                done <= 1'b1;
            end
            default: begin
                done <= 1'b0;
            end
        endcase
    end
end

endmodule
```

### 3. 约束文件模板

```tcl
##=============================================================================
## 文件名称: top.xdc
## 功能描述: 顶层约束文件
##=============================================================================

##-----------------------------------------------------------------------------
## 时钟约束
##-----------------------------------------------------------------------------
# 主时钟
create_clock -period 10.000 -name clk_100m [get_ports clk]

# 生成时钟（如有 PLL/MMCM）
# create_generated_clock -name clk_50m -source [get_pins pll/clk_in] -divide_by 2 [get_pins pll/clk_out]

##-----------------------------------------------------------------------------
## I/O 约束
##-----------------------------------------------------------------------------
# 输入延迟
# set_input_delay -clock clk_100m -max 5.000 [get_ports data_in]
# set_input_delay -clock clk_100m -min 2.000 [get_ports data_in]

# 输出延迟
# set_output_delay -clock clk_100m -max 5.000 [get_ports data_out]
# set_output_delay -clock clk_100m -min 2.000 [get_ports data_out]

##-----------------------------------------------------------------------------
## 虚假路径
##-----------------------------------------------------------------------------
# 异步复位
set_false_path -from [get_ports rst_n]

# 跨时钟域（如有）
# set_false_path -from [get_clocks clk_a] -to [get_clocks clk_b]

##-----------------------------------------------------------------------------
## 多周期路径（如有）
##-----------------------------------------------------------------------------
# set_multicycle_path -setup 2 -from [get_pins reg_a/D] -to [get_pins reg_b/D]
# set_multicycle_path -hold 1 -from [get_pins reg_a/D] -to [get_pins reg_b/D]

##-----------------------------------------------------------------------------
## 管脚分配（根据实际硬件修改）
##-----------------------------------------------------------------------------
# set_property PACKAGE_PIN E3 [get_ports clk]
# set_property IOSTANDARD LVCMOS33 [get_ports clk]

# set_property PACKAGE_PIN C12 [get_ports rst_n]
# set_property IOSTANDARD LVCMOS33 [get_ports rst_n]
```

### 4. 测试平台模板

#### 4.1 基础测试平台

```verilog
//=============================================================================
// 测试平台: tb_module_name
// 功能描述: 测试 module_name 模块
//=============================================================================
`timescale 1ns / 1ps

module tb_module_name;

// 参数
parameter DATA_WIDTH = 8;
parameter CLK_PERIOD = 10;  // 100MHz

// 信号
reg clk;
reg rst_n;
reg [DATA_WIDTH-1:0] data_in;
reg valid_in;
wire [DATA_WIDTH-1:0] data_out;
wire valid_out;

// 时钟生成
initial begin
    clk = 0;
    forever #(CLK_PERIOD/2) clk = ~clk;
end

// 复位生成
initial begin
    rst_n = 0;
    #100;
    rst_n = 1;
end

// 实例化被测模块
module_name #(
    .DATA_WIDTH(DATA_WIDTH)
) u_dut (
    .clk(clk),
    .rst_n(rst_n),
    .data_in(data_in),
    .valid_in(valid_in),
    .data_out(data_out),
    .valid_out(valid_out)
);

// 测试激励
initial begin
    // 初始化
    data_in = 0;
    valid_in = 0;

    // 等待复位完成
    @(posedge rst_n);
    #100;

    // 测试用例 1: 基本功能
    $display("Test Case 1: Basic Function");
    data_in = 8'hAA;
    valid_in = 1;
    #CLK_PERIOD;
    valid_in = 0;
    #100;

    // 检查结果
    if (data_out !== 8'hAA) begin
        $display("FAIL: Expected 0xAA, got %h", data_out);
    end else begin
        $display("PASS");
    end

    // 测试结束
    #1000;
    $finish;
end

// 波形输出
initial begin
    $dumpfile("waveform.vcd");
    $dumpvars(0, tb_module_name);
end

endmodule
```

#### 3.2 自检测试平台

```verilog
//=============================================================================
// 测试平台: tb_self_check
// 功能描述: 自检测试平台，自动比较结果
//=============================================================================
`timescale 1ns / 1ps

module tb_self_check;

parameter DATA_WIDTH = 8;
parameter CLK_PERIOD = 10;
parameter TEST_CASES = 10;

// 信号
reg clk;
reg rst_n;
reg [DATA_WIDTH-1:0] data_in;
reg valid_in;
wire [DATA_WIDTH-1:0] data_out;
wire valid_out;

// 测试数据
reg [DATA_WIDTH-1:0] test_data [0:TEST_CASES-1];
reg [DATA_WIDTH-1:0] expected_data [0:TEST_CASES-1];

// 统计
integer pass_count;
integer fail_count;
integer test_index;

// 时钟生成
initial begin
    clk = 0;
    forever #(CLK_PERIOD/2) clk = ~clk;
end

// 实例化被测模块
module_name #(
    .DATA_WIDTH(DATA_WIDTH)
) u_dut (
    .clk(clk),
    .rst_n(rst_n),
    .data_in(data_in),
    .valid_in(valid_in),
    .data_out(data_out),
    .valid_out(valid_out)
);

// 初始化测试数据
initial begin
    // 设置测试数据和期望结果
    test_data[0] = 8'h00; expected_data[0] = 8'h01;
    test_data[1] = 8'hAA; expected_data[1] = 8'hAB;
    test_data[2] = 8'h55; expected_data[2] = 8'h56;
    // ... 更多测试用例
end

// 测试执行
initial begin
    // 初始化
    pass_count = 0;
    fail_count = 0;
    test_index = 0;
    data_in = 0;
    valid_in = 0;

    // 等待复位
    @(posedge rst_n);
    #100;

    // 执行测试用例
    for (test_index = 0; test_index < TEST_CASES; test_index = test_index + 1) begin
        $display("Test Case %0d: Input=0x%h, Expected=0x%h",
                 test_index, test_data[test_index], expected_data[test_index]);

        // 输入数据
        data_in = test_data[test_index];
        valid_in = 1;
        #CLK_PERIOD;
        valid_in = 0;

        // 等待输出
        #100;

        // 比较结果
        if (data_out === expected_data[test_index]) begin
            $display("  PASS");
            pass_count = pass_count + 1;
        end else begin
            $display("  FAIL: Got 0x%h", data_out);
            fail_count = fail_count + 1;
        end
    end

    // 输出统计
    $display("\n=== Test Summary ===");
    $display("Total: %0d, Pass: %0d, Fail: %0d",
             TEST_CASES, pass_count, fail_count);

    if (fail_count == 0)
        $display("ALL TESTS PASSED!");
    else
        $display("SOME TESTS FAILED!");

    $finish;
end

endmodule
```

### 5. 仿真运行脚本

```bash
#!/bin/bash
# run_sim.sh - 仿真运行脚本

MODULE=$1
TESTCASE=$2

if [ -z "$MODULE" ]; then
    echo "用法: ./run_sim.sh <模块名> [测试用例]"
    echo "示例: ./run_sim.sh fifo"
    echo "示例: ./run_sim.sh fifo basic"
    exit 1
fi

# 目录设置
SIM_DIR="prj/02_sim/$MODULE"
TB_FILE="$SIM_DIR/tb_${MODULE}.v"
SRC_DIR="prj/01_src/00_hdl"

# 检查测试平台是否存在
if [ ! -f "$TB_FILE" ]; then
    echo "错误: 测试平台不存在: $TB_FILE"
    exit 1
fi

# 创建仿真目录
mkdir -p prj/02_sim/$MODULE/work

# 编译
echo "编译 $MODULE 模块..."
vlog -work work \
    $SRC_DIR/00_common/*.v \
    $SRC_DIR/*/$MODULE/*.v \
    $TB_FILE

if [ $? -ne 0 ]; then
    echo "编译失败"
    exit 1
fi

# 仿真
echo "运行仿真..."
if [ -n "$TESTCASE" ]; then
    vsim -c work.tb_${MODULE} -do "run -all; quit"
else
    vsim -c work.tb_${MODULE} -do "run -all; quit"
fi

echo "仿真完成"
```

### 6. .gitignore 模板

```gitignore
# Vivado 项目文件
*.xpr
*.runs/
*.cache/
*.hw/
*.ip_user_files/
*.sim/

# 临时文件
*.log
*.jou
*.str
*.pb
*.dcp

# 比特流文件（可选，根据需要决定是否忽略）
# *.bit
# *.bin

# 仿真输出
*.wdb
*.vcd
*.wlf

# Python
__pycache__/
*.pyc
.pytest_cache/

# MATLAB
*.asv
*.mex*

# OS
.DS_Store
Thumbs.db
```

### 7. README 模块模板

```markdown
# 模块名称

## 功能描述
简要描述模块功能

## 接口定义

| 信号 | 方向 | 位宽 | 说明 |
|------|------|------|------|
| clk | input | 1 | 时钟 |
| rst_n | input | 1 | 异步复位 |
| data_in | input | DATA_WIDTH | 数据输入 |
| valid_in | input | 1 | 输入有效 |
| data_out | output | DATA_WIDTH | 数据输出 |
| valid_out | output | 1 | 输出有效 |

## 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| DATA_WIDTH | 8 | 数据位宽 |

## 时序要求
- 时钟频率: 100MHz
- 建立时间: < 5ns
- 保持时间: < 2ns

## 使用说明
[使用说明]

## 测试说明
测试平台位于 `prj/02_sim/<module>/`

## 参考文档
- fpga-design-guide.md
- timing-constraints-guide.md
```

---

## 二、设计模式库

### 1. 常用设计模式

| 模式 | 用途 | 文档 |
|------|------|------|
| **流水线** | 提高吞吐量 | fpga-design-guide.md |
| **状态机** | 控制逻辑 | ai-hardware-coding-spec.md |
| **FIFO** | 数据缓冲 | algorithm-implementation.md |
| **握手机制** | 跨时钟域 | timing-constraints-guide.md |
| **仲裁器** | 资源共享 | algorithm-implementation.md |

### 2. 设计模式模板

```verilog
//=============================================================================
// 设计模式: 流水线
// 用途: 提高吞吐量，隔离组合逻辑
//=============================================================================
module pipeline_stage #(
    parameter DATA_WIDTH = 8
)(
    input  wire                    clk,
    input  wire                    rst_n,
    input  wire [DATA_WIDTH-1:0]   data_in,
    input  wire                    valid_in,
    output reg  [DATA_WIDTH-1:0]   data_out,
    output reg                     valid_out
);

// 流水线寄存器
always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
        data_out <= {DATA_WIDTH{1'b0}};
        valid_out <= 1'b0;
    end
    else begin
        data_out <= data_in;
        valid_out <= valid_in;
    end
end

endmodule
```

---

## 三、IP 核管理

### 1. IP 核使用规范

| 规范 | 说明 |
|------|------|
| **版本控制** | 记录 IP 核版本号 |
| **配置文档** | 记录 IP 核配置参数 |
| **接口定义** | 明确 IP 核接口信号 |
| **测试验证** | 验证 IP 核功能 |

### 2. IP 核目录结构

```
01_src/01_ip/
├── 00_clk/            # 时钟相关 IP
│   ├── pll/           # PLL
│   │   ├── ip_pll.xci
│   │   ├── ip_pll.xco
│   │   └── README.md  # 配置说明
│   └── mmcm/          # MMCM
├── 01_mem/            # 存储器 IP
│   ├── bram/          # BRAM
│   └── fifo/          # FIFO
├── 02_dsp/            # DSP IP
│   ├── mult/          # 乘法器
│   └── acc/           # 累加器
└── 03_comm/           # 通信 IP
    ├── uart/          # UART
    └── spi/           # SPI
```

### 3. IP 核配置文档模板

```markdown
# IP 核名称: [名称]

## 基本信息
- IP 类型: [PLL/BRAM/FIFO/etc]
- 版本: [版本号]
- 供应商: [Xilinx/Altera/自研]

## 配置参数
| 参数 | 值 | 说明 |
|------|-----|------|
| CLKIN_PERIOD | 10.000 | 输入时钟周期(ns) |
| CLKFBOUT_MULT | 12 | 反馈倍频 |
| DIVCLK_DIVIDE | 1 | 分频 |
| CLKOUT0_DIVIDE | 1 | 输出分频 |

## 接口定义
| 信号 | 方向 | 说明 |
|------|------|------|
| clk_in | input | 输入时钟 |
| clk_out | output | 输出时钟 |
| locked | output | 锁定信号 |

## 使用说明
[使用说明]

## 验证结果
[验证结果]
```

---

## 四、问题解决库

### 1. 常见问题及解决方案

| 问题 | 原因 | 解决方案 | 参考文档 |
|------|------|----------|----------|
| **时序违例** | 逻辑层级过多 | 插入流水线 | timing-constraints-guide.md |
| **资源不足** | 设计规模大 | 资源共享、IP Core | fpga-best-practices.md |
| **功耗过高** | 时钟频率高 | 时钟门控、降低频率 | fpga-design-guide.md |
| **仿真不收敛** | 时序问题 | 检查时序、验证复位 | verilog-design-experience.md |
| **综合失败** | 语法错误 | 检查语法、遵循规范 | fpga-coding-standards.md |

### 2. 问题解决流程

```
发现问题 → 分析原因 → 查找解决方案 → 实施修复 → 验证结果
    │
    ├── 查阅文档
    │   ├── error-recovery.md
    │   ├── fpga-best-practices.md
    │   └── timing-constraints-guide.md
    │
    ├── 搜索知识库
    │   ├── 关键词搜索
    │   ├── 标签搜索
    │   └── 知识图谱导航
    │
    └── 参考经验
        ├── 项目历史
        ├── 团队经验
        └── 社区资源
```

---

## 五、代码复用库

### 1. 常用模块

| 模块 | 功能 | 文档 |
|------|------|------|
| **FIFO** | 数据缓冲 | algorithm-implementation.md |
| **UART** | 串口通信 | algorithm-implementation.md |
| **SPI** | 外设接口 | riscv-fpga-guide.md |
| **I2C** | 总线接口 | riscv-fpga-guide.md |
| **CRC** | 校验计算 | algorithm-implementation.md |

### 2. 模块复用规范

```verilog
//=============================================================================
// 模块复用规范
//=============================================================================
// 1. 参数化设计
module module_name #(
    parameter DATA_WIDTH = 8,
    parameter ADDR_WIDTH = 4
)(
    ...
);

// 2. 清晰的接口定义
// 输入: clk, rst_n, data_in, valid_in
// 输出: data_out, valid_out

// 3. 充分的注释
// 功能描述、输入输出说明、时序要求

// 4. 测试平台
// 提供完整的测试平台和测试用例

// 5. 文档
// 提供设计文档和使用说明
```

---

## 六、项目启动清单

### 1. 新项目启动检查

- [ ] 明确项目需求
- [ ] 确定目标器件
- [ ] 规划模块结构
- [ ] 选择设计模式
- [ ] 准备开发环境

### 2. 设计阶段检查

- [ ] 完成架构设计
- [ ] 定义接口规范
- [ ] 编写设计文档
- [ ] 代码审查
- [ ] 时序约束

### 3. 验证阶段检查

- [ ] 编写测试平台
- [ ] 功能仿真通过
- [ ] 时序仿真通过
- [ ] 代码覆盖率达标
- [ ] 性能指标达标

### 4. 发布阶段检查

- [ ] 比特流生成
- [ ] 硬件测试通过
- [ ] 文档更新
- [ ] 版本标签
- [ ] 代码归档

---

## 七、经验记录模板

### 1. 项目经验记录

```markdown
# 项目经验记录

## 项目名称
[项目名称]

## 项目周期
[开始日期] - [结束日期]

## 项目目标
[项目目标描述]

## 技术栈
- FPGA: [型号]
- 工具: [Vivado 版本]
- 语言: [Verilog/SystemVerilog]

## 关键决策
1. [决策 1]: [原因]
2. [决策 2]: [原因]

## 遇到的问题
1. [问题 1]:
   - 原因: [原因分析]
   - 解决方案: [解决方案]
   - 经验教训: [经验教训]

2. [问题 2]:
   - 原因: [原因分析]
   - 解决方案: [解决方案]
   - 经验教训: [经验教训]

## 性能指标
- 时钟频率: [频率]
- 资源利用率: [LUT/FF/BRAM]
- 功耗: [功耗]

## 经验总结
[经验总结]

## 可复用组件
- [组件 1]: [描述]
- [组件 2]: [描述]
```

---

## 八、参考资源

### 知识文档

| 文档 | 用途 |
|------|------|
| fpga-design-guide.md | 设计指南 |
| fpga-best-practices.md | 最佳实践 |
| algorithm-implementation.md | 算法实现 |
| vivado-guide.md | 工具使用 |

### 模板文件

| 文件 | 用途 |
|------|------|
| project_template/ | 项目模板 |
| module_template.v | 模块模板 |
| testbench_template.v | 测试平台模板 |

---

## 九、项目最佳实践

### 1. 目录管理

| 实践 | 说明 |
|------|------|
| **编号前缀** | 使用 00-08 编号，便于排序 |
| **功能分离** | 不同类型文件分开存放 |
| **模块化** | 每个模块一个目录 |
| **版本控制** | 使用 Git 管理代码 |

### 2. 文件命名

| 类型 | 命名规范 | 示例 |
|------|----------|------|
| **HDL 文件** | 小写 + 下划线 | `fifo_buffer.v` |
| **测试文件** | tb_ 前缀 | `tb_fifo_buffer.v` |
| **约束文件** | 项目名.xdc | `top.xdc` |
| **文档文件** | 描述性名称 | `design_spec.md` |

### 3. 代码组织

| 实践 | 说明 |
|------|------|
| **参数化** | 使用 parameter 增加灵活性 |
| **模块化** | 功能独立，接口清晰 |
| **注释** | 关键逻辑必须注释 |
| **规范** | 遵循编码规范 |

### 4. 版本管理

| 实践 | 说明 |
|------|------|
| **提交规范** | 规范的提交信息 |
| **分支策略** | 功能分支、开发分支 |
| **代码审查** | 提交前审查 |
| **版本标签** | 重要版本打标签 |

---

## 十、项目初始化清单

### 新项目启动

- [ ] 确定项目名称和目标
- [ ] 选择目标器件
- [ ] 创建项目目录结构
- [ ] 初始化 Git 仓库
- [ ] 编写 README.md
- [ ] 配置开发环境

### 设计阶段

- [ ] 完成架构设计
- [ ] 定义接口规范
- [ ] 编写设计文档
- [ ] 创建模块目录
- [ ] 时序约束

### 验证阶段

- [ ] 编写测试平台
- [ ] 功能仿真通过
- [ ] 时序仿真通过
- [ ] 代码覆盖率达标

### 发布阶段

- [ ] 比特流生成
- [ ] 硬件测试通过
- [ ] 文档更新
- [ ] 版本标签
- [ ] 代码归档
