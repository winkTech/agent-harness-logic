`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// tb_smoke — mac_pipe 最小自测(公开给 agent 工作区)
// 仅覆盖: 一条 3 beat 短帧 (1*1, +2*3, +10*10) → 输出 1, 7, 107。
// 通过本测试不代表满足全部契约(符号/溢出/延迟对齐/复位/气泡不在此覆盖)。
//-----------------------------------------------------------------------------
module tb_smoke;

  logic               clk;
  logic               rst;
  logic               s_valid;
  logic               s_clr;
  logic signed [15:0] s_a;
  logic signed [15:0] s_b;
  wire                m_valid;
  wire signed [47:0]  m_acc;

  logic signed [47:0] got_q[$];

  mac_pipe dut (
    .clk(clk), .rst(rst),
    .s_valid(s_valid), .s_clr(s_clr), .s_a(s_a), .s_b(s_b),
    .m_valid(m_valid), .m_acc(m_acc)
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    #100us;
    $display("[SMOKE] watchdog timeout");
    $display("RESULT: FAIL");
    $fatal(1, "tb_smoke watchdog timeout");
  end

  always @(posedge clk) begin
    if (!rst && m_valid === 1'b1) got_q.push_back(m_acc);
  end

  task automatic send(input logic clr, input logic signed [15:0] a, input logic signed [15:0] b);
    @(negedge clk);
    s_valid = 1'b1; s_clr = clr; s_a = a; s_b = b;
  endtask

  initial begin
    int unsigned n_err = 0;
    logic signed [47:0] exp[3];
    exp[0] = 48'sd1; exp[1] = 48'sd7; exp[2] = 48'sd107;

    s_valid = 1'b0; s_clr = 1'b0; s_a = '0; s_b = '0; rst = 1'b1;
    repeat (4) @(negedge clk);
    rst = 1'b0;
    repeat (2) @(negedge clk);

    send(1'b1, 16'sd1,  16'sd1);   // acc = 1
    send(1'b0, 16'sd2,  16'sd3);   // acc = 7
    send(1'b0, 16'sd10, 16'sd10);  // acc = 107
    @(negedge clk);
    s_valid = 1'b0;

    repeat (10) @(negedge clk);

    if (got_q.size() != 3) begin
      $display("[SMOKE] expected 3 output beats, got %0d", got_q.size());
      n_err++;
    end else begin
      for (int i = 0; i < 3; i++) begin
        if (got_q[i] !== exp[i]) begin
          $display("[SMOKE] beat %0d: got %0d expect %0d", i, got_q[i], exp[i]);
          n_err++;
        end
      end
    end

    if (n_err == 0) begin
      $display("RESULT: PASS");
      $finish;
    end else begin
      $display("RESULT: FAIL");
      $fatal(1, "tb_smoke: %0d errors", n_err);
    end
  end

endmodule
