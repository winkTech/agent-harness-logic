`default_nettype none
//==============================================================================
// delay_line — 定长流水延迟线 (valid 标记, 无背压)
// 功能: o_valid/o_data 是 i_valid/i_data 精确延迟 P_DELAY 拍的副本
// 端口: i_clk/i_rst(同步高有效); i_valid/i_data -> o_valid/o_data
// 主要逻辑: ri_ 输入寄存(第 1 拍) -> 中间移位链(P_DELAY-2 拍) -> ro_ 输出寄存
// 延迟: 恒等于 P_DELAY 拍 (P_DELAY >= 2: 红线 1/2 要求входные/输出各占一级)
// 吞吐: 1 拍/beat, 自由流水
// 背压: 无 tready(与 complex_multiplier 同约定)。需要背压时在输出侧例化
//       axis_skid_buffer, 不要在本模块内加 ready —— 那正是原 pipe_delay
//       模板出错的地方
// 复位: valid 链清零; 数据链不复位 —— 数据由 valid 门控, 不复位可省复位
//       扇出并让综合器推断 SRL 移位寄存器
//
// 来源: 取代 skills/hdl-coding/templates/comm/ 下两件:
//   pipe_delay.sv (v1.0.0) — 带 valid/ready 版本。缺陷:
//     (1) assign o_ready = w_stage0_advance, 组合依赖链穿到 i_ready,
//         输入端口组合直出输出端口 (违反红线 2, 与 axis_pipeline_reg 同类);
//     (2) 各级 advance 共用末级 w_advance, 是"全局停顿"而非逐级吸收,
//         中间气泡无法压缩, 且 stage0 清 valid 条件 (w_advance && !i_valid)
//         在 i_valid=1 但 stage0 不推进时错误保留旧 valid;
//     (3) 复位清数据链, 阻止 SRL 推断。
//   delay_sync.v (v1.0.0) — 纯数据版本。缺陷: 端口无 i_/o_ 前缀
//     (clock/reset/data_in/data_out), 无 valid 语义, 复位清数据链。
//   裁决: 定长延迟 + 背压是两个正交职责, 分别由本模块与 axis_skid_buffer
//   承担; 不再提供带 ready 的延迟线。
//==============================================================================
module delay_line #(
    parameter int P_DWIDTH = 32,
    parameter int P_DELAY  = 2      // 总延迟拍数, 最小 2
)(
    input  wire logic                i_clk,
    input  wire logic                i_rst,      // 同步复位, 高有效

    input  wire logic                i_valid,
    input  wire logic [P_DWIDTH-1:0] i_data,

    output logic                     o_valid,
    output logic [P_DWIDTH-1:0]      o_data
);

    // 编译期契约: P_DELAY >= 2 (输入/输出寄存各占一级)
    if (P_DELAY < 2) $error("delay_line: P_DELAY 最小为 2");

    localparam int P_MID = P_DELAY - 2;   // 中间移位级数

    //==========================================================================
    // 输入寄存 (红线 1)
    //==========================================================================
    logic                ri_valid;
    logic [P_DWIDTH-1:0] ri_data;

    always_ff @(posedge i_clk) begin
        if (i_rst) ri_valid <= 1'b0;
        else       ri_valid <= i_valid;
    end

    // 数据链不复位 (SRL 友好), 由 valid 门控
    always_ff @(posedge i_clk) begin
        ri_data <= i_data;
    end

    //==========================================================================
    // 中间移位链 (P_DELAY > 2 时存在)
    //==========================================================================
    logic                w_last_valid;
    logic [P_DWIDTH-1:0] w_last_data;

    generate
        if (P_MID == 0) begin : gen_direct
            assign w_last_valid = ri_valid;
            assign w_last_data  = ri_data;
        end else begin : gen_chain
            logic                r_valid_pipe [0:P_MID-1];
            logic [P_DWIDTH-1:0] r_data_pipe  [0:P_MID-1];

            always_ff @(posedge i_clk) begin
                if (i_rst) begin
                    for (int k = 0; k < P_MID; k++) r_valid_pipe[k] <= 1'b0;
                end else begin
                    r_valid_pipe[0] <= ri_valid;
                    for (int k = 1; k < P_MID; k++)
                        r_valid_pipe[k] <= r_valid_pipe[k-1];
                end
            end

            always_ff @(posedge i_clk) begin
                r_data_pipe[0] <= ri_data;
                for (int k = 1; k < P_MID; k++)
                    r_data_pipe[k] <= r_data_pipe[k-1];
            end

            assign w_last_valid = r_valid_pipe[P_MID-1];
            assign w_last_data  = r_data_pipe[P_MID-1];
        end
    endgenerate

    //==========================================================================
    // 输出寄存 (红线 2)
    //==========================================================================
    logic                ro_valid;
    logic [P_DWIDTH-1:0] ro_data;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_valid <= 1'b0;
        else       ro_valid <= w_last_valid;
    end

    always_ff @(posedge i_clk) begin
        ro_data <= w_last_data;
    end

    assign o_valid = ro_valid;
    assign o_data  = ro_data;

endmodule
`default_nettype wire
