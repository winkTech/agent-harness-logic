`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// tb_smoke — axis_skid_buffer 最小连通性自测(公开给 agent 工作区)
// 仅覆盖: 复位释放后全通条件下 8 个 beat 按序透传。
// 通过本测试不代表满足全部契约(背压/保持语义/复位残留等不在此覆盖)。
//-----------------------------------------------------------------------------
module tb_smoke;

  localparam int DATA_W = 16;

  logic               clk;
  logic               rst;
  logic               s_valid;
  logic [DATA_W-1:0]  s_data;
  wire                s_ready;
  wire                m_valid;
  logic               m_ready;
  wire [DATA_W-1:0]   m_data;

  int unsigned n_sent = 0;
  logic [DATA_W-1:0] got_q[$];

  axis_skid_buffer #(.DATA_W(DATA_W)) dut (
    .clk(clk), .rst(rst),
    .s_valid(s_valid), .s_ready(s_ready), .s_data(s_data),
    .m_valid(m_valid), .m_ready(m_ready), .m_data(m_data)
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    #100us;
    $display("[SMOKE] watchdog timeout");
    $display("RESULT: FAIL");
    $fatal(1, "tb_smoke watchdog timeout");
  end

  // 收集输出
  always @(posedge clk) begin
    if (!rst && m_valid === 1'b1 && m_ready === 1'b1) got_q.push_back(m_data);
  end

  initial begin
    int unsigned n_err = 0;
    s_valid = 1'b0; s_data = '0; m_ready = 1'b0; rst = 1'b1;
    repeat (4) @(negedge clk);
    rst = 1'b0;
    @(negedge clk);
    m_ready = 1'b1;

    // 发 8 个递增 beat(保持 valid 至握手)
    while (n_sent < 8) begin
      s_valid = 1'b1;
      s_data  = DATA_W'(16'hA000 + n_sent);
      @(posedge clk);
      if (s_valid === 1'b1 && s_ready === 1'b1) n_sent++;
      @(negedge clk);
    end
    s_valid = 1'b0;

    // 排空
    repeat (20) @(negedge clk);

    if (got_q.size() != 8) begin
      $display("[SMOKE] expected 8 beats, got %0d", got_q.size());
      n_err++;
    end else begin
      for (int i = 0; i < 8; i++) begin
        if (got_q[i] !== DATA_W'(16'hA000 + i)) begin
          $display("[SMOKE] beat %0d: got 0x%0h expect 0x%0h", i, got_q[i], 16'hA000 + i);
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
