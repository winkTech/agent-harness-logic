//==============================================================================
// rrc_polyphase_fir — RRC 根升余弦脉冲成形多相 FIR 滤波器核
// 功能: 33 抽头(alpha=0.5, sps=4, span=8) 4 相多相插值; 符号率入(AXI-S), 4x 采样率出
// 端口: i_clk/i_rst(同步高有效); s_axis(符号 I/Q Q2.14); m_axis(样点 I/Q Q2.14)
// 主要逻辑: 9 深符号缓存 -> 槽计数相位调度 -> 9 抽头 MAC(乘积寄存+加法树) ->
//           round-half-away(/2^15)+对称饱和(±32767), 与 golden 定点语义逐位一致
// 系数: models/comm/rrc/rrc_coeff.hex (Q1.15) 逐相展开, 相1-3 补零至 9 抽头
// 约束: 输入符号间隔 >= 4 拍 (s_axis_tready 恒 1, 无内部背压缓冲)
//==============================================================================
module rrc_polyphase_fir #(
    parameter int DATA_W  = 16,
    parameter int COEFF_W = 16,
    parameter int ACC_W   = 38,
    parameter int SPS     = 4,
    parameter int TAPS_PP = 9      // 每相抽头数 (33 taps / 4 相, 零补齐)
)(
    input  logic                i_clk,
    input  logic                i_rst,          // 同步复位, 高有效
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata
);

    //==========================================================================
    // 多相系数表 H[p][k] = h[p + 4k] (h = rrc_coeff.hex, Q1.15; 越界补零)
    //==========================================================================
    typedef logic signed [COEFF_W-1:0] coeff_t;
    localparam coeff_t H [SPS][TAPS_PP] = '{
        '{16'shFF5A, 16'sh0032, 16'sh02B7, 16'shF936, 16'sh48BE, 16'shF936, 16'sh02B7, 16'sh0032, 16'shFF5A},
        '{16'shFFC1, 16'shFEF2, 16'sh00FD, 16'sh0A0A, 16'sh3E5E, 16'shF5F6, 16'sh00FD, 16'sh010E, 16'sh0000},
        '{16'sh00B0, 16'shFF0A, 16'shFB33, 16'sh2508, 16'sh2508, 16'shFB33, 16'shFF0A, 16'sh00B0, 16'sh0000},
        '{16'sh010E, 16'sh00FD, 16'shF5F6, 16'sh3E5E, 16'sh0A0A, 16'sh00FD, 16'shFEF2, 16'shFFC1, 16'sh0000}
    };

    typedef logic signed [DATA_W-1:0] data_t;
    typedef logic signed [ACC_W-1:0]  acc_t;

    //==========================================================================
    // round-half-away-from-zero(acc / 2^15) + 对称饱和 ±32767
    // 与 golden 一致: round(y*2^14), clip ±max_q (rrc_pulse_shaping.m L41-42)
    //==========================================================================
    function automatic data_t round_clip(input acc_t acc);
        acc_t mag, q;
        mag = (acc < 0) ? -acc : acc;
        q   = (mag + acc_t'(1 <<< 14)) >>> 15;
        if (q > acc_t'(32767)) q = acc_t'(32767);
        round_clip = (acc < 0) ? data_t'(-q) : data_t'(q);
    endfunction

    //==========================================================================
    // 输入符号缓存 (9 深: 相0 需 9 抽头)
    //==========================================================================
    data_t sym_buf_i[0:TAPS_PP-1];
    data_t sym_buf_q[0:TAPS_PP-1];
    logic  w_accept;
    assign w_accept      = s_axis_tvalid && s_axis_tready;
    assign s_axis_tready = 1'b1;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int i = 0; i < TAPS_PP; i++) begin
                sym_buf_i[i] <= '0;
                sym_buf_q[i] <= '0;
            end
        end else if (w_accept) begin
            for (int i = TAPS_PP-1; i > 0; i--) begin
                sym_buf_i[i] <= sym_buf_i[i-1];
                sym_buf_q[i] <= sym_buf_q[i-1];
            end
            sym_buf_i[0] <= data_t'(s_axis_tdata[DATA_W-1:0]);
            sym_buf_q[0] <= data_t'(s_axis_tdata[DATA_W*2-1:DATA_W]);
        end
    end

    //==========================================================================
    // 相位调度: 接收后调度 4 个计算槽 (缓存移位后逐相计算, 停止即静默)
    //==========================================================================
    logic [2:0]             r_slots;
    logic [$clog2(SPS)-1:0] r_phase;
    logic                   w_slot_go;
    assign w_slot_go = (r_slots != 0);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_slots <= '0;
            r_phase <= '0;
        end else if (w_accept) begin
            r_slots <= 3'd4;           // 下一拍起计算相 0..3
            r_phase <= '0;
        end else if (w_slot_go) begin
            r_slots <= r_slots - 3'd1;
            r_phase <= r_phase + 1'b1;
        end
    end

    //==========================================================================
    // MAC 流水 — 级1: 9 乘积寄存; 级2: 加法树; 级3: 舍入/饱和输出
    //==========================================================================
    acc_t mac_i [TAPS_PP];
    acc_t mac_q [TAPS_PP];
    acc_t sum_i, sum_q;
    data_t ro_i, ro_q;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k < TAPS_PP; k++) begin
                mac_i[k] <= '0;
                mac_q[k] <= '0;
            end
        end else if (w_slot_go) begin
            for (int k = 0; k < TAPS_PP; k++) begin
                mac_i[k] <= acc_t'(sym_buf_i[k]) * acc_t'(H[r_phase][k]);
                mac_q[k] <= acc_t'(sym_buf_q[k]) * acc_t'(H[r_phase][k]);
            end
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            sum_i <= '0;
            sum_q <= '0;
        end else begin
            sum_i <= mac_i[0] + mac_i[1] + mac_i[2] + mac_i[3] + mac_i[4]
                   + mac_i[5] + mac_i[6] + mac_i[7] + mac_i[8];
            sum_q <= mac_q[0] + mac_q[1] + mac_q[2] + mac_q[3] + mac_q[4]
                   + mac_q[5] + mac_q[6] + mac_q[7] + mac_q[8];
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_i <= '0;
            ro_q <= '0;
        end else begin
            ro_i <= round_clip(sum_i);
            ro_q <= round_clip(sum_q);
        end
    end

    //==========================================================================
    // 输出 valid: 计算槽标志沿数据流水对齐延迟 3 级 (mac->sum->ro)
    //==========================================================================
    logic [2:0] r_vpipe;

    always_ff @(posedge i_clk) begin
        if (i_rst)
            r_vpipe <= '0;
        else
            r_vpipe <= {r_vpipe[1:0], w_slot_go};
    end

    assign m_axis_tdata  = {ro_q, ro_i};
    assign m_axis_tvalid = r_vpipe[2];

endmodule : rrc_polyphase_fir
