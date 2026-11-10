`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// MUTANT m05 — ready 被节拍门控: 功能正确(无丢/无重/无乱序/协议合规),
//              但吞吐减半 —— 只有零气泡吞吐断言能抓到
// 预期检出手段: 满流量窗口零气泡检查
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
  reg              r_tgl;                          // MUTANT: 节拍门控

  wire w_ready_early = (m_ready || (!r_skid_valid && (!ro_m_valid || !s_valid)))
                       && r_tgl;                   // MUTANT: ready 占空比减半

  always @(posedge clk) begin
    if (rst) r_tgl <= 1'b0;
    else     r_tgl <= ~r_tgl;
  end

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
