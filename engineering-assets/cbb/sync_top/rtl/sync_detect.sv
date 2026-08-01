//==============================================================================
// sync_detect — 短前导码流式包检测 + 粗 CFO 相关累加 (ADR-003)
// 功能: 递推滑窗自相关检测 802.11a 短前导码周期性, 输出判决平顶事件与
//       平顶期相关累加和 S_cfo (供 CORDIC 求角 -> 粗 CFO)。
//       C_m = C_{m-1} + p(m) - p_sub(m),  p(m) = r(m)·conj(r(m-16))
//       P_m = P_{m-1} + e(m) - e_sub(m),  e(m) = |r(m-16)|²
//       判决 b(m) = ( 2·|C_m>>>16|² > (P_m>>16)² )   (等价 M>0.5, 免除法)
//       连续 9 拍 b=1 触发 run_hit (平顶始于 idx-8); b 回落触发 plat_end。
//       S_cfo = Σ p(m), 对满足 b(m)=1 且 (已在平顶 或 本拍恰好凑满 9 连) 的 m
//       (即从第 9 个越限样点起累加到平顶末, 前 8 个样点不计)。
// X 安全 / 暖机 (镜像约定, 位真复现):
//       p(m)=e(m)=0  对 m<32 (延迟链未填满段强制清零, X 不入链);
//       减项 p_sub(m)=p(m-16) 仅当 m>=48, 否则 0 (SRL 未填满段不减)。
//       等价: C_m = Σ_{k=max(32, m-15)}^{m} p(k), P 同构。
//       判决满窗门控: b(m)=0 对 m<48 (部分窗口下比值无意义, 防噪声假平顶)。
// 端口: i_clk/i_rst (同步复位, 高有效); i_beat/i_di/i_dq 样点流 (顶层 ri_ 后);
//       o_run_hit/o_plat_end (单时钟脉冲) + 平顶起止样点序号 + S_cfo
// 主要逻辑: 7 级拍域流水 (输入寄存 -> 乘 -> 积 -> 递推累加 -> 缩放 ->
//           平方 -> 判决), 样点序号随流水同步下移
// 复位: 同步高有效, 控制链/累加器复位; 乘法器与移位链不复位 (§1.1/§10.2)
//   // [复位豁免] r_m_*/r_e_*/r_q_* 为 DSP 流水寄存器; sr/sp/se/sd 为 SRL 延迟链
//
// 定点约定 (与 generate_vectors.m 位真镜像逐字一致):
//   r: Q2.14 s16; p: s32; e: u33; C: s38; P: u38
//   cs = C>>>16 (s22), ps = P>>16 (u22); 判决 ((cs_re²+cs_im²)<<1) > ps²
//   S_cfo: s42
//==============================================================================
module sync_detect #(
    parameter int DATA_W = 16,
    parameter int P_LAG  = 16,          // 短前导码周期 = 相关滞后 = 窗长
    parameter int P_RUN  = 9,           // 平顶判定连续越限拍数
    parameter int P_IDXW = 32
)(
    input  logic                      i_clk,
    input  logic                      i_rst,       // 同步复位, 高有效
    input  logic                      i_beat,
    input  logic signed [DATA_W-1:0]  i_di,
    input  logic signed [DATA_W-1:0]  i_dq,

    output logic                      o_run_hit,   // 9 连越限 (单时钟脉冲)
    output logic                      o_plat_end,  // 平顶结束 (单时钟脉冲)
    output logic [P_IDXW-1:0]         o_plat_start_idx,  // run_hit 时有效
    output logic [P_IDXW-1:0]         o_plat_end_idx,    // plat_end 时有效
    output logic signed [41:0]        o_scfo_re,   // plat_end 时有效
    output logic signed [41:0]        o_scfo_im
);

    localparam int P_PW = 2*DATA_W;     // 乘积分量位宽 32
    localparam int P_CW = 38;           // C/P 累加位宽
    localparam int P_SW = 42;           // S_cfo 位宽

    //==========================================================================
    // 级 0: 输入寄存 (红线 1) + 样点序号 + 16 深延迟链
    //==========================================================================
    logic                     r_a_v;
    logic signed [DATA_W-1:0] r_a_di, r_a_dq;
    logic [P_IDXW-1:0]        r_idx;                 // 当前 r_a_ 样点序号

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_a_v <= 1'b0;
            r_idx <= '0;
        end else if (i_beat) begin
            r_a_v <= 1'b1;
            if (r_a_v) r_idx <= r_idx + 1'b1;        // 首样点序号 0
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_a_di <= i_di;
            r_a_dq <= i_dq;
        end
    end

    // r 延迟 16 (SRL, 不复位; m<32 段由 p/e 清零门控隔离)
    logic signed [DATA_W-1:0] sr_di [0:P_LAG-1];
    logic signed [DATA_W-1:0] sr_dq [0:P_LAG-1];

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            sr_di[0] <= r_a_di;
            sr_dq[0] <= r_a_dq;
            for (int i = 1; i < P_LAG; i++) begin
                sr_di[i] <= sr_di[i-1];
                sr_dq[i] <= sr_dq[i-1];
            end
        end
    end

    logic signed [DATA_W-1:0] w_d16_di, w_d16_dq;
    assign w_d16_di = sr_di[P_LAG-1];
    assign w_d16_dq = sr_dq[P_LAG-1];

    // 样点序号随流水下移: r_idx_d[i] = 级 i+1 正在处理的样点序号
    // (控制信号, 必须复位 — 否则 X 经 w_pv/w_sv 三元门灌入递推累加器且永不恢复)
    logic [P_IDXW-1:0] r_idx_d [0:5];

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int i = 0; i < 6; i++) r_idx_d[i] <= '0;
        end else if (i_beat) begin
            r_idx_d[0] <= r_idx;
            for (int i = 1; i < 6; i++) r_idx_d[i] <= r_idx_d[i-1];
        end
    end

    //==========================================================================
    // 级 1: 4 实乘 + 2 能量乘 (DSP 流水寄存, 不复位 §10.2)
    //==========================================================================
    logic signed [P_PW-1:0] r_m_rr, r_m_ii, r_m_ir, r_m_ri;
    logic signed [P_PW-1:0] r_e_a, r_e_b;

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_m_rr <= r_a_di * w_d16_di;
            r_m_ii <= r_a_dq * w_d16_dq;
            r_m_ir <= r_a_dq * w_d16_di;
            r_m_ri <= r_a_di * w_d16_dq;
            r_e_a  <= w_d16_di * w_d16_di;
            r_e_b  <= w_d16_dq * w_d16_dq;
        end
    end

    //==========================================================================
    // 级 2: p(m) / e(m), m<32 强制清零 (X 安全 + 暖机, 见文件头)
    //==========================================================================
    // p/e 求和寄存器带复位: 级 3 累加器与本级同沿, 首拍会消费本级装载前的
    // 旧值 — 不复位则 X 直灌递推累加器 (流水填充竞态)。本级是 fabric 加法器
    // 寄存, 不是 DSP 内部级 (r_m_* 才是), 复位不碍宏吸收 (§10.2)
    logic signed [P_PW-1:0] r_p_re, r_p_im;
    logic        [P_PW:0]   r_e;
    logic                   w_pv;

    assign w_pv = (r_idx_d[0] >= P_IDXW'(32));

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_p_re <= '0;
            r_p_im <= '0;
            r_e    <= '0;
        end else if (i_beat) begin
            r_p_re <= w_pv ? (r_m_rr + r_m_ii) : '0;
            r_p_im <= w_pv ? (r_m_ir - r_m_ri) : '0;
            r_e    <= w_pv ? ((P_PW+1)'(r_e_a) + (P_PW+1)'(r_e_b)) : '0;
        end
    end

    // p/e 延迟 16 (SRL) — 递推减项
    logic signed [P_PW-1:0] sp_re [0:P_LAG-1];
    logic signed [P_PW-1:0] sp_im [0:P_LAG-1];
    logic        [P_PW:0]   se    [0:P_LAG-1];

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            sp_re[0] <= r_p_re;  sp_im[0] <= r_p_im;  se[0] <= r_e;
            for (int i = 1; i < P_LAG; i++) begin
                sp_re[i] <= sp_re[i-1];
                sp_im[i] <= sp_im[i-1];
                se[i]    <= se[i-1];
            end
        end
    end

    // p 再延迟 4 拍对齐判决 b (S_cfo 累加用)
    logic signed [P_PW-1:0] sd_re [0:3];
    logic signed [P_PW-1:0] sd_im [0:3];

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            sd_re[0] <= r_p_re;  sd_im[0] <= r_p_im;
            for (int i = 1; i < 4; i++) begin
                sd_re[i] <= sd_re[i-1];
                sd_im[i] <= sd_im[i-1];
            end
        end
    end

    //==========================================================================
    // 级 3: 递推累加 C / P (控制关键, 复位); 减项 m<48 门控为 0
    //==========================================================================
    logic signed [P_CW-1:0] r_c_re, r_c_im;
    logic        [P_CW-1:0] r_pw;
    logic                   w_sv;

    assign w_sv = (r_idx_d[1] >= P_IDXW'(48));

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_c_re <= '0;  r_c_im <= '0;  r_pw <= '0;
        end else if (i_beat) begin
            r_c_re <= r_c_re + P_CW'(r_p_re) - (w_sv ? P_CW'(sp_re[P_LAG-1]) : '0);
            r_c_im <= r_c_im + P_CW'(r_p_im) - (w_sv ? P_CW'(sp_im[P_LAG-1]) : '0);
            r_pw   <= r_pw   + P_CW'(r_e)    - (w_sv ? P_CW'(se[P_LAG-1])    : '0);
        end
    end

    //==========================================================================
    // 级 4: 缩放; 级 5: 平方; 级 6: 判决 b
    //==========================================================================
    logic signed [21:0] r_cs_re, r_cs_im;
    logic        [21:0] r_ps;

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_cs_re <= 22'(r_c_re >>> 16);
            r_cs_im <= 22'(r_c_im >>> 16);
            r_ps    <= 22'(r_pw >> 16);
        end
    end

    logic signed [43:0] r_q_rr, r_q_ii;
    logic        [43:0] r_q_pp;

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            r_q_rr <= r_cs_re * r_cs_re;
            r_q_ii <= r_cs_im * r_cs_im;
            r_q_pp <= r_ps * r_ps;
        end
    end

    logic r_b;

    // 满窗门控: m<48 时递推窗口未满 (p 自 32 起、减项自 48 起), 部分窗口下
    // 噪声区单项主导的比值会随机越限造成假平顶 — 判决仅在满窗后有效
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_b <= 1'b0;
        end else if (i_beat) begin
            r_b <= (r_idx_d[4] >= P_IDXW'(48)) &&
                   ((45'(unsigned'(r_q_rr) + unsigned'(r_q_ii)) << 1) >
                    45'(r_q_pp));
        end
    end

    //==========================================================================
    // 平顶状态机 + S_cfo 累加 (b 拍域; 脉冲输出为单时钟宽)
    //==========================================================================
    logic [3:0]             r_run;
    logic                   r_inplat;
    logic signed [P_SW-1:0] ro_s_re, ro_s_im;
    logic [P_IDXW-1:0]      ro_start_idx, ro_end_idx;
    logic                   ro_run_hit, ro_plat_end;

    logic w_hit, w_fall;
    assign w_hit  = r_b && !r_inplat && (r_run == 4'(P_RUN-1));
    assign w_fall = r_inplat && !r_b;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_run    <= '0;
            r_inplat <= 1'b0;
            ro_s_re  <= '0;
            ro_s_im  <= '0;
        end else if (i_beat) begin
            if (r_b) begin
                if (r_run != 4'(P_RUN-1)) r_run <= r_run + 1'b1;
            end else begin
                r_run <= '0;
            end

            if (w_hit) begin
                r_inplat     <= 1'b1;
                ro_start_idx <= r_idx_d[5] - P_IDXW'(P_RUN-1);
                ro_s_re      <= P_SW'(sd_re[3]);      // 首项 = 第 9 个越限样点
                ro_s_im      <= P_SW'(sd_im[3]);
            end else if (r_inplat && r_b) begin
                ro_s_re <= ro_s_re + P_SW'(sd_re[3]);
                ro_s_im <= ro_s_im + P_SW'(sd_im[3]);
            end else if (w_fall) begin
                r_inplat   <= 1'b0;
                ro_end_idx <= r_idx_d[5];             // 首个回落样点序号
            end
        end
    end

    // 事件脉冲: 严格单时钟宽 (不随拍间隙拉长)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_run_hit  <= 1'b0;
            ro_plat_end <= 1'b0;
        end else begin
            ro_run_hit  <= i_beat && w_hit;
            ro_plat_end <= i_beat && w_fall;
        end
    end

    assign o_run_hit        = ro_run_hit;
    assign o_plat_end       = ro_plat_end;
    assign o_plat_start_idx = ro_start_idx;
    assign o_plat_end_idx   = ro_end_idx;
    assign o_scfo_re        = ro_s_re;
    assign o_scfo_im        = ro_s_im;

endmodule : sync_detect
