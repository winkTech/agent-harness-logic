//-----------------------------------------------------------------
//                          Mod Mapper
//-----------------------------------------------------------------
// 功能描述: 比特流 → IQ 调制符号映射
//   支持 BPSK / QPSK / 16QAM / 64QAM
//   定点格式: Q2.14 (16-bit signed)
//   流水线: 3 级 (输入寄存 → 调制 → 输出寄存)
//-----------------------------------------------------------------
// 主要逻辑:
//   1. Stage1: 输入寄存 (r_data_d1/r_valid_d1/r_last_d1)
//   2. Stage2: 查表调制 → IQ 符号 (r_i_d2/r_q_d2)
//   3. Stage3: ro_ 输出寄存 (数据与 valid 对齐, 带反压保持)
//-----------------------------------------------------------------
// 本文件为 hdl-coding 规范修复版。相对修复前的差异:
//   (1) **§6 阻塞/非阻塞混用 (MUST)**: Stage2 原写
//       `{r_i_d2, r_q_d2} = modulate(...)` —— 时序 always 块里用阻塞赋值,
//       与同块其它 `<=` 混用, 会与读这两个寄存器的其它进程产生仿真竞态。
//       现改为非阻塞 `<=`。
//   (2) **红线 2 输出寄存**: 原 m_axis_i/m_axis_q 直接 assign 自 Stage2 的
//       r_i_d2/r_q_d2, 而 m_axis_tvalid 来自再晚一拍的 ro_valid ——
//       **数据比 valid 早 1 拍, 下游按 valid 采样必然取错**。
//       现新增对齐的 ro_i/ro_q 输出寄存级, 数据与 valid 同拍。
//   (3) **AXI4-Stream 协议**: 原 `ro_valid <= r_valid_d2 && m_axis_tready`
//       让 tvalid 依赖 tready, 违反 AXI-S (tvalid 不得等 tready)。
//       现输出级为标准"可保持的寄存输出": tvalid 只由数据有无决定,
//       下游拉低 tready 时整级保持不变, 不丢不重。
//   (4) modulate/qam*_map 改为 automatic (原 modulate 为静态存储)。
//   以上 (2)(3) 使输出相对输入延迟由 2 拍变 3 拍。
//   (5) 三级流水改为**统一使能** w_pipe_ce。原实现各级使能条件不一致
//       (Stage2 只看 r_valid_d1), 下游反压时 Stage2 仍会推进并覆盖 Stage3
//       尚未被收走的数据 —— 随机反压下实测数据错位。统一使能后整条流水
//       要么一起前移、要么一起冻结, 不丢不重。
//
// !! 已知残留偏差 (有意保留, 非疏漏) !!
//   [D1] s_axis_tready 仍是组合输出 (= !ro_valid || m_axis_tready), 未做到
//        "输出全部由 ro_ 驱动"。AXI4-Stream 的 ready 反压路径天生是组合的,
//        要打断它必须引入弹性缓冲 (一拍 skid), 那是接口架构改动而非改写法。
//        本库已有现成件: incubator/intake/axis_skid_buffer —— 需要切断 ready
//        组合路径时在本模块边界外套一级即可, 不必改本模块内部。
//        修复前的 w_ready 同样是组合的, 此项不是回归。
//
// !! 遗留缺陷 (承自原始代码, 本次**未改**) !!
//   [F1] 64QAM 是桩: qam64_map 恒输出 0, P_MOD_TYPE=3 时无有效星座。
//   [F2] modulate 的 case 用 3'd0..3'd3 匹配 int 型 P_MOD_TYPE, 宽度不一致
//        (靠隐式扩展成立), 且 P_MOD_TYPE 为编译期常量, 该 case 实为静态选择。
//-----------------------------------------------------------------

