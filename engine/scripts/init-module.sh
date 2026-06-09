#!/bin/bash
# ============================================================================
# init-module.sh — FPGA 模块脚手架
# 用法:
#   cd <项目根目录>
#   bash path/to/init-module.sh <模块名> [数据位宽]
#   bash path/to/init-module.sh fifo 32
# ============================================================================
# 创建: 01_src/00_hdl/<module>/ + 02_sim/<module>/ + tb 模板
# 关联: cross-project-experience.md → "模块接入流程"
# ============================================================================

set -euo pipefail

# ── 颜色 ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── 参数 ────────────────────────────────────────────────────────────────────
MODULE_NAME="${1:-}"
DATA_WIDTH="${2:-16}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$PWD"

if [ -z "$MODULE_NAME" ]; then
    echo -e "${RED}用法: bash $0 <模块名> [数据位宽]${NC}"
    echo "  示例: bash $0 fir_filter"
    echo "  示例: bash $0 ldpc_encoder 8"
    echo ""
    echo -e "${YELLOW}说明: 在 \$PWD/prj/ 下创建模块目录${NC}"
    echo "  必须先进入项目根目录 (含 prj/ 子目录) 再执行"
    exit 1
fi

# ── 检查项目结构 ─────────────────────────────────────────────────────────────
if [ ! -d "prj/01_src/00_hdl" ]; then
    echo -e "${RED}❌ 未检测到 prj/ 目录结构。${NC}"
    echo "   请在项目根目录 (包含 prj/) 下执行: cd <project> && bash $0 $MODULE_NAME"
    exit 1
fi

# ── 创建目录 ─────────────────────────────────────────────────────────────────
echo -e "${CYAN}═══ 添加模块: ${MODULE_NAME} ═══${NC}"

HDL_DIR="prj/01_src/00_hdl/${MODULE_NAME}"
SIM_DIR="prj/02_sim/${MODULE_NAME}"

if [ -d "$HDL_DIR" ]; then
    echo -e "${YELLOW}  ⚠️  模块目录已存在: ${HDL_DIR}/${NC}"
    echo "   跳过 mkdir"
else
    mkdir -p "$HDL_DIR"
    echo -e "${GREEN}  ✅ 创建: ${HDL_DIR}/${NC}"
fi

if [ -d "$SIM_DIR" ]; then
    echo -e "${YELLOW}  ⚠️  仿真目录已存在: ${SIM_DIR}/${NC}"
else
    mkdir -p "$SIM_DIR"
    echo -e "${GREEN}  ✅ 创建: ${SIM_DIR}/${NC}"
fi

# ── 模块模板 ─────────────────────────────────────────────────────────────────
if [ ! -f "${HDL_DIR}/${MODULE_NAME}.v" ]; then
    cat > "${HDL_DIR}/${MODULE_NAME}.v" << EOF
// ============================================================================
// ${MODULE_NAME}
// 功能: <功能描述>
// 接口: 自定义
// ============================================================================

