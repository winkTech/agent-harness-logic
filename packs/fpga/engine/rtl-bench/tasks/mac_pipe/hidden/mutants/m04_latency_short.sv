`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// MUTANT m04 — valid 流水少一级: m_valid 提前一拍,违反"延迟恰好 3 拍"契约,
//              且 valid 与累加值错位
// 预期检出手段: 逐拍 valid 延迟对齐检查
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
      ro_m_valid <= r1_valid;              // MUTANT: 应为 r2_valid,延迟只有 2 拍
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
