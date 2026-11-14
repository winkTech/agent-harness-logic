`default_nettype none
//==============================================================================
// axis_skid_buffer — AXI4-Stream skid buffer (全寄存, 满吞吐)
// 功能: 打断 AXI-S 链路上的组合路径, 使上下游的 valid/ready/data 全部来自寄存器,
//       同时保持每拍一次成交的满带宽
// 端口: i_clk/i_rst(同步高有效); s_axis_t{valid,ready,data,last} / m_axis_t{...}
// 主要逻辑: 主输出寄存 + 1 深 skid 寄存 + 寄存的 s_axis_tready
// 延迟: 1 拍 (数据从入口寄存到出口)
// 吞吐: 1 拍/beat (s_axis_tvalid 与 m_axis_tready 恒高时逐拍成交)
// 复位: 复位释放后首拍 s_axis_tready=0, 第 2 拍起为 1 (tready 是寄存输出的代价)
//
// 红线说明:
//   红线 1 (输入寄存): s_axis_tdata/tlast 直接进入 ro_tdata 或 r_skid_data 寄存器,
//     不存在从输入到任何输出的组合路径 —— skid 寄存器本身即输入寄存级。
//   红线 2 (输出寄存): 四个输出全部由寄存器驱动, 含 s_axis_tready(<= ro_sready)。
//     w_sready_next 虽组合依赖 m_axis_tready/s_axis_tvalid, 但它只喂寄存器,
//     不直接驱动端口, 因此无输入穿通。这比库内 rrc_polyphase_fir 的
//     `s_axis_tready = (r_slots=='0) && !(m_axis_tvalid && !m_axis_tready)`
//     更严格 —— 后者是组合穿通, 在 RL-OUT 判据收紧后会被判违规。
//
// 来源: 改写自 skills/hdl-coding/templates/comm/axis_pipeline_reg.sv (v1.0.0)
//   原件缺陷 (本模块修复):
//     (1) `assign o_tready = w_stage0_advance`, 而 w_stage0_advance 组合依赖
//         w_advance -> i_tready, 即输入端口组合穿通到输出 —— 违反红线 2;
//     (2) 端口用 i_tdata/o_tdata 而非库内统一的 s_axis_/m_axis_ 协议名;
//     (3) 无 tlast, 无法承载帧边界;
//     (4) 全流水共用一个 w_advance, 是"全局停顿"而非真正的 skid 吸收结构。
//==============================================================================
module axis_skid_buffer #(
    parameter int P_DWIDTH = 32
)(
    input  wire logic                i_clk,
    input  wire logic                i_rst,          // 同步复位, 高有效

    // 从机侧 (上游)
    input  wire logic                s_axis_tvalid,
    output logic                     s_axis_tready,
    input  wire logic [P_DWIDTH-1:0] s_axis_tdata,
    input  wire logic                s_axis_tlast,

    // 主机侧 (下游)
    output logic                     m_axis_tvalid,
    input  wire logic                m_axis_tready,
    output logic [P_DWIDTH-1:0]      m_axis_tdata,
    output logic                     m_axis_tlast
);

    //==========================================================================
    // 输出寄存 (红线 2)
    //==========================================================================
    logic                ro_tvalid;
    logic [P_DWIDTH-1:0] ro_tdata;
    logic                ro_tlast;
    logic                ro_sready;      // 驱动 s_axis_tready

    //==========================================================================
    // skid 寄存 (下游堵塞时吸收 1 拍在途数据, 使 tready 可以寄存而不丢数)
    //==========================================================================
    logic                r_skid_valid;
    logic [P_DWIDTH-1:0] r_skid_data;
    logic                r_skid_last;

    //==========================================================================
    // 组合逻辑: 下一拍是否仍可接收
    //   - 下游本拍取走 => 一定能腾出位置;
    //   - 或 skid 空闲, 且 (出口空 或 上游本拍没给数) => 不会撞满。
    // 该信号只喂 ro_sready 寄存器, 不直接驱动端口。
    //==========================================================================
    logic w_sready_next;

    assign w_sready_next = m_axis_tready
                        || (!r_skid_valid && (!ro_tvalid || !s_axis_tvalid));

    //==========================================================================
    // 时序逻辑: 主寄存 + skid 寄存 + 寄存 ready
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_tvalid    <= 1'b0;
            ro_tdata     <= '0;
            ro_tlast     <= 1'b0;
            ro_sready    <= 1'b0;
            r_skid_valid <= 1'b0;
            r_skid_data  <= '0;
            r_skid_last  <= 1'b0;
        end else begin
            ro_sready <= w_sready_next;

            if (ro_sready) begin
                // 本拍允许接收上游
                if (s_axis_tvalid) begin
                    if (!ro_tvalid || m_axis_tready) begin
                        // 出口空 或 下游本拍取走 => 直接进主寄存
                        ro_tdata  <= s_axis_tdata;
                        ro_tlast  <= s_axis_tlast;
                        ro_tvalid <= 1'b1;
                    end else begin
                        // 出口被占且下游没取 => 暂存进 skid
                        r_skid_data  <= s_axis_tdata;
                        r_skid_last  <= s_axis_tlast;
                        r_skid_valid <= 1'b1;
                    end
                end else if (m_axis_tready) begin
                    // 上游无数据且下游取走 => 出口转空
                    ro_tvalid <= 1'b0;
                end
            end else if (m_axis_tready) begin
                // 本拍不收上游, 下游取走 => 用 skid 内容补位 (skid 空则出口转空)
                ro_tdata     <= r_skid_data;
                ro_tlast     <= r_skid_last;
                ro_tvalid    <= r_skid_valid;
                r_skid_valid <= 1'b0;
            end
        end
    end

    //==========================================================================
    // 输出赋值 (仅寄存器到端口的连线, 无组合逻辑)
    //==========================================================================
    assign s_axis_tready = ro_sready;
    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tdata  = ro_tdata;
    assign m_axis_tlast  = ro_tlast;

endmodule
`default_nettype wire
