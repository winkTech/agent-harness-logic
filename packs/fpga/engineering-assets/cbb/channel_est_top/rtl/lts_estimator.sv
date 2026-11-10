//==============================================================================
// lts_estimator — 长训练符号 LS 信道估计 (ADR-002 估计基础)
// 功能: 对 2 个 LTS 符号做全用载波 LS: H_LTS[k] = ((X_lts[k]*Y1[k]) +
//       (X_lts[k]*Y2[k]) + 1) >>> 1  (X_lts ∈ {±1,0}, 除法退化为符号翻转,
//       平均带 +1 舍入); 保护带/DC 子载波恒置 +1.0 (Q2.14 = 16384)。
//       结果存 64×36 双口 RAM (18b I / 18b Q 字段), 并在写入时旁路捕获
//       4 个导频位置 {11,25,39,53} 的 H 值供 CPE 跟踪使用。
// 端口: i_clk/i_rst (同步复位, 高有效); i_beat/i_sub/i_di/i_dq (顶层 ri_ 级
//       之后的已寄存样点流); i_ph_lts1/i_ph_lts2 (本拍所属符号相位);
//       i_rd_ce/i_rd_addr -> o_rd_di/o_rd_dq (输出级读口, 1 拍延迟);
//       o_pilot_h_i/o_pilot_h_q (导频位 H_LTS 寄存)
// 主要逻辑: 符号翻转级 (r_a_) -> LTS1 直写 / LTS2 读-改-写平均 -> RAM;
//           读口在 LTS2 期间被 RMW 借用 (顶层保证输出级此时空闲, 无冲突)
// 复位: 同步高有效, 仅控制链复位; RAM 与数据寄存不复位
//   // [复位豁免] ro_rd_raw 为 RAM 读数据寄存器, 加复位会阻断 BRAM/LUTRAM 输出
//   //            寄存器吸收 (UG949 Know What You Infer, SKILL §10.2)
//
// 定点约定 (与 generate_vectors.m 位真镜像逐字一致):
//   Y: Q2.14 s16; H_LTS = floor((s*Y1 + s*Y2 + 1)/2) (算术右移 1, 向 +inf 半舍入)
//==============================================================================
module lts_estimator #(
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
    input  logic                     i_ph_lts1,    // 本拍属于 LTS1 符号
    input  logic                     i_ph_lts2,    // 本拍属于 LTS2 符号

    // H_LTS RAM 读口 (输出级用, 1 拍延迟; LTS2 期间被内部 RMW 借用)
    input  logic                     i_rd_ce,
    input  logic [P_IDX_W-1:0]       i_rd_addr,
    output logic signed [DATA_W-1:0] o_rd_di,
    output logic signed [DATA_W-1:0] o_rd_dq,

    // 导频位 H_LTS (帧内常量, LTS2 写入时旁路捕获)
    output logic [3:0][DATA_W-1:0]   o_pilot_h_i,
    output logic [3:0][DATA_W-1:0]   o_pilot_h_q
);

    localparam int P_PILOT_POS [4] = '{11, 25, 39, 53};
    localparam logic signed [DATA_W-1:0] P_ONE_Q14 = 16'sd16384; // +1.0 Q2.14
    localparam int P_F_W = DATA_W + 2;  // RAM 字段位宽 (18b, 容纳 LTS1 原值+和)

    //==========================================================================
    // 802.11a LTS 频域序列符号表 (algorithm_spec §2.2 / lts_seq.m)
    // 子载波 -26..26 -> 0-based k = 列表序号 + 6; DC (k=32) = 0
    //==========================================================================
    localparam int P_LTS_SEQ [0:52] = '{
         1, 1,-1,-1, 1, 1,-1, 1,-1, 1, 1, 1, 1, 1, 1,-1,-1, 1, 1,-1, 1,-1, 1, 1, 1, 1,
         0,
         1,-1,-1, 1, 1,-1, 1,-1, 1,-1,-1,-1,-1,-1, 1, 1,-1,-1, 1,-1, 1,-1, 1, 1, 1, 1
    };

    function automatic logic [N_FFT-1:0] f_neg_mask();
        logic [N_FFT-1:0] m;
        m = '0;
        for (int i = 0; i < 53; i++) begin
            if (P_LTS_SEQ[i] < 0) m[i+6] = 1'b1;
        end
        return m;
    endfunction

    localparam logic [N_FFT-1:0] P_NEG_MASK = f_neg_mask();

    // 保护带 (k<6, k>58) 与 DC (k=32) -> 恒 +1.0
    logic w_zero, w_neg;
    assign w_zero = (i_sub < P_IDX_W'(6)) || (i_sub > P_IDX_W'(58)) ||
                    (i_sub == P_IDX_W'(32));
    assign w_neg  = P_NEG_MASK[i_sub];

    //==========================================================================
    // 符号翻转级 (本模块输入寄存级, 红线 1)
    //==========================================================================
    logic                       r_a_valid;
    logic                       r_a_lts2;
    logic                       r_a_zero;
    logic [P_IDX_W-1:0]         r_a_addr;
    logic signed [DATA_W-1:0]   r_a_di, r_a_dq;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_a_valid <= 1'b0;
            r_a_lts2  <= 1'b0;
        end else begin
            r_a_valid <= i_beat && (i_ph_lts1 || i_ph_lts2);
            r_a_lts2  <= i_ph_lts2;
        end
    end

    // 数据通路寄存 (不复位 §1.1, 由 r_a_valid 屏蔽)
    always_ff @(posedge i_clk) begin
        r_a_addr <= i_sub;
        r_a_zero <= w_zero;
        r_a_di   <= w_zero ? P_ONE_Q14 : (w_neg ? -i_di : i_di);
        r_a_dq   <= w_zero ? '0        : (w_neg ? -i_dq : i_dq);
    end

    //==========================================================================
    // H_LTS RAM: 64 × 36 (双 18b 字段), 1W1R 简单双口
    //==========================================================================
    logic [2*P_F_W-1:0] r_mem [0:N_FFT-1];

    // 写数据: LTS1 直写符号翻转值; LTS2 读-改-写平均 (RMW 读见下方读口)
    logic signed [P_F_W-1:0] w_sum_i, w_sum_q;    // 17b 和 (18b 声明)
    logic signed [P_F_W-1:0] w_avg_i, w_avg_q;
    logic signed [P_F_W-1:0] w_rmw_di, w_rmw_dq;
    logic signed [P_F_W-1:0] w_wr_fi, w_wr_fq;    // 最终写入字段

    logic [2*P_F_W-1:0]      ro_rd_raw;            // 共享读数据寄存器 (RMW/输出级)

    assign w_rmw_di = $signed(ro_rd_raw[P_F_W-1:0]);
    assign w_rmw_dq = $signed(ro_rd_raw[2*P_F_W-1:P_F_W]);

    assign w_sum_i = w_rmw_di + P_F_W'(r_a_di) + P_F_W'(1);
    assign w_sum_q = w_rmw_dq + P_F_W'(r_a_dq) + P_F_W'(1);
    assign w_avg_i = w_sum_i >>> 1;
    assign w_avg_q = w_sum_q >>> 1;

    always_comb begin
        if (!r_a_lts2) begin
            // LTS1: 直写 (零位写常量已在 r_a_ 级完成)
            w_wr_fi = P_F_W'(r_a_di);
            w_wr_fq = P_F_W'(r_a_dq);
        end else if (r_a_zero) begin
            w_wr_fi = P_F_W'(P_ONE_Q14);
            w_wr_fq = '0;
        end else begin
            w_wr_fi = w_avg_i;
            w_wr_fq = w_avg_q;
        end
    end

    always_ff @(posedge i_clk) begin
        if (r_a_valid) r_mem[r_a_addr] <= {w_wr_fq, w_wr_fi};
    end

    //==========================================================================
    // 读口: LTS2 期间借给 RMW (addr = i_sub, 与写错开 1 拍, 地址不同无冲突);
    //       其余时间由输出级驱动。顶层保证两者不同时活跃。
    //==========================================================================
    logic               w_rmw_rd;
    logic [P_IDX_W-1:0] w_rd_addr_mux;
    logic               w_rd_en_mux;

    assign w_rmw_rd      = i_beat && i_ph_lts2;
    assign w_rd_addr_mux = w_rmw_rd ? i_sub : i_rd_addr;
    assign w_rd_en_mux   = w_rmw_rd || i_rd_ce;

    // [复位豁免] RAM 读数据寄存器不复位 (SKILL §10.2)
    always_ff @(posedge i_clk) begin
        if (w_rd_en_mux) ro_rd_raw <= r_mem[w_rd_addr_mux];
    end

    assign o_rd_di = ro_rd_raw[DATA_W-1:0];
    assign o_rd_dq = ro_rd_raw[P_F_W +: DATA_W];

    //==========================================================================
    // 导频位 H_LTS 旁路捕获 (LTS2 写入拍)
    //==========================================================================
    logic [3:0][DATA_W-1:0] ro_pilot_h_i, ro_pilot_h_q;

    always_ff @(posedge i_clk) begin
        if (r_a_valid && r_a_lts2) begin
            for (int p = 0; p < 4; p++) begin
                if (r_a_addr == P_IDX_W'(P_PILOT_POS[p])) begin
                    ro_pilot_h_i[p] <= w_wr_fi[DATA_W-1:0];
                    ro_pilot_h_q[p] <= w_wr_fq[DATA_W-1:0];
                end
            end
        end
    end

    assign o_pilot_h_i = ro_pilot_h_i;
    assign o_pilot_h_q = ro_pilot_h_q;

endmodule : lts_estimator
