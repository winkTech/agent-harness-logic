//==============================================================================
// cordic_core — 流水线 CORDIC (vector / rotation 双模)
// 功能: vector 模式求 atan2(y,x) -> o_phase (Q1.15, 单位 rad/pi);
//       rotation 模式把 (x,y) 旋转 i_phi 角度 -> (o_xo, o_yo)
// 端口: i_clk/i_rst (同步复位, 高有效); i_start/i_mode/i_xi/i_yi/i_phi;
//       o_done/o_xo/o_yo/o_phase
// 主要逻辑: ri_ 级预缩放装载 -> STAGES 级移位-加减迭代流水 -> ro_ 寄存输出
// 延迟: i_start 到 o_done 共 STAGES+2 拍 (装载 1 + 迭代 STAGES + 输出寄存 1)
// 复位: 同步高有效, 全部流水寄存器统一复位
//
// 本文件为 hdl-coding 规范修复版。相对修复前 (git 历史) 的行为差异:
//   (1) 复位由 "异步低有效 negedge rst_n" 改为 "同步高有效 i_rst";
//   (2) 迭代级原先完全无复位, valid/x/y/z/phase 上电为 X 并会随流水传播,
//       现补同步复位, 复位后全链为确定值;
//   (3) 输出由"寄存器别名 assign"改为显式 ro_ 输出寄存 -> 延迟 +1 拍。
//
// !! 遗留功能缺陷 (承自原始代码, 本次规范修复**未改其逻辑**, 仅如实标注) !!
//   [F1] 迭代级里 vector 模式只更新 phase_pipe 不更新 z_pipe, rotation 模式只更新
//        z_pipe 不更新 phase_pipe。未被赋值的那一路**不会随流水前移**, 停在该级
//        上一次的残值, 因此 rotation 模式下 o_phase、vector 模式下的 z 通路都是
//        脏数据。正确做法是两路都无条件逐级搬移, 只在对应模式下做加减。
//   [F2] ANG 表固定 12 项, 而 STAGES 是可配参数 —— STAGES != 12 时越界或漏用。
//   [F3] 装载级 `$signed(i_xi) * GAIN_SCALE / 32768` 用了除法且未做溢出保护,
//        综合出来是常数乘 + 移位, 但位宽 DATA_W+4 对增益补偿后的中间值是否够,
//        原始代码未论证。
//   以上三项均需算法侧决策, 不在编码规范修复范围内, 故只标注不擅改。
//   注: 本模块在 sync_top 中未被例化 (孤立模块), 上述缺陷当前不影响顶层行为。
//==============================================================================
module cordic_core #(
    parameter int DATA_W    = 16,
    parameter int PHASE_W   = 16,
    parameter int STAGES    = 12
)(
    input  logic                     i_clk,
    input  logic                     i_rst,     // 同步复位, 高有效
    input  logic                     i_start,
    input  logic                     i_mode,    // 0=rotation, 1=vector (atan2)
    input  logic signed [DATA_W-1:0] i_xi,
    input  logic signed [DATA_W-1:0] i_yi,
    input  logic [PHASE_W-1:0]       i_phi,     // target angle (rotation mode)
    output logic                     o_done,
    output logic signed [DATA_W-1:0] o_xo,
    output logic signed [DATA_W-1:0] o_yo,
    output logic [PHASE_W-1:0]       o_phase    // estimated phase (vector mode)
);
    // CORDIC angle constants (atan(2^-i) * 2^(PHASE_W-1) / pi)
    // For i=0..11: atan(2^-i) * 32768 / pi
    localparam int ANG[0:STAGES-1] = '{
        16384, 9672, 5110, 2594, 1302, 652, 326, 163, 81, 41, 20, 10
    };
    localparam int GAIN_SCALE = 19898;  // 1/CORDIC_gain * 2^(DATA_W-1)

    // 流水寄存器组 (下标 0 即红线 1 要求的 ri_ 输入寄存级)
    logic signed [DATA_W+3:0] r_x_pipe     [0:STAGES];
    logic signed [DATA_W+3:0] r_y_pipe     [0:STAGES];
    logic [PHASE_W-1:0]       r_z_pipe     [0:STAGES];
    logic [PHASE_W-1:0]       r_phase_pipe [0:STAGES];
    logic                     r_mode_pipe  [0:STAGES];
    logic                     r_valid_pipe [0:STAGES];

    //==========================================================================
    // ri_ 装载级 (红线 1): 输入端口经此级寄存后才进入迭代流水
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_valid_pipe[0] <= 1'b0;
            r_x_pipe[0]     <= '0;
            r_y_pipe[0]     <= '0;
            r_z_pipe[0]     <= '0;
            r_phase_pipe[0] <= '0;
            r_mode_pipe[0]  <= 1'b0;
        end else if (i_start) begin
            r_valid_pipe[0] <= 1'b1;
            r_x_pipe[0]     <= $signed(i_xi) * GAIN_SCALE / 32768;
            r_y_pipe[0]     <= $signed(i_yi) * GAIN_SCALE / 32768;
            r_z_pipe[0]     <= i_phi;
            r_phase_pipe[0] <= '0;
            r_mode_pipe[0]  <= i_mode;
        end else begin
            r_valid_pipe[0] <= 1'b0;
        end
    end

    //==========================================================================
    // CORDIC 迭代流水
    //==========================================================================
    genvar i;
    generate
        for (i = 0; i < STAGES; i++) begin : cordic_stage
            always_ff @(posedge i_clk) begin
                if (i_rst) begin
                    r_valid_pipe[i+1] <= 1'b0;
                    r_mode_pipe[i+1]  <= 1'b0;
                    r_x_pipe[i+1]     <= '0;
                    r_y_pipe[i+1]     <= '0;
                    r_z_pipe[i+1]     <= '0;
                    r_phase_pipe[i+1] <= '0;
                end else begin
                    r_valid_pipe[i+1] <= r_valid_pipe[i];
                    r_mode_pipe[i+1]  <= r_mode_pipe[i];

                    if (r_valid_pipe[i]) begin
                        if (r_mode_pipe[i]) begin
                            // Vector mode: rotate towards x-axis
                            if (r_y_pipe[i] >= 0) begin
                                r_x_pipe[i+1]     <= r_x_pipe[i] + (r_y_pipe[i] >>> i);
                                r_y_pipe[i+1]     <= r_y_pipe[i] - (r_x_pipe[i] >>> i);
                                r_phase_pipe[i+1] <= r_phase_pipe[i] + ANG[i];
                            end else begin
                                r_x_pipe[i+1]     <= r_x_pipe[i] - (r_y_pipe[i] >>> i);
                                r_y_pipe[i+1]     <= r_y_pipe[i] + (r_x_pipe[i] >>> i);
                                r_phase_pipe[i+1] <= r_phase_pipe[i] - ANG[i];
                            end
                        end else begin
                            // Rotation mode: rotate by target angle
                            if (r_z_pipe[i] >= 0) begin
                                r_x_pipe[i+1] <= r_x_pipe[i] - (r_y_pipe[i] >>> i);
                                r_y_pipe[i+1] <= r_y_pipe[i] + (r_x_pipe[i] >>> i);
                                r_z_pipe[i+1] <= r_z_pipe[i] - ANG[i];
                            end else begin
                                r_x_pipe[i+1] <= r_x_pipe[i] + (r_y_pipe[i] >>> i);
                                r_y_pipe[i+1] <= r_y_pipe[i] - (r_x_pipe[i] >>> i);
                                r_z_pipe[i+1] <= r_z_pipe[i] + ANG[i];
                            end
                        end
                    end
                end
            end
        end
    endgenerate

    //==========================================================================
    // ro_ 输出寄存 (红线 2)
    //==========================================================================
    logic                     ro_done;
    logic signed [DATA_W-1:0] ro_xo, ro_yo;
    logic [PHASE_W-1:0]       ro_phase;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_done  <= 1'b0;
            ro_xo    <= '0;
            ro_yo    <= '0;
            ro_phase <= '0;
        end else begin
            ro_done  <= r_valid_pipe[STAGES];
            ro_xo    <= r_x_pipe[STAGES][DATA_W-1:0];
            ro_yo    <= r_y_pipe[STAGES][DATA_W-1:0];
            ro_phase <= r_phase_pipe[STAGES];
        end
    end

    assign o_done  = ro_done;
    assign o_xo    = ro_xo;
    assign o_yo    = ro_yo;
    assign o_phase = ro_phase;

endmodule : cordic_core
