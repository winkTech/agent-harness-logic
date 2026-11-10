// ============================================================================
// rtl_module_template — RTL 模块骨架模板
// 功能: <填写功能描述>
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (输入流); m_axis (输出流);
//       i_enable (使能)
// 主要逻辑: ri_ 输入寄存 -> <填写处理逻辑> -> ro_ 输出寄存
// 延迟: 2 拍 (ri_ 1 + ro_ 1); 插入处理级后据实更新
// 接口: AXI4-Stream
// ============================================================================
// 用法: 复制本文件 -> 把模块名 rtl_module_template 改成实际模块名 (文件名同步) ->
//       在 Stage 1 的 TODO 处填入处理逻辑 -> 按实际情况更新上方文件头。
//       模板本身可编译、可 lint, 请保持这一性质。
//
// 本模板已对齐 docs/rules/01-hdl.md 五条红线, 直接照抄不会踩线:
//   红线1 输入寄存 ri_    —— ri_data/ri_valid/ri_last 级
//   红线2 输出寄存 ro_    —— m_axis_* 全部由 ro_ 驱动
//   红线3 同步复位 i_rst  —— 高有效, 无 negedge
//   红线4 三段式 FSM      —— 本模板无状态机; 需要时见
//                           skills/hdl-coding/references/fsm-templates.md
//   红线5 无锁存器        —— 无 always @(*), 时序块分支完整
//
// 已知残留偏差 (AXI-S 固有, 非疏漏):
//   [D1] s_axis_tready 是组合输出。AXI4-Stream 的 ready 反压路径天生组合,
//        要打断它必须引入一拍弹性缓冲。需要切断该组合路径时, 在本模块边界外
//        套一级 engineering-assets/incubator/intake/axis_skid_buffer。
// ============================================================================

`timescale 1ns / 1ps

module rtl_module_template #(
    parameter DATA_WIDTH = 16,
    parameter USER_WIDTH = 1
) (
    input  wire                  i_clk,
    input  wire                  i_rst,      // 同步复位, 高有效

    // Slave interface (input)
    input  wire [DATA_WIDTH-1:0] s_axis_tdata,
    input  wire                  s_axis_tvalid,
    output wire                  s_axis_tready,
    input  wire                  s_axis_tlast,

    // Master interface (output)
    output wire [DATA_WIDTH-1:0] m_axis_tdata,
    output wire                  m_axis_tvalid,
    input  wire                  m_axis_tready,
    output wire                  m_axis_tlast,

    // Control
    input  wire                  i_enable
);

    // ========================================================================
    // Internal signals
    // ========================================================================
    wire                 w_out_ce;    // 输出级可推进 (空 或 下游本拍收走)
    reg [DATA_WIDTH-1:0] ri_data;     // 红线1: 输入寄存级
    reg                  ri_valid;
    reg                  ri_last;
    reg [DATA_WIDTH-1:0] ro_data;     // 红线2: 输出寄存级
    reg                  ro_valid;
    reg                  ro_last;

    // 全流水统一使能: 下游反压时整条冻结, 不丢不重。
    // 各级使能条件必须一致 —— 若只冻结输出级而让中间级继续走, 中间级会覆盖
    // 尚未被收走的数据。
    assign w_out_ce = !ro_valid || m_axis_tready;

    // ========================================================================
    // Stage 1: 输入寄存 (红线 1)
    // ========================================================================
    always @(posedge i_clk) begin
        if (i_rst) begin
            ri_data  <= {DATA_WIDTH{1'b0}};
            ri_valid <= 1'b0;
            ri_last  <= 1'b0;
        end else if (w_out_ce) begin
            ri_data  <= s_axis_tdata;   // TODO: 在此填入处理逻辑
            ri_valid <= s_axis_tvalid && s_axis_tready;
            ri_last  <= s_axis_tlast;
        end
    end

    // ========================================================================
    // Stage 2: 输出寄存 (红线 2)
    // ========================================================================
    always @(posedge i_clk) begin
        if (i_rst) begin
            ro_data  <= {DATA_WIDTH{1'b0}};
            ro_valid <= 1'b0;
            ro_last  <= 1'b0;
        end else if (w_out_ce) begin
            ro_data  <= ri_data;
            ro_valid <= ri_valid;
            ro_last  <= ri_last;
        end
    end

    // ========================================================================
    // Output assignments
    // 注意: m_axis_tvalid **不得**依赖 m_axis_tready —— AXI4-Stream 规定
    // tvalid 一旦拉高就必须保持到 tready 到来, 不能撤回。
    // ========================================================================
    assign s_axis_tready = i_enable && w_out_ce;   // 见 [D1]
    assign m_axis_tdata  = ro_data;
    assign m_axis_tvalid = ro_valid;
    assign m_axis_tlast  = ro_last;

endmodule
