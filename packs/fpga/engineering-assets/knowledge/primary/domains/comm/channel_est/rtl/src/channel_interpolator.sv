//==============================================================================
// channel_interpolator — 导频间线性插值
// 功能: 由 4 个导频信道估计值线性插值出全部 64 个子载波的信道响应
// 端口: i_clk/i_rst (同步复位, 高有效); i_start (启动一次插值);
//       i_pilot_h_i / i_pilot_h_q (4 个复数导频); m_axis (插值结果 I/Q 打包)
// 主要逻辑: 三段式 FSM (IDLE/COMPUTE/OUTPUT/DONE); COMPUTE 段分 3 拍算三段斜率
//           (相邻导频差 × 1/14 的 Q0.16 常数, 带舍入); OUTPUT 段用累加器逐点
//           推出信道值, 导频位直接取导频值, 两端外推为最近导频, DC 位置固定 1.0
// 复位: 同步高有效, 全部流水寄存器统一复位
//
// 本文件为 hdl-coding 规范修复版。相对修复前的差异:
//   (1) 复位由 `negedge rst_n` 异步低有效改为同步高有效 i_rst;
//   (2) 端口 clk/rst_n/start/pilot_* -> i_clk/i_rst/i_start/i_pilot_*;
//   (3) delta_i/delta_q 与 prod_i/prod_q 两级**原先完全无复位**, 现补同步复位;
//   (4) m_axis_tvalid 原为 `(state == OUTPUT)` 组合直出、m_axis_tdata 原直接取
//       always_comb 的 out_i/out_q (违红线 2), 现改为 ro_ 寄存输出;
//       输出级与累加器共用统一使能 w_out_ce, 下游反压时整体冻结, 不丢不重;
//   (5) 两处 unique case 补 default (红线 4/5)。
//
// !! 遗留缺陷 (承自原始代码, 本次**未改**) !!
//   [F1] slope 的定点标定未论证: prod = delta(18bit) × 4681(Q0.16) 取 [29:14]
//        并按 bit13 舍入, 该切片位置与 DATA_W 的关系是硬编码的, DATA_W != 16
//        时不成立。
//   [F2] 累加器 acc_i/acc_q 为 DATA_W 位且用 data_t' 强制截断, 多次累加斜率
//        后可能溢出且无饱和保护。
//   [F3] 上游 ls_estimator 的 [F1] 使导频只在第一个符号有效, 本模块的输入
//        因而从第二个符号起是陈旧值。
//==============================================================================
module channel_interpolator #(
    parameter int N_FFT   = 64,
    parameter int N_PILOT = 4,
    parameter int DATA_W  = 16
)(
    input  logic                i_clk,
    input  logic                i_rst,        // 同步复位, 高有效
    input  logic                i_start,
    input  logic [N_PILOT-1:0][DATA_W-1:0] i_pilot_h_i,
    input  logic [N_PILOT-1:0][DATA_W-1:0] i_pilot_h_q,
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata
);
    localparam PILOT_POS_0 = 11;
    localparam PILOT_POS_1 = 25;
    localparam PILOT_POS_2 = 39;
    localparam PILOT_POS_3 = 53;
    localparam COEFF_114 = 4681;  // Q0.16: round(2^16/14)

    typedef logic signed [DATA_W-1:0] data_t;

    //==========================================================================
    // 状态编码 (红线/命名: 状态用 P_ 前缀)
    //==========================================================================
    typedef enum logic [1:0] {P_IDLE, P_COMPUTE, P_OUTPUT, P_DONE} state_t;
    state_t r_state, w_state_nxt;

    logic [$clog2(N_FFT)-1:0]   r_out_cnt;
    logic [$clog2(N_PILOT)-1:0] r_slope_phase;

    // 输出级统一使能: 输出寄存器空 或 下游本拍收走 -> 整体前移一拍, 否则冻结
    logic ro_tvalid;
    logic [DATA_W*2-1:0] ro_tdata;
    logic w_out_ce;

    assign w_out_ce = !ro_tvalid || m_axis_tready;

    // Slope pipelined computation
    logic signed [DATA_W+1:0]  r_delta_i, r_delta_q;
    logic signed [DATA_W+15:0] r_prod_i,  r_prod_q;
    logic signed [DATA_W+1:0]  r_slope_i [3];
    logic signed [DATA_W+1:0]  r_slope_q [3];

    always_ff @(posedge i_clk) begin
        if (i_rst)                                        r_slope_phase <= '0;
        else if (r_state == P_COMPUTE && r_slope_phase < 2) r_slope_phase <= r_slope_phase + 1;
        else if (r_state != P_COMPUTE)                     r_slope_phase <= '0;
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_delta_i <= '0;
            r_delta_q <= '0;
        end else begin
            unique case (r_slope_phase)
                0: begin r_delta_i <= $signed(i_pilot_h_i[1]) - $signed(i_pilot_h_i[0]); r_delta_q <= $signed(i_pilot_h_q[1]) - $signed(i_pilot_h_q[0]); end
                1: begin r_delta_i <= $signed(i_pilot_h_i[2]) - $signed(i_pilot_h_i[1]); r_delta_q <= $signed(i_pilot_h_q[2]) - $signed(i_pilot_h_q[1]); end
                2: begin r_delta_i <= $signed(i_pilot_h_i[3]) - $signed(i_pilot_h_i[2]); r_delta_q <= $signed(i_pilot_h_q[3]) - $signed(i_pilot_h_q[2]); end
                default: begin r_delta_i <= '0; r_delta_q <= '0; end
            endcase
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_prod_i <= '0;
            r_prod_q <= '0;
        end else begin
            r_prod_i <= r_delta_i * COEFF_114;
            r_prod_q <= r_delta_q * COEFF_114;
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_slope_i[0] <= '0; r_slope_q[0] <= '0;
            r_slope_i[1] <= '0; r_slope_q[1] <= '0;
            r_slope_i[2] <= '0; r_slope_q[2] <= '0;
        end else if (r_state == P_COMPUTE) begin
            r_slope_i[r_slope_phase] <= r_prod_i[29:14] + (r_prod_i[13] ? 1 : 0);
            r_slope_q[r_slope_phase] <= r_prod_q[29:14] + (r_prod_q[13] ? 1 : 0);
        end
    end

    //==========================================================================
    // 输出累加器
    //==========================================================================
    data_t w_out_i, w_out_q;
    data_t r_acc_i, r_acc_q;
    logic  w_gap0, w_gap1, w_gap2;

    assign w_gap0 = (r_out_cnt > PILOT_POS_0 && r_out_cnt < PILOT_POS_1);
    assign w_gap1 = (r_out_cnt > PILOT_POS_1 && r_out_cnt < PILOT_POS_2);
    assign w_gap2 = (r_out_cnt > PILOT_POS_2 && r_out_cnt < PILOT_POS_3);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_acc_i <= '0; r_acc_q <= '0;
        end else if (r_state == P_OUTPUT && w_out_ce) begin
            if      (r_out_cnt == PILOT_POS_0) begin r_acc_i <= i_pilot_h_i[0]; r_acc_q <= i_pilot_h_q[0]; end
            else if (w_gap0) begin r_acc_i <= data_t'($signed(r_acc_i) + $signed(r_slope_i[0])); r_acc_q <= data_t'($signed(r_acc_q) + $signed(r_slope_q[0])); end
            else if (r_out_cnt == PILOT_POS_1) begin r_acc_i <= i_pilot_h_i[1]; r_acc_q <= i_pilot_h_q[1]; end
            else if (w_gap1) begin r_acc_i <= data_t'($signed(r_acc_i) + $signed(r_slope_i[1])); r_acc_q <= data_t'($signed(r_acc_q) + $signed(r_slope_q[1])); end
            else if (r_out_cnt == PILOT_POS_2) begin r_acc_i <= i_pilot_h_i[2]; r_acc_q <= i_pilot_h_q[2]; end
            else if (w_gap2) begin r_acc_i <= data_t'($signed(r_acc_i) + $signed(r_slope_i[2])); r_acc_q <= data_t'($signed(r_acc_q) + $signed(r_slope_q[2])); end
            else if (r_out_cnt == PILOT_POS_3) begin r_acc_i <= i_pilot_h_i[3]; r_acc_q <= i_pilot_h_q[3]; end
        end
    end

    always_comb begin
        unique case (1)
            r_out_cnt == 32:            begin w_out_i = data_t'(1 << 14); w_out_q = '0; end
            r_out_cnt <= PILOT_POS_0:   begin w_out_i = i_pilot_h_i[0]; w_out_q = i_pilot_h_q[0]; end
            r_out_cnt == PILOT_POS_1:   begin w_out_i = i_pilot_h_i[1]; w_out_q = i_pilot_h_q[1]; end
            r_out_cnt == PILOT_POS_2:   begin w_out_i = i_pilot_h_i[2]; w_out_q = i_pilot_h_q[2]; end
            r_out_cnt == PILOT_POS_3:   begin w_out_i = i_pilot_h_i[3]; w_out_q = i_pilot_h_q[3]; end
            r_out_cnt > PILOT_POS_3:    begin w_out_i = i_pilot_h_i[3]; w_out_q = i_pilot_h_q[3]; end
            default:                    begin w_out_i = r_acc_i; w_out_q = r_acc_q; end
        endcase
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) r_out_cnt <= '0;
        else if (r_state == P_OUTPUT && w_out_ce) begin
            if (r_out_cnt == N_FFT-1) r_out_cnt <= '0;
            else                      r_out_cnt <= r_out_cnt + 1;
        end else if (r_state != P_OUTPUT) r_out_cnt <= '0;
    end

    //==========================================================================
    // 三段式状态机 (红线 4)
    //==========================================================================
    always_comb begin
        w_state_nxt = r_state;
        unique case (r_state)
            P_IDLE:    if (i_start) w_state_nxt = P_COMPUTE;
            P_COMPUTE: if (r_slope_phase == 2) w_state_nxt = P_OUTPUT;
            P_OUTPUT:  if (w_out_ce && r_out_cnt == N_FFT-1) w_state_nxt = P_DONE;
            P_DONE:    w_state_nxt = P_IDLE;
            default:   w_state_nxt = P_IDLE;
        endcase
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) r_state <= P_IDLE;
        else       r_state <= w_state_nxt;
    end

    //==========================================================================
    // ro_ 输出寄存 (红线 2) —— tvalid 不依赖 tready, 反压时整级保持
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_tvalid <= 1'b0;
            ro_tdata  <= '0;
        end else if (w_out_ce) begin
            ro_tvalid <= (r_state == P_OUTPUT);
            ro_tdata  <= {w_out_q, w_out_i};
        end
    end

    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tdata  = ro_tdata;

endmodule : channel_interpolator
