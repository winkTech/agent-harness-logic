`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// MUTANT m06 — 复位不清输出 valid: 中段复位后残留 valid/输出 beat
// 预期检出手段: 流水线有在途 beat 时中段复位 + 复位期间输出检查
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
      // MUTANT: 缺少 ro_m_valid <= 1'b0; 复位不清残留输出 valid
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
    if (rst)           r_acc <= '0;
    else if (r2_valid) r_acc <= r2_clr ? r2_p : (r_acc + r2_p);
  end

  assign m_valid = ro_m_valid;
  assign m_acc   = r_acc;

endmodule