\`timescale 1ns / 1ps

module ${MODULE_NAME} #(
    parameter DATA_WIDTH = ${DATA_WIDTH}
) (
    input  wire                  clk,
    input  wire                  rst_n,

    // 输入
    input  wire [DATA_WIDTH-1:0] data_in,
    input  wire                  valid_in,

    // 输出
    output reg  [DATA_WIDTH-1:0] data_out,
    output reg                   valid_out
);

    // ========================================================================
    // TODO: 模块逻辑
    // ========================================================================
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            data_out  <= {DATA_WIDTH{1'b0}};
            valid_out <= 1'b0;
        end else begin
            data_out  <= data_in;
            valid_out <= valid_in;
        end
    end

endmodule
EOF
    echo -e "${GREEN}  ✅ 创建: ${HDL_DIR}/${MODULE_NAME}.v${NC}"
else
    echo -e "${YELLOW}  ⚠️  已存在: ${HDL_DIR}/${MODULE_NAME}.v (跳过)${NC}"
fi

# ── 测试平台模板 ─────────────────────────────────────────────────────────────
if [ ! -f "${SIM_DIR}/tb_${MODULE_NAME}.v" ]; then
    cat > "${SIM_DIR}/tb_${MODULE_NAME}.v" << EOF
// ============================================================================
// 测试平台: tb_${MODULE_NAME}
// 功能: <测试描述>
// ============================================================================

\`timescale 1ns / 1ps

module tb_${MODULE_NAME} ();

    parameter DATA_WIDTH = ${DATA_WIDTH};
    parameter CLK_PERIOD = 10;  // 100MHz

    // ── 信号 ───────────────────────────────────────────────────────────────
    reg                          clk;
    reg                          rst_n;

    reg  [DATA_WIDTH-1:0]        data_in;
    reg                          valid_in;
    wire [DATA_WIDTH-1:0]        data_out;
    wire                         valid_out;

    integer                      pass_cnt;
    integer                      fail_cnt;

    // ── 时钟 ───────────────────────────────────────────────────────────────
    initial begin clk = 0; forever #(CLK_PERIOD/2) clk = ~clk; end

    // ── 复位 ───────────────────────────────────────────────────────────────
    initial begin
        rst_n = 0;
        #(CLK_PERIOD * 10);
        rst_n = 1;
    end

    // ── 实例化 DUT ─────────────────────────────────────────────────────────
    ${MODULE_NAME} #(
        .DATA_WIDTH(DATA_WIDTH)
    ) u_dut (
        .clk     (clk),
        .rst_n   (rst_n),
        .data_in (data_in),
        .valid_in(valid_in),
        .data_out(data_out),
        .valid_out(valid_out)
    );

    // ── 测试序列 ───────────────────────────────────────────────────────────
    initial begin
        // 初始化
        pass_cnt = 0;
        fail_cnt = 0;
        data_in  = 0;
        valid_in = 0;

        @(posedge rst_n);
        #(CLK_PERIOD * 5);

        // Test 1: 基本功能
        \$display("Test 1: Basic");
        data_in  = 'hA5;
        valid_in = 1;
        #CLK_PERIOD;
        valid_in = 0;
        #(CLK_PERIOD * 5);

        if (data_out === 'hA5) begin
            \$display("  PASS");
            pass_cnt = pass_cnt + 1;
        end else begin
            \$display("  FAIL: got 0x%h", data_out);
            fail_cnt = fail_cnt + 1;
        end

        // ── 统计 ───────────────────────────────────────────────────────────
        #(CLK_PERIOD * 10);
        \$display("");
        \$display("=== Summary: Pass=%0d, Fail=%0d ===", pass_cnt, fail_cnt);
        \$(if (fail_cnt == 0) \$display("ALL TESTS PASSED"); else \$display("SOME TESTS FAILED");)
        \$finish;
    end

    // ── 波形 ───────────────────────────────────────────────────────────────
    initial begin
        \$dumpfile("${MODULE_NAME}.vcd");
        \$dumpvars(0, tb_${MODULE_NAME});
    end

endmodule
EOF
    echo -e "${GREEN}  ✅ 创建: ${SIM_DIR}/tb_${MODULE_NAME}.v${NC}"
else
    echo -e "${YELLOW}  ⚠️  已存在: ${SIM_DIR}/tb_${MODULE_NAME}.v (跳过)${NC}"
fi

# ── 完成 ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}═══ 模块 ${MODULE_NAME} 创建完成 ═══${NC}"
echo ""
echo -e "${YELLOW}下一步:${NC}"
echo "  1. 编写 ${HDL_DIR}/${MODULE_NAME}.v 的逻辑"
echo "  2. 补充 ${SIM_DIR}/tb_${MODULE_NAME}.v 的测试用例"
echo "  3. 编译仿真: cd $PROJECT_ROOT && vlog -work work ${HDL_DIR}/${MODULE_NAME}.v ${SIM_DIR}/tb_${MODULE_NAME}.v"
echo "  4. 如果涉及新时钟 → 更新 prj/03_xdc/"
echo "  5. 如果涉及 MATLAB golden model → 更新 prj/07_mat/"
echo ""
