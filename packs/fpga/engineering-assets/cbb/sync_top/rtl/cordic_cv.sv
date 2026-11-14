//==============================================================================
// cordic_cv — 圆周 CORDIC, 向量/旋转双模 (迭代式, 无 DSP)
// 来源: 复制自 cbb/channel_est_top/rtl/cordic_cv.sv (1.0.0 certified, 实现与
//       常数逐字一致); sync_top 用向量模式求 S_cfo 相角 (ADR-003)
// 功能: 供信道估计 CPE 跟踪使用 (ADR-002):
//       向量模式 (i_mode=0): 求复数 (x,y) 的相角 -> o_z (Q3.13, 弧度, (-pi,pi])
//       旋转模式 (i_mode=1): 将 (x,y) 旋转 i_z 弧度 -> (o_x,o_y), 含增益 A≈1.6468;
//         求 e^{j*z} 时以 (x,y)=(9949,0)=(K*2^14,0) 启动, 输出即 Q2.14 cos/sin
// 端口: i_clk/i_rst (同步复位, 高有效); i_start 单拍脉冲装载; o_done 单拍脉冲
// 主要逻辑: ri_ 装载 -> 预旋转象限归约 (向量: x<0 转 pi; 旋转: |z|>pi/2 转 pi)
//           -> 14 次移位-加减迭代 -> 结果寄存
// 延迟: i_start 到 o_done 共 17 拍 (装载 1 + 预旋转 1 + 迭代 14 + 输出 1)
// 复位: 同步高有效, 仅控制链复位; 数据寄存器不复位 (由 o_done 屏蔽, §1.1)
//
// 定点约定 (与 golden 位真镜像 generate_vectors.m 必须逐字一致):
//   xy: 有符号 P_XY_W=22 位; 角度: 有符号 16 位 Q3.13 (1 LSB = 2^-13 rad)
//   atan 表 = round(atan(2^-i)*2^13), i=0..13; PI=25736, PI/2=12868
//   迭代: d=+1/-1; x' = x - d*(y>>>i); y' = y + d*(x>>>i); z' = z - d*atan[i]
//     向量模式 d = (y>=0) ? -1 : +1;  旋转模式 d = (z>=0) ? +1 : -1
//==============================================================================
module cordic_cv #(
    parameter int P_XY_W = 22,
    parameter int P_A_W  = 16,
    parameter int P_ITER = 14
)(
    input  logic                       i_clk,
    input  logic                       i_rst,      // 同步复位, 高有效
    input  logic                       i_start,    // 单拍装载脉冲 (仅 IDLE 态有效)
    input  logic                       i_mode,     // 0=向量(求角), 1=旋转
    input  logic signed [P_XY_W-1:0]   i_x,
    input  logic signed [P_XY_W-1:0]   i_y,
    input  logic signed [P_A_W-1:0]    i_z,        // 旋转模式的目标角 (Q3.13)
    output logic                       o_busy,
    output logic                       o_done,     // 单拍脉冲, 结果同拍有效
    output logic signed [P_XY_W-1:0]   o_x,
    output logic signed [P_XY_W-1:0]   o_y,
    output logic signed [P_A_W-1:0]    o_z
);

    localparam logic signed [P_A_W-1:0] P_PI      = 16'sd25736; // round(pi*2^13)
    localparam logic signed [P_A_W-1:0] P_PI_HALF = 16'sd12868; // round(pi/2*2^13)

    // atan(2^-i) * 2^13, i = 0..13 (Q3.13)
    localparam logic signed [P_A_W-1:0] P_ATAN [P_ITER] = '{
        16'sd6434, 16'sd3798, 16'sd2007, 16'sd1019,
        16'sd511,  16'sd256,  16'sd128,  16'sd64,
        16'sd32,   16'sd16,   16'sd8,    16'sd4,
        16'sd2,    16'sd1
    };

    //==========================================================================
    // 状态编码
    //==========================================================================
    typedef enum logic [1:0] {P_IDLE, P_PRE, P_RUN, P_OUT} state_t;
    state_t r_state, w_state_nxt;

    logic [$clog2(P_ITER)-1:0] r_it;

    //==========================================================================
    // ri_ 输入寄存 (红线 1): i_start 拍装载操作数
    //==========================================================================
    logic signed [P_XY_W-1:0] ri_x, ri_y;
    logic signed [P_A_W-1:0]  ri_z;
    logic                     ri_mode;

    always_ff @(posedge i_clk) begin
        if (r_state == P_IDLE && i_start) begin
            ri_x    <= i_x;
            ri_y    <= i_y;
            ri_z    <= i_z;
            ri_mode <= i_mode;
        end
    end

    //==========================================================================
    // 迭代数据寄存器 (数据通路, 不复位 §1.1 — 结果由 o_done 定拍)
    //==========================================================================
    logic signed [P_XY_W-1:0] r_x, r_y;
    logic signed [P_A_W-1:0]  r_z;
    logic                     w_d_pos;   // d=+1 ?

    assign w_d_pos = ri_mode ? (r_z >= 0) : (r_y < 0);

    always_ff @(posedge i_clk) begin
        if (r_state == P_PRE) begin
            if (!ri_mode) begin
                // 向量模式: x<0 时预转 pi, 使角度落入收敛域 (-pi/2, pi/2]
                if (ri_x < 0) begin
                    r_x <= -ri_x;
                    r_y <= -ri_y;
                    r_z <= (ri_y >= 0) ? P_PI : -P_PI;
                end else begin
                    r_x <= ri_x;
                    r_y <= ri_y;
                    r_z <= '0;
                end
            end else begin
                // 旋转模式: |z|>pi/2 时预转 pi
                if (ri_z > P_PI_HALF) begin
                    r_x <= -ri_x; r_y <= -ri_y; r_z <= ri_z - P_PI;
                end else if (ri_z < -P_PI_HALF) begin
                    r_x <= -ri_x; r_y <= -ri_y; r_z <= ri_z + P_PI;
                end else begin
                    r_x <= ri_x;  r_y <= ri_y;  r_z <= ri_z;
                end
            end
        end else if (r_state == P_RUN) begin
            if (w_d_pos) begin
                r_x <= r_x - (r_y >>> r_it);
                r_y <= r_y + (r_x >>> r_it);
                r_z <= r_z - P_ATAN[r_it];
            end else begin
                r_x <= r_x + (r_y >>> r_it);
                r_y <= r_y - (r_x >>> r_it);
                r_z <= r_z + P_ATAN[r_it];
            end
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst)                   r_it <= '0;
        else if (r_state == P_PRE)   r_it <= '0;
        else if (r_state == P_RUN)   r_it <= r_it + 1'b1;
    end

    //==========================================================================
    // 三段式状态机 (红线 4)
    //==========================================================================
    always_comb begin
        w_state_nxt = r_state;
        case (r_state)
            P_IDLE: if (i_start)                          w_state_nxt = P_PRE;
            P_PRE:                                        w_state_nxt = P_RUN;
            P_RUN:  if (r_it == ($clog2(P_ITER))'(P_ITER-1)) w_state_nxt = P_OUT;
            P_OUT:                                        w_state_nxt = P_IDLE;
            default:                                      w_state_nxt = P_IDLE;
        endcase
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) r_state <= P_IDLE;
        else       r_state <= w_state_nxt;
    end

    //==========================================================================
    // ro_ 输出寄存 (红线 2)
    //==========================================================================
    logic                     ro_done, ro_busy;
    logic signed [P_XY_W-1:0] ro_x, ro_y;
    logic signed [P_A_W-1:0]  ro_z;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_done <= 1'b0;
            ro_busy <= 1'b0;
        end else begin
            ro_done <= (r_state == P_OUT);
            ro_busy <= (w_state_nxt != P_IDLE);
        end
    end

    // 结果数据寄存 (不复位, 由 ro_done 定拍)
    always_ff @(posedge i_clk) begin
        if (r_state == P_OUT) begin
            ro_x <= r_x;
            ro_y <= r_y;
            ro_z <= r_z;
        end
    end

    assign o_busy = ro_busy;
    assign o_done = ro_done;
    assign o_x    = ro_x;
    assign o_y    = ro_y;
    assign o_z    = ro_z;

endmodule : cordic_cv
