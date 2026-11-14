//==============================================================================
// fft64_sdf_core — 64 点流水 FFT/IFFT 核 (R2²SDF, DIF, 方向可参数化)
// 功能: 每拍一样点的流式 64 点变换。结构取 ADR-004 的 **基-2² SDF**:
//       6 级反馈延迟 32/16/8/4/2/1, 奇数级为 BF2I, 偶数级为 BF2II;
//       完整复乘仅 2 个 (级 2 与级 4 之后) —— 基-2 SDF 需 4 个, 本结构减半。
//       本核恒输出**位反序**流 + o_idx; 自然序由 fft64_reorder 承接。
// 方向 (P_DIR): 1 = IFFT (旋转因子 e^{+j2πk/64}), 0 = FFT (e^{-j2πk/64})。
//       **方向切换须翻两处符号, 缺一不可**:
//         (1) 非平凡旋转因子的虚部 (P_TWS 取负)
//         (2) BF2II 的平凡因子: IFFT 用 +j, FFT 用 -j
//       只翻其一会让输出错到比信号本身还大 —— golden 侧实测: 只翻 (1) 时最大
//       误差 46725 LSB 而信号幅度仅 17800 LSB; 两处都翻后降至 3.5 LSB 即量化量级。
// 标定: ifft(x)·sqrt(64) 与 fft(x)/sqrt(64) 展开后同为 Σ(...)/8, 故两方向共用
//       同一逐级移位调度 —— 级 2/4/6 蝶形后各 (x+1)>>>1, 净 /8。
// 端口: i_clk/i_rst; i_beat (样点拍 CE)/i_valid/i_re/i_im (Q2.14, 自然序,
//       每符号连续 64 拍); i_sb 侧带 (与样点同延迟透传, 供 frame_start 穿越);
//       o_valid/o_idx (位反序序号 0..63)/o_re/o_im/o_sb。
//       尾部冲刷: 流结束后需继续馈拍排空在途样点 (TB 契约)。
// 定点: 内部 s21 —— **不是 s20**。满幅 Q2.14 输入下移位前逐轴上界为
//       16·max|x| = 45.25 (两轴同时满幅时的模), 超出 s20 的 ±32; golden 侧按
//       64 个输出 bin 逐个对抗构造搜索, 最坏 40.611 (k=14) 确实溢 s20,
//       s21 的 ±64 有 1.58x 裕量。真实 OFDM 信号峰值仅 3.6~4.7, 两者皆安全 ——
//       加宽针对的是满幅 CW 干扰一类工况, 不是典型信号。
//       旋转乘 (v·w + 8192)>>>14; 级 2/4/6 蝶形后 (x+1)>>>1 (rounding, 非截断);
//       输出级: IFFT 再 (x+1)>>>1 转 Q3.13, FFT 保持 Q2.14 (仅饱和不移位) ——
//       两者都只是格式转换, 不是额外缩放。
// 复位: 同步高有效, 仅控制链复位; FIFO/数据流水不复位 (§1.1/§10.2)
//==============================================================================
`default_nettype none

module fft64_sdf_core #(
    parameter int DATA_W = 16,
    parameter int P_W    = 21,   // 内部位宽 (见头注释: s20 在满幅输入下会回绕)
    parameter bit P_DIR  = 1'b0  // 0 = FFT (正向), 1 = IFFT (反向)
)(
    input  wire                      i_clk,
    input  wire                      i_rst,       // 同步复位, 高有效
    input  wire                      i_beat,      // 样点拍 (CE)
    input  wire                      i_valid,
    input  wire signed [DATA_W-1:0]  i_re,        // Q2.14
    input  wire signed [DATA_W-1:0]  i_im,
    input  wire                      i_sb,        // 侧带 (与样点同延迟透传)

    output wire                      o_valid,
    output wire [5:0]                o_idx,       // 位反序序号
    output wire signed [DATA_W-1:0]  o_re,        // FFT: Q2.14 / IFFT: Q3.13
    output wire signed [DATA_W-1:0]  o_im,
    output wire                      o_sb
);

    localparam int MW    = P_W + 16;              // 复乘中间积位宽
    // 侧带延迟线长度 —— **实测定标, 不是推导值**。
    // 不能套用 golden 镜像里的 63+3+3=69: 那是数值对应关系 (哪个输入样点对应哪个
    // 输出样点), 不是 RTL 的时钟拍数。按拍数推的 76 也偏一拍。
    // 定标判据由 TB 直接断言契约本身: o_sb 为高的那一拍, o_idx 必须为 0
    // (即侧带与它所标记符号的**首个输出**同拍)。实测 75 满足该契约。
    localparam int P_LAT = 75;

    // 旋转因子表 (打包常量, 见该文件头注释说明为何不用 unpacked 数组)
    `include "fft64_twiddle.svh"

    //==========================================================================
    // 输入寄存 (红线 1) + 节点总线
    //==========================================================================
    logic                     ri_valid, ri_sb;
    logic signed [DATA_W-1:0] ri_re, ri_im;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid <= 1'b0;
            ri_sb    <= 1'b0;
        end else if (i_beat) begin
            ri_valid <= i_valid;
            ri_sb    <= i_sb;
        end
    end
    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            ri_re <= i_re;
            ri_im <= i_im;
        end
    end

    logic                  w_v  [0:8];
    logic signed [P_W-1:0] w_re [0:8];
    logic signed [P_W-1:0] w_im [0:8];

    assign w_v[0]  = ri_valid;
    assign w_re[0] = P_W'(ri_re);
    assign w_im[0] = P_W'(ri_im);

    //==========================================================================
    // 6 个蝶形级: 奇数级 BF2I, 偶数级 BF2II (平凡 ±j + 缩放)
    //==========================================================================
    generate
        for (genvar s = 1; s <= 6; s++) begin : g_stage
            localparam int  D     = 64 >> s;              // 32,16,8,4,2,1
            localparam int  LG    = 6 - s;
            localparam bit  BF2II = (s % 2 == 0);
            localparam int  SI    = (s <= 2) ? (s - 1) : (s <= 4) ? s : (s + 1);
            localparam int  SO    = SI + 1;

            logic [6:0]            r_cnt;
            logic                  w_c, w_n1, r_warm;
            logic signed [P_W-1:0] fifo_re [0:D-1];
            logic signed [P_W-1:0] fifo_im [0:D-1];
            logic signed [P_W-1:0] w_xr, w_xi, w_br, w_bi, w_pr, w_pi;
            logic signed [P_W-1:0] ro_re, ro_im;
            logic                  ro_v;

            assign w_c  = r_cnt[LG];
            assign w_n1 = r_cnt[LG+1];

            always_ff @(posedge i_clk) begin
                if (i_rst)                    r_cnt <= '0;
                else if (i_beat && w_v[SI])   r_cnt <= r_cnt + 1'b1;
            end

            always_ff @(posedge i_clk) begin
                if (i_rst)                                       r_warm <= 1'b0;
                else if (i_beat && w_v[SI] && r_cnt == 7'(D-1))  r_warm <= 1'b1;
            end

            // BF2II 平凡因子: IFFT 用 +j -> (-im, re); FFT 用 -j -> (im, -re)
            assign w_xr = (BF2II && w_c && w_n1) ? (P_DIR ? -w_im[SI] :  w_im[SI]) : w_re[SI];
            assign w_xi = (BF2II && w_c && w_n1) ? (P_DIR ?  w_re[SI] : -w_re[SI]) : w_im[SI];

            // 蝶形: c=1 出和、存差; c=0 出上一块的差、存本块样点
            assign w_br = w_c ? (fifo_re[D-1] + w_xr) : fifo_re[D-1];
            assign w_bi = w_c ? (fifo_im[D-1] + w_xi) : fifo_im[D-1];
            assign w_pr = w_c ? (fifo_re[D-1] - w_xr) : w_xr;
            assign w_pi = w_c ? (fifo_im[D-1] - w_xi) : w_xi;

            always_ff @(posedge i_clk) begin
                if (i_beat && w_v[SI]) begin
                    fifo_re[0] <= w_pr;
                    fifo_im[0] <= w_pi;
                    for (int i = 1; i < D; i++) begin
                        fifo_re[i] <= fifo_re[i-1];
                        fifo_im[i] <= fifo_im[i-1];
                    end
                end
            end

            // 输出寄存 (+ BF2II 级的缩放: (x+1)>>>1 rounding)
            always_ff @(posedge i_clk) begin
                if (i_beat) begin
                    ro_re <= BF2II ? ((w_br + P_W'(1)) >>> 1) : w_br;
                    ro_im <= BF2II ? ((w_bi + P_W'(1)) >>> 1) : w_bi;
                end
            end

            always_ff @(posedge i_clk) begin
                if (i_rst)       ro_v <= 1'b0;
                else if (i_beat) ro_v <= w_v[SI] && r_warm;
            end

            assign w_v[SO]  = ro_v;
            assign w_re[SO] = ro_re;
            assign w_im[SO] = ro_im;
        end
    endgenerate

    //==========================================================================
    // 2 个完整复乘: 乘1 接级 2 之后 (W_64), 乘2 接级 4 之后 (W_16 = W_64^4)
    // 指数 e = SCALE · base · swap2(grp); base/grp 取自本级输出序号
    //==========================================================================
    generate
        for (genvar m = 0; m < 2; m++) begin : g_mult
            localparam int SI    = (m == 0) ? 2 : 5;
            localparam int SO    = (m == 0) ? 3 : 6;
            localparam int KLG   = (m == 0) ? 4 : 2;
            localparam int SCALE = (m == 0) ? 1 : 4;

            logic [5:0]              r_cnt;
            logic [1:0]              w_grp, w_sw;
            logic [5:0]              w_base, w_e;
            logic signed [15:0]      r_wc, r_ws;
            logic signed [P_W-1:0]   r_ar, r_ai;
            logic signed [MW-1:0]    r_m1, r_m2, r_m3, r_m4;
            logic                    r_v1, r_v2, r_v3;
            logic signed [P_W-1:0]   ro_re, ro_im;

            always_ff @(posedge i_clk) begin
                if (i_rst)                    r_cnt <= '0;
                else if (i_beat && w_v[SI])   r_cnt <= r_cnt + 1'b1;
            end

            assign w_base = 6'(r_cnt & 6'((1 << KLG) - 1));
            assign w_grp  = 2'(r_cnt >> KLG);
            assign w_sw   = {w_grp[0], w_grp[1]};         // P=[0,2,1,3] 即两位对调
            assign w_e    = 6'(SCALE * w_base * 6'(w_sw));

            // 虚部符号在装载时按方向施加 (P_DIR 为参数, 常量折叠不产生运行期逻辑)
            always_ff @(posedge i_clk) begin
                if (i_beat) begin
                    r_ar <= w_re[SI];   r_ai <= w_im[SI];
                    // (63-e)*16 +: 16 —— 见表声明处关于打包顺序的说明
                    r_wc <= P_TWC[(63 - w_e) * 16 +: 16];
                    r_ws <= P_DIR ?  16'(P_TWS[(63 - w_e) * 16 +: 16])
                                  : -16'(P_TWS[(63 - w_e) * 16 +: 16]);
                    r_m1 <= r_ar * r_wc;   r_m2 <= r_ai * r_ws;
                    r_m3 <= r_ar * r_ws;   r_m4 <= r_ai * r_wc;
                end
            end

            always_ff @(posedge i_clk) begin
                if (i_rst) begin
                    r_v1 <= 1'b0;  r_v2 <= 1'b0;  r_v3 <= 1'b0;
                end else if (i_beat) begin
                    // 数据 3 拍: 操作数/系数寄存 -> 乘积寄存 -> 合并寄存
                    r_v1 <= w_v[SI];  r_v2 <= r_v1;  r_v3 <= r_v2;
                end
            end

            // (a+jb)(c+js): re = ac-bs, im = as+bc; 舍入 (+8192)>>>14
            always_ff @(posedge i_clk) begin
                if (i_beat) begin
                    ro_re <= P_W'((r_m1 - r_m2 + MW'(8192)) >>> 14);
                    ro_im <= P_W'((r_m3 + r_m4 + MW'(8192)) >>> 14);
                end
            end

            assign w_v[SO]  = r_v3;
            assign w_re[SO] = ro_re;
            assign w_im[SO] = ro_im;
        end
    endgenerate

    //==========================================================================
    // 侧带延迟线: 与样点同延迟 P_LAT 拍
    //==========================================================================
    logic [P_LAT-1:0] r_sbq;
    always_ff @(posedge i_clk) begin
        if (i_rst)       r_sbq <= '0;
        else if (i_beat) r_sbq <= {r_sbq[P_LAT-2:0], ri_sb};
    end

    //==========================================================================
    // 输出级: IFFT 再 (x+1)>>>1 转 Q3.13; FFT 保持 Q2.14。两者均 s16 饱和。
    //==========================================================================
    logic       ro_valid, ro_sb;
    logic [5:0] ro_idx, r_ocnt;
    logic signed [DATA_W-1:0] ro_re, ro_im;
    logic signed [P_W-1:0]    w_hre, w_him;

    assign w_hre = P_DIR ? ((w_re[8] + P_W'(1)) >>> 1) : w_re[8];
    assign w_him = P_DIR ? ((w_im[8] + P_W'(1)) >>> 1) : w_im[8];

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid <= 1'b0;
            r_ocnt   <= '0;
            ro_idx   <= '0;
            ro_sb    <= 1'b0;
        end else if (i_beat) begin
            ro_valid <= w_v[8];
            ro_sb    <= r_sbq[P_LAT-1];
            if (w_v[8]) begin
                ro_idx <= r_ocnt;
                r_ocnt <= r_ocnt + 1'b1;
            end
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            ro_re <= (w_hre > P_W'(32767))  ?  16'sd32767 :
                     (w_hre < -P_W'(32768)) ? -16'sd32768 : 16'(w_hre);
            ro_im <= (w_him > P_W'(32767))  ?  16'sd32767 :
                     (w_him < -P_W'(32768)) ? -16'sd32768 : 16'(w_him);
        end
    end

    assign o_valid = ro_valid;
    assign o_idx   = ro_idx;
    assign o_re    = ro_re;
    assign o_im    = ro_im;
    assign o_sb    = ro_sb;

endmodule : fft64_sdf_core

`default_nettype wire
