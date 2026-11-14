//==============================================================================
// mod_demapper — 软判决解调 (max-log LLR), Q(10,4) 串行输出
//
// 接口由 tb/tb_mod_demapper.sv 定死 (TB 先行), 数值规格的单一事实源是
// models/comm/ofdm/src/rtl_mirror_demap.m, 判卷 0 容差。
//
// ## 为什么串行输出成立 —— 这笔账要在写 RTL 之前算
//
//   OOC 约束 100 MHz; OFDM 符号 = 80 样点 @20 MHz = 4 us = **400 拍**
//   64QAM 每符号 48 x 6 = **288 个 LLR** < 400, 余量 28%
//
//   若按 20 MHz 时钟算, 288 > 80, 串行**根本走不通**, 必须并出 bps 个。
//   接口形状取决于这笔账, 不取决于哪种写法好看。
//
// ## 吞吐: 必须让 metric 流水与串行化重叠
//
//   "算完再串行"是 5 + bps = 11 拍/点, 48 点需 528 拍 > 400 —— **持续速率不够**,
//   不是突发问题, 加输入 FIFO 也救不了。
//   故本件在串行化第 1 拍就把下一点打进 metric 流水: 稳态 max(bps, 6) <= 6 拍/点,
//   48 点 288 拍 < 400。代价只是**一个保持寄存器**, 不需要宽 FIFO ——
//   同一时刻只有一个点在 metric 流水里, 权重/移位量因此也只需一组寄存器而非延迟链。
//
// ## 子件
//   demap_metric x2  单轴 max-log metric (I/Q 各一), 延迟 5
//   demap_scale  x1  加权/移位/饱和, 延迟 5, 按比特分时复用
//==============================================================================
`default_nettype none

module mod_demapper #(
    parameter int P_DATA_W = 16,
    parameter int P_LLR_W  = 10,
    parameter int P_CONF_W = 12
)(
    input  wire                       i_clk,
    input  wire                       i_rst,        // 同步高有效
    input  wire [1:0]                 i_mod,        // 0=QPSK 1=16QAM 2=64QAM

    input  wire                       s_axis_tvalid,
    output wire                       s_axis_tready,
    input  wire [2*P_DATA_W-1:0]      s_axis_tdata, // {im, re}, Q4.12
    input  wire [P_CONF_W-1:0]        i_conf,       // {sh[5:0], man[5:0]}
    input  wire                       i_erasure,

    output wire                       m_axis_tvalid,
    input  wire                       m_axis_tready,
    output wire signed [P_LLR_W-1:0]  m_axis_tdata,
    output wire                       m_axis_tlast  // 该符号最后一个比特
);

    localparam int SCALE_LAT = 5;
    localparam int OFD       = 16;                  // 出侧 FIFO 深度 (2 的幂)
    localparam int OFW       = 4;                   // $clog2(OFD)

    //--------------------------------------------------------------------------
    // ri_ 输入寄存。同一时刻只有一个点在 metric 流水里, 故权重/移位量/擦除
    // 只需一组寄存器 —— 不需要与流水同深的延迟链。
    //--------------------------------------------------------------------------
    logic                    ri_valid;
    logic [2*P_DATA_W-1:0]   ri_x;
    logic [1:0]              ri_mod;
    logic [15:0]             ri_wman;
    logic [6:0]              ri_shift;
    logic                    ri_er;

    wire [5:0] w_sh  = i_conf[P_CONF_W-1:6];
    wire [5:0] w_man = i_conf[5:0];
    // sh' = 67 - sh - log2K, log2K = 1/4/5。sh 超出契约区 [0,34] 时结果落到
    // >=48 那一支 (输出 0), 是安全侧退化而不是乱数。
    wire [6:0] w_l2k = (i_mod == 2'd0) ? 7'd1 : ((i_mod == 2'd1) ? 7'd4 : 7'd5);
    wire [6:0] w_shp = 7'd67 - 7'({1'b0, w_sh}) - w_l2k;

    wire w_accept = s_axis_tvalid & s_axis_tready;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid <= 1'b0;
            ri_mod   <= 2'd0;
            ri_er    <= 1'b0;
        end else begin
            ri_valid <= w_accept;
            if (w_accept) begin
                ri_mod   <= i_mod;
                ri_er    <= i_erasure;
            end
        end
    end

    // 数据载荷少复位 (hdl §1.1): 由 valid 链把关, 复位不必清零。
    always_ff @(posedge i_clk) begin
        if (w_accept) begin
            ri_x     <= s_axis_tdata;
            ri_wman  <= 16'd32768 + {w_man, 9'd0};       // 2^15 + man*2^9
            ri_shift <= w_shp;
        end
    end

    //--------------------------------------------------------------------------
    // 两轴 metric
    //--------------------------------------------------------------------------
    wire               w_mv_i, w_mv_q;
    wire signed [32:0] w_i0, w_i1, w_i2, w_q0, w_q1, w_q2;

    demap_metric #(.P_DATA_W(P_DATA_W)) u_mi (
        .i_clk(i_clk), .i_rst(i_rst), .i_valid(ri_valid),
        .i_y(ri_x[P_DATA_W-1:0]), .i_mod(ri_mod),
        .o_valid(w_mv_i), .o_m0(w_i0), .o_m1(w_i1), .o_m2(w_i2));

    demap_metric #(.P_DATA_W(P_DATA_W)) u_mq (
        .i_clk(i_clk), .i_rst(i_rst), .i_valid(ri_valid),
        .i_y(ri_x[2*P_DATA_W-1:P_DATA_W]), .i_mod(ri_mod),
        .o_valid(w_mv_q), .o_m0(w_q0), .o_m1(w_q1), .o_m2(w_q2));

    //--------------------------------------------------------------------------
    // 在飞标记与保持寄存器
    //--------------------------------------------------------------------------
    logic               r_inflight;
    logic               r_hold_v;
    logic signed [32:0] r_h [0:5];                  // b0..b5, I 在前 Q 在后
    logic [15:0]        r_h_wman;
    logic [6:0]         r_h_shift;
    logic               r_h_er;
    logic [1:0]         r_h_mod;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_inflight <= 1'b0;
        end else begin
            if (w_accept)      r_inflight <= 1'b1;
            else if (w_mv_i)   r_inflight <= 1'b0;
        end
    end

    //--------------------------------------------------------------------------
    // 串行化 FSM (3 段)
    //--------------------------------------------------------------------------
    localparam logic S_IDLE = 1'b0;
    localparam logic S_RUN  = 1'b1;

    logic               r_state, w_next;
    logic [2:0]         r_bit;
    logic signed [32:0] r_c [0:5];
    logic [15:0]        r_c_wman;
    logic [6:0]         r_c_shift;
    logic               r_c_er;
    logic [2:0]         r_c_bps;
    logic [OFW:0]       r_credit;

    wire [2:0] w_half   = (r_h_mod == 2'd0) ? 3'd1 : ((r_h_mod == 2'd1) ? 3'd2 : 3'd3);
    wire       w_issue  = (r_state == S_RUN) && (r_credit != '0);
    wire       w_last   = w_issue && (r_bit == (r_c_bps - 3'd1));

    // 1 段: 状态寄存
    always_ff @(posedge i_clk) begin
        if (i_rst) r_state <= S_IDLE;
        else       r_state <= w_next;
    end

    // 2 段: 次态
    always_comb begin
        w_next = r_state;
        case (r_state)
            S_IDLE:  if (r_hold_v) w_next = S_RUN;
            default: if (w_last)   w_next = S_IDLE;
        endcase
    end

    // 装载条件单列: 控制段与载荷段必须用**同一个**条件, 分成两个 always_ff 后
    // 若各写一遍, 日后改动很容易只改一处。
    wire w_load = (r_state == S_IDLE) & r_hold_v;

    // 3 段: 控制 (受复位)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_hold_v <= 1'b0;
            r_bit    <= 3'd0;
            r_c_er   <= 1'b0;
            r_c_bps  <= 3'd2;
            r_h_er   <= 1'b0;
            r_h_mod  <= 2'd0;
        end else begin
            if (w_mv_i) begin
                r_h_er   <= ri_er;
                r_h_mod  <= ri_mod;
                r_hold_v <= 1'b1;
            end
            if (w_load) begin
                r_c_er   <= r_h_er;
                r_c_bps  <= {w_half[1:0], 1'b0};           // bps = 2*half
                r_bit    <= 3'd0;
                // **不是无条件清 0**: 若同拍又有 metric 结果落下来, 保持寄存器应继续
                // 有效, 否则那一点会被静默丢掉。当前流控下这种同拍不可达 (同一时刻只有
                // 一个点在飞), 但写成无条件清 0 等于把"不可达"变成沉默的数据丢失路径 ——
                // 一旦日后放宽流控就会中招, 且现象只是"偶尔少几个 LLR"。
                r_hold_v <= w_mv_i;
            end
            if (!w_load && (r_state != S_IDLE) && w_issue)
                r_bit <= w_last ? 3'd0 : (r_bit + 3'd1);
        end
    end

    // 3 段: 数据载荷 (少复位)
    always_ff @(posedge i_clk) begin
        if (w_mv_i) begin
            r_h[0] <= w_i0; r_h[1] <= w_i1; r_h[2] <= w_i2;
            r_h[3] <= w_q0; r_h[4] <= w_q1; r_h[5] <= w_q2;
            r_h_wman  <= ri_wman;
            r_h_shift <= ri_shift;
        end
        if (w_load) begin
            // I 的 half 个比特在前, Q 的在后 (b0 在前)
            r_c[0] <= r_h[0];
            r_c[1] <= (w_half == 3'd1) ? r_h[3] : r_h[1];
            r_c[2] <= (w_half == 3'd2) ? r_h[3] : r_h[2];
            r_c[3] <= (w_half == 3'd2) ? r_h[4] : r_h[3];
            r_c[4] <= r_h[4];
            r_c[5] <= r_h[5];
            r_c_wman  <= r_h_wman;
            r_c_shift <= r_h_shift;
        end
    end

    //--------------------------------------------------------------------------
    // 末级: 加权/移位/饱和 (按比特分时复用)
    //--------------------------------------------------------------------------
    logic signed [32:0] w_met;
    always_comb begin
        case (r_bit)
            3'd0:    w_met = r_c[0];
            3'd1:    w_met = r_c[1];
            3'd2:    w_met = r_c[2];
            3'd3:    w_met = r_c[3];
            3'd4:    w_met = r_c[4];
            default: w_met = r_c[5];
        endcase
    end

    wire                     w_sv;
    wire signed [P_LLR_W-1:0] w_sllr;

    demap_scale #(.P_LLR_W(P_LLR_W)) u_scale (
        .i_clk(i_clk), .i_rst(i_rst), .i_valid(w_issue),
        .i_metric(w_met), .i_wman(r_c_wman), .i_shift(r_c_shift),
        .i_erasure(r_c_er),
        .o_valid(w_sv), .o_llr(w_sllr));

    // tlast 与 scale 同深的移位链 —— scale 没有旁带, 由顶层对齐
    logic [SCALE_LAT-1:0] r_lastpipe;
    always_ff @(posedge i_clk) begin
        if (i_rst) r_lastpipe <= '0;
        else       r_lastpipe <= {r_lastpipe[SCALE_LAT-2:0], w_last};
    end

    //--------------------------------------------------------------------------
    // 出侧 FIFO + 信用。信用保证已发进 scale 的拍一定有位置落地, 故 scale
    // 不需要反压端口 (它是无条件推进的流水)。
    //--------------------------------------------------------------------------
    logic [P_LLR_W:0] r_ofifo [0:OFD-1];
    logic [OFW:0]     r_owp, r_orp;

    wire w_opop = m_axis_tvalid & m_axis_tready;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_owp    <= '0;
            r_orp    <= '0;
            r_credit <= (OFW+1)'(OFD);
        end else begin
            if (w_sv) begin
                r_ofifo[r_owp[OFW-1:0]] <= {r_lastpipe[SCALE_LAT-1], w_sllr};
                r_owp <= r_owp + 1'b1;
            end
            if (w_opop) r_orp <= r_orp + 1'b1;

            case ({w_issue, w_opop})
                2'b10:   r_credit <= r_credit - 1'b1;
                2'b01:   r_credit <= r_credit + 1'b1;
                default: r_credit <= r_credit;
            endcase
        end
    end

    assign m_axis_tvalid = (r_owp != r_orp);
    assign m_axis_tdata  = r_ofifo[r_orp[OFW-1:0]][P_LLR_W-1:0];
    assign m_axis_tlast  = r_ofifo[r_orp[OFW-1:0]][P_LLR_W];

    // 收点条件。保持寄存器"本拍正被 FSM 取走"也算空 —— 少这一项时实测 7.9 拍/点,
    // 对 8.33 的预算只剩 5% 余量; 加上后 ~6.9, 余量 17%。新点的 metric 结果要 6 拍
    // 后才回来, 那时保持寄存器早已腾空, 故安全。
    wire w_hold_free = ~r_hold_v | (r_state == S_IDLE);
    // **复位期间必须拉低 tready**。少了 ~i_rst 这一项时: r_inflight 与 r_hold_v 都被
    // 复位清零 -> w_hold_free=1 -> tready=1, 上游若保持 tvalid 则握手成立、数据被吃掉,
    // 而 ri_valid 被复位钳在 0 —— **数据静默丢失, 上游还以为发出去了**。
    // 这是列复位寄存器清单时才看出来的, 三个功能 TB 全绿也照样漏 (它们复位时不驱动
    // tvalid)。tb_demap_reset 的 T0b 锁住它。
    assign s_axis_tready = ~i_rst & ~r_inflight & w_hold_free;

endmodule

`default_nettype wire
