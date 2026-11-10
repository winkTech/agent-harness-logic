`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// MUTANT m02 — 操作数寄存器丢失 signed: 乘法按无符号执行,负操作数结果错误
// 预期检出手段: 随机/极值操作数(含负数) + 累加值比对
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

  reg [15:0] r1_a, r1_b;                   // MUTANT: 丢失 signed,乘法变无符号
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
