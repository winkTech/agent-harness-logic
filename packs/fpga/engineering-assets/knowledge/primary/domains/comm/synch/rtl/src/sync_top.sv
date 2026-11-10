//==============================================================================
// sync_top — OFDM 突发同步顶层 (802.11a), AXI4-Stream 封装
// 功能: 集成短前导码包检测 (packet_detect) 与长前导码精定时 (fine_timing),
//       输出 FFT 窗触发与同步锁定标志; 数据通路当前为直通占位
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (ADC 样点 Q2.14);
//       m_axis (CFO 校正后样点, 当前=直通); o_fft_start; o_sync_locked
// 主要逻辑: ri_ 输入寄存 -> packet_detect / fine_timing 并联 ->
//           三段式 FSM (SEARCH/DETECT/TRACK) -> ro_ 寄存输出
// 延迟: m_axis 相对 s_axis 为 2 拍 (ri_ 1 + ro_ 1)
// 复位: 同步高有效, 逐级传递给两个子模块
//
// 本文件为 hdl-coding 规范修复版。相对修复前 (git 历史) 的行为差异:
//   (1) 复位由 "异步低有效 negedge rst_n" 改为 "同步高有效 i_rst";
//   (2) m_axis_tvalid/tdata 原为 s_axis 组合直通 (违红线 2), 现经 ri_/ro_
//       两级寄存 -> 数据通路延迟 0 拍变 2 拍;
//   (3) o_sync_locked 原为 `assign = (state==TRACK)` 组合直出, 现 ro_ 寄存 -> +1 拍;
//   (4) FSM 由二段式补为三段式并补 default 分支 (红线 4)。
//
// !! 遗留功能缺陷 (承自原始代码, 本次规范修复**未改其逻辑**, 仅如实标注) !!
//   [F1] 数据通路是直通占位: CFO 估计与校正**未实现**, cordic_core 虽在包内
//        但顶层未例化。本模块目前只做检测, 不做校正。
//   [F2] m_axis_tready 未被使用 —— 下游反压时本模块照发不误, 会丢样点。
//        接背压需要在数据通路上加 skid buffer 或把 tready 反压回 s_axis。
//   [F3] 受 fine_timing 的 [F1] 影响 (o_fft_window_start 恒 0), 本 FSM 的
//        DETECT->TRACK 跳转**永不发生**, o_sync_locked 恒为 0。
//        修复需先在 fine_timing 里定义 FFT 窗触发判据, 属算法决策。
//==============================================================================
module sync_top #(
    parameter int DATA_W = 16
)(
    input  logic                i_clk,
    input  logic                i_rst,          // 同步复位, 高有效

    // AXI4-Stream slave (input samples)
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,

    // AXI4-Stream master (CFO corrected samples)
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata,

    // FFT window start trigger
    output logic                o_fft_start,
    output logic                o_sync_locked
);

    //==========================================================================
    // 状态编码 (红线/命名: 状态用 P_ 前缀)
    //==========================================================================
    typedef enum logic [1:0] {P_SEARCH, P_DETECT, P_TRACK} state_t;
    state_t r_state, w_state_nxt;

    //==========================================================================
    // ri_ 输入寄存 (红线 1) —— 数据通路输入不得直通到输出
    //==========================================================================
    logic                ri_tvalid;
    logic [DATA_W*2-1:0] ri_tdata;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_tvalid <= 1'b0;
            ri_tdata  <= '0;
        end else begin
            ri_tvalid <= s_axis_tvalid;
            if (s_axis_tvalid) ri_tdata <= s_axis_tdata;
        end
    end

    //==========================================================================
    // 子模块互连信号
    //==========================================================================
    logic              w_pd_detected;
    logic [DATA_W-1:0] w_pd_metric;
    logic              w_pd_metric_valid;
    logic [8:0]        w_ft_offset;
    logic              w_ft_fft_start;
    logic              r_ft_enable;

    //==========================================================================
    // 包检测
    //==========================================================================
    packet_detect #(
        .DATA_W(DATA_W)
    ) u_pd (
        .i_clk             (i_clk),
        .i_rst             (i_rst),
        .s_axis_tvalid     (s_axis_tvalid),
        .s_axis_tready     (s_axis_tready),
        .s_axis_tdata      (s_axis_tdata),
        .o_packet_detected (w_pd_detected),
        .o_metric_q15      (w_pd_metric),
        .o_metric_valid    (w_pd_metric_valid)
    );

    //==========================================================================
    // 精定时使能: 包检测置位后开启, FFT 窗触发后关闭
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst)                 r_ft_enable <= 1'b0;
        else if (w_pd_detected)    r_ft_enable <= 1'b1;
        else if (w_ft_fft_start)   r_ft_enable <= 1'b0;
    end

    //==========================================================================
    // 精定时
    //==========================================================================
    fine_timing #(
        .DATA_W(DATA_W)
    ) u_ft (
        .i_clk              (i_clk),
        .i_rst              (i_rst),
        .i_enable           (r_ft_enable),
        .s_axis_tvalid      (s_axis_tvalid),
        .s_axis_tdata       (s_axis_tdata),
        .o_fft_window_start (w_ft_fft_start),
        .o_timing_offset    (w_ft_offset)
    );

    //==========================================================================
    // 三段式状态机 (红线 4)
    //   段 1: 次态组合逻辑 (含 default, 红线 5)
    //   段 2: 状态寄存
    //   段 3: 输出寄存 (见下方 ro_ 段)
    //==========================================================================
    always_comb begin
        w_state_nxt = r_state;                       // 默认保持, 杜绝 latch
        case (r_state)
            P_SEARCH: if (w_pd_detected)                      w_state_nxt = P_DETECT;
            P_DETECT: if (w_ft_fft_start)                     w_state_nxt = P_TRACK;
            P_TRACK:  if (!w_pd_detected && r_ft_enable)      w_state_nxt = P_SEARCH;
            default:                                          w_state_nxt = P_SEARCH;
        endcase
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) r_state <= P_SEARCH;
        else       r_state <= w_state_nxt;
    end

    //==========================================================================
    // ro_ 输出寄存 (红线 2)
    // 注: m_axis 为直通占位 (见文件头 [F1]), 且未响应 m_axis_tready ([F2])
    //==========================================================================
    logic                ro_tvalid;
    logic [DATA_W*2-1:0] ro_tdata;
    logic                ro_fft_start;
    logic                ro_sync_locked;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_tvalid      <= 1'b0;
            ro_tdata       <= '0;
            ro_fft_start   <= 1'b0;
            ro_sync_locked <= 1'b0;
        end else begin
            ro_tvalid      <= ri_tvalid;
            if (ri_tvalid) ro_tdata <= ri_tdata;
            ro_fft_start   <= w_ft_fft_start;
            ro_sync_locked <= (r_state == P_TRACK);
        end
    end

    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tdata  = ro_tdata;
    assign o_fft_start   = ro_fft_start;
    assign o_sync_locked = ro_sync_locked;

endmodule : sync_top
