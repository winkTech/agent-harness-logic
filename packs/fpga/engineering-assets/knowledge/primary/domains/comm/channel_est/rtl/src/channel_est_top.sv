//==============================================================================
// channel_est_top — 信道估计顶层 (LS 估计 + 线性插值)
// 功能: 802.11a OFDM 信道估计 —— 从 FFT 输出抽取 4 个导频做 LS 估计,
//       再线性插值出 64 个子载波的信道响应
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (FFT 输出 Y);
//       m_axis (信道估计 H_est 到均衡器)
// 主要逻辑: ls_estimator 抓导频 -> 三段式流水控制 FSM -> channel_interpolator 插值
// 延迟: 约 1 个 OFDM 符号 (64 拍抓取 + 数拍计算 + 64 拍输出)
// 复位: 同步高有效, 统一下发给两个子模块
//
// 本文件为 hdl-coding 规范修复版。相对修复前的差异:
//   (1) 复位由 `negedge rst_n` 异步低有效改为同步高有效 i_rst;
//   (2) 端口 clk/rst_n -> i_clk/i_rst;
//   (3) FSM 补为三段式并补 default 分支 (红线 4/5);
//   (4) **删除跨层次引用**: interp_busy 原写 `u_interpolator.m_axis_tvalid`,
//       从父模块伸手取子模块内部信号。该写法可仿真但违反模块封装, 且部分
//       综合/形式工具不支持。该信号本就已通过端口连到顶层的 m_axis_tvalid,
//       现直接用顶层信号。
//
// !! 遗留缺陷 (承自原始代码, 本次**未改**) !!
//   [F1] 流水控制 FSM 的三个状态语义存疑: 复位进 IDLE, 靠 o_symbol_done 进
//        WAIT_SYMBOL, 再靠 !interp_busy 进 COMPUTE_SYMBOL, 然后无条件回 IDLE。
//        而 interp_busy 的定义里又含 `pipe_state == COMPUTE_SYMBOL`, 形成
//        自指。文件头注释宣称"当前符号抓取期间处理上一符号"的乒乓流水,
//        代码里没有对应的双缓冲结构。
//   [F2] 顶层没有把 ls_estimator 的 o_pilot_valid 用起来, 插值器直接读导频寄存器,
//        依赖上层时序保证读到的是完整的一组 —— 无显式握手保护。
//   [F3] 受 ls_estimator [F1] 影响, 导频只在第一个 OFDM 符号有效。
//==============================================================================
module channel_est_top #(
    parameter int DATA_W = 16
)(
    input  logic                i_clk,
    input  logic                i_rst,        // 同步复位, 高有效

    // AXI4-Stream slave (Y from FFT)
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,

    // AXI4-Stream master (H_est to equalizer)
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata
);

    //==========================================================================
    // Internal signals
    //==========================================================================
    logic        w_ls_symbol_done;
    logic        w_ls_pilot_valid;
    logic [3:0][DATA_W-1:0] w_ls_pilot_i;
    logic [3:0][DATA_W-1:0] w_ls_pilot_q;

    logic        w_interp_start;
    logic        w_interp_busy;

    //==========================================================================
    // 状态编码 (红线/命名: 状态用 P_ 前缀)
    //==========================================================================
    typedef enum logic [1:0] {P_IDLE, P_WAIT_SYMBOL, P_COMPUTE_SYMBOL} pipe_state_t;
    pipe_state_t r_pipe_state, w_pipe_state_nxt;

    //==========================================================================
    // LS Estimator instance
    //==========================================================================
    ls_estimator #(
        .DATA_W(DATA_W)
    ) u_ls_estimator (
        .i_clk         (i_clk),
        .i_rst         (i_rst),
        .s_axis_tvalid (s_axis_tvalid),
        .s_axis_tready (s_axis_tready),
        .s_axis_tdata  (s_axis_tdata),
        .o_pilot_valid (w_ls_pilot_valid),
        .o_pilot_h_i   (w_ls_pilot_i),
        .o_pilot_h_q   (w_ls_pilot_q),
        .o_symbol_done (w_ls_symbol_done)
    );

    //==========================================================================
    // 三段式流水控制 FSM (红线 4)
    //   段 1: 次态组合 (含 default, 红线 5)
    //==========================================================================
    always_comb begin
        w_pipe_state_nxt = r_pipe_state;
        case (r_pipe_state)
            P_IDLE:           if (w_ls_symbol_done) w_pipe_state_nxt = P_WAIT_SYMBOL;
            P_WAIT_SYMBOL:    if (!w_interp_busy)   w_pipe_state_nxt = P_COMPUTE_SYMBOL;
            P_COMPUTE_SYMBOL:                       w_pipe_state_nxt = P_IDLE;
            default:                                w_pipe_state_nxt = P_IDLE;
        endcase
    end

    //   段 2: 状态寄存
    always_ff @(posedge i_clk) begin
        if (i_rst) r_pipe_state <= P_IDLE;
        else       r_pipe_state <= w_pipe_state_nxt;
    end

    //   段 3: 状态译码输出 (启动脉冲直接由状态寄存器译出, 无组合输入参与)
    assign w_interp_start = (r_pipe_state == P_COMPUTE_SYMBOL);

    //==========================================================================
    // Interpolator instance
    //==========================================================================
    channel_interpolator #(
        .DATA_W(DATA_W)
    ) u_interpolator (
        .i_clk          (i_clk),
        .i_rst          (i_rst),
        .i_start        (w_interp_start),
        .i_pilot_h_i    (w_ls_pilot_i),
        .i_pilot_h_q    (w_ls_pilot_q),
        .m_axis_tvalid  (m_axis_tvalid),
        .m_axis_tready  (m_axis_tready),
        .m_axis_tdata   (m_axis_tdata)
    );

    // 用顶层端口信号, 不做跨层次引用 (见文件头 (4))
    assign w_interp_busy = m_axis_tvalid || (r_pipe_state == P_COMPUTE_SYMBOL);

endmodule : channel_est_top
