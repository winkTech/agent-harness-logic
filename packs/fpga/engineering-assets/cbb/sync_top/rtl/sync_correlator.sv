//==============================================================================
// sync_correlator — 长前导码 T1 符号量化 64 抽头互相关器 (ADR-003)
// 功能: 对 CFO 校正后样点流做流式互相关 R(m) = Σ_{k=0..63} r(m-63+k)·conj(t_q(k)),
//       t_q(k) = sign(Re t1(k)) + j·sign(Im t1(k)) ∈ {±1±j} —— 乘法退化为
//       加减法树, 0 DSP (|R|² 的两个平方除外)。输出 |R(m)|² 与窗尾样点序号,
//       峰值搜索由顶层完成。
// T1 符号表: 由 golden (models/comm/synch generate_preamble, T1=long(33:96))
//       导出; sign 规则 = (值>0 ? +1 : -1) (恰为 0 的 4 个分量取 -1)。
//       cosim 时 TB 将本表与 golden 导出的 t1_sign_coeffs.txt 逐位核对。
// 端口: i_clk/i_rst; i_beat/i_di/i_dq/i_idx (校正流 + 样点序号);
//       o_r2/o_r2_v/o_end_idx — |R|², 有效拍, 窗尾样点序号 (滞后 5 拍)
// 复位: 同步高有效, 仅 valid 链复位; 数据级不复位 (§1.1)
//   // [复位豁免] r_q_* 为 DSP 流水寄存器 (§10.2); 抽头链为 SRL
//
// 定点约定 (与 generate_vectors.m 位真镜像逐字一致):
//   项 term_re(k) = a·rre + b·rim, term_im(k) = a·rim - b·rre (a,b∈{±1});
//   R 分量 s23 (64 项 s17 和); |R|² = R_re² + R_im² (u47)
//==============================================================================
module sync_correlator #(
    parameter int DATA_W = 16,
    parameter int P_TAPS = 64,
    parameter int P_IDXW = 32
)(
    input  logic                      i_clk,
    input  logic                      i_rst,      // 同步复位, 高有效
    input  logic                      i_beat,
    input  logic signed [DATA_W-1:0]  i_di,
    input  logic signed [DATA_W-1:0]  i_dq,
    input  logic [P_IDXW-1:0]         i_idx,      // i_d* 的样点序号

    output logic                      o_r2_v,
    output logic [46:0]               o_r2,
    output logic [P_IDXW-1:0]         o_end_idx   // 相关窗尾样点序号
);

    // T1 时域符号表 (1 = +1, 0 = -1); 下标 = T1 样点序号 0..63
    localparam bit [0:63] P_SRE = 64'b0110000111101001100111110101110101011101011111001100101111000011;
    localparam bit [0:63] P_SIM = 64'b0001000100010111100000110101101001010010100111110000101110111011;

    //==========================================================================
    // 输入寄存 (红线 1) + 64 深抽头链 (taps[0] 最新)
    //==========================================================================
    logic signed [DATA_W-1:0] r_a_di, r_a_dq;
    logic [P_IDXW-1:0]        r_a_idx;

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_a_di  <= i_di;
            r_a_dq  <= i_dq;
            r_a_idx <= i_idx;
        end
    end

    logic signed [DATA_W-1:0] taps_i [0:P_TAPS-1];
    logic signed [DATA_W-1:0] taps_q [0:P_TAPS-1];

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            taps_i[0] <= r_a_di;
            taps_q[0] <= r_a_dq;
            for (int i = 1; i < P_TAPS; i++) begin
                taps_i[i] <= taps_i[i-1];
                taps_q[i] <= taps_q[i-1];
            end
        end
    end

    //==========================================================================
    // 加法树: 64 项 -> 8 组部分和 (寄存) -> 总和 (寄存)
    // 项 k 对应抽头 age = 63-k (r(m-63+k) 即 63-k 拍前的样点)
    //==========================================================================
    logic signed [16:0] w_t_re [0:P_TAPS-1];
    logic signed [16:0] w_t_im [0:P_TAPS-1];
    logic signed [19:0] w_g_re [0:7];
    logic signed [19:0] w_g_im [0:7];

    always_comb begin
        // a = P_SRE[k]?+1:-1, b = P_SIM[k]?+1:-1
        for (int k = 0; k < P_TAPS; k++) begin
            w_t_re[k] = (P_SRE[k] ? 17'(taps_i[63-k]) : -17'(taps_i[63-k])) +
                        (P_SIM[k] ? 17'(taps_q[63-k]) : -17'(taps_q[63-k]));
            w_t_im[k] = (P_SRE[k] ? 17'(taps_q[63-k]) : -17'(taps_q[63-k])) -
                        (P_SIM[k] ? 17'(taps_i[63-k]) : -17'(taps_i[63-k]));
        end
        for (int g = 0; g < 8; g++) begin
            w_g_re[g] = '0;
            w_g_im[g] = '0;
            for (int j = 0; j < 8; j++) begin
                w_g_re[g] = w_g_re[g] + 20'(w_t_re[g*8+j]);
                w_g_im[g] = w_g_im[g] + 20'(w_t_im[g*8+j]);
            end
        end
    end

    logic signed [19:0] r_g_re [0:7];
    logic signed [19:0] r_g_im [0:7];

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            for (int g = 0; g < 8; g++) begin
                r_g_re[g] <= w_g_re[g];
                r_g_im[g] <= w_g_im[g];
            end
        end
    end

    logic signed [22:0] w_s_re, w_s_im;

    always_comb begin
        w_s_re = '0;
        w_s_im = '0;
        for (int g = 0; g < 8; g++) begin
            w_s_re = w_s_re + 23'(r_g_re[g]);
            w_s_im = w_s_im + 23'(r_g_im[g]);
        end
    end

    logic signed [22:0] r_r_re, r_r_im;

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_r_re <= w_s_re;
            r_r_im <= w_s_im;
        end
    end

    //==========================================================================
    // |R|²: 平方 (寄存) -> 求和 (寄存)
    //==========================================================================
    logic signed [45:0] r_q_re, r_q_im;

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_q_re <= r_r_re * r_r_re;
            r_q_im <= r_r_im * r_r_im;
        end
    end

    logic [46:0] ro_r2;

    always_ff @(posedge i_clk) begin
        if (i_beat) ro_r2 <= 47'(unsigned'(r_q_re)) + 47'(unsigned'(r_q_im));
    end

    //==========================================================================
    // 序号/valid 随流水下移 (5 级: 输入寄存/组和/总和/平方/求和)
    //==========================================================================
    logic [P_IDXW-1:0] r_idx_d [0:3];
    logic [P_IDXW-1:0] ro_end_idx;
    logic [4:0]        r_v;

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_idx_d[0] <= r_a_idx;
            for (int i = 1; i < 4; i++) r_idx_d[i] <= r_idx_d[i-1];
            ro_end_idx <= r_idx_d[3];
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst)      r_v <= '0;
        else if (i_beat) r_v <= {r_v[3:0], 1'b1};
    end

    logic ro_r2_v;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_r2_v <= 1'b0;
        else       ro_r2_v <= i_beat && r_v[4];
    end

    assign o_r2_v    = ro_r2_v;
    assign o_r2      = ro_r2;
    assign o_end_idx = ro_end_idx;

endmodule : sync_correlator
