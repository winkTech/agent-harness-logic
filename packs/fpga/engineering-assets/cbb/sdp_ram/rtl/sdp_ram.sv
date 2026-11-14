`default_nettype none
//==============================================================================
// sdp_ram — 简单双端口同步 RAM (1 写口 + 1 读口, 单时钟)
// 功能: 参数化位宽/深度的存储阵列; 写口无回读, 读口同步读, 面向 BRAM 推断
// 端口: i_clk/i_rst(同步高有效); 写 i_wr_en/i_wr_addr/i_wr_data;
//       读 i_rd_en/i_rd_addr -> o_rd_data/o_rd_valid
// 主要逻辑: 输入寄存(ri_) -> 阵列同步读写 -> 输出寄存(ro_)
// 延迟: 2 拍 (ri_ 输入寄存 1 + 阵列同步读 1)
// 同址语义: 同一拍写与读命中同一地址时, 读端得到"旧值"(read-old);
//           由非阻塞赋值语义保证, 不依赖工具默认行为, 见阵列块注释
// 约束: 阵列本身不复位 (BRAM 内容不可复位, 强行复位会阻止 BRAM 推断);
//       复位仅作用于输入寄存级与输出寄存级。上电内容为 X, 调用方须先写后读。
//
// 来源: 改写自 skills/hdl-coding/templates/comm/ram_2port.v (v1.0.0)
//   原件缺陷 (本模块逐条修复):
//     (1) 端口无 i_/o_ 前缀 (clka/ena/wea/addra/dia/doa) —— 违反红线 1/2 命名;
//     (2) initial 块初始化阵列与输出寄存器 —— 综合器忽略, 与 ldpc h_matrix_addr
//         被 Vivado 丢弃 (G-C-03 FAIL) 属同一类坑;
//     (3) 真双口双时钟, 两个 always 块写同一阵列, A/B 同址同拍写为仿真竞态、
//         综合行为不可预测 —— 收敛为单时钟 1 写 1 读, 消除该未定义行为;
//     (4) 无复位。
//==============================================================================
module sdp_ram #(
    parameter int P_DWIDTH = 32,       // 数据位宽
    parameter int P_AWIDTH = 9         // 地址位宽 (深度 = 2**P_AWIDTH)
)(
    input  wire logic                i_clk,
    input  wire logic                i_rst,   // 同步复位, 高有效

    // 写端口
    input  wire logic                i_wr_en,
    input  wire logic [P_AWIDTH-1:0] i_wr_addr,
    input  wire logic [P_DWIDTH-1:0] i_wr_data,

    // 读端口
    input  wire logic                i_rd_en,
    input  wire logic [P_AWIDTH-1:0] i_rd_addr,
    output logic [P_DWIDTH-1:0] o_rd_data,
    output logic                o_rd_valid    // 与 o_rd_data 同拍对齐
);

    localparam int P_DEPTH = 1 << P_AWIDTH;

    //==========================================================================
    // 输入寄存 (红线 1: 禁止输入直通)
    //==========================================================================
    logic                ri_wr_en;
    logic [P_AWIDTH-1:0] ri_wr_addr;
    logic [P_DWIDTH-1:0] ri_wr_data;
    logic                ri_rd_en;
    logic [P_AWIDTH-1:0] ri_rd_addr;

    //==========================================================================
    // 输出寄存 (红线 2: 输出必须由 ro_ 驱动)
    //==========================================================================
    logic [P_DWIDTH-1:0] ro_rd_data;
    logic                ro_rd_valid;

    // 存储阵列
    logic [P_DWIDTH-1:0] r_mem [0:P_DEPTH-1];

    //==========================================================================
    // 时序逻辑: 输入寄存级
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_wr_en   <= 1'b0;
            ri_wr_addr <= '0;
            ri_wr_data <= '0;
            ri_rd_en   <= 1'b0;
            ri_rd_addr <= '0;
        end else begin
            ri_wr_en   <= i_wr_en;
            ri_wr_addr <= i_wr_addr;
            ri_wr_data <= i_wr_data;
            ri_rd_en   <= i_rd_en;
            ri_rd_addr <= i_rd_addr;
        end
    end

    //==========================================================================
    // 时序逻辑: 阵列同步读写 (Xilinx 简单双端口 BRAM 推断模板)
    //
    // 写与读置于同一时序块且均为非阻塞赋值: 本拍所有 RHS 先于任何 LHS 更新求值,
    // 故 ri_wr_addr == ri_rd_addr 时 ro_rd_data 取到的是本拍写入之前的旧值。
    // 这就是本模块对外承诺的 read-old 语义。
    //
    // 阵列不受 i_rst 影响 —— 复位 BRAM 内容不可综合。
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (ri_wr_en) begin
            r_mem[ri_wr_addr] <= ri_wr_data;
        end

        if (i_rst) begin
            ro_rd_data <= '0;
        end else if (ri_rd_en) begin
            ro_rd_data <= r_mem[ri_rd_addr];
        end
    end

    //==========================================================================
    // 时序逻辑: 读有效标志 (与 ro_rd_data 逐拍对齐)
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_rd_valid <= 1'b0;
        end else begin
            ro_rd_valid <= ri_rd_en;
        end
    end

    //==========================================================================
    // 输出赋值 (仅寄存器到端口的连线, 无组合逻辑)
    //==========================================================================
    assign o_rd_data  = ro_rd_data;
    assign o_rd_valid = ro_rd_valid;

endmodule
`default_nettype wire
