//==============================================================================
// cordic_rot_pipe — 流水线 CORDIC 旋转器 (每拍一样点, ADR-003 CFO 校正)
// 功能: 对样点流做复数旋转 (x+jy)·e^{j·θ}, θ 逐样点可变 (NCO 相位斜坡)。
//       含 CORDIC 增益 A≈1.6468 — 调用方须对输入预缩放 K=9949/2^14 (1/A),
//       净增益 ≈1 (直通段 θ=0 时输出 ≈ 输入 ± 数 LSB 量化抖动, ADR-003 契约)。
// 端口: i_clk/i_rst (同步复位, 高有效); i_ce 拍使能 (与样点流同步推进);
//       i_valid/i_x/i_y/i_phase -> o_valid/o_x/o_y; 延迟 16 个 ce 拍
//       (预旋转 1 + 迭代 14 + 输出寄存 1)
// 主要逻辑: 象限预旋转 (|θ|>π/2 转 π) -> 14 级展开迭代 -> ro_ 输出寄存
// 复位: 同步高有效, 仅 valid 链复位; 数据级不复位 (§1.1, 由 o_valid 屏蔽)
//
// 定点约定 (与 generate_vectors.m 位真镜像逐字一致, 常数同 cordic_cv):
//   角度 Q3.13; atan 表 round(atan(2^-i)·2^13); PI=25736, PI/2=12868
//   迭代: d = (z>=0)?+1:-1; x' = x - d·(y>>>i); y' = y + d·(x>>>i);
//         z' = z - d·atan[i]  (与 cordic_cv 旋转模式同式)
//==============================================================================
module cordic_rot_pipe #(
    parameter int P_XY_W = 20,          // 内部 xy 位宽 (含增益余量)
    parameter int P_A_W  = 16,          // 角度位宽 Q3.13
    parameter int P_ITER = 14
)(
    input  logic                     i_clk,
    input  logic                     i_rst,      // 同步复位, 高有效
    input  logic                     i_ce,       // 拍使能 (样点流推进)

    input  logic                     i_valid,
    input  logic signed [P_XY_W-1:0] i_x,
    input  logic signed [P_XY_W-1:0] i_y,
    input  logic signed [P_A_W-1:0]  i_phase,    // Q3.13

    output logic                     o_valid,
    output logic signed [P_XY_W-1:0] o_x,
    output logic signed [P_XY_W-1:0] o_y
);

    localparam logic signed [P_A_W-1:0] P_PI      = 16'sd25736;
    localparam logic signed [P_A_W-1:0] P_PI_HALF = 16'sd12868;

    localparam logic signed [P_A_W-1:0] P_ATAN [P_ITER] = '{
        16'sd6434, 16'sd3798, 16'sd2007, 16'sd1019,
        16'sd511,  16'sd256,  16'sd128,  16'sd64,
        16'sd32,   16'sd16,   16'sd8,    16'sd4,
        16'sd2,    16'sd1
    };

    // 级数组: [0]=预旋转输出, [1..P_ITER]=迭代输出
    logic signed [P_XY_W-1:0] r_x [0:P_ITER];
    logic signed [P_XY_W-1:0] r_y [0:P_ITER];
    logic signed [P_A_W-1:0]  r_z [0:P_ITER];
    logic [P_ITER:0]          r_v;

    //==========================================================================
    // 级 0: 象限预旋转 (本模块输入寄存级, 红线 1)
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_ce) begin
            if (i_phase > P_PI_HALF) begin
                r_x[0] <= -i_x;  r_y[0] <= -i_y;  r_z[0] <= i_phase - P_PI;
            end else if (i_phase < -P_PI_HALF) begin
                r_x[0] <= -i_x;  r_y[0] <= -i_y;  r_z[0] <= i_phase + P_PI;
            end else begin
                r_x[0] <= i_x;   r_y[0] <= i_y;   r_z[0] <= i_phase;
            end
        end
    end

    //==========================================================================
    // 级 1..14: 展开迭代 (数据级不复位 §1.1)
    //==========================================================================
    generate
        for (genvar g = 0; g < P_ITER; g++) begin : g_iter
            always_ff @(posedge i_clk) begin
                if (i_ce) begin
                    if (r_z[g] >= 0) begin
                        r_x[g+1] <= r_x[g] - (r_y[g] >>> g);
                        r_y[g+1] <= r_y[g] + (r_x[g] >>> g);
                        r_z[g+1] <= r_z[g] - P_ATAN[g];
                    end else begin
                        r_x[g+1] <= r_x[g] + (r_y[g] >>> g);
                        r_y[g+1] <= r_y[g] - (r_x[g] >>> g);
                        r_z[g+1] <= r_z[g] + P_ATAN[g];
                    end
                end
            end
        end
    endgenerate

    // valid 链 (控制, 复位)
    always_ff @(posedge i_clk) begin
        if (i_rst)      r_v <= '0;
        else if (i_ce)  r_v <= {r_v[P_ITER-1:0], i_valid};
    end

    //==========================================================================
    // ro_ 输出寄存 (红线 2)
    //==========================================================================
    logic                     ro_valid;
    logic signed [P_XY_W-1:0] ro_x, ro_y;

    always_ff @(posedge i_clk) begin
        if (i_rst)     ro_valid <= 1'b0;
        else if (i_ce) ro_valid <= r_v[P_ITER];
    end

    always_ff @(posedge i_clk) begin
        if (i_ce) begin
            ro_x <= r_x[P_ITER];
            ro_y <= r_y[P_ITER];
        end
    end

    assign o_valid = ro_valid;
    assign o_x     = ro_x;
    assign o_y     = ro_y;

endmodule : cordic_rot_pipe
