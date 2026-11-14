`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// axis_skid_buffer — AXI-Stream 寄存切片(skid buffer)参考实现(判卷资产)
//
// 契约:
//   - s_ready / m_valid / m_data 均为寄存器直接输出
//   - 满吞吐零气泡;背压时新 beat 落入 skid 寄存器,无丢/无重/无乱序
//   - AXIS 保持语义: m_valid 置位后至握手前不撤销,m_data 不变
//-----------------------------------------------------------------------------
module axis_skid_buffer #(
  parameter int DATA_W = 16
)(
  input  wire              clk,
  input  wire              rst,       // 同步高有效
  input  wire              s_valid,
  output wire              s_ready,
  input  wire [DATA_W-1:0] s_data,
  output wire              m_valid,
  input  wire              m_ready,
  output wire [DATA_W-1:0] m_data
);

  reg              ro_s_ready;
  reg              ro_m_valid;
  reg [DATA_W-1:0] ro_m_data;
  reg              r_skid_valid;
  reg [DATA_W-1:0] r_skid_data;

  // 下一拍可收: 下游本拍在消费,或 skid 空且(输出空或本拍无新 beat 入)
  wire w_ready_early = m_ready || (!r_skid_valid && (!ro_m_valid || !s_valid));

  always @(posedge clk) begin
    if (rst) begin
      ro_s_ready   <= 1'b0;
      ro_m_valid   <= 1'b0;
      r_skid_valid <= 1'b0;
    end else begin
      ro_s_ready <= w_ready_early;

      if (ro_s_ready) begin
        if (m_ready || !ro_m_valid) begin
          ro_m_valid   <= s_valid;      // 直通装载输出寄存器
          r_skid_valid <= 1'b0;
        end else begin
          r_skid_valid <= s_valid;      // 输出被堵,新 beat 落入 skid
        end
      end else if (m_ready) begin
        ro_m_valid   <= r_skid_valid;   // 出口疏通,skid 内容前移
        r_skid_valid <= 1'b0;
      end
    end
  end

  // 数据通路无复位,少控制集
  always @(posedge clk) begin
    if (ro_s_ready) begin
      if (m_ready || !ro_m_valid) ro_m_data   <= s_data;
      else                        r_skid_data <= s_data;
    end else if (m_ready) begin
      ro_m_data <= r_skid_data;
    end
  end

  assign s_ready = ro_s_ready;
  assign m_valid = ro_m_valid;
  assign m_data  = ro_m_data;

endmodule
