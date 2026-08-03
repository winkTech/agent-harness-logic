//==============================================================================
// cpe_rotate_out — CPE 校正输出级 (cpe_tracker 子模块, G-A-04 拆分)
// 功能: 从 cpe_tracker 计算 FSM 接收 (cos,sin) = e^{j·CPE} (Q2.14 快照),
//       逐点读 H_LTS RAM, 复乘 e^{j·CPE}, round+饱和为 Q2.14, 64 拍 AXIS
//       输出; 支持反压 (统一使能 w_oce 整级冻结, 不丢不重)。
// 端口: i_clk/i_rst (同步复位, 高有效);
//       i_cs_valid/i_cos/i_sin -> o_take: (c,s) 交接握手 — o_take 为寄存脉冲
//         (滞后取走拍 1 拍), 期间 ro_rd_ce 已置位, 结构上不可能重复取走;
//       o_rd_active/o_rd_addr/i_rd_*: H_LTS RAM 读口 (顶层做
//         i_rd_ce = o_rd_active && (!m_axis_tvalid || m_axis_tready) 门控);
//       m_axis; o_busy (输出级活跃, 含取走过渡拍)
// 主要逻辑: 4 级流水 addr -> RAM 读 -> 复乘 -> round/sat -> AXIS reg
// 复位: 同步高有效, 仅控制链复位; 乘法器/数据流水不复位
//   // [复位豁免] r_om* 为 DSP 流水寄存器, 加复位阻断 MREG/PREG 吸收
//   //            (UG949 Know What You Infer, SKILL §10.2)
//
// 定点约定 (与 generate_vectors.m 位真镜像逐字一致):
//   输出 = sat16( floor( (Hr·c - Hq·s + 8192) / 2^14 ) ) (+j 同理 Hr·s + Hq·c)
//==============================================================================
module cpe_rotate_out #(
    parameter int N_FFT   = 64,
    parameter int DATA_W  = 16,
    parameter int P_IDX_W = 6,          // = $clog2(N_FFT), 派生参数勿改
    parameter int P_CS_W  = 18          // cos/sin 位宽 (≈±16384)
)(
    input  logic                     i_clk,
    input  logic                     i_rst,        // 同步复位, 高有效

    // (c,s) 交接 (cpe_tracker 计算 FSM P_PEND 态)
    input  logic                     i_cs_valid,
    input  logic signed [P_CS_W-1:0] i_cos,
    input  logic signed [P_CS_W-1:0] i_sin,
    output logic                     o_take,       // 已取走 (寄存脉冲)

    // H_LTS RAM 读口 (1 拍延迟; 读使能门控在顶层, 见文件头)
    output logic                     o_rd_active,
    output logic [P_IDX_W-1:0]       o_rd_addr,
    input  logic signed [DATA_W-1:0] i_rd_di,
    input  logic signed [DATA_W-1:0] i_rd_dq,

    // AXI4-Stream master (H(m) 到均衡器)
    output logic                     m_axis_tvalid,
    input  logic                     m_axis_tready,
    output logic [DATA_W*2-1:0]      m_axis_tdata,

    output logic                     o_busy        // 输出级活跃
);

    logic                     ro_tvalid;
    logic [DATA_W*2-1:0]      ro_tdata;
    logic                     w_oce;
    logic                     ro_rd_ce;           // = 输出级活跃 (寄存, 红线 2)
    logic [P_IDX_W-1:0]       ro_rd_addr;
    logic                     r_ov1, r_ov2, r_ov3;
    logic signed [P_CS_W-1:0] r_oc, r_os;         // 本符号的 cos/sin 快照 (ri_ 级)
    logic                     w_out_take;

    assign w_oce = !ro_tvalid || m_axis_tready;

    // 取走条件: (c,s) 就绪且流水已排空 (r_oc/r_os 为共享操作数,
    // 在途级必须用旧值算完)。取走后 ro_rd_ce=1 即刻封锁再次取走。
    assign w_out_take = i_cs_valid && !ro_rd_ce &&
                        !r_ov1 && !r_ov2 && !r_ov3;

    // 活跃标志与地址计数 (纯寄存输出; 读使能门控在顶层完成)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_rd_ce   <= 1'b0;
            ro_rd_addr <= '0;
        end else if (w_out_take) begin
            ro_rd_ce   <= 1'b1;
            ro_rd_addr <= '0;
        end else if (ro_rd_ce && w_oce) begin
            if (ro_rd_addr == P_IDX_W'(N_FFT-1)) ro_rd_ce <= 1'b0;
            ro_rd_addr <= ro_rd_addr + 1'b1;
        end
    end

    // (c,s) 快照 = 本模块输入寄存级 (红线 1), 由 w_out_take 定拍
    always_ff @(posedge i_clk) begin
        if (w_out_take) begin
            r_oc <= i_cos;
            r_os <= i_sin;
        end
    end

    // 取走回执 (寄存, 红线 2): 滞后 1 拍, cpe_tracker FSM 由此离开 P_PEND
    logic ro_take;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_take <= 1'b0;
        else       ro_take <= w_out_take;
    end

    assign o_take      = ro_take;
    assign o_rd_active = ro_rd_ce;
    assign o_rd_addr   = ro_rd_addr;

    // valid 链 (控制, 复位)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_ov1 <= 1'b0;
            r_ov2 <= 1'b0;
            r_ov3 <= 1'b0;
        end else if (w_oce) begin
            r_ov1 <= ro_rd_ce;
            r_ov2 <= r_ov1;
            r_ov3 <= r_ov2;
        end
    end

    // 复乘 (DSP 流水寄存, 不复位 §10.2): H·(c+js)
    logic signed [DATA_W+P_CS_W-1:0] r_om1, r_om2, r_om3, r_om4;   // s34

    always_ff @(posedge i_clk) begin
        if (w_oce && r_ov1) begin
            r_om1 <= i_rd_di * r_oc;
            r_om2 <= i_rd_dq * r_os;
            r_om3 <= i_rd_di * r_os;
            r_om4 <= i_rd_dq * r_oc;
        end
    end

    // round + 饱和 (数据通路, 不复位, 由 r_ov3 定拍屏蔽)
    logic signed [DATA_W+P_CS_W:0]    w_sum_re, w_sum_im;          // s35
    logic signed [DATA_W+P_CS_W-14:0] w_rnd_re, w_rnd_im;          // s21
    logic signed [DATA_W-1:0]         w_sat_re, w_sat_im;
    logic signed [DATA_W-1:0]         r_out_re, r_out_im;

    assign w_sum_re = r_om1 - r_om2;
    assign w_sum_im = r_om3 + r_om4;
    assign w_rnd_re = (w_sum_re + 35'sd8192) >>> 14;
    assign w_rnd_im = (w_sum_im + 35'sd8192) >>> 14;

    always_comb begin
        if      (w_rnd_re > 21'sd32767)  w_sat_re = 16'sd32767;
        else if (w_rnd_re < -21'sd32768) w_sat_re = -16'sd32768;
        else                             w_sat_re = DATA_W'(w_rnd_re);
        if      (w_rnd_im > 21'sd32767)  w_sat_im = 16'sd32767;
        else if (w_rnd_im < -21'sd32768) w_sat_im = -16'sd32768;
        else                             w_sat_im = DATA_W'(w_rnd_im);
    end

    always_ff @(posedge i_clk) begin
        if (w_oce) begin
            r_out_re <= w_sat_re;
            r_out_im <= w_sat_im;
        end
    end

    // AXIS 输出寄存 (红线 2): tvalid 不依赖 tready, 反压保持。
    // ro_tdata 与 ro_tvalid 同拍装载 (r_out_* 由 r_ov3 定拍), 严格对齐
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_tvalid <= 1'b0;
        end else if (w_oce) begin
            ro_tvalid <= r_ov3;
        end
    end

    always_ff @(posedge i_clk) begin
        if (w_oce) ro_tdata <= {r_out_im, r_out_re};
    end

    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tdata  = ro_tdata;

    // 状态输出 (ro_ 寄存, 红线 2); 含 w_out_take 过渡拍, 防 busy 空窗
    logic ro_busy;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_busy <= 1'b0;
        else       ro_busy <= ro_rd_ce || r_ov1 || r_ov2 || r_ov3 ||
                              ro_tvalid || w_out_take;
    end

    assign o_busy = ro_busy;

endmodule : cpe_rotate_out
