//==============================================================================
// sync_top — 802.11a OFDM 突发同步顶层 (ADR-003 因果化架构)
// 功能: 短前导码检测 (sync_detect) -> 粗 CFO 求角 (cordic_cv) -> 因果 NCO 旋转
//       校正 (K 预缩放 + cordic_rot_pipe) -> T1 精定时/输出 (sync_track_out)。
// 契约 (ADR-003, 详见 README/limitations): m_axis = 因果校正流, 样点序号
//   >= corr_start (= plat_end_idx+40, 拍域确定) 起旋转 e^{-j·θ(n)}, 之前样点
//   θ=0 过同一流水 (≈恒等±量化); 相对 s_axis 固定延迟 P_DLY=384 拍;
//   o_fft_start 与 m_axis 上 T1 首样点同拍; o_sync_locked 保持到复位 (单突发);
//   无反压契约 (m_axis_tready 被忽略, 稳态须为高)。
// 数值链 (与 generate_vectors.m 位真镜像逐字一致): n_peak = start +
//   (end-start)>>1; 平顶最短 P_MINPLAT=64; CORDIC 输入 S_cfo>>>18; θ_inc =
//   -(φ<<4) Q3.21 累加±π回绕取 (acc+128)>>>8; K 预缩放 (x·9949+8192)>>>14;
//   输出 sat16; 精定时/T2 防错锁见 sync_track_out。复位: 同步高有效 (§1.1)
//==============================================================================
module sync_top #(
    parameter int DATA_W = 16
)(
    input  logic                i_clk,
    input  logic                i_rst,          // 同步复位, 高有效
    // AXI-S slave (输入样点)
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,
    // AXI-S master (CFO 校正流, 延迟 P_DLY 拍)
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,  // 忽略 (ADR-003 无反压契约)
    output logic [DATA_W*2-1:0] m_axis_tdata,
    // 同步指示
    output logic                o_fft_start,
    output logic                o_sync_locked
);

    localparam int P_IDXW = 32;
    localparam int P_DLY  = 384;                // 对齐延迟线深度 (< 512)
    localparam int P_WIN  = 256;                // 精定时搜索窗宽
    localparam int P_EST_GAP = 40;              // plat_end -> corr_start 拍距
    localparam int P_MINPLAT = 64;              // 平顶最短长度 (拒斜坡瞬态假平顶)
    localparam logic signed [23:0] P_PI_Q21  = 24'sd6588416;   // pi·2^21
    localparam logic signed [24:0] P_2PI_Q21 = 25'sd13176832;  // 2pi·2^21

    //==========================================================================
    // s_axis: 恒 ready + ri_ 输入寄存 (红线 1)
    //==========================================================================
    logic ro_tready;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_tready <= 1'b0;
        else       ro_tready <= 1'b1;
    end

    assign s_axis_tready = ro_tready;

    logic                     ri_v;
    logic signed [DATA_W-1:0] ri_di, ri_dq;
    logic [P_IDXW-1:0]        r_in_idx;         // 当前 ri_ 样点序号 (首样点 0)
    logic                     r_in_v1;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_v     <= 1'b0;
            r_in_v1  <= 1'b0;
            r_in_idx <= '0;
        end else begin
            ri_v <= s_axis_tvalid && ro_tready;
            if (s_axis_tvalid && ro_tready) begin
                r_in_v1 <= 1'b1;
                if (r_in_v1) r_in_idx <= r_in_idx + 1'b1;
            end
        end
    end

    always_ff @(posedge i_clk) begin
        if (s_axis_tvalid && ro_tready) begin
            ri_di <= $signed(s_axis_tdata[DATA_W-1:0]);
            ri_dq <= $signed(s_axis_tdata[DATA_W*2-1:DATA_W]);
        end
    end

    //==========================================================================
    // 包检测 + S_cfo
    //==========================================================================
    logic                w_run_hit, w_plat_end;
    logic [P_IDXW-1:0]   w_start_idx, w_end_idx;
    logic signed [41:0]  w_scfo_re, w_scfo_im;

    sync_detect #(
        .DATA_W (DATA_W),
        .P_IDXW (P_IDXW)
    ) u_detect (
        .i_clk            (i_clk),
        .i_rst            (i_rst),
        .i_beat           (ri_v),
        .i_di             (ri_di),
        .i_dq             (ri_dq),
        .o_run_hit        (w_run_hit),
        .o_plat_end       (w_plat_end),
        .o_plat_start_idx (w_start_idx),
        .o_plat_end_idx   (w_end_idx),
        .o_scfo_re        (w_scfo_re),
        .o_scfo_im        (w_scfo_im)
    );

    //==========================================================================
    // 同步 FSM (三段式, 红线 4)
    //==========================================================================
    typedef enum logic [2:0] {P_IDLE, P_PLAT, P_ASTART, P_AWAIT, P_SEARCH,
                              P_T2RD, P_T2CMP, P_TRACK} state_t;
    state_t r_state, w_state_nxt;

    logic [P_IDXW-1:0]  r_n_peak, r_corr_start;
    logic signed [15:0] r_cpe;
    logic signed [23:0] r_tinc;

    logic               w_cd_done;
    logic signed [21:0] w_cd_ox, w_cd_oy;       // 向量模式只取角, xy 不用
    logic signed [15:0] w_cd_oz;
    logic               w_cd_busy;
    logic               w_search_done;

    // 平顶接受判据 >= P_MINPLAT: 爬升段瞬态假平顶拒绝并重新武装 (镜像同式)
    logic w_plat_ok;
    assign w_plat_ok = (w_end_idx - w_start_idx) >= P_IDXW'(P_MINPLAT);

    always_comb begin
        w_state_nxt = r_state;
        case (r_state)
            P_IDLE:   if (w_run_hit)     w_state_nxt = P_PLAT;
            P_PLAT:   if (w_plat_end)    w_state_nxt = w_plat_ok ? P_ASTART
                                                                 : P_IDLE;
            P_ASTART:                    w_state_nxt = P_AWAIT;
            P_AWAIT:  if (w_cd_done)     w_state_nxt = P_SEARCH;
            P_SEARCH: if (w_search_done) w_state_nxt = P_T2RD;
            P_T2RD:                      w_state_nxt = P_T2CMP;
            P_T2CMP:                     w_state_nxt = P_TRACK;
            P_TRACK:                     w_state_nxt = P_TRACK;
            default:                     w_state_nxt = P_IDLE;
        endcase
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) r_state <= P_IDLE;
        else       r_state <= w_state_nxt;
    end

    // 事件锁存 (数据通路, 由 FSM 定拍; 仅接受合格平顶)
    always_ff @(posedge i_clk) begin
        if (w_plat_end && w_plat_ok) begin
            r_n_peak     <= w_start_idx + ((w_end_idx - w_start_idx) >> 1);
            r_corr_start <= w_end_idx + P_IDXW'(P_EST_GAP);
        end
        if (r_state == P_AWAIT && w_cd_done) begin
            r_cpe  <= w_cd_oz;
            r_tinc <= -(24'(w_cd_oz) <<< 4);     // θ_inc = -(φ<<4), Q3.21
        end
    end

    cordic_cv #(
        .P_XY_W (22),
        .P_A_W  (16),
        .P_ITER (14)
    ) u_cordic (
        .i_clk   (i_clk),
        .i_rst   (i_rst),
        .i_start (r_state == P_ASTART),
        .i_mode  (1'b0),                         // 向量模式: 求 S_cfo 相角
        .i_x     (22'(w_scfo_re >>> 18)),
        .i_y     (22'(w_scfo_im >>> 18)),
        .i_z     (16'sd0),
        .o_busy  (w_cd_busy),
        .o_done  (w_cd_done),
        .o_x     (w_cd_ox),
        .o_y     (w_cd_oy),
        .o_z     (w_cd_oz)
    );

    //==========================================================================
    // NCO 相位累加 (θ 与样点按序号对齐, 校正自 corr_start 起)
    //==========================================================================
    logic               w_corr_on;
    logic signed [23:0] r_acc;
    logic signed [15:0] r_theta_d;              // 与 K 缩放级对齐 (滞后 1 拍)

    // 校正使能覆盖 SEARCH 后所有态 (T2RD/T2CMP 两拍空窗会致 θ 归零 +
    // 累加器暂停, cosim 逐位比对实测抓出)
    assign w_corr_on = (r_state == P_SEARCH || r_state == P_T2RD ||
                        r_state == P_T2CMP || r_state == P_TRACK) &&
                       (r_in_idx >= r_corr_start);

    logic signed [24:0] w_acc_sum, w_acc_nxt;    // 次态相位: 累加 + ±π 回绕

    always_comb begin
        w_acc_sum = 25'(r_acc) + 25'(r_tinc);
        if      (w_acc_sum >  25'(P_PI_Q21)) w_acc_nxt = w_acc_sum - P_2PI_Q21;
        else if (w_acc_sum < -25'(P_PI_Q21)) w_acc_nxt = w_acc_sum + P_2PI_Q21;
        else                                 w_acc_nxt = w_acc_sum;
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_acc     <= '0;
            r_theta_d <= '0;
        end else if (ri_v) begin
            if (w_corr_on) begin
                r_theta_d <= 16'((r_acc + 24'sd128) >>> 8);   // 本样点 θ (Q3.13)
                r_acc     <= 24'(w_acc_nxt);
            end else begin
                r_theta_d <= '0;
            end
        end
    end

    //==========================================================================
    // K 预缩放 (1/A 增益补偿) + 流水线旋转
    //==========================================================================
    logic signed [DATA_W-1:0] r_k_di, r_k_dq;
    logic                     r_k_v;

    always_ff @(posedge i_clk) begin
        if (i_rst)     r_k_v <= 1'b0;
        else if (ri_v) r_k_v <= 1'b1;
    end

    always_ff @(posedge i_clk) begin
        if (ri_v) begin
            r_k_di <= 16'((32'(ri_di) * 32'sd9949 + 32'sd8192) >>> 14);
            r_k_dq <= 16'((32'(ri_dq) * 32'sd9949 + 32'sd8192) >>> 14);
        end
    end

    logic               w_rot_v;
    logic signed [19:0] w_rot_x, w_rot_y;

    cordic_rot_pipe #(
        .P_XY_W (20),
        .P_A_W  (16),
        .P_ITER (14)
    ) u_rot (
        .i_clk   (i_clk),
        .i_rst   (i_rst),
        .i_ce    (ri_v),
        .i_valid (r_k_v),
        .i_x     (20'(r_k_di)),
        .i_y     (20'(r_k_dq)),
        .i_phase (r_theta_d),
        .o_valid (w_rot_v),
        .o_x     (w_rot_x),
        .o_y     (w_rot_y)
    );

    // 饱和到 Q2.14 s16
    logic signed [DATA_W-1:0] w_c_di, w_c_dq;

    always_comb begin
        if      (w_rot_x > 20'sd32767)  w_c_di = 16'sd32767;
        else if (w_rot_x < -20'sd32768) w_c_di = -16'sd32768;
        else                            w_c_di = 16'(w_rot_x);
        if      (w_rot_y > 20'sd32767)  w_c_dq = 16'sd32767;
        else if (w_rot_y < -20'sd32768) w_c_dq = -16'sd32768;
        else                            w_c_dq = 16'(w_rot_y);
    end

    logic w_rot_beat;
    assign w_rot_beat = ri_v && w_rot_v;        // 校正流有效拍

    logic [P_IDXW-1:0] r_rot_idx;               // 当前校正流样点序号

    always_ff @(posedge i_clk) begin
        if (i_rst)           r_rot_idx <= '0;
        else if (w_rot_beat) r_rot_idx <= r_rot_idx + 1'b1;
    end

    //==========================================================================
    // 精定时 + T2 防错锁 + 对齐输出 (G-A-04 拆分子模块, 内含 sync_correlator)
    //==========================================================================
    sync_track_out #(
        .DATA_W (DATA_W),
        .P_IDXW (P_IDXW),
        .P_DLY  (P_DLY),
        .P_WIN  (P_WIN)
    ) u_track (
        .i_clk         (i_clk),
        .i_rst         (i_rst),
        .i_search      (r_state == P_SEARCH),
        .i_t2rd        (r_state == P_T2RD),
        .i_t2cmp       (r_state == P_T2CMP),
        .i_track       (r_state == P_TRACK),
        .i_n_peak      (r_n_peak),
        .o_search_done (w_search_done),
        .i_beat        (w_rot_beat),
        .i_di          (w_c_di),
        .i_dq          (w_c_dq),
        .i_idx         (r_rot_idx),
        .m_axis_tvalid (m_axis_tvalid),
        .m_axis_tdata  (m_axis_tdata),
        .o_fft_start   (o_fft_start),
        .o_sync_locked (o_sync_locked)
    );

endmodule : sync_top
