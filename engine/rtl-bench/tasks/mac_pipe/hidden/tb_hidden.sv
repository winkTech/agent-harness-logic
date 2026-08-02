`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// tb_hidden — mac_pipe 隐藏判卷 TB(评测资产,不进 agent 工作区)
//
// 判卷契约: stdout 输出 "RESULT: PASS" 或 "RESULT: FAIL",失败路径 $fatal
// 检查点: 逐拍 valid 延迟对齐(恰 3 拍) / 有符号乘累加值(48 位) / 气泡保持 /
//         中段复位清状态(复位后 clr=0 首帧从 0 累加) / X 检查
// 只观测端口;idle 拍故意驱动垃圾操作数,专抓无 valid 门控的累加实现
//-----------------------------------------------------------------------------
module tb_hidden;

  logic               clk;
  logic               rst;
  logic               s_valid;
  logic               s_clr;
  logic signed [15:0] s_a;
  logic signed [15:0] s_b;
  wire                m_valid;
  wire signed [47:0]  m_acc;

  int unsigned n_err     = 0;
  int unsigned n_checked = 0;

  // 金模型(与 RTL 不同构: 行为级顺序累加)
  logic signed [47:0] acc_model = '0;
  logic signed [47:0] exp_q[$];
  logic signed [47:0] exp_beat;

  // valid 延迟对齐流水(TB 侧参考)
  bit v0 = 0, v1 = 0, v2 = 0;
  logic p_rst = 1'b1;

  mac_pipe dut (
    .clk(clk), .rst(rst),
    .s_valid(s_valid), .s_clr(s_clr), .s_a(s_a), .s_b(s_b),
    .m_valid(m_valid), .m_acc(m_acc)
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    #2ms;
    $display("[TB] watchdog timeout");
    $display("RESULT: FAIL");
    $fatal(1, "tb_hidden watchdog timeout");
  end

  function void fail(string msg);
    n_err++;
    if (n_err <= 20) $display("[TB][%0t] FAIL: %s", $time, msg);
  endfunction

  //---------------------------------------------------------------------------
  // 记分板(posedge 采样)
  //---------------------------------------------------------------------------
  always @(posedge clk) begin
    if (rst) begin
      if (p_rst && m_valid === 1'b1) fail("m_valid asserted during reset");
      v0 = 0; v1 = 0; v2 = 0;
      acc_model = '0;
      exp_q.delete();
    end else begin
      // 逐拍延迟对齐: m_valid 必须恰为 s_valid 的 3 拍延迟
      if (!p_rst) begin
        if (m_valid !== v2)
          fail($sformatf("m_valid=%b but expected %b (3-cycle alignment)", m_valid, v2));
        if (m_valid === 1'b1 && v2) begin
          if ((^m_acc) === 1'bx) fail("m_acc has X/Z while m_valid");
          else if (exp_q.size() == 0) fail("output beat but scoreboard empty");
          else begin
            exp_beat = exp_q.pop_front();
            if (m_acc !== exp_beat)
              fail($sformatf("acc mismatch: got %0d expect %0d", m_acc, exp_beat));
            else
              n_checked++;
          end
        end
      end
      // 金模型按输入顺序推进
      if (s_valid === 1'b1) begin
        if (s_clr === 1'b1) acc_model = 48'(s_a) * 48'(s_b);
        else                acc_model = acc_model + 48'(s_a) * 48'(s_b);
        exp_q.push_back(acc_model);
      end
      // 参考延迟流水移位(blocking,顺序: 先用 v2 判,再移位)
      v2 = v1;
      v1 = v0;
      v0 = (s_valid === 1'b1);
    end
    p_rst <= rst;
  end

  //---------------------------------------------------------------------------
  // 驱动(negedge;idle 拍也驱动垃圾操作数)
  //---------------------------------------------------------------------------
  task automatic idle_cycle();
    @(negedge clk);
    s_valid = 1'b0;
    s_clr   = 1'b0;
    s_a     = $urandom;   // 垃圾操作数,不该被累加
    s_b     = $urandom;
  endtask

  // mode 0: 随机操作数; mode 1: 极值操作数(压符号位与 32 位溢出)
  task automatic drive_frame(int len, int gap_pct, int mode, bit first_clr);
    for (int i = 0; i < len; i++) begin
      while ($urandom_range(0, 99) < gap_pct) idle_cycle();
      @(negedge clk);
      s_valid = 1'b1;
      s_clr   = (i == 0) && first_clr;
      if (mode == 0) begin
        s_a = $urandom;
        s_b = $urandom;
      end else begin
        case ($urandom_range(0, 4))
          0: s_a = 16'sh7FFF; 1: s_a = 16'sh8000; 2: s_a = 16'sh0001;
          3: s_a = -16'sd1;   default: s_a = 16'sh7FFF;
        endcase
        case ($urandom_range(0, 4))
          0: s_b = 16'sh7FFF; 1: s_b = 16'sh8000; 2: s_b = 16'sh0001;
          3: s_b = -16'sd1;   default: s_b = 16'sh7FFF;
        endcase
      end
    end
    idle_cycle();
  endtask

  //---------------------------------------------------------------------------
  // 主序列
  //---------------------------------------------------------------------------
  initial begin
    s_valid = 1'b0; s_clr = 1'b0; s_a = '0; s_b = '0; rst = 1'b1;
    repeat (4) @(negedge clk);
    rst = 1'b0;
    repeat (2) @(negedge clk);

    // S1: 随机帧(有 clr,含气泡)
    repeat (20) drive_frame($urandom_range(1, 20), 30, 0, 1'b1);

    // S5: 背靠背满流量长帧(无气泡)
    repeat (4) drive_frame(50, 0, 0, 1'b1);

    // 极值/溢出: 长同号帧把累加推过 32 位
    repeat (6) drive_frame(30, 10, 1, 1'b1);

    // S4: 中段复位 —— 流水线里有在途 beat 时拉复位
    drive_frame(3, 0, 0, 1'b1);
    @(negedge clk);
    s_valid = 1'b1; s_clr = 1'b0; s_a = 16'sd123; s_b = 16'sd456;
    @(negedge clk);                 // 在途 beat 尚未走完流水线
    s_valid = 1'b0;
    rst = 1'b1;
    repeat (3) @(negedge clk);
    rst = 1'b0;
    repeat (2) @(negedge clk);
    // 复位后 clr=0 首帧必须从 0 开始累加(金模型同步清零)
    repeat (6) drive_frame($urandom_range(2, 12), 20, 0, 1'b0);
    // 再回到正常 clr 帧
    repeat (6) drive_frame($urandom_range(1, 16), 25, 0, 1'b1);

    // 收尾: 排空流水线
    repeat (10) idle_cycle();
    if (exp_q.size() != 0)
      fail($sformatf("%0d beats never produced output", exp_q.size()));
    if (n_checked < 400)
      fail($sformatf("too few beats checked (%0d)", n_checked));

    if (n_err == 0) begin
      $display("[TB] %0d beats checked, 0 errors", n_checked);
      $display("RESULT: PASS");
      $finish;
    end else begin
      $display("[TB] %0d beats checked, %0d errors", n_checked, n_err);
      $display("RESULT: FAIL");
      $fatal(1, "tb_hidden: %0d errors", n_err);
    end
  end

endmodule
