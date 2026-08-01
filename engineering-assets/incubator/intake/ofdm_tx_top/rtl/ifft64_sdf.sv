//==============================================================================
// ifft64_sdf — 64 点流水 IFFT (R2-SDF, DIF, 共轭旋转因子; ADR-004)
// 功能: 每拍一样点的流式 64 点 IFFT。采用 DIF FFT 蝶形 + 共轭旋转因子
//       W64^{-nk} = e^{+j2πnk/64} 直接实现 IFFT; 6 级反馈延迟 32/16/8/4/2/1。
//       标定 (与 golden ifft_chain 的 ifft(x)·sqrt(64) = Σx·W/8 一致):
//       级 2/4/6 蝶形后各算术右移 1 (净 /8), 输出再 (x+1)>>>1 转 Q3.13 并
//       饱和 s16 — 即 golden 值域的 Q3.13 量化。
// 端口: i_clk/i_rst; i_beat/i_valid/i_re/i_im (Q2.14, 自然序, 每符号连续
//       64 拍); o_valid/o_re/o_im (Q3.13, **位反序**) + o_idx (输出样点在
//       符号内的位反序序号 0..63, 供下游按 bitrev 写地址吸收重排)。
//       尾部冲刷: 流结束后需继续馈拍 (如零符号) 排空 ~70 拍在途样点 (TB 契约)。
// 主要逻辑: 6 级 SDF: 各级本地拍计数 cnt, 相位 c = cnt[log2(D)];
//       c=0: FIFO 存入 x, 输出 = FIFO 出口的上一块差值 (级 1-4 乘旋转因子,
//            级 5 乘 {1,+j} 平凡因子);
//       c=1: 输出 = fifo+x (和, **无舍入直通**), FIFO 存 fifo-x (差)。
// 定点 (与 generate_vectors.m 位真镜像逐字一致):
//       内部 s20; 旋转乘积 (v·w + 8192)>>>14; 级 2/4/6 移位为纯截断 >>>1;
//       输出 (x+1)>>>1 后 sat16。旋转因子表 = round(cos/sin(2πk/64)·16384)。
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

    // 共轭旋转因子 e^{+j2πk/64}, Q2.14 (k=0..31); 级 s 以步长 2^(s-1) 索引
    localparam logic signed [15:0] P_TWC [0:31] = '{
        16'sd16384, 16'sd16305, 16'sd16069, 16'sd15679, 16'sd15137, 16'sd14449,
        16'sd13623, 16'sd12665, 16'sd11585, 16'sd10394, 16'sd9102,  16'sd7723,
        16'sd6270,  16'sd4756,  16'sd3196,  16'sd1606,  16'sd0,     -16'sd1606,
        -16'sd3196, -16'sd4756, -16'sd6270, -16'sd7723, -16'sd9102, -16'sd10394,
        -16'sd11585,-16'sd12665,-16'sd13623,-16'sd14449,-16'sd15137,-16'sd15679,
        -16'sd16069,-16'sd16305
    };
    localparam logic signed [15:0] P_TWS [0:31] = '{
        16'sd0,     16'sd1606,  16'sd3196,  16'sd4756,  16'sd6270,  16'sd7723,
        16'sd9102,  16'sd10394, 16'sd11585, 16'sd12665, 16'sd13623, 16'sd14449,
        16'sd15137, 16'sd15679, 16'sd16069, 16'sd16305, 16'sd16384, 16'sd16305,
        16'sd16069, 16'sd15679, 16'sd15137, 16'sd14449, 16'sd13623, 16'sd12665,
        16'sd11585, 16'sd10394, 16'sd9102,  16'sd7723,  16'sd6270,  16'sd4756,
        16'sd3196,  16'sd1606
    };

    // 级间信号: [0]=输入, [s]=级 s 输出
    logic                    w_v   [0:6];
    logic signed [P_W-1:0]   w_re  [0:6];
    logic signed [P_W-1:0]   w_im  [0:6];

    assign w_v[0]  = i_valid;
    assign w_re[0] = P_W'(i_re);
    assign w_im[0] = P_W'(i_im);

    //==========================================================================
    // 6 级 SDF (generate); 级 s: 延迟 D=64>>s, 相位位 cnt[6-s],
    // 级 1-4 差值路乘旋转因子 (索引 k·2^(s-1)), 级 5 乘 {1,+j}, 级 6 无
    //==========================================================================
    generate
        for (genvar s = 1; s <= 6; s++) begin : g_stage
            localparam int D  = 64 >> s;          // 32,16,8,4,2,1
            localparam bit SH = (s == 2 || s == 4 || s == 6);  // 本级右移 1

            logic [5:0]             r_cnt;        // 本级输入拍计数
            logic                   w_c;          // 相位: 0=填充, 1=蝶形
            logic signed [P_W-1:0]  fifo_re [0:D-1];
            logic signed [P_W-1:0]  fifo_im [0:D-1];
            logic signed [P_W-1:0]  w_fre, w_fim; // FIFO 出口
            logic signed [P_W-1:0]  w_bre, w_bim; // 蝶形/直通结果 (移位前)
            logic signed [P_W-1:0]  w_sre, w_sim; // 移位后
            logic                   r_bv;         // 蝶形输出 valid (1 拍)
            logic [5:0]             r_bidx;       // 输出样点序号跟踪

            assign w_c   = r_cnt[6-s];
            assign w_fre = fifo_re[D-1];
            assign w_fim = fifo_im[D-1];

            always_ff @(posedge i_clk) begin
                if (i_rst)                     r_cnt <= '0;
                else if (i_beat && w_v[s-1])   r_cnt <= r_cnt + 1'b1;
            end

            // FIFO (SRL, 不复位): c=0 存入 x; c=1 存入差 fifo-x
            always_ff @(posedge i_clk) begin
                if (i_beat && w_v[s-1]) begin
                    fifo_re[0] <= w_c ? (w_fre - w_re[s-1]) : w_re[s-1];
                    fifo_im[0] <= w_c ? (w_fim - w_im[s-1]) : w_im[s-1];
                    for (int i = 1; i < D; i++) begin
                        fifo_re[i] <= fifo_re[i-1];
                        fifo_im[i] <= fifo_im[i-1];
                    end
                end
            end

            // 蝶形结果: c=1 → 和 (直通无舍入); c=0 → FIFO 中上一块的差值
            assign w_bre = w_c ? (w_fre + w_re[s-1]) : w_fre;
            assign w_bim = w_c ? (w_fim + w_im[s-1]) : w_fim;
            assign w_sre = SH ? (w_bre >>> 1) : w_bre;
            assign w_sim = SH ? (w_bim >>> 1) : w_bim;

            // 本级输出 valid: 前 D 拍 (首块填充) 无效, 之后每拍有效
            logic r_warm;
            always_ff @(posedge i_clk) begin
                if (i_rst)                                   r_warm <= 1'b0;
                else if (i_beat && w_v[s-1] && r_cnt == 6'(D-1)) r_warm <= 1'b1;
            end

            if (s <= 4) begin : g_tw
                // 差值路旋转乘: 索引 k = (输出块内序号)·2^(s-1); c=1 直通
                logic                   r_mv;     // 乘级 valid
                logic                   r_bp;     // 直通标志 (和相位)
                logic signed [P_W-1:0]  r_are, r_aim;      // 操作数寄存
                logic signed [15:0]     r_wc, r_ws;
                logic signed [P_W+15:0] r_m1, r_m2, r_m3, r_m4;
                logic                   r_m2v, r_m2bp;
                logic signed [P_W-1:0]  r_bpre1, r_bpim1;
                logic [4:0]             w_tk;

                // c=0 输出的是上一块差值序列, 其块内序号 = r_cnt mod D
                assign w_tk = 5'((6'(r_cnt) & 6'(D-1)) << (s-1));

                always_ff @(posedge i_clk) begin
                    if (i_rst) begin
                        r_mv  <= 1'b0;
                        r_m2v <= 1'b0;
                    end else if (i_beat) begin
                        r_mv  <= w_v[s-1] && r_warm;
                        r_m2v <= r_mv;
                    end
                end

                always_ff @(posedge i_clk) begin
                    if (i_beat) begin
                        r_bp   <= w_c;            // c=1 (和) 直通
                        r_are  <= w_sre;
                        r_aim  <= w_sim;
                        r_wc   <= P_TWC[w_tk];
                        r_ws   <= P_TWS[w_tk];
                        // 乘级 (DSP 流水, 不复位 §10.2)
                        r_m1   <= r_are * r_wc;
                        r_m2   <= r_aim * r_ws;
                        r_m3   <= r_are * r_ws;
                        r_m4   <= r_aim * r_wc;
                        r_m2bp <= r_bp;
                        r_bpre1 <= r_are;  r_bpim1 <= r_aim;
                    end
                end

                // (a+jb)(c+js): re = ac-bs, im = as+bc; 舍入 (+8192)>>>14
                // 旁路 (和相位) 与乘结果同级对齐: r_bpre1 与 r_m1 均对应 T0
                logic signed [P_W-1:0] w_ore, w_oim;
                assign w_ore = r_m2bp ? r_bpre1
                             : P_W'((r_m1 - r_m2 + 36'sd8192) >>> 14);
                assign w_oim = r_m2bp ? r_bpim1
                             : P_W'((r_m3 + r_m4 + 36'sd8192) >>> 14);

                assign w_v[s]  = r_m2v;
                assign w_re[s] = w_ore;
                assign w_im[s] = w_oim;
            end else if (s == 5) begin : g_j
                // 平凡因子 {1, +j}: 差值路 k∈{0,1}: k=1 → ×(+j): (re,im)→(-im,re)
                logic r_jv, r_jrot;
                logic signed [P_W-1:0] r_jre, r_jim;
                always_ff @(posedge i_clk) begin
                    if (i_rst) r_jv <= 1'b0;
                    else if (i_beat) r_jv <= w_v[s-1] && r_warm;
                end
                always_ff @(posedge i_clk) begin
                    if (i_beat) begin
                        r_jrot <= (!w_c) && r_cnt[0];   // 差值路第 2 点
                        r_jre  <= w_sre;
                        r_jim  <= w_sim;
                    end
                end
                assign w_v[s]  = r_jv;
                assign w_re[s] = r_jrot ? -r_jim : r_jre;
                assign w_im[s] = r_jrot ?  r_jre : r_jim;
            end else begin : g_last
                logic r_lv;
                logic signed [P_W-1:0] r_lre, r_lim;
                always_ff @(posedge i_clk) begin
                    if (i_rst) r_lv <= 1'b0;
                    else if (i_beat) r_lv <= w_v[s-1] && r_warm;
                end
                always_ff @(posedge i_clk) begin
                    if (i_beat) begin
                        r_lre <= w_sre;
                        r_lim <= w_sim;
                    end
                end
                assign w_v[s]  = r_lv;
                assign w_re[s] = r_lre;
                assign w_im[s] = r_lim;
            end
        end
    endgenerate

    //==========================================================================
    // 输出级: Q2.14 域值 → Q3.13 ((x+1)>>>1) + sat16; 位反序序号计数
    //==========================================================================
    logic       ro_valid;
    logic [5:0] ro_idx, r_ocnt;
    logic signed [DATA_W-1:0] ro_re, ro_im;
    logic signed [P_W-1:0]    w_hre, w_him;

    assign w_hre = (w_re[6] + 20'sd1) >>> 1;
    assign w_him = (w_im[6] + 20'sd1) >>> 1;

    // o_idx = 输出样点顺序号 n (0..63 循环, SDF 输出为位反序排列), 下游按
    // {n[0],n[1],n[2],n[3],n[4],n[5]} 写地址完成重排; 先用后加保证同拍对齐
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid <= 1'b0;
            r_ocnt   <= '0;
            ro_idx   <= '0;
        end else if (i_beat) begin
            ro_valid <= w_v[6];
            if (w_v[6]) begin
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
