`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// MUTANT m03 — ready 条件过宽: 输出被堵且 skid 将满时仍拉高 s_ready,
//              第二个 beat 覆盖 skid 中未送出的 beat(缓冲溢出丢数)
// 预期检出手段: 背压场景 + scoreboard 丢数/失配
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

  wire w_ready_early = m_ready || !r_skid_valid;   // MUTANT: 丢掉了输出占用/新入判断

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
