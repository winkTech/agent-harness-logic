`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// MUTANT m07 — 被堵时撤销输出 valid: 违反 AXIS 保持语义(valid 置位后不得撤销)
// 预期检出手段: 保持语义检查(上拍 valid&&!ready => 本拍 valid 保持)
//-----------------------------------------------------------------------------
module axis_skid_buffer #(
  parameter int DATA_W = 16
)(
  input  wire              clk,
  input  wire              rst,
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
          ro_m_valid   <= s_valid;
          r_skid_valid <= 1'b0;
        end else begin
          r_skid_valid <= s_valid;
          ro_m_valid   <= 1'b0;                   // MUTANT: 被堵时撤销未握手的 beat
        end
      end else if (m_ready) begin
        ro_m_valid   <= r_skid_valid;
        r_skid_valid <= 1'b0;
      end
    end
  end

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
