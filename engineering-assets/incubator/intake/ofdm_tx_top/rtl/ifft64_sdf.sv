//==============================================================================
// ifft64_sdf — 64 点流水 IFFT (R2²SDF, DIF, 共轭旋转因子; ADR-004)
// 功能: 每拍一样点的流式 64 点 IFFT。按 ADR-004 指定的 **基-2² SDF** 结构:
//       6 级反馈延迟 32/16/8/4/2/1, 奇数级为 BF2I, 偶数级为 BF2II;
//       完整复乘仅 2 个 (级 2 与级 4 之后) —— 基-2 SDF 需 4 个, 本结构减半。
//       标定: 与 golden ifft_chain 的 ifft(x)·sqrt(64) = Σ X·U^{nk}/8 一致
//       (U = e^{+j2πnk/64}), 由级 2/4/6 蝶形后各右移 1 达成净 /8。
// 推导: 输入序 k=32k1+16k2+k3, 输出序 n=n1+2n2+4n3 →
//       U^{32k1·n}=(-1)^{k1n1} (BF2I), U^{16k2·n}=j^{k2(n1+2n2)} (BF2II 的平凡
//       因子, 乘在进入蝶形的 x 上, 同时作用于和路与差路),
//       余项 U^{k3(n1+2n2)} 即级 2 后的完整复乘; 级 4 后同理降为 W_16 = U^4。
//       流式组号给出的是 (n2,n1), 故旋转指数的组系数需换位 P=[0,2,1,3]
//       (等价于 grp 两位对调)。
// 端口: i_clk/i_rst; i_beat/i_valid/i_re/i_im (Q2.14, 自然序, 每符号连续
//       64 拍); o_valid/o_re/o_im (Q3.13, **位反序**) + o_idx (输出样点在
//       符号内的位反序序号 0..63, 供下游按 bitrev 写地址吸收重排)。
//       尾部冲刷: 流结束后需继续馈拍 (如零符号) 排空在途样点 (TB 契约)。
// 定点 (与 fixed_point_report §2.2/§2.4 记录的调度一致):
//       内部 s20; 旋转乘 (v·w + 8192)>>>14; 级 2/4/6 蝶形后 (x+1)>>>1
//       (**rounding**, 非截断); 输出 (x+1)>>>1 转 Q3.13 后 sat16。
//       旋转因子表 = round(cos/sin(2πk/64)·16384), k=0..63。
// 复位: 同步高有效, 仅控制链复位; FIFO/数据流水不复位 (§1.1/§10.2)
//==============================================================================
module ifft64_sdf #(
    parameter int DATA_W = 16
)(
    input  logic                     i_clk,
    input  logic                     i_rst,       // 同步复位, 高有效
    input  logic                     i_beat,      // 样点拍 (CE)
    input  logic                     i_valid,
    input  logic signed [DATA_W-1:0] i_re,        // Q2.14
    input  logic signed [DATA_W-1:0] i_im,

    output logic                     o_valid,
    output logic [5:0]               o_idx,       // 位反序序号
    output logic signed [DATA_W-1:0] o_re,        // Q3.13
    output logic signed [DATA_W-1:0] o_im
);

    localparam int P_W = 20;                      // 内部位宽

    // 共轭旋转因子 e^{+j2πk/64} = round(cos/sin(2πk/64)·16384), Q2.14
    // 指数域 0..45 (k3·3 ≤ 45), 取满 64 项
    localparam logic signed [15:0] P_TWC [0:63] = '{
        16'sd16384, 16'sd16305, 16'sd16069, 16'sd15679, 16'sd15137, 16'sd14449,
        16'sd13623, 16'sd12665, 16'sd11585, 16'sd10394, 16'sd9102,  16'sd7723,
        16'sd6270,  16'sd4756,  16'sd3196,  16'sd1606,  16'sd0,     -16'sd1606,
        -16'sd3196, -16'sd4756, -16'sd6270, -16'sd7723, -16'sd9102, -16'sd10394,
        -16'sd11585,-16'sd12665,-16'sd13623,-16'sd14449,-16'sd15137,-16'sd15679,
        -16'sd16069,-16'sd16305,-16'sd16384,-16'sd16305,-16'sd16069,-16'sd15679,
        -16'sd15137,-16'sd14449,-16'sd13623,-16'sd12665,-16'sd11585,-16'sd10394,
        -16'sd9102, -16'sd7723, -16'sd6270, -16'sd4756, -16'sd3196, -16'sd1606,
        16'sd0,     16'sd1606,  16'sd3196,  16'sd4756,  16'sd6270,  16'sd7723,
        16'sd9102,  16'sd10394, 16'sd11585, 16'sd12665, 16'sd13623, 16'sd14449,
        16'sd15137, 16'sd15679, 16'sd16069, 16'sd16305
    };
    localparam logic signed [15:0] P_TWS [0:63] = '{
        16'sd0,     16'sd1606,  16'sd3196,  16'sd4756,  16'sd6270,  16'sd7723,
        16'sd9102,  16'sd10394, 16'sd11585, 16'sd12665, 16'sd13623, 16'sd14449,
        16'sd15137, 16'sd15679, 16'sd16069, 16'sd16305, 16'sd16384, 16'sd16305,
        16'sd16069, 16'sd15679, 16'sd15137, 16'sd14449, 16'sd13623, 16'sd12665,
        16'sd11585, 16'sd10394, 16'sd9102,  16'sd7723,  16'sd6270,  16'sd4756,
        16'sd3196,  16'sd1606,  16'sd0,     -16'sd1606, -16'sd3196, -16'sd4756,
        -16'sd6270, -16'sd7723, -16'sd9102, -16'sd10394,-16'sd11585,-16'sd12665,
        -16'sd13623,-16'sd14449,-16'sd15137,-16'sd15679,-16'sd16069,-16'sd16305,
        -16'sd16384,-16'sd16305,-16'sd16069,-16'sd15679,-16'sd15137,-16'sd14449,
        -16'sd13623,-16'sd12665,-16'sd11585,-16'sd10394,-16'sd9102, -16'sd7723,
        -16'sd6270, -16'sd4756, -16'sd3196, -16'sd1606
    };

    // 链路节点: 0=输入 1=级1 2=级2 3=乘1 4=级3 5=级4 6=乘2 7=级5 8=级6
    logic                  w_v  [0:8];
    logic signed [P_W-1:0] w_re [0:8];
    logic signed [P_W-1:0] w_im [0:8];

    assign w_v[0]  = i_valid;
    assign w_re[0] = P_W'(i_re);
    assign w_im[0] = P_W'(i_im);

    //==========================================================================
    // 6 个蝶形级: 奇数级 BF2I, 偶数级 BF2II (平凡因子 +j + 缩放)
    //==========================================================================
    generate
        for (genvar s = 1; s <= 6; s++) begin : g_stage
            localparam int  D     = 64 >> s;              // 32,16,8,4,2,1
            localparam int  LG    = 6 - s;                // log2(D)
            localparam bit  BF2II = (s % 2 == 0);
            localparam int  SI    = (s <= 2) ? (s - 1) : (s <= 4) ? s : (s + 1);
            localparam int  SO    = SI + 1;               // 本级输出节点号

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

            // BF2II 平凡因子 j^{n1}: c=1 且 n1=1 时 x ← +j·x = (-im, re)
            assign w_xr = (BF2II && w_c && w_n1) ? -w_im[SI] : w_re[SI];
            assign w_xi = (BF2II && w_c && w_n1) ?  w_re[SI] : w_im[SI];

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
                    ro_re <= BF2II ? ((w_br + 20'sd1) >>> 1) : w_br;
                    ro_im <= BF2II ? ((w_bi + 20'sd1) >>> 1) : w_bi;
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
    // 指数 e = SCALE · base · swap2(grp); base/grp 取自本级输出序号 m
    //==========================================================================
    generate
        for (genvar m = 0; m < 2; m++) begin : g_mult
            localparam int SI    = (m == 0) ? 2 : 5;      // 输入节点
            localparam int SO    = (m == 0) ? 3 : 6;      // 输出节点
            localparam int KLG   = (m == 0) ? 4 : 2;      // log2(base 位宽)
            localparam int SCALE = (m == 0) ? 1 : 4;

            logic [5:0]              r_cnt;
            logic [1:0]              w_grp, w_sw;
            logic [5:0]              w_base, w_e;
            logic signed [15:0]      r_wc, r_ws;
            logic signed [P_W-1:0]   r_ar, r_ai;
            logic signed [P_W+15:0]  r_m1, r_m2, r_m3, r_m4;
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

            always_ff @(posedge i_clk) begin
                if (i_beat) begin
                    r_ar <= w_re[SI];   r_ai <= w_im[SI];
                    r_wc <= P_TWC[w_e]; r_ws <= P_TWS[w_e];
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
                    ro_re <= P_W'((r_m1 - r_m2 + 36'sd8192) >>> 14);
                    ro_im <= P_W'((r_m3 + r_m4 + 36'sd8192) >>> 14);
                end
            end

            assign w_v[SO]  = r_v3;
            assign w_re[SO] = ro_re;
            assign w_im[SO] = ro_im;
        end
    endgenerate

    //==========================================================================
    // 输出级: Q2.14 域值 → Q3.13 ((x+1)>>>1) + sat16; 位反序序号计数
    //==========================================================================
    logic       ro_valid;
    logic [5:0] ro_idx, r_ocnt;
    logic signed [DATA_W-1:0] ro_re, ro_im;
    logic signed [P_W-1:0]    w_hre, w_him;

    assign w_hre = (w_re[8] + 20'sd1) >>> 1;
    assign w_him = (w_im[8] + 20'sd1) >>> 1;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid <= 1'b0;
            r_ocnt   <= '0;
            ro_idx   <= '0;
        end else if (i_beat) begin
            ro_valid <= w_v[8];
            if (w_v[8]) begin
                ro_idx <= r_ocnt;
                r_ocnt <= r_ocnt + 1'b1;
            end
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            ro_re <= (w_hre > 20'sd32767)  ? 16'sd32767 :
                     (w_hre < -20'sd32768) ? -16'sd32768 : 16'(w_hre);
            ro_im <= (w_him > 20'sd32767)  ? 16'sd32767 :
                     (w_him < -20'sd32768) ? -16'sd32768 : 16'(w_him);
        end
    end

    assign o_valid = ro_valid;
    assign o_idx   = ro_idx;
    assign o_re    = ro_re;
    assign o_im    = ro_im;

endmodule : ifft64_sdf
