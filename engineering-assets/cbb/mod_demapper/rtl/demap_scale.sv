//==============================================================================
// demap_scale — 加权 / 移位 / 饱和末级
//
//   llr = sat10( (metric * wman + 2^(sh'-1)) >>> sh' ),  sh' = 67 - sh - log2K
//
// 规格来自 models/comm/ofdm/src/rtl_mirror_demap.m, 判据见 tb/tb_demap_scale.sv
// (TB 先行)。三档调制共用一个实例, 由 mod_demapper 顶层按比特分时复用。
//
// ## sh' >= 48 直接给 0 —— 这是可证的, 不是近似
//
//   |metric| <= (32768+4424)^2 = 1.383e9, wman <= 65024
//   => |积| <= 8.99e13 < 2^46.4
//   sh' >= 48 时 |积| < 2^(sh'-1), 于是
//     积 >= 0: 0 <= 积 + 半量 < 2^sh'          -> 商 0
//     积 <  0: 0 <  积 + 半量 < 2^(sh'-1)      -> 商 0
//   两支都恰为 0。省掉的是一个 **67 位**加法器 (sh'=66 时半量 = 2^65) 与同宽的
//   移位器 —— 不省的话这一级会成为整个件的面积与时序瓶颈。
//
//   捷径**由 TB 验证而非被相信**: tb_demap_scale 的参考模型走 64 位全精度完整式子,
//   sh' 逐值扫 28..66, 47/48 分界两侧若有一处不成立立刻分岔。
//
// ## 流水线 (延迟 5)
//   ri_  输入寄存
//   r1_  prod = metric * wman                 s49
//   r2_  sum  = prod + 半量                    s50   (sh'>=48 时置 0 并打标记)
//   r3_  算术右移 + 饱和                       s10
//   ro_  输出寄存
//==============================================================================
`default_nettype none

module demap_scale #(
    parameter int P_LLR_W = 10
)(
    input  wire                       i_clk,
    input  wire                       i_rst,       // 同步高有效
    input  wire                       i_valid,
    input  wire signed [32:0]         i_metric,
    input  wire [15:0]                i_wman,
    input  wire [6:0]                 i_shift,     // sh' in [28, 66], 故 7 位
    input  wire                       i_erasure,

    output wire                       o_valid,
    output wire signed [P_LLR_W-1:0]  o_llr
);

    // 饱和限。写成 50 位与 P_LLR_W 位两份常量, 是因为 iverilog 12 不接受
    // 50'sd(<表达式>) 这种带括号的定宽字面量, 只能先定型再用。
    localparam int                    SAT_HI  =  (1 << (P_LLR_W - 1)) - 1;   // +511
    localparam int                    SAT_LO  = -(1 << (P_LLR_W - 1));       // -512
    localparam logic signed [49:0]    C_HI50  = 50'(SAT_HI);
    localparam logic signed [49:0]    C_LO50  = 50'(SAT_LO);
    localparam logic signed [P_LLR_W-1:0] C_HI = P_LLR_W'(SAT_HI);
    localparam logic signed [P_LLR_W-1:0] C_LO = P_LLR_W'(SAT_LO);

    //--------------------------------------------------------------------------
    // ri_ 输入寄存
    //--------------------------------------------------------------------------
    logic               ri_valid;
    logic signed [32:0] ri_metric;
    logic [15:0]        ri_wman;
    logic [6:0]         ri_shift;
    logic               ri_er;

    // 控制 (valid / 各标志) 受复位; **数据载荷少复位** (hdl §1.1)。
    // r1_prod 是乘法器输出寄存器, 带复位会挡住 DSP 内部寄存器吸收; r2_sum 是 50 位
    // 加法器输出, 加复位纯属抬高控制集。载荷在复位期间是旧值 —— 无人采样, 因为
    // valid 链已经清零。tb_demap_reset 的 T3 反过来锁这一点。
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid  <= 1'b0;
            ri_er     <= 1'b0;
        end else begin
            ri_valid  <= i_valid;
            ri_er     <= i_erasure;
        end
    end

    always_ff @(posedge i_clk) begin
        ri_metric <= i_metric;
        ri_wman   <= i_wman;
        ri_shift  <= i_shift;
    end

    //--------------------------------------------------------------------------
    // r1_ 乘积 s49
    //--------------------------------------------------------------------------
    logic               r1_valid;
    logic signed [48:0] r1_prod;
    logic [6:0]         r1_shift;
    logic               r1_er;
    logic               r1_big;              // sh' >= 48 -> 结果可证恒 0

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r1_valid <= 1'b0;
            r1_er    <= 1'b0;
            r1_big   <= 1'b0;
        end else begin
            r1_valid <= ri_valid;
            r1_er    <= ri_er;
            r1_big   <= (ri_shift >= 7'd48);
        end
    end

    always_ff @(posedge i_clk) begin
        r1_prod  <= 49'(ri_metric * $signed({1'b0, ri_wman}));
        r1_shift <= ri_shift;
    end

    //--------------------------------------------------------------------------
    // r2_ 加半量 —— 只在 sh' < 48 时有意义, 故半量最大 2^46, s50 够
    //--------------------------------------------------------------------------
    logic               r2_valid;
    logic signed [49:0] r2_sum;
    logic [6:0]         r2_shift;
    logic               r2_zero;             // 输出应强制为 0

    wire signed [49:0] w_half = r1_big ? 50'sd0
                                       : (50'sd1 <<< (r1_shift - 7'd1));

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r2_valid <= 1'b0;
            r2_zero  <= 1'b0;
        end else begin
            r2_valid <= r1_valid;
            r2_zero  <= r1_big | r1_er;
        end
    end

    always_ff @(posedge i_clk) begin
        r2_sum   <= 50'(r1_prod) + w_half;
        r2_shift <= r1_shift;
    end

    //--------------------------------------------------------------------------
    // r3_ 算术右移 + 饱和 (必须饱和, 回绕会变号 —— 那在译码器眼里是
    //     "高置信度的错误比特", 比截断恶劣得多)
    //--------------------------------------------------------------------------
    logic                     r3_valid;
    logic signed [P_LLR_W-1:0] r3_llr;

    wire signed [49:0] w_shifted = r2_sum >>> r2_shift;

    always_ff @(posedge i_clk) begin
        if (i_rst) r3_valid <= 1'b0;
        else       r3_valid <= r2_valid;
    end

    always_ff @(posedge i_clk) begin
        if (r2_zero)                    r3_llr <= '0;
        else if (w_shifted > C_HI50)    r3_llr <= C_HI;
        else if (w_shifted < C_LO50)    r3_llr <= C_LO;
        else                            r3_llr <= w_shifted[P_LLR_W-1:0];
    end

    //--------------------------------------------------------------------------
    // ro_ 输出寄存
    //--------------------------------------------------------------------------
    logic                      ro_valid;
    logic signed [P_LLR_W-1:0] ro_llr;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_valid <= 1'b0;
        else       ro_valid <= r3_valid;
    end

    always_ff @(posedge i_clk) ro_llr <= r3_llr;

    assign o_valid = ro_valid;
    assign o_llr   = ro_llr;

endmodule

`default_nettype wire
