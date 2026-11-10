//==============================================================================
// channel_est_top — 信道估计顶层 (LTS-LS + 导频 CPE 跟踪, ADR-002 架构)
// 功能: 802.11a OFDM 信道估计。每帧 = 2×LTS + N 个数据符号 (均为 FFT 输出,
//       64 子载波/符号): LTS 阶段做全用载波 LS (lts_estimator), 数据符号阶段
//       用 4 导频估计公共相位并输出 H(m) = H_LTS·e^{j·CPE(m)} (cpe_tracker)。
//       LTS 符号不产生输出; 每个数据符号输出 64 点 Q2.14 {Q,I}。
// 端口: i_clk/i_rst (同步复位, 高有效);
//       i_frame_start — 帧起始侧带脉冲 (风格同 sync_top.o_fft_start), 标记
//         其后进入的第一个符号为 LTS1; **须领先首个 LTS 样点 ≥1 拍**;
//       s_axis (FFT 输出 Y, Q2.14 {Q,I}); m_axis (H(m) 到均衡器)
// 主要逻辑: ri_ 输入寄存 -> 帧/符号定序 (UNSYNC/LTS1/LTS2/DATA, 64 拍边界)
//           -> lts_estimator (H_LTS RAM) + cpe_tracker (CPE + 输出)
// 节流 (s_axis_tready 拉低, AXIS 合法):
//   (1) 帧起始待决而计算/输出级尚未排空 —— 保护 H_LTS RAM 不被新帧覆写;
//   (2) 数据符号末 2 拍且上一符号 CPE 计算链未闲 —— 保证符号尾锁存不冲突
// 延迟: 数据符号末拍 -> 该符号 H 输出完成约 110 拍 (< 1 OFDM 符号 @100MHz)
// 复位: 同步高有效, 统一下发; 复位后处于 UNSYNC, 静默丢弃样点直到 i_frame_start
//==============================================================================
module channel_est_top #(
    parameter int DATA_W = 16
)(
    input  logic                i_clk,
    input  logic                i_rst,          // 同步复位, 高有效

    input  logic                i_frame_start,  // 帧起始脉冲 (领先 LTS1 ≥1 拍)

    // AXI4-Stream slave (Y from FFT)
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,

    // AXI4-Stream master (H(m) to equalizer)
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata
);

    localparam int N_FFT   = 64;
    localparam int P_IDX_W = 6;    // $clog2(N_FFT)

    //==========================================================================
    // 帧起始待决 + ri_ 输入寄存 (红线 1)
    //==========================================================================
    logic w_s_accept;
    logic r_fs_pend;
    logic ro_tready;

    assign w_s_accept = s_axis_tvalid && ro_tready;

    always_ff @(posedge i_clk) begin
        if (i_rst)                          r_fs_pend <= 1'b0;
        else if (i_frame_start)             r_fs_pend <= 1'b1;
        else if (w_s_accept && r_fs_pend)   r_fs_pend <= 1'b0;  // 该拍即 LTS1[0]
    end

    logic                ri_tvalid;
    logic                ri_fs_take;    // 本已寄存拍为帧首拍 (LTS1 sub 0)
    logic [DATA_W*2-1:0] ri_tdata;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_tvalid  <= 1'b0;
            ri_fs_take <= 1'b0;
        end else begin
            ri_tvalid  <= w_s_accept;
            ri_fs_take <= w_s_accept && r_fs_pend;
        end
    end

    // 数据寄存 (不复位 §1.1, 由 ri_tvalid 屏蔽)
    always_ff @(posedge i_clk) begin
        ri_tdata <= s_axis_tdata;
    end

    //==========================================================================
    // 帧/符号定序: 本拍有效相位组合自寄存状态 (三段式, 红线 4)
    //==========================================================================
    typedef enum logic [1:0] {P_UNSYNC, P_LTS1, P_LTS2, P_DATA} phase_t;
    phase_t r_phase, w_phase_nxt;
    logic [P_IDX_W-1:0] r_sub, w_sub_eff;

    logic w_ph_lts1, w_ph_lts2, w_ph_data, w_sym_last;

    assign w_sub_eff  = ri_fs_take ? '0 : r_sub;
    assign w_ph_lts1  = ri_fs_take || (r_phase == P_LTS1);
    assign w_ph_lts2  = !ri_fs_take && (r_phase == P_LTS2);
    assign w_ph_data  = !ri_fs_take && (r_phase == P_DATA);
    assign w_sym_last = ri_tvalid && (w_sub_eff == P_IDX_W'(N_FFT-1));

    //   段 1: 次态组合 (含 default, 红线 5)
    always_comb begin
        w_phase_nxt = r_phase;
        if (ri_fs_take) begin
            w_phase_nxt = P_LTS1;                       // 帧首拍已按 LTS1 处理
        end else if (w_sym_last) begin
            case (r_phase)
                P_LTS1:   w_phase_nxt = P_LTS2;
                P_LTS2:   w_phase_nxt = P_DATA;
                P_DATA:   w_phase_nxt = P_DATA;
                default:  w_phase_nxt = r_phase;        // UNSYNC 保持
            endcase
        end
    end

    //   段 2: 状态/计数寄存
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_phase <= P_UNSYNC;
            r_sub   <= '0;
        end else if (ri_tvalid) begin
            r_phase <= w_phase_nxt;
            r_sub   <= (w_sub_eff == P_IDX_W'(N_FFT-1)) ? '0 : w_sub_eff + 1'b1;
        end
    end

    //==========================================================================
    // 子模块
    //==========================================================================
    logic                     w_rd_active, w_rd_ce;
    logic [P_IDX_W-1:0]       w_rd_addr;
    logic signed [DATA_W-1:0] w_rd_di, w_rd_dq;
    logic [3:0][DATA_W-1:0]   w_pilot_h_i, w_pilot_h_q;
    logic                     w_calc_busy, w_out_busy;

    lts_estimator #(
        .N_FFT   (N_FFT),
        .DATA_W  (DATA_W),
        .P_IDX_W (P_IDX_W)
    ) u_lts_estimator (
        .i_clk       (i_clk),
        .i_rst       (i_rst),
        .i_beat      (ri_tvalid),
        .i_sub       (w_sub_eff),
        .i_di        ($signed(ri_tdata[DATA_W-1:0])),
        .i_dq        ($signed(ri_tdata[DATA_W*2-1:DATA_W])),
        .i_ph_lts1   (w_ph_lts1),
        .i_ph_lts2   (w_ph_lts2),
        .i_rd_ce     (w_rd_ce),
        .i_rd_addr   (w_rd_addr),
        .o_rd_di     (w_rd_di),
        .o_rd_dq     (w_rd_dq),
        .o_pilot_h_i (w_pilot_h_i),
        .o_pilot_h_q (w_pilot_h_q)
    );

    cpe_tracker #(
        .N_FFT   (N_FFT),
        .DATA_W  (DATA_W),
        .P_IDX_W (P_IDX_W)
    ) u_cpe_tracker (
        .i_clk         (i_clk),
        .i_rst         (i_rst),
        .i_beat        (ri_tvalid),
        .i_sub         (w_sub_eff),
        .i_di          ($signed(ri_tdata[DATA_W-1:0])),
        .i_dq          ($signed(ri_tdata[DATA_W*2-1:DATA_W])),
        .i_ph_data     (w_ph_data),
        .i_abort       (ri_fs_take),
        .i_pilot_h_i   (w_pilot_h_i),
        .i_pilot_h_q   (w_pilot_h_q),
        .o_rd_active   (w_rd_active),
        .o_rd_addr     (w_rd_addr),
        .i_rd_di       (w_rd_di),
        .i_rd_dq       (w_rd_dq),
        .m_axis_tvalid (m_axis_tvalid),
        .m_axis_tready (m_axis_tready),
        .m_axis_tdata  (m_axis_tdata),
        .o_calc_busy   (w_calc_busy),
        .o_out_busy    (w_out_busy)
    );

    // RAM 读使能 = 输出级活跃 && 输出流水推进 (见 cpe_tracker 端口注释:
    // 冻结时若继续读, 已前进的地址会覆盖在途数据)
    assign w_rd_ce = w_rd_active && (!m_axis_tvalid || m_axis_tready);

    //==========================================================================
    // s_axis_tready (ro_ 寄存, 红线 2) — 节流条件见文件头
    //==========================================================================
    logic w_stall_frame, w_stall_tail;

    assign w_stall_frame = (i_frame_start || r_fs_pend) && (w_calc_busy || w_out_busy);
    // 窗口自 61 起: accept->ri->r_sub 共 2 拍滞后 + ro_tready 寄存 1 拍,
    // 背靠背流下需提前 3 拍决策才能保证第 63 拍被拦住
    assign w_stall_tail  = (r_phase == P_DATA) && (r_sub >= P_IDX_W'(61)) &&
                           w_calc_busy;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_tready <= 1'b0;
        else       ro_tready <= !(w_stall_frame || w_stall_tail);
    end

    assign s_axis_tready = ro_tready;

endmodule : channel_est_top
