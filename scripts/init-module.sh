#!/bin/bash
#
# init-module.sh — FPGA 模块初始化脚本
#
# 用法: init-module.sh <module_name> [data_width]
#
# 在已初始化的 FPGA 项目中添加新模块:
#   1. 在 01_src/00_hdl/ 下创建 <module_name>/ 目录
#   2. 写入 SystemVerilog 模块模板 (AXI-Stream 接口, 三段式FSM)
#   3. 写入 Testbench 模板
#   4. 检查 Makefile 是否存在
#
# 参数:
#   module_name   模块名 (必需, 小写字母+下划线)
#   data_width    数据位宽 (默认: 16)
#
# 示例:
#   init-module.sh fir_filter 16
#   init-module.sh uart_tx 8
#

set -euo pipefail

# ─── 颜色定义 ─────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── 帮助 ─────────────────────────────────────────────────────────────────
usage() {
    echo "用法: $0 <module_name> [data_width]"
    echo ""
    echo "参数:"
    echo "  module_name   模块名 (必需, 小写字母+下划线)"
    echo "  data_width    数据位宽 (默认: 16)"
    echo ""
    echo "示例:"
    echo "  $0 fir_filter 16"
    echo "  $0 uart_tx 8"
    echo "  $0 axis_fifo"
    exit 1
}

# ─── 参数解析 ─────────────────────────────────────────────────────────────
if [ $# -lt 1 ]; then
    usage
fi

MODULE_NAME="$1"
DATA_WIDTH="${2:-16}"

# 校验模块名: 小写字母 + 下划线
if [[ ! "$MODULE_NAME" =~ ^[a-z][a-z0-9_]*$ ]]; then
    echo -e "${RED}错误: 无效的模块名 \"$MODULE_NAME\"。${NC}"
    echo "模块名必须是小写字母开头，只包含小写字母、数字和下划线。"
    exit 1
fi

# 校验位宽
if ! [[ "$DATA_WIDTH" =~ ^[0-9]+$ ]] || [ "$DATA_WIDTH" -lt 1 ]; then
    echo -e "${RED}错误: 数据位宽必须是正整数 (got: $DATA_WIDTH)。${NC}"
    exit 1
fi

# ─── 目录 ──────────────────────────────────────────────────────────────────
HDL_DIR="01_src/00_hdl"
SIM_DIR="02_sim"
MODULE_DIR="$HDL_DIR/$MODULE_NAME"
TB_FILE="$SIM_DIR/tb_$MODULE_NAME.sv"

# ─── 步骤 1: 创建模块目录 ────────────────────────────────────────────────
echo -e "${GREEN}[1/4] 创建模块目录...${NC}"

if [ -d "$MODULE_DIR" ]; then
    echo -e "${YELLOW}警告: 模块目录 $MODULE_DIR 已存在。${NC}"
    echo "请先删除已有目录或使用不同的模块名。"
    exit 1
fi

mkdir -p "$MODULE_DIR"
touch "$MODULE_DIR/.gitkeep"
echo -e "  ${CYAN}✓${NC} $MODULE_DIR/"

# ─── 步骤 2: 写入 SV 模块模板 ────────────────────────────────────────────
echo -e "${GREEN}[2/4] 写入模块模板 $MODULE_DIR/$MODULE_NAME.sv ...${NC}"

cat > "$MODULE_DIR/$MODULE_NAME.sv" << 'SVMOD'
//==============================================================================
// Module: __MODULE_NAME__
// Description: <Add description>
//
// Interfaces:
//   - AXI4-Stream Slave  (input)  — i_axis_*
//   - AXI4-Stream Master (output) — o_axis_*
//
// Parameters:
//   P_DATA_WIDTH — Data bus width (default: __DATA_WIDTH__)
//
// FSM states:
//   S_IDLE — Wait for input valid
//   S_CALC — Processing stage
//   S_DONE — Output valid, wait for ready
//==============================================================================

module __MODULE_NAME__ #(
    parameter int P_DATA_WIDTH = __DATA_WIDTH__
) (
    // Clock and reset
    input  logic                     i_clk,
    input  logic                     i_rst,

    // AXI4-Stream Slave (input)
    input  logic                     i_axis_tvalid,
    input  logic [P_DATA_WIDTH-1:0]  i_axis_tdata,
    output logic                     i_axis_tready,

    // AXI4-Stream Master (output)
    output logic                     o_axis_tvalid,
    output logic [P_DATA_WIDTH-1:0]  o_axis_tdata,
    input  logic                     o_axis_tready
);

    //==========================================================================
    // Internal registers (ri_ = input reg, ro_ = output reg)
    //==========================================================================
    logic [P_DATA_WIDTH-1:0] ri_data;
    logic [P_DATA_WIDTH-1:0] ro_data;
    logic [P_DATA_WIDTH-1:0] w_result;

    //==========================================================================
    // Three-state FSM
    //==========================================================================
    typedef enum logic [1:0] {
        S_IDLE = 2'b00,
        S_CALC = 2'b01,
        S_DONE = 2'b10
    } state_t;

    state_t state_reg;
    state_t state_next;

    // State register
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            state_reg <= S_IDLE;
        end else begin
            state_reg <= state_next;
        end
    end

    // Next-state logic
    always_comb begin
        state_next = state_reg;
        case (state_reg)

            S_IDLE: begin
                if (i_axis_tvalid) begin
                    state_next = S_CALC;
                end
            end

            S_CALC: begin
                state_next = S_DONE;
            end

            S_DONE: begin
                if (o_axis_tready) begin
                    state_next = S_IDLE;
                end
            end

            default: begin
                state_next = S_IDLE;
            end
        endcase
    end

    // Output decode (combinational)
    always_comb begin
        i_axis_tready = (state_reg == S_IDLE);
        o_axis_tvalid = (state_reg == S_DONE);
    end

    //==========================================================================
    // Input register
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_data <= '0;
        end else if (i_axis_tvalid && i_axis_tready) begin
            ri_data <= i_axis_tdata;
        end
    end

    //==========================================================================
    // Processing logic (combinational) — placeholder
    // Replace w_result assignment with actual processing logic
    //==========================================================================
    always_comb begin
        w_result = ri_data;  // TODO: Replace with actual datapath
    end

    //==========================================================================
    // Output register
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_data <= '0;
        end else begin
            ro_data <= w_result;
        end
    end

    assign o_axis_tdata = ro_data;

