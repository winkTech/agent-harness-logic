`default_nettype none
//==============================================================================
// lfsr_gen — 参数化 Fibonacci LFSR 伪随机序列发生器
// 功能: 每次使能推进一步, 输出当前序列字; 本原多项式下周期 2^P_WIDTH-1
// 端口: i_clk/i_rst(同步高有效); i_en 推进使能 -> o_valid + o_data
// 主要逻辑: 输入寄存(ri_) -> LFSR 核 -> 输出寄存(ro_)
// 延迟: i_en 置位后 2 拍 o_valid/o_data 有效; 每个 i_en 拍恰好产出一个字
// 序列: 首字 = P_SEED, 之后按 next = {state[W-2:0], ^(state & P_POLY)} 推进
// 复位: 回 P_SEED 并重新产生完全相同的序列 (确定性)
//
// 抽头约定 (必须读): P_POLY bit[e-1] = 1 表示多项式含 x^e 项。
//   例 16'hB400 = bit15,13,12,10 = x^16+x^14+x^13+x^11+1 (周期 65535)
//   例  7'h60  = bit6,5          = x^7+x^6+1              (周期 127)
//   P_POLY 全 P_WIDTH 位参与反馈, bit[P_WIDTH-1] (x^P_WIDTH 项) 必须为 1。
//
// 来源: 改写自 skills/hdl-coding/templates/comm/lfsr_gen.sv (v1.0.0)
//   原件缺陷 (本模块逐条修复):
//     (1) 功能性错误: 反馈写作 ^(r_lfsr & POLY[WIDTH-2:0]), 掩码截到 W-1 位,
//         把 x^WIDTH 主抽头 (bit15) 丢掉 —— 默认参数下实际反馈多项式已不是
//         标称的 x^16+x^14+x^13+x^11+1, 序列错、周期也不再是 65535;
//     (2) o_valid = i_valid 输入组合直出 (违反红线 2), 且 o_data 是寄存输出、
//         滞后一拍 —— valid 与 data 错拍, 下游按拍采样会采错字;
//     (3) r_done 寄存器写入后从未被读 (死逻辑);
//     (4) 同一 always 内 if(i_valid)/else if(!i_valid) 冗余分支。
//   原件注释中 7 bit 多项式给 7'h41 并标注 "x^7+x^6+1" —— 与其自身 e-1 位
//   映射约定不符 (7'h41 实为 x^7+x^1+1); 本头部 7'h60 才是 x^7+x^6+1,
//   TB 以实测周期 127 钉死该约定。
//==============================================================================
module lfsr_gen #(
    parameter int                 P_WIDTH = 16,
    parameter logic [P_WIDTH-1:0] P_POLY  = 16'hB400,  // 抽头掩码, 见头部约定
    parameter logic [P_WIDTH-1:0] P_SEED  = 16'hACE1   // 初始状态, 全 0 非法
)(
    input  wire logic                i_clk,
    input  wire logic                i_rst,      // 同步复位, 高有效

    input  wire logic                i_en,       // 每个置位拍推进并产出一个字

    output logic                     o_valid,
    output logic [P_WIDTH-1:0]       o_data
);

    //==========================================================================
    // 输入寄存 (红线 1)
    //==========================================================================
    logic ri_en;

    always_ff @(posedge i_clk) begin
        if (i_rst) ri_en <= 1'b0;
        else       ri_en <= i_en;
    end

    //==========================================================================
    // LFSR 核: 全 P_POLY 掩码参与反馈 (修复原件丢 x^WIDTH 抽头)
    //==========================================================================
    logic [P_WIDTH-1:0] r_lfsr;
    logic               w_feedback;

    assign w_feedback = ^(r_lfsr & P_POLY);

    always_ff @(posedge i_clk) begin
        if (i_rst)      r_lfsr <= P_SEED;
        else if (ri_en) r_lfsr <= {r_lfsr[P_WIDTH-2:0], w_feedback};
    end

    //==========================================================================
    // 输出寄存 (红线 2): 采推进前的当前字, valid 与 data 严格同拍
    //==========================================================================
    logic               ro_valid;
    logic [P_WIDTH-1:0] ro_data;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid <= 1'b0;
            ro_data  <= {P_WIDTH{1'b0}};
        end else begin
            ro_valid <= ri_en;
            if (ri_en) ro_data <= r_lfsr;
        end
    end

    assign o_valid = ro_valid;
    assign o_data  = ro_data;

endmodule
`default_nettype wire