`timescale 1ns / 1ps

module mapper #(
    parameter int P_MOD_TYPE = 2
)(
    input  wire         i_clk_sys,
    input  wire         i_rst_sys,

    input  wire [5:0]   s_axis_tdata,
    input  wire         s_axis_tvalid,
    output wire         s_axis_tready,
    input  wire         s_axis_tlast,

    output wire [15:0]  m_axis_i,
    output wire [15:0]  m_axis_q,
    output wire         m_axis_tvalid,
    input  wire         m_axis_tready,
    output wire         m_axis_tlast
);

    //-----------------------------------------------------------------
    // Q2.14 星座点常量 (1.0 = 16'h4000)
    //-----------------------------------------------------------------
    localparam BPSK_POS       = 16'h4000;
    localparam BPSK_NEG       = 16'hC000;
    localparam QPSK_POS       = 16'h2D41;
    localparam QPSK_NEG       = 16'hD2BF;
    localparam QAM16_AMP1     = 16'h1440;
    localparam QAM16_AMP3     = 16'h3CC0;
    localparam QAM16_AMP1_NEG = 16'hEBC0;
    localparam QAM16_AMP3_NEG = 16'hC340;

    //-----------------------------------------------------------------
    // 流水线寄存器
    //-----------------------------------------------------------------
    reg [5:0]  r_data_d1;
    reg        r_valid_d1;
    reg        r_last_d1;

    reg [15:0] r_i_d2;
    reg [15:0] r_q_d2;
    reg        r_valid_d2;
    reg        r_last_d2;

    reg [15:0] ro_i;
    reg [15:0] ro_q;
    reg        ro_valid;
    reg        ro_last;

    // 全流水统一使能: 输出级空 或 下游本拍收走 -> 整条 3 级流水前移一拍;
    // 否则整条冻结 (含上游 tready 拉低)。统一使能是这条非弹性流水唯一
    // 不丢不重的推进方式 —— 若只冻结输出级而让中间级继续走, 中间级会覆盖
    // 尚未被收走的数据 (这正是整改过程中实测到的失配, 见 CHANGELOG)。
    wire       w_pipe_ce;

    assign w_pipe_ce     = !ro_valid || m_axis_tready;
    assign s_axis_tready = w_pipe_ce;

    //-----------------------------------------------------------------
    // Stage 1: 输入寄存器 (同步复位)
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_data_d1  <= 6'd0;
            r_valid_d1 <= 1'b0;
            r_last_d1  <= 1'b0;
        end else if (w_pipe_ce) begin
            r_data_d1  <= s_axis_tdata;
            r_valid_d1 <= s_axis_tvalid;
            r_last_d1  <= s_axis_tlast;
        end
    end

    //-----------------------------------------------------------------
    // Stage 2: 调制映射 (全部非阻塞赋值, 见文件头 (1))
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_i_d2     <= 16'd0;
            r_q_d2     <= 16'd0;
            r_valid_d2 <= 1'b0;
            r_last_d2  <= 1'b0;
        end else if (w_pipe_ce) begin
            {r_i_d2, r_q_d2} <= modulate(r_data_d1);
            r_valid_d2       <= r_valid_d1;
            r_last_d2        <= r_last_d1;
        end
    end

    //-----------------------------------------------------------------
    // Stage 3: ro_ 输出寄存 (红线 2)
    // 数据与 valid 同拍; 下游反压时整级保持 (tvalid 不依赖 tready)
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_i     <= 16'd0;
            ro_q     <= 16'd0;
            ro_valid <= 1'b0;
            ro_last  <= 1'b0;
        end else if (w_pipe_ce) begin
            ro_i     <= r_i_d2;
            ro_q     <= r_q_d2;
            ro_valid <= r_valid_d2;
            ro_last  <= r_last_d2;
        end
    end

    assign m_axis_i      = ro_i;
    assign m_axis_q      = ro_q;
    assign m_axis_tvalid = ro_valid;
    assign m_axis_tlast  = ro_last;

    //-----------------------------------------------------------------
    // 调制函数
    //-----------------------------------------------------------------
    function automatic [31:0] modulate(input [5:0] bits);
        reg [15:0] i_out, q_out;
        begin
            case (P_MOD_TYPE)
                3'd0: begin
                    i_out = bits[0] ? BPSK_POS : BPSK_NEG;
                    q_out = 16'd0;
                end
                3'd1: begin
                    i_out = bits[0] ? QPSK_POS : QPSK_NEG;
                    q_out = bits[1] ? QPSK_POS : QPSK_NEG;
                end
                3'd2: begin
                    qam16_map(bits[1:0], bits[3:2], i_out, q_out);
                end
                3'd3: begin
                    qam64_map(bits[2:0], bits[5:4], i_out, q_out);
                end
                default: begin
                    i_out = 16'd0;
                    q_out = 16'd0;
                end
            endcase
            modulate = {i_out, q_out};
        end
    endfunction

    //-----------------------------------------------------------------
    // 16QAM Gray 映射
    //-----------------------------------------------------------------
    function automatic void qam16_map(
        input [1:0] i_bits, q_bits,
        output reg [15:0] i_val, q_val
    );
        case (i_bits)
            2'b00: i_val = QAM16_AMP3_NEG;
            2'b01: i_val = QAM16_AMP1_NEG;
            2'b11: i_val = QAM16_AMP1;
            2'b10: i_val = QAM16_AMP3;
            default: i_val = 16'd0;
        endcase
        case (q_bits)
            2'b00: q_val = QAM16_AMP3_NEG;
            2'b01: q_val = QAM16_AMP1_NEG;
            2'b11: q_val = QAM16_AMP1;
            2'b10: q_val = QAM16_AMP3;
            default: q_val = 16'd0;
        endcase
    endfunction

    //-----------------------------------------------------------------
    // 64QAM Gray 映射 —— 见文件头 [F1]: 当前为桩, 恒输出 0
    //-----------------------------------------------------------------
    function automatic void qam64_map(
        input [2:0] i_bits, q_bits,
        output reg [15:0] i_val, q_val
    );
        i_val = 16'd0;
        q_val = 16'd0;
    endfunction

endmodule
