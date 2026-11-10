//==============================================================================
// demap_metric — 单轴 max-log metric: metric[b] = min(d2 | b=1) - min(d2 | b=0)
//
// 规格来自 models/comm/ofdm/src/rtl_mirror_demap.m, 判据见 tb/tb_demap_metric.sv
// (TB 先行)。两轴各例化一个, 由 mod_demapper 顶层组合。
//
// ## 8 槽位统一化 —— 三档调制共用一条数据通路
//
//   QPSK  槽 0-3 = -2896, 槽 4-7 = +2896                (每电平复制 4 份)
//   16QAM 槽 0,1=-3886 2,3=-1295 4,5=+1295 6,7=+3886    (每电平复制 2 份)
//   64QAM 槽 0..7 = -4424 -3160 -1896 -632 +632 +1896 +3160 +4424
//
//   复制不改变 min 的结果 (重复项的 min 还是它自己), 换来的是**掩码与调制无关**:
//     b0 -> 8'b1111_0000    b1 -> 8'b0011_1100    b2 -> 8'b0110_0110
//   Gray 标号在三档之间是嵌套的 —— 这是从 mod_mapper 枚举查出来的, 不是凑的。
//
//   推论: QPSK 的 m1/m2 与 16QAM 的 m2 **恒为 0**, 因为掩码两侧取到同一组电平。
//   故上层无须按调制屏蔽未用的 metric。tb_demap_metric 的 T4 锁住这条。
//
// ## 流水线 (延迟 5)
//   ri_  输入寄存
//   r1_  diff[j] = y - lev[j]                     s17
//   r2_  sq[j]   = diff[j]^2                      u32   (8 个乘法器)
//   r3_  min 树 (每比特两棵 4 路) 与相减           s33
//   ro_  输出寄存
//==============================================================================
`default_nettype none

module demap_metric #(
    parameter int P_DATA_W = 16
)(
    input  wire                        i_clk,
    input  wire                        i_rst,      // 同步高有效
    input  wire                        i_valid,
    input  wire signed [P_DATA_W-1:0]  i_y,        // Q4.12
    input  wire [1:0]                  i_mod,      // 0=QPSK 1=16QAM 2=64QAM

    output wire                        o_valid,
    output wire signed [32:0]          o_m0,
    output wire signed [32:0]          o_m1,
    output wire signed [32:0]          o_m2
);

    //--------------------------------------------------------------------------
    // 电平表 (Q4.12 整数, 与 rtl_mirror_demap 的 info.levels 逐值相同)
    //--------------------------------------------------------------------------
    function automatic logic signed [15:0] f_lev(input logic [1:0] m, input int j);
        case (m)
            2'd0: f_lev = (j < 4) ? -16'sd2896 : 16'sd2896;
            2'd1: case (j / 2)
                      0: f_lev = -16'sd3886;
                      1: f_lev = -16'sd1295;
                      2: f_lev =  16'sd1295;
                      default: f_lev = 16'sd3886;
                  endcase
            default: case (j)
                      0: f_lev = -16'sd4424;
                      1: f_lev = -16'sd3160;
                      2: f_lev = -16'sd1896;
                      3: f_lev =  -16'sd632;
                      4: f_lev =   16'sd632;
                      5: f_lev =  16'sd1896;
                      6: f_lev =  16'sd3160;
                      default: f_lev = 16'sd4424;
                  endcase
        endcase
    endfunction

    function automatic logic [31:0] f_min2(input logic [31:0] a, input logic [31:0] b);
        f_min2 = (a < b) ? a : b;
    endfunction

    //--------------------------------------------------------------------------
    // ri_ 输入寄存 (红线: 输入必须先寄存)
    //--------------------------------------------------------------------------
    logic                     ri_valid;
    logic signed [P_DATA_W-1:0] ri_y;
    logic [1:0]               ri_mod;

    // 控制受复位; **数据通路少复位** (hdl §1.1) —— 由 valid 链把关, 复位不必清零。
    // 给数据通路加复位会抬高控制集, 且下游 r2_sq 是乘法器的输出寄存器: 带复位会挡住
    // DSP 内部寄存器的吸收, 把乘法赶到 LUT 上。tb_demap_reset 的 T3 反过来锁这一点 ——
    // 少复位不是"忘了写", 是有意的, 谁顺手补上就会在 T3 上失败。
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid <= 1'b0;
            ri_mod   <= 2'd0;
        end else begin
            ri_valid <= i_valid;
            ri_mod   <= i_mod;
        end
    end

    always_ff @(posedge i_clk) ri_y <= i_y;

    //--------------------------------------------------------------------------
    // r1_ 差值
    //--------------------------------------------------------------------------
    logic               r1_valid;
    logic signed [16:0] r1_d [0:7];

    always_ff @(posedge i_clk) begin
        if (i_rst) r1_valid <= 1'b0;
        else       r1_valid <= ri_valid;
    end

    always_ff @(posedge i_clk) begin
        for (int j = 0; j < 8; j++)
            r1_d[j] <= 17'(ri_y) - 17'(f_lev(ri_mod, j));
    end

    //--------------------------------------------------------------------------
    // r2_ 平方 —— d2 <= (32768+4424)^2 = 1.383e9 < 2^31, u32 够
    //--------------------------------------------------------------------------
    logic        r2_valid;
    logic [31:0] r2_sq [0:7];

    always_ff @(posedge i_clk) begin
        if (i_rst) r2_valid <= 1'b0;
        else       r2_valid <= r1_valid;
    end

    // r2_sq 是乘法器输出寄存器 —— 这一处的少复位最要紧, 带复位会挡住 DSP 吸收
    always_ff @(posedge i_clk) begin
        for (int j = 0; j < 8; j++)
            r2_sq[j] <= 32'(r1_d[j] * r1_d[j]);
    end

    //--------------------------------------------------------------------------
    // r3_ min 树 + 相减
    //   b0 ones={4,5,6,7} zeros={0,1,2,3}
    //   b1 ones={2,3,4,5} zeros={0,1,6,7}
    //   b2 ones={1,2,5,6} zeros={0,3,4,7}
    //--------------------------------------------------------------------------
    logic              r3_valid;
    logic signed [32:0] r3_m0, r3_m1, r3_m2;

    wire [31:0] w_o0 = f_min2(f_min2(r2_sq[4], r2_sq[5]), f_min2(r2_sq[6], r2_sq[7]));
    wire [31:0] w_z0 = f_min2(f_min2(r2_sq[0], r2_sq[1]), f_min2(r2_sq[2], r2_sq[3]));
    wire [31:0] w_o1 = f_min2(f_min2(r2_sq[2], r2_sq[3]), f_min2(r2_sq[4], r2_sq[5]));
    wire [31:0] w_z1 = f_min2(f_min2(r2_sq[0], r2_sq[1]), f_min2(r2_sq[6], r2_sq[7]));
    wire [31:0] w_o2 = f_min2(f_min2(r2_sq[1], r2_sq[2]), f_min2(r2_sq[5], r2_sq[6]));
    wire [31:0] w_z2 = f_min2(f_min2(r2_sq[0], r2_sq[3]), f_min2(r2_sq[4], r2_sq[7]));

    always_ff @(posedge i_clk) begin
        if (i_rst) r3_valid <= 1'b0;
        else       r3_valid <= r2_valid;
    end

    always_ff @(posedge i_clk) begin
        r3_m0 <= 33'({1'b0, w_o0}) - 33'({1'b0, w_z0});
        r3_m1 <= 33'({1'b0, w_o1}) - 33'({1'b0, w_z1});
        r3_m2 <= 33'({1'b0, w_o2}) - 33'({1'b0, w_z2});
    end

    //--------------------------------------------------------------------------
    // ro_ 输出寄存 (红线: 输出必须寄存)
    //--------------------------------------------------------------------------
    logic               ro_valid;
    logic signed [32:0] ro_m0, ro_m1, ro_m2;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_valid <= 1'b0;
        else       ro_valid <= r3_valid;
    end

    always_ff @(posedge i_clk) begin
        ro_m0 <= r3_m0;
        ro_m1 <= r3_m1;
        ro_m2 <= r3_m2;
    end

    assign o_valid = ro_valid;
    assign o_m0    = ro_m0;
    assign o_m1    = ro_m1;
    assign o_m2    = ro_m2;

endmodule

`default_nettype wire
