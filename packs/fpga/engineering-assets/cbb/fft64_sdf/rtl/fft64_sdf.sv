//==============================================================================
// fft64_sdf — 64 点流式 FFT/IFFT 顶层 (方向与输出序均可参数化)
// 功能: 把 fft64_sdf_core (恒位反序输出) 与 fft64_reorder (位反序->自然序)
//       按 P_NATURAL_OUT 组合起来。
//         P_NATURAL_OUT=1 (RX 默认): 例化 reorder, 输出自然序 —— 下游
//           channel_est_top 已认证且按自然序流式吃 64 拍、无索引口, 且 FFT 输出
//           要扇出给它与均衡器两路, 故必须在扇出前就是自然序。
//         P_NATURAL_OUT=0 (TX 复用): 不例化 reorder, 保持位反序 + o_idx, 由下游
//           的乒乓 RAM 用 bitrev 写地址零代价吸收 (手法见 tx_cp_insert)。
// 方向: P_DIR=0 为 FFT (正向), 1 为 IFFT。**方向切换须翻两处符号** —— 非平凡
//       旋转因子表与 BF2II 的平凡 ±j, 缺一不可, 详见 core 的头注释。
//       实数且对称的激励对两个方向给出相同结果, 分辨不出方向符号,
//       必须用复数单音验证 (tb_fft64_direction: FFT->bin1 / IFFT->bin63)。
// 定点: 内部 s21 (满幅输入下 s20 会回绕, 见 core 头注释); 输入 Q2.14;
//       输出 FFT 为 Q2.14 / IFFT 为 Q3.13 —— 输出级对 IFFT 多做的一次 (x+1)>>>1
//       是格式转换而非缩放, 同一物理量的整数值因此差一倍。
// 侧带: i_sb 标记输入符号首拍, o_sb 与本符号**首个输出**同拍, 供 frame_start
//       穿越本模块后仍与它所标记的符号对齐 (需求门禁 2026-08-03 裁定)。
// 延迟: P_NATURAL_OUT=0 时约 78 拍; =1 时另加一个符号 (reorder 乒乓)。
// 复位: 同步高有效, 仅控制链复位; FIFO/RAM 不复位。
//==============================================================================
`default_nettype none

module fft64_sdf #(
    parameter int DATA_W        = 16,
    parameter int P_W           = 21,     // 内部位宽
    parameter bit P_DIR         = 1'b0,   // 0 = FFT, 1 = IFFT
    parameter bit P_NATURAL_OUT = 1'b1    // 1 = 自然序输出, 0 = 位反序 + o_idx
)(
    input  wire                      i_clk,
    input  wire                      i_rst,       // 同步复位, 高有效
    input  wire                      i_beat,      // 样点拍 (CE)
    input  wire                      i_valid,
    input  wire signed [DATA_W-1:0]  i_re,        // Q2.14
    input  wire signed [DATA_W-1:0]  i_im,
    input  wire                      i_sb,        // 侧带 (frame_start 穿越用)

    output wire                      o_valid,
    output wire [5:0]                o_idx,       // 自然序模式: 流序号; 位反序模式: 位反序号
    output wire signed [DATA_W-1:0]  o_re,        // FFT: Q2.14 / IFFT: Q3.13
    output wire signed [DATA_W-1:0]  o_im,
    output wire                      o_sb
);

    logic                     w_cv, w_csb;
    logic [5:0]               w_cidx;
    logic signed [DATA_W-1:0] w_cre, w_cim;

    fft64_sdf_core #(
        .DATA_W(DATA_W), .P_W(P_W), .P_DIR(P_DIR)
    ) u_core (
        .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat), .i_valid(i_valid),
        .i_re(i_re), .i_im(i_im), .i_sb(i_sb),
        .o_valid(w_cv), .o_idx(w_cidx), .o_re(w_cre), .o_im(w_cim), .o_sb(w_csb)
    );

    generate
        if (P_NATURAL_OUT) begin : g_natural
            // 本分支是**纯接线**: o_idx 由 reorder 内部与数据同拍寄存后给出,
            // 顶层不再加任何组合逻辑 —— 否则会违反"输出须由寄存器驱动"(红线 2)。
            fft64_reorder #(.DATA_W(DATA_W)) u_reorder (
                .i_clk(i_clk), .i_rst(i_rst), .i_beat(i_beat),
                .i_valid(w_cv), .i_idx(w_cidx), .i_re(w_cre), .i_im(w_cim), .i_sb(w_csb),
                .o_valid(o_valid), .o_idx(o_idx), .o_re(o_re), .o_im(o_im), .o_sb(o_sb)
            );
        end else begin : g_bitrev
            assign o_valid = w_cv;
            assign o_idx   = w_cidx;
            assign o_re    = w_cre;
            assign o_im    = w_cim;
            assign o_sb    = w_csb;
        end
    endgenerate

endmodule : fft64_sdf

`default_nettype wire
