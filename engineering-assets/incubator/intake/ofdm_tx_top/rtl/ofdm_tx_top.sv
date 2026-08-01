//==============================================================================
// ofdm_tx_top — 802.11a 风格 OFDM 发射机顶层 (ADR-004 架构重排)
// 功能: 比特流 → 四调制星座映射 (tx_mapper) → 子载波/导频映射
//       (tx_pilot_map) → 自研 64 点流水 IFFT (ifft64_sdf) → CP 插入
//       (tx_cp_insert, 位反序写地址吸收重排) → m_axis (80 样点/符号)。
// 契约 (ADR-004, 详见 README/limitations):
//   - s_axis_tdata[5:0] = 一个星座符号的比特组 (LSB 对齐: BPSK b0 /
//     QPSK b0b1 / 16QAM b0..b3 / 64QAM b0..b5, b0=码流首比特, 与 golden
//     mod_mapper 逐字一致); 每 48 拍构成一个 OFDM 符号; s_axis_tlast 未用;
//   - i_cfg_mod_type[1:0]: 0 BPSK / 1 QPSK / 2 16QAM / 3 64QAM (帧内须稳定;
//     高 2 位保留); 0.1.0 的 i_cfg_fft_len/i_cfg_cp_len 从未被消费, 已删除;
//   - m_axis: {Q3.13_Q[15:0], Q3.13_I[15:0]}, tlast = 每符号第 80 拍;
//   - 符号信用节流: 在途符号 ≤2 (CP 乒乓深度), 新符号首拍需信用,
//     符号中途 48 拍保证连续接受;
//   - 尾部冲刷: 流结束后需再馈 ≥2 个全零符号排空 IFFT 流水 (TB/集成契约)。
// 定点: 频域 Q2.14 → IFFT 内部 s20 (级 2/4/6 >>>1) → 时域 Q3.13 sat16;
//       全部整数语义与 generate_vectors.m 位真镜像逐字一致。
// 复位: 同步高有效, 统一下发; 数据流水少复位 (§1.1)
//==============================================================================
module ofdm_tx_top #(
    parameter int DATA_W = 16
)(
    input  logic                i_clk,
    input  logic                i_rst,          // 同步复位, 高有效

    input  logic [3:0]          i_cfg_mod_type, // [1:0] 有效

    // 比特组输入 (AXI-S slave)
    input  logic [5:0]          s_axis_tdata,
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic                s_axis_tlast,   // 未用 (帧语义在外部)

    // 时域输出 (AXI-S master)
    output logic [DATA_W*2-1:0] m_axis_tdata,
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic                m_axis_tlast
);

    //==========================================================================
    // 符号信用节流 + ri_ 输入寄存 (红线 1)
    // credit 0..2 = CP 乒乓可容纳的在途符号数; 新符号首拍消费 1 信用,
    // cp o_sym_done 归还; 符号中途 (r_bcnt!=0) 保证连续接受
    //==========================================================================
    logic       w_sym_done;
    logic [1:0] r_credit, w_credit_nxt;
    logic [5:0] r_bcnt,   w_bcnt_nxt;
    logic       ro_tready;
    logic       w_accept;

    assign w_accept = s_axis_tvalid && ro_tready;

    // ro_tready 必须由次态推导: 若用现态, 符号最后一拍 (r_bcnt=47 且信用已
    // 耗尽) 的 ready 会因 r_bcnt!=0 仍为 1, 下一拍 r_bcnt 已回 0 而 ready
    // 尚未落下, 多放行一个 beat —— 信用 0-1 回绕成 3, 第三个符号提前开收,
    // 与 tx_pilot_map 的两级乒乓相撞 (读中的 bank 被覆写)。
    assign w_bcnt_nxt   = !w_accept          ? r_bcnt
                        : (r_bcnt == 6'd47)  ? 6'd0
                                             : (r_bcnt + 6'd1);
    assign w_credit_nxt = r_credit
                        - ((w_accept && r_bcnt == 6'd0) ? 2'd1 : 2'd0)
                        + (w_sym_done ? 2'd1 : 2'd0);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_credit <= 2'd2;
            r_bcnt   <= '0;
        end else begin
            r_credit <= w_credit_nxt;
            r_bcnt   <= w_bcnt_nxt;
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_tready <= 1'b0;
        else       ro_tready <= (w_credit_nxt != 2'd0) || (w_bcnt_nxt != 6'd0);
    end

    assign s_axis_tready = ro_tready;

    logic       ri_v;
    logic [5:0] ri_bits;
    logic [1:0] ri_mod;

    always_ff @(posedge i_clk) begin
        if (i_rst) ri_v <= 1'b0;
        else       ri_v <= w_accept;
    end

    always_ff @(posedge i_clk) begin
        ri_bits <= s_axis_tdata;
        ri_mod  <= i_cfg_mod_type[1:0];
    end

    //==========================================================================
    // 映射 → 子载波/导频 → IFFT → CP (全链 i_beat=1, valid 驱动)
    //==========================================================================
    logic                     w_map_v;
    logic signed [DATA_W-1:0] w_map_re, w_map_im;

    tx_mapper #(.DATA_W(DATA_W)) u_mapper (
        .i_clk     (i_clk),
        .i_rst     (i_rst),
        .i_beat    (1'b1),
        .i_valid   (ri_v),
        .i_bits    (ri_bits),
        .i_cfg_mod (ri_mod),
        .o_valid   (w_map_v),
        .o_re      (w_map_re),
        .o_im      (w_map_im)
    );

    logic                     w_grid_v;
    logic signed [DATA_W-1:0] w_grid_re, w_grid_im;

    tx_pilot_map #(.DATA_W(DATA_W)) u_pilot_map (
        .i_clk   (i_clk),
        .i_rst   (i_rst),
        .i_beat  (1'b1),
        .i_valid (w_map_v),
        .i_re    (w_map_re),
        .i_im    (w_map_im),
        .o_valid (w_grid_v),
        .o_re    (w_grid_re),
        .o_im    (w_grid_im)
    );

    logic                     w_ifft_v;
    logic [5:0]               w_ifft_idx;
    logic signed [DATA_W-1:0] w_ifft_re, w_ifft_im;

    ifft64_sdf #(.DATA_W(DATA_W)) u_ifft (
        .i_clk   (i_clk),
        .i_rst   (i_rst),
        .i_beat  (1'b1),
        .i_valid (w_grid_v),
        .i_re    (w_grid_re),
        .i_im    (w_grid_im),
        .o_valid (w_ifft_v),
        .o_idx   (w_ifft_idx),
        .o_re    (w_ifft_re),
        .o_im    (w_ifft_im)
    );

    logic w_ovf;

    tx_cp_insert #(.DATA_W(DATA_W)) u_cp (
        .i_clk         (i_clk),
        .i_rst         (i_rst),
        .i_beat        (1'b1),
        .i_valid       (w_ifft_v),
        .i_idx         (w_ifft_idx),
        .i_re          (w_ifft_re),
        .i_im          (w_ifft_im),
        .m_axis_tvalid (m_axis_tvalid),
        .m_axis_tready (m_axis_tready),
        .m_axis_tdata  (m_axis_tdata),
        .m_axis_tlast  (m_axis_tlast),
        .o_sym_done    (w_sym_done),
        .o_ovf         (w_ovf)
    );

endmodule : ofdm_tx_top
