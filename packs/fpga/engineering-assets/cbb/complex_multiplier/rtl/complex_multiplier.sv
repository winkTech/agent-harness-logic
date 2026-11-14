`default_nettype none
//==============================================================================
// complex_multiplier — 复数乘法器 (四乘法直算, 全精度)
// 功能: (i_a_re + j*i_a_im) * (i_b_re + j*i_b_im), 有符号全精度输出, 不截断不饱和
// 端口: i_clk/i_rst(同步高有效); i_valid + 四个有符号输入 -> o_valid + o_re/o_im
// 主要逻辑: 输入寄存(ri_) -> 四乘积寄存 -> 加减寄存(ro_)
// 延迟: 3 拍; 吞吐: 1 拍/样点 (数据通路自由流水, 由 valid 标记有效拍)
// 位宽: 乘积 P_A_W+P_B_W 位; 两乘积相加需再进 1 位 => 输出 P_A_W+P_B_W+1 位
//       16x16 时输出 33 位, |re| <= 2*2^30 < 2^32, 数学上不可能溢出
// 定标: 全精度输出, 不做舍入/饱和 —— 定标语义交调用方,
//       避免重蹈库内 4 套互不相同定点语义的覆辙 (rrc/ldpc/channel_est/cn_update)
// 背压: 本核为定长延迟流水, 不带 tready。需要背压时在输出侧例化 axis_skid_buffer
//
// 来源: 改写自 skills/hdl-coding/templates/comm/cmult.sv (v1.0.0)
//   原件缺陷 —— 该模板 SKILL.md 标称"符合本规范", 实测为功能性错误, 四条独立缺陷:
//     (1) 算法公式错。原注释写 "re = P1 + P3 = ac + bd  ✓", 但复数乘法的实部
//         是 ac - bd。正确的三乘法 (Gauss/Karatsuba) 形式应为
//           P1 = c*(a+b), P2 = a*(d-c), P3 = b*(d+c), re = P1 - P3, im = P1 + P2
//         原件写成 P1 = c*(a-b) 且 re = P1+P3 / im = P2+P3, 三处全错;
//         按其代码实际算出 re = ac+bd、im = ad-ac+bd+bc, 虚部完全不成立。
//     (2) 操作数张冠李戴。按其注释约定 a=i_a_re, b=i_a_im, c=i_b_re, d=i_b_im,
//         但 L87 算的是 i_a_re - i_b_re (即 a-c 而非 a-b), L93 把 r_b 赋成
//         i_b_im (即 d 而非 b)。
//     (3) L89-90 的 r_d_plus_c 表达式为 {X} - {X} + i_b_re, 自相抵消后只剩
//         i_b_re; 且该寄存器算完后从未被使用 (死寄存器), 实际用的是 L101 的
//         组合 wire。
//     (4) 流水错拍 + 违反红线 1。L101 的 w_d_plus_c 直接取未寄存的输入端口,
//         却在 L116 与第一级寄存值 r_b 相乘 —— 两者相差一拍, 结果无意义;
//         同时构成输入不寄存直接参与运算。
//   本模块改用四乘法直算: DSP48 每乘法独占一片, 映射直观、位宽推理无歧义;
//   三乘法省 1 个 DSP 但引入额外加法器与位宽增长, 在无实测资源压力前不做该优化。
//==============================================================================
module complex_multiplier #(
    parameter int P_A_W = 16,      // 输入 a 的实/虚部位宽 (有符号)
    parameter int P_B_W = 16       // 输入 b 的实/虚部位宽 (有符号)
)(
    input  wire logic                     i_clk,
    input  wire logic                     i_rst,     // 同步复位, 高有效

    input  wire logic                     i_valid,
    input  wire logic signed [P_A_W-1:0]  i_a_re,
    input  wire logic signed [P_A_W-1:0]  i_a_im,
    input  wire logic signed [P_B_W-1:0]  i_b_re,
    input  wire logic signed [P_B_W-1:0]  i_b_im,

    output logic                          o_valid,
    output logic signed [P_A_W+P_B_W:0]   o_re,
    output logic signed [P_A_W+P_B_W:0]   o_im
);

    localparam int P_PROD_W = P_A_W + P_B_W;       // 单个乘积位宽
    localparam int P_OUT_W  = P_PROD_W + 1;        // 两乘积相加后的位宽

    typedef logic signed [P_OUT_W-1:0] out_t;

    //==========================================================================
    // 输入寄存 (红线 1: 禁止输入直通)
    //==========================================================================
    logic                     ri_valid;
    logic signed [P_A_W-1:0]  ri_a_re;
    logic signed [P_A_W-1:0]  ri_a_im;
    logic signed [P_B_W-1:0]  ri_b_re;
    logic signed [P_B_W-1:0]  ri_b_im;

    //==========================================================================
    // 级 2: 四个乘积 (ac / bd / ad / bc)
    //==========================================================================
    logic signed [P_PROD_W-1:0] r_p_rere;   // a_re * b_re
    logic signed [P_PROD_W-1:0] r_p_imim;   // a_im * b_im
    logic signed [P_PROD_W-1:0] r_p_reim;   // a_re * b_im
    logic signed [P_PROD_W-1:0] r_p_imre;   // a_im * b_re
    logic                       r_valid_m;

    //==========================================================================
    // 输出寄存 (红线 2: 输出必须由 ro_ 驱动)
    //==========================================================================
    logic signed [P_OUT_W-1:0] ro_re;
    logic signed [P_OUT_W-1:0] ro_im;
    logic                      ro_valid;

    //==========================================================================
    // 时序逻辑 级 1: 输入寄存
    // 数据通路自由流水 (不由 valid 门控), 有效性仅由 valid 链标记 —— 与 rrc 一致,
    // 避免使能链成为时序瓶颈; 无效拍的数据虽被计算但被 valid 屏蔽。
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid <= 1'b0;
            ri_a_re  <= '0;
            ri_a_im  <= '0;
            ri_b_re  <= '0;
            ri_b_im  <= '0;
        end else begin
            ri_valid <= i_valid;
            ri_a_re  <= i_a_re;
            ri_a_im  <= i_a_im;
            ri_b_re  <= i_b_re;
            ri_b_im  <= i_b_im;
        end
    end

    //==========================================================================
    // 时序逻辑 级 2: 四乘法 (全部使用同一级的寄存值, 无跨级错拍)
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_p_rere  <= '0;
            r_p_imim  <= '0;
            r_p_reim  <= '0;
            r_p_imre  <= '0;
            r_valid_m <= 1'b0;
        end else begin
            r_p_rere  <= ri_a_re * ri_b_re;
            r_p_imim  <= ri_a_im * ri_b_im;
            r_p_reim  <= ri_a_re * ri_b_im;
            r_p_imre  <= ri_a_im * ri_b_re;
            r_valid_m <= ri_valid;
        end
    end

    //==========================================================================
    // 时序逻辑 级 3: 加减输出
    //   re = a_re*b_re - a_im*b_im
    //   im = a_re*b_im + a_im*b_re
    // 显式拓宽到 P_OUT_W 后再运算, 保证进位位不丢失。
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_re    <= '0;
            ro_im    <= '0;
            ro_valid <= 1'b0;
        end else begin
            ro_re    <= out_t'(r_p_rere) - out_t'(r_p_imim);
            ro_im    <= out_t'(r_p_reim) + out_t'(r_p_imre);
            ro_valid <= r_valid_m;
        end
    end

    //==========================================================================
    // 输出赋值 (仅寄存器到端口的连线, 无组合逻辑)
    //==========================================================================
    assign o_re    = ro_re;
    assign o_im    = ro_im;
    assign o_valid = ro_valid;

endmodule
`default_nettype wire
