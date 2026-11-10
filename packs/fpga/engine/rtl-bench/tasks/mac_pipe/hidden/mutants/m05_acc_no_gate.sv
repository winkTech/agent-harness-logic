`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// MUTANT m05 — 累加级丢失 valid 门控: 输入气泡期间残留乘积被反复累加
// 预期检出手段: 带气泡的帧(TB 在 idle 拍驱动垃圾操作数) + 累加值比对
//-----------------------------------------------------------------------------
module mac_pipe (
  input  wire               clk,
  input  wire               rst,
  input  wire               s_valid,
  input  wire               s_clr,
  input  wire signed [15:0] s_a,
  input  wire signed [15:0] s_b,
  output wire               m_valid,
  output wire signed [47:0] m_acc
);

  reg r1_valid, r2_valid, ro_m_valid;
  reg r1_clr,   r2_clr;

  always @(posedge clk) begin
    if (rst) begin
      r1_valid   <= 1'b0;
      r2_valid   <= 1'b0;
      ro_m_valid <= 1'b0;
    end else begin
      r1_valid   <= s_valid;
      r2_valid   <= r1_valid;
      ro_m_valid <= r2_valid;
    end
  end

  reg signed [15:0] r1_a, r1_b;
  reg signed [31:0] r2_p;

  always @(posedge clk) begin
    r1_a   <= s_a;
    r1_b   <= s_b;
    r1_clr <= s_clr;
    r2_p   <= r1_a * r1_b;
    r2_clr <= r1_clr;
  end

  reg signed [47:0] r_acc;

  always @(posedge clk) begin
    if (rst) r_acc <= '0;
    else     r_acc <= r2_clr ? r2_p : (r_acc + r2_p);   // MUTANT: 丢失 r2_valid 门控
  end

  assign m_valid = ro_m_valid;
  assign m_acc   = r_acc;

endmodule