endmodule : __MODULE_NAME__
SVMOD

# 替换占位符
sed -i "s/__MODULE_NAME__/$MODULE_NAME/g" "$MODULE_DIR/$MODULE_NAME.sv"
sed -i "s/__DATA_WIDTH__/$DATA_WIDTH/g" "$MODULE_DIR/$MODULE_NAME.sv"

echo -e "  ${CYAN}✓${NC} $MODULE_DIR/$MODULE_NAME.sv"

# ─── 步骤 3: 写入 Testbench 模板 ─────────────────────────────────────────
echo -e "${GREEN}[3/4] 写入 Testbench 模板 $TB_FILE ...${NC}"

cat > "$TB_FILE" << 'SVTB'
//==============================================================================
// Testbench: tb___MODULE_NAME__
// Description: Basic testbench for __MODULE_NAME__
//==============================================================================

`timescale 1ns/1ps

module tb___MODULE_NAME__ ();

    //==========================================================================
    // Parameters
    //==========================================================================
    parameter int P_DATA_WIDTH = __DATA_WIDTH__;

    //==========================================================================
    // Signals
    //==========================================================================
    logic                    clk;
    logic                    rst;

    logic                    i_axis_tvalid;
    logic [P_DATA_WIDTH-1:0] i_axis_tdata;
    logic                    i_axis_tready;

    logic                    o_axis_tvalid;
    logic [P_DATA_WIDTH-1:0] o_axis_tdata;
    logic                    o_axis_tready;

    //==========================================================================
    // DUT Instantiation
    //==========================================================================
    __MODULE_NAME__ #(
        .P_DATA_WIDTH(P_DATA_WIDTH)
    ) u_dut (
        .i_clk         ( clk            ),
        .i_rst         ( rst            ),
        .i_axis_tvalid ( i_axis_tvalid  ),
        .i_axis_tdata  ( i_axis_tdata   ),
        .i_axis_tready ( i_axis_tready  ),
        .o_axis_tvalid ( o_axis_tvalid  ),
        .o_axis_tdata  ( o_axis_tdata   ),
        .o_axis_tready ( o_axis_tready  )
    );

    //==========================================================================
    // Clock Generation (100 MHz)
    //==========================================================================
    initial begin
        clk = 1'b0;
        forever #5 clk = ~clk;
    end

    //==========================================================================
    // Stimulus
    //==========================================================================
    initial begin
        // Reset
        rst            = 1'b1;
        i_axis_tvalid  = 1'b0;
        i_axis_tdata   = '0;
        o_axis_tready  = 1'b1;

        #100;
        rst = 1'b0;
        #20;

        // Send word 0xA5
        @(posedge clk);
        i_axis_tvalid = 1'b1;
        i_axis_tdata  = 'hA5;
        @(posedge clk);
        i_axis_tvalid = 1'b0;
        @(posedge clk);

        // Wait for output
        wait (o_axis_tvalid && o_axis_tready);
        @(posedge clk);

        // Send word 0x5A
        @(posedge clk);
        i_axis_tvalid = 1'b1;
        i_axis_tdata  = 'h5A;
        @(posedge clk);
        i_axis_tvalid = 1'b0;

        // Wait for output
        wait (o_axis_tvalid && o_axis_tready);
        @(posedge clk);

        #200;
        $finish;
    end

    //==========================================================================
    // Waveform Dump
    //==========================================================================
    initial begin
        $dumpfile("tb___MODULE_NAME__.vcd");
        $dumpvars(0, tb___MODULE_NAME__);
    end

    //==========================================================================
    // Self-Check (placeholder)
    //==========================================================================
    initial begin
        #1;
        // TODO: Add assertions
    end

endmodule : tb___MODULE_NAME__
SVTB

# 替换占位符 (注意: TB 中使用 __MODULE_NAME__ 作为占位符)
sed -i "s/__MODULE_NAME__/$MODULE_NAME/g" "$TB_FILE"
sed -i "s/__DATA_WIDTH__/$DATA_WIDTH/g" "$TB_FILE"

echo -e "  ${CYAN}✓${NC} $TB_FILE"

# ─── 步骤 4: 检查 Makefile ───────────────────────────────────────────────
echo -e "${GREEN}[4/4] 检查 Makefile...${NC}"

if [ -f "Makefile" ]; then
    echo -e "  ${CYAN}✓${NC} Makefile 存在"
else
    echo -e "  ${YELLOW}⚠  Makefile 不存在!${NC}"
    echo "  请运行 init-project.sh 初始化项目，或手动创建 Makefile。"
fi

# ─── 完成 ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}========================================================${NC}"
echo -e "${GREEN}  模块 \"$MODULE_NAME\" 创建成功!${NC}"
echo -e "${GREEN}  位宽: $DATA_WIDTH${NC}"
echo -e "${GREEN}========================================================${NC}"
echo ""
echo -e "${YELLOW}下一步:${NC}"
echo "  1. 编辑 $MODULE_DIR/$MODULE_NAME.sv 实现处理逻辑"
echo "  2. 编辑 $TB_FILE 添加测试用例"
echo "  3. 运行仿真: make sim TB_TOP=tb_$MODULE_NAME"
echo ""
