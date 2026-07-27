`default_nettype none
//==============================================================================
// frame_sync — 以太网风格帧定界器 (前导 + SFD 检测, 数据流透传)
// 功能: 在载波字节流中检测 ≥P_MIN_PREAMBLE 个 0x55 + SFD 0xD5, 之后的数据
//       字节以对齐的 o_valid/o_data 透传, 并给出 o_sof/o_eof 定界脉冲
// 端口: i_clk/i_rst(同步高有效); i_valid(载波)/i_data[8] ->
//       o_valid/o_data + o_sof(首数据拍同拍)/o_eof(帧尾后单拍)
// 主要逻辑: 输入寄存(ri_) -> 三段式 FSM(IDLE/PREAMBLE/DATA + default)
//           -> ro_ 输出寄存
// 延迟: 输出流相对输入流 2 拍 (输入寄存 + 输出寄存)
// 语义 (必须读):
//   - i_valid 是**载波有效** (如 GMII rx_dv): 帧内必须连续, 拉低即帧尾;
//     不是可气泡的流 valid —— 需要气泡语义请在上游先做流适配;
//   - 前导/SFD 被剥除, 不出现在输出流; FCS **不**剥除 (定界器不做
//     store-and-forward; 剥 FCS 可组合 delay_line + crc32 实现);
//   - 前导不足 P_MIN_PREAMBLE 个 0x55 时 SFD 不成帧; 假前导后同一载波内
//     可重新猎取; 零长帧 (SFD 后立即掉载波) 只出 eof 不出 sof (退化情形)。
//
// 来源: 改写自 skills/hdl-coding/templates/internet/frame_sync.v (v1.0.0)
//   原件缺陷 (本模块逐条修复):
//     (1) r_preamble_cnt 是死寄存器: 只写从不读, 前导长度完全不校验 ——
//         单个 0x55 + 0xD5 即成帧, 抗噪能力为零;
//     (2) 不透传数据: 只给指示不给数据流, 且指示与原始 i_data 的相位关系
//         未定义, 下游无法对齐采样;
//     (3) 单 always 混合状态/输出 (违反三段式), 输入未寄存 (红线 1);
//     (4) P_ST_CRC 状态无意义 (单拍直通回 IDLE, 不做任何事);
//     (5) o_frame_valid 在 sof 拍置位但该拍并无数据语义, 语义悬空。
//==============================================================================
module frame_sync #(
    parameter int P_MIN_PREAMBLE = 2    // SFD 前最少 0x55 字节数 (>=1)
)(
    input  wire logic        i_clk,
    input  wire logic        i_rst,      // 同步复位, 高有效

    input  wire logic        i_valid,    // 载波有效 (帧内连续, 见头部语义)
    input  wire logic [7:0]  i_data,

    output logic             o_valid,    // 数据拍有效 (前导/SFD 已剥)
    output logic [7:0]       o_data,
    output logic             o_sof,      // 与首数据拍同拍
    output logic             o_eof       // 帧尾后单拍脉冲 (该拍 o_valid=0)
);

    localparam logic [7:0] P_PREAMBLE = 8'h55;
    localparam logic [7:0] P_SFD      = 8'hD5;

    localparam logic [2:0] P_ST_IDLE     = 3'b001;  // 猎取首个前导字节
    localparam logic [2:0] P_ST_PREAMBLE = 3'b010;  // 累计前导 / 等 SFD
    localparam logic [2:0] P_ST_DATA     = 3'b100;  // 帧数据透传

    //==========================================================================
    // 输入寄存 (红线 1)
    //==========================================================================
    logic       ri_valid;
    logic [7:0] ri_data;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid <= 1'b0;
            ri_data  <= 8'h00;
        end else begin
            ri_valid <= i_valid;
            ri_data  <= i_data;
        end
    end

    //==========================================================================
    // 状态寄存 (段 1)
    //==========================================================================
    logic [2:0] r_cur_state, r_nxt_state;

    always_ff @(posedge i_clk) begin
        if (i_rst) r_cur_state <= P_ST_IDLE;
        else       r_cur_state <= r_nxt_state;
    end

    //==========================================================================
    // 次态组合 (段 2)
    //==========================================================================
    logic [$clog2(P_MIN_PREAMBLE)+1:0] r_pre_cnt;
    logic w_pre_enough;

    assign w_pre_enough = (r_pre_cnt >= P_MIN_PREAMBLE[$clog2(P_MIN_PREAMBLE)+1:0]);

    always_comb begin
        r_nxt_state = r_cur_state;
        unique case (r_cur_state)
            P_ST_IDLE:
                if (ri_valid && ri_data == P_PREAMBLE) r_nxt_state = P_ST_PREAMBLE;
            P_ST_PREAMBLE:
                if (!ri_valid)                   r_nxt_state = P_ST_IDLE;
                else if (ri_data == P_PREAMBLE)  r_nxt_state = P_ST_PREAMBLE;
                else if (ri_data == P_SFD && w_pre_enough) r_nxt_state = P_ST_DATA;
                else                             r_nxt_state = P_ST_IDLE;  // 假前导, 重新猎取
            P_ST_DATA:
                if (!ri_valid) r_nxt_state = P_ST_IDLE;   // 掉载波 = 帧尾
            default: r_nxt_state = P_ST_IDLE;
        endcase
    end

    // 前导计数 (修原件死寄存器: 此计数真正参与 SFD 判定)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_pre_cnt <= '0;
        end else if (r_cur_state == P_ST_IDLE) begin
            r_pre_cnt <= (ri_valid && ri_data == P_PREAMBLE) ? 'd1 : '0;
        end else if (r_cur_state == P_ST_PREAMBLE && ri_valid
                     && ri_data == P_PREAMBLE && !w_pre_enough) begin
            r_pre_cnt <= r_pre_cnt + 1'b1;    // 到阈值即饱和
        end
    end

    //==========================================================================
    // 输出寄存 (段 3, 红线 2)
    //==========================================================================
    logic       ro_valid, ro_sof, ro_eof;
    logic [7:0] ro_data;
    logic       r_sof_pend;   // PRE->DATA 后首个数据拍打 sof

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid   <= 1'b0;
            ro_sof     <= 1'b0;
            ro_eof     <= 1'b0;
            ro_data    <= 8'h00;
            r_sof_pend <= 1'b0;
        end else begin
            if (r_cur_state == P_ST_PREAMBLE && r_nxt_state == P_ST_DATA)
                r_sof_pend <= 1'b1;

            ro_valid <= (r_cur_state == P_ST_DATA) && ri_valid;
            ro_sof   <= (r_cur_state == P_ST_DATA) && ri_valid && r_sof_pend;
            ro_eof   <= (r_cur_state == P_ST_DATA) && !ri_valid;
            if ((r_cur_state == P_ST_DATA) && ri_valid) begin
                ro_data    <= ri_data;
                r_sof_pend <= 1'b0;
            end
        end
    end

    assign o_valid = ro_valid;
    assign o_data  = ro_data;
    assign o_sof   = ro_sof;
    assign o_eof   = ro_eof;

endmodule
`default_nettype wire
