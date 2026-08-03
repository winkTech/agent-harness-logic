`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// mac_pipe — 3 级流水有符号乘累加参考实现(判卷资产)
//
// 结构对应 DSP48E1 全流水: 级1 输入寄存(AREG/BREG) → 级2 乘积寄存(MREG)
// → 级3 累加寄存(PREG)。控制流水(valid/clr)走织物 FF。
// 契约: 延迟恰好 3 拍;clr beat 令 acc=积;复位清累加状态。
//-----------------------------------------------------------------------------
module mac_pipe (
  input  wire               clk,
  input  wire               rst,      // 同步高有效
  input  wire               s_valid,
  input  wire               s_clr,
  input  wire signed [15:0] s_a,
  input  wire signed [15:0] s_b,
  output wire               m_valid,
  output wire signed [47:0] m_acc
);

  // 控制流水(带复位)
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

  // 数据流水(无复位,利于 DSP 吸收)
  reg signed [15:0] r1_a, r1_b;
  reg signed [31:0] r2_p;

  always @(posedge clk) begin
    r1_a   <= s_a;
    r1_b   <= s_b;
    r1_clr <= s_clr;
    r2_p   <= r1_a * r1_b;
    r2_clr <= r1_clr;
  end

  // 累加级(复位清零;valid 门控,气泡期间保持)
  reg signed [47:0] r_acc;

  always @(posedge clk) begin
    if (rst)           r_acc <= '0;
    else if (r2_valid) r_acc <= r2_clr ? r2_p : (r_acc + r2_p);
  end

  assign m_valid = ro_m_valid;
  assign m_acc   = r_acc;

endmodule
