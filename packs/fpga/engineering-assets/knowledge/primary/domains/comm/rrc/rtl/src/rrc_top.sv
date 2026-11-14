//==============================================================================
// rrc_top — RRC 成形滤波顶层 (AXI4-Stream 封装)
// 功能: 在认证核 rrc_polyphase_fir 外套输入/输出寄存片, 提供 AXI-S 边界
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (符号 I/Q Q2.14);
//       m_axis (4x 采样率样点 I/Q Q2.14); i_alpha_sel (预留, 见 [F1])
// 主要逻辑: ri_ 输入寄存片 -> rrc_polyphase_fir 核 -> ro_ 输出寄存片
// 定点: Q2.14, 16bit I/Q; alpha=0.5, sps=4, span=8, 33 抽头
// 复位: 同步高有效, 下发给核
//
// 本文件为 hdl-coding 规范整改版 (2026-07-28)。改动:
//   (1) 复位由 `negedge rst_n` 异步低有效改为同步高有效 i_rst;
//   (2) 端口 clk/rst_n/alpha_sel -> i_clk/i_rst/i_alpha_sel;
//   (3) 内部信号加 ri_/ro_/w_ 前缀;
//   (4) **核已换为认证版本**: 原 knowledge 目录下的 rrc_polyphase_fir.sv 是一份
//       与 cbb/rrc_polyphase_fir (certified, 18/18 门全绿, 与 golden bit-true)
//       **算法上不同的旧版** —— 系数表不同、用 initial 建 ROM、对称折叠结构不同。
//       同名模块两份实现同时存在于仓库是编译期陷阱。现 knowledge 侧直接采用
//       认证版本, 本顶层的例化参数/端口随之对齐 (SPAN -> TAPS_PP, clk -> i_clk)。
//
// !! 遗留项 !!
//   [F1] i_alpha_sel 在本模块内**从未被使用** —— 运行时切换 alpha 未实现,
//        滤波系数由认证核内的常量表静态决定。保留端口是为了不破坏既有 TB/UVM
//        的连接; 真要做可配 alpha 需要核内多套系数表 + 选择逻辑, 属功能扩展。
//   [D1] s_axis_tready 仍是组合输出 (AXI-S ready 反压路径天生组合)。要打断需在
//        边界外套一级 incubator/intake/axis_skid_buffer, 属接口架构改动。
//==============================================================================
module rrc_top #(
    parameter int DATA_W = 16
)(
    input  logic         i_clk,
    input  logic         i_rst,          // 同步复位, 高有效
    input  logic         s_axis_tvalid,
    output logic         s_axis_tready,
    input  logic [31:0]  s_axis_tdata,
    output logic         m_axis_tvalid,
    input  logic         m_axis_tready,
    output logic [31:0]  m_axis_tdata,
    input  logic [7:0]   i_alpha_sel     // 见 [F1]: 当前未使用
);

    logic        w_core_tvalid, w_core_tready;
    logic [31:0] w_core_tdata;

    //--------------------------------------------------------------------------
    // ri_ 输入寄存片 (红线 1)
    //--------------------------------------------------------------------------
    logic        ri_valid;
    logic [31:0] ri_data;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid <= 1'b0;
            ri_data  <= '0;
        end else if (s_axis_tready) begin
            ri_valid <= s_axis_tvalid;
            ri_data  <= s_axis_tdata;
        end
    end

    assign s_axis_tready = ~ri_valid || (ri_valid && w_core_tvalid && w_core_tready);

    //--------------------------------------------------------------------------
    // 多相 FIR 核 (cbb/rrc_polyphase_fir, certified)
    //--------------------------------------------------------------------------
    rrc_polyphase_fir #(
        .DATA_W (DATA_W), .SPS (4), .TAPS_PP (9)
    ) u_fir (
        .i_clk          (i_clk),
        .i_rst          (i_rst),
        .s_axis_tvalid  (ri_valid),
        .s_axis_tready  (w_core_tready),
        .s_axis_tdata   (ri_data),
        .m_axis_tvalid  (w_core_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tdata   (w_core_tdata)
    );

    //--------------------------------------------------------------------------
    // ro_ 输出寄存片 (红线 2)
    //--------------------------------------------------------------------------
    logic        ro_valid;
    logic [31:0] ro_data;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid <= 1'b0;
            ro_data  <= '0;
        end else if (w_core_tvalid && w_core_tready) begin
            ro_valid <= 1'b1;
            ro_data  <= w_core_tdata;
        end else if (m_axis_tready) begin
            ro_valid <= 1'b0;
        end
    end

    assign m_axis_tvalid = ro_valid;
    assign m_axis_tdata  = ro_data;

endmodule : rrc_top
