//==============================================================================
// cpe_tracker — 导频公共相位跟踪 (ADR-002)
// 功能: 对每个数据符号:
//       (1) 导频拍即乘即累加 S = Σ_p Y[p]·conj(H_LTS[p])·pilot[p]
//           (pilot = [1,1,1,-1] @ {11,25,39,53} = 子载波 {-21,-7,+7,+21},
//            取负的是 +21 —— 802.11a 的 P 序列; 2026-08-09 由 [1,1,-1,1] 订正);
//       (2) 符号尾: CORDIC 向量模式求 CPE = angle(S), 旋转模式求
//           (cos,sin) = e^{j·CPE} (Q2.14);
//       (3) 校正输出交给子模块 cpe_rotate_out (逐点读 H_LTS RAM 复乘
//           e^{j·CPE}, round+饱和, 64 拍 AXIS 输出, 反压整级冻结)。
// 端口: i_clk/i_rst (同步复位, 高有效); 已寄存样点流 (顶层 ri_ 级后);
//       i_pilot_h_* (lts_estimator 导频位 H); RAM 读口; m_axis; 状态输出
// 主要逻辑: 3 级导频积流水 -> S 累加 -> 计算 FSM (VEC->ROT->PEND)
//           -> cpe_rotate_out (P_PEND 交接 (c,s), o_take 寄存回执)
// 延迟: 数据符号末拍到该符号 H 输出完成约 110 拍 (< 1 OFDM 符号 = 400 拍@100M)
// 复位: 同步高有效, 仅控制链复位; 乘法器/数据流水不复位
//   // [复位豁免] r_m_* 为 DSP 流水寄存器, 加复位阻断 MREG/PREG 吸收
//   //            (UG949 Know What You Infer, SKILL §10.2)
//
// 定点约定 (与 generate_vectors.m 位真镜像逐字一致):
//   t_re =  Yr·Hr + Yi·Hq;  t_im = Yq·Hr - Yr·Hq   (即 Y·conj(H))
//   S: s36 累加; CORDIC 输入 = S >>> 14 (截取 [35:14], 22b)
//==============================================================================
module cpe_tracker #(
    parameter int N_FFT   = 64,
    parameter int DATA_W  = 16,
    parameter int P_IDX_W = 6           // = $clog2(N_FFT), 派生参数勿改
)(
    input  logic                     i_clk,
    input  logic                     i_rst,        // 同步复位, 高有效

    // 已寄存样点流 (顶层 ri_ 级之后)
    input  logic                     i_beat,
    input  logic [P_IDX_W-1:0]       i_sub,
    input  logic signed [DATA_W-1:0] i_di,
    input  logic signed [DATA_W-1:0] i_dq,
    input  logic                     i_ph_data,    // 本拍属于数据符号
    input  logic                     i_abort,      // 帧重启: 清在途符号状态

    // 导频位 H_LTS (lts_estimator, 帧内常量)
    input  logic [3:0][DATA_W-1:0]   i_pilot_h_i,
    input  logic [3:0][DATA_W-1:0]   i_pilot_h_q,

    // H_LTS RAM 读口 (1 拍延迟)。o_rd_active 为寄存的输出级活跃标志;
    // 顶层必须做 i_rd_ce = o_rd_active && (!m_axis_tvalid || m_axis_tready)
    // 与推进使能同门控, 否则冻结期间 RAM 读寄存器会覆盖在途数据
    output logic                     o_rd_active,
    output logic [P_IDX_W-1:0]       o_rd_addr,
    input  logic signed [DATA_W-1:0] i_rd_di,
    input  logic signed [DATA_W-1:0] i_rd_dq,

    // AXI4-Stream master (H(m) 到均衡器)
    output logic                     m_axis_tvalid,
    input  logic                     m_axis_tready,
    output logic [DATA_W*2-1:0]      m_axis_tdata,

    // 状态 (顶层节流用)
    output logic                     o_calc_busy,  // S/CORDIC/(c,s) 在途
    output logic                     o_out_busy    // 输出级活跃
);

    localparam int P_PILOT_POS [4] = '{11, 25, 39, 53};
    localparam int P_S_W  = 36;                    // S 累加位宽
    localparam int P_XY_W = 22;                    // CORDIC xy 位宽
    localparam int P_CS_W = 18;                    // cos/sin 位宽 (≈±16384)
    // CORDIC 旋转启动值 K*2^14 = round(2^14/1.6467602540) (增益预补偿)
    localparam logic signed [P_XY_W-1:0] P_K_Q14 = 22'sd9949;

    //==========================================================================
    // 导频积流水 — 级 1: 命中检测 + 操作数寄存 (本模块输入寄存级, 红线 1)
    //==========================================================================
    logic       w_p_hit;
    logic [1:0] w_p_sel;
    logic       w_p_neg;

    always_comb begin
        w_p_sel = 2'd0;
        case (i_sub)
            P_IDX_W'(P_PILOT_POS[1]): w_p_sel = 2'd1;
            P_IDX_W'(P_PILOT_POS[2]): w_p_sel = 2'd2;
            P_IDX_W'(P_PILOT_POS[3]): w_p_sel = 2'd3;
            default:                  w_p_sel = 2'd0;
        endcase
    end

    assign w_p_hit = i_beat && i_ph_data &&
                     (i_sub inside {P_IDX_W'(P_PILOT_POS[0]), P_IDX_W'(P_PILOT_POS[1]),
                                    P_IDX_W'(P_PILOT_POS[2]), P_IDX_W'(P_PILOT_POS[3])});
    // 负号在 P_PILOT_POS[3] = bin 53 = 子载波 +21 (802.11a 的 P 序列)。1.0.3 由 [2]
    // (bin 39 = +7) 订正 —— 原值与 models/comm/ofdm 及 tx_pilot_map 相反, 串成链路时
    // CPE 四项抵消。由 integration/contracts/chain_pilot_contract.m 实跑把关。
    assign w_p_neg = (i_sub == P_IDX_W'(P_PILOT_POS[3]));   // pilot = [1,1,1,-1]

    logic                     r_p1_v, r_p1_neg;
    logic signed [DATA_W-1:0] r_p1_yi, r_p1_yq, r_p1_hi, r_p1_hq;

    always_ff @(posedge i_clk) begin
        if (i_rst) r_p1_v <= 1'b0;
        else       r_p1_v <= w_p_hit && !i_abort;
    end

    always_ff @(posedge i_clk) begin
        r_p1_neg <= w_p_neg;
        r_p1_yi  <= i_di;
        r_p1_yq  <= i_dq;
        r_p1_hi  <= $signed(i_pilot_h_i[w_p_sel]);
        r_p1_hq  <= $signed(i_pilot_h_q[w_p_sel]);
    end

    //==========================================================================
    // 级 2: 4 实乘 (DSP 流水寄存, 不复位 §10.2)
    //==========================================================================
    logic                         r_p2_v, r_p2_neg;
    logic signed [2*DATA_W-1:0]   r_m_rr, r_m_ii, r_m_ir, r_m_ri;

    always_ff @(posedge i_clk) begin
        if (i_rst) r_p2_v <= 1'b0;
        else       r_p2_v <= r_p1_v;
    end

    always_ff @(posedge i_clk) begin
        r_p2_neg <= r_p1_neg;
        r_m_rr   <= r_p1_yi * r_p1_hi;
        r_m_ii   <= r_p1_yq * r_p1_hq;
        r_m_ir   <= r_p1_yq * r_p1_hi;
        r_m_ri   <= r_p1_yi * r_p1_hq;
    end

    //==========================================================================
    // 级 3: Y·conj(H)·pilot 累加 S (控制关键, 同步复位)
    //==========================================================================
    logic signed [P_S_W-1:0] r_s_re, r_s_im;
    logic signed [2*DATA_W:0] w_t_re, w_t_im;     // s33

    assign w_t_re = r_m_rr + r_m_ii;
    assign w_t_im = r_m_ir - r_m_ri;

    logic w_sym_end;
    logic r_sym_pend;

    assign w_sym_end = i_beat && i_ph_data && (i_sub == P_IDX_W'(N_FFT-1));

    always_ff @(posedge i_clk) begin
        if (i_rst || i_abort) begin
            r_s_re <= '0;
            r_s_im <= '0;
        end else if (w_sym_end) begin
            // 符号尾清零 (S 已由计算 FSM 同拍锁存); 末导频积在 10+ 拍前已落账
            r_s_re <= '0;
            r_s_im <= '0;
        end else if (r_p2_v) begin
            r_s_re <= r_s_re + (r_p2_neg ? -(P_S_W'(w_t_re)) : P_S_W'(w_t_re));
            r_s_im <= r_s_im + (r_p2_neg ? -(P_S_W'(w_t_im)) : P_S_W'(w_t_im));
        end
    end

    //==========================================================================
    // 计算 FSM: 符号尾锁 S -> CORDIC 向量 (CPE) -> 旋转 (cos,sin) -> 待输出级取
    //==========================================================================
    typedef enum logic [2:0] {P_CIDLE, P_VSTART, P_VWAIT, P_RSTART, P_RWAIT, P_PEND}
        calc_t;
    calc_t r_cstate, w_cstate_nxt;

    logic signed [P_S_W-1:0]  r_sl_re, r_sl_im;   // 锁存的 S
    logic signed [15:0]       r_cpe;              // Q3.13
    logic signed [P_CS_W-1:0] r_cs_cos, r_cs_sin;

    logic                      w_cd_start, w_cd_mode;
    logic                      w_cd_busy, w_cd_done;
    logic signed [P_XY_W-1:0]  w_cd_x, w_cd_y, w_cd_ox, w_cd_oy;
    logic signed [15:0]        w_cd_z, w_cd_oz;

    logic w_take;                                 // 输出级已取走 (寄存回执)

    always_ff @(posedge i_clk) begin
        if (i_rst || i_abort)  r_sym_pend <= 1'b0;
        else if (w_sym_end)    r_sym_pend <= 1'b1;
        else if (r_cstate == P_CIDLE && r_sym_pend) r_sym_pend <= 1'b0;
    end

    // 逐符号导频极性 (1.0.4, owner 裁定方案 A): TX 侧按符号序把四个导频整体 ±1 交替,
    // 首个数据符号 +1。本件此前不建模极性, 每隔一个符号 CPE 差 pi —— 与 1.0.3 那次的
    // "导频值放错位置"是**两个独立缺陷**。极性对四个导频相同, 故锁存 S 时整体取负一次
    // 即可 (S 是四项之和, 负 S 与负每一项等价), 比逐个翻转便宜。
    // 标准用 127 长 PRBS 而非交替 (ofdm_tx_top 偏差 L3); 改 PRBS 只需换 r_pol_neg 的
    // 产生式, 其余不动。详见 CHANGELOG 1.0.4 与 docs/limitations.md。
    logic r_pol_neg;                              // 1 = 本符号极性为 -1

    always_ff @(posedge i_clk) begin
        if (i_rst || i_abort) r_pol_neg <= 1'b0;  // 帧内首个数据符号极性 +1
        else if (w_sym_end)   r_pol_neg <= ~r_pol_neg;
    end

    // S 锁存 (数据通路, 不复位; 由 FSM 定拍)
    always_ff @(posedge i_clk) begin
        if (w_sym_end) begin
            r_sl_re <= r_pol_neg ? -r_s_re : r_s_re;
            r_sl_im <= r_pol_neg ? -r_s_im : r_s_im;
        end
    end

    always_comb begin
        w_cstate_nxt = r_cstate;
        case (r_cstate)
            P_CIDLE:  if (r_sym_pend)  w_cstate_nxt = P_VSTART;
            P_VSTART:                  w_cstate_nxt = P_VWAIT;
            P_VWAIT:  if (w_cd_done)   w_cstate_nxt = P_RSTART;
            P_RSTART:                  w_cstate_nxt = P_RWAIT;
            P_RWAIT:  if (w_cd_done)   w_cstate_nxt = P_PEND;
            P_PEND:   if (w_take)      w_cstate_nxt = P_CIDLE;
            default:                   w_cstate_nxt = P_CIDLE;
        endcase
    end

    always_ff @(posedge i_clk) begin
        if (i_rst || i_abort) r_cstate <= P_CIDLE;
        else                  r_cstate <= w_cstate_nxt;
    end

    assign w_cd_start = (r_cstate == P_VSTART) || (r_cstate == P_RSTART);
    assign w_cd_mode  = (r_cstate == P_RSTART);
    assign w_cd_x     = (r_cstate == P_RSTART) ? P_K_Q14
                                               : P_XY_W'(r_sl_re >>> 14);
    assign w_cd_y     = (r_cstate == P_RSTART) ? '0
                                               : P_XY_W'(r_sl_im >>> 14);
    assign w_cd_z     = r_cpe;

    // CORDIC 结果采集 (数据通路, 由 FSM 定拍)
    always_ff @(posedge i_clk) begin
        if (r_cstate == P_VWAIT && w_cd_done) r_cpe <= w_cd_oz;
        if (r_cstate == P_RWAIT && w_cd_done) begin
            r_cs_cos <= w_cd_ox[P_CS_W-1:0];
            r_cs_sin <= w_cd_oy[P_CS_W-1:0];
        end
    end

    cordic_cv #(
        .P_XY_W (P_XY_W),
        .P_A_W  (16),
        .P_ITER (14)
    ) u_cordic (
        .i_clk   (i_clk),
        .i_rst   (i_rst),
        .i_start (w_cd_start),
        .i_mode  (w_cd_mode),
        .i_x     (w_cd_x),
        .i_y     (w_cd_y),
        .i_z     (w_cd_z),
        .o_busy  (w_cd_busy),
        .o_done  (w_cd_done),
        .o_x     (w_cd_ox),
        .o_y     (w_cd_oy),
        .o_z     (w_cd_oz)
    );

    //==========================================================================
    // 校正输出级 (G-A-04 拆分子模块): P_PEND 态交接 (c,s), 寄存回执 w_take
    //==========================================================================
    cpe_rotate_out #(
        .N_FFT   (N_FFT),
        .DATA_W  (DATA_W),
        .P_IDX_W (P_IDX_W),
        .P_CS_W  (P_CS_W)
    ) u_rotate_out (
        .i_clk         (i_clk),
        .i_rst         (i_rst),
        .i_cs_valid    (r_cstate == P_PEND),
        .i_cos         (r_cs_cos),
        .i_sin         (r_cs_sin),
        .o_take        (w_take),
        .o_rd_active   (o_rd_active),
        .o_rd_addr     (o_rd_addr),
        .i_rd_di       (i_rd_di),
        .i_rd_dq       (i_rd_dq),
        .m_axis_tvalid (m_axis_tvalid),
        .m_axis_tready (m_axis_tready),
        .m_axis_tdata  (m_axis_tdata),
        .o_busy        (o_out_busy)
    );

    //==========================================================================
    // 状态输出 (ro_ 寄存, 红线 2)
    //==========================================================================
    logic ro_calc_busy;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_calc_busy <= 1'b0;
        else       ro_calc_busy <= (w_cstate_nxt != P_CIDLE) || r_sym_pend ||
                                   w_sym_end;
    end

    assign o_calc_busy = ro_calc_busy;

endmodule : cpe_tracker
