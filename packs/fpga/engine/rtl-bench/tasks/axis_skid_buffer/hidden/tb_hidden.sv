`timescale 1ns / 1ps
//-----------------------------------------------------------------------------
// tb_hidden — axis_skid_buffer 隐藏判卷 TB(评测资产,不进 agent 工作区)
//
// 判卷契约: stdout 输出 "RESULT: PASS" 或 "RESULT: FAIL"(取最后一次出现),
//           失败路径同时 $fatal,保证退出码/Fatal 信息与 RESULT 一致
// 场景: S1 基础 / S2 背压+AXIS 保持语义 / S4 中段复位 / S5 零气泡吞吐
// 只使用端口级观测,不探测 DUT 内部 —— 兼容任意流水级数的实现(预热 WARMUP 拍)
//-----------------------------------------------------------------------------
module tb_hidden;

  localparam int DATA_W = 16;
  localparam int WARMUP = 10;   // 吞吐窗口预热拍数,容忍多级流水实现

  logic               clk;
  logic               rst;
  logic               s_valid;
  logic [DATA_W-1:0]  s_data;
  wire                s_ready;
  wire                m_valid;
  logic               m_ready;
  wire [DATA_W-1:0]   m_data;

  int unsigned n_err     = 0;
  int unsigned n_checked = 0;
  logic [DATA_W-1:0] exp_q[$];
  logic [DATA_W-1:0] exp_beat;

  // 驱动/记分间的握手旗标(negedge 驱动,posedge 记分,交替无竞争)
  bit s_hold  = 0;   // 主侧有 beat 保持中
  bit s_fired = 0;   // 保持中的 beat 已被接收
  bit tp_window = 0; // 零气泡吞吐窗口
  int unsigned tp_cycle = 0;

  // 上一拍采样值(AXIS 保持语义检查)
  logic              p_m_valid = 1'b0;
  logic              p_m_ready = 1'b1;
  logic [DATA_W-1:0] p_m_data  = '0;
  logic              p_rst     = 1'b1;  // 同步复位需满一拍才生效,首拍不查输出

  axis_skid_buffer #(.DATA_W(DATA_W)) dut (
    .clk(clk), .rst(rst),
    .s_valid(s_valid), .s_ready(s_ready), .s_data(s_data),
    .m_valid(m_valid), .m_ready(m_ready), .m_data(m_data)
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  // 看门狗: 死锁类缺陷也要能出 FAIL
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
  // 记分板(posedge 采样;DUT 用 NBA 更新,此处读到的是拍内稳定值)
  //---------------------------------------------------------------------------
  always @(posedge clk) begin
    if (rst) begin
      // 同步复位在置位后的下一拍生效,只在复位已保持≥1拍时检查
      if (p_rst && m_valid === 1'b1) fail("m_valid asserted during reset");
    end else begin
      // 入口握手
      if (s_valid === 1'b1 && s_ready === 1'b1) begin
        exp_q.push_back(s_data);
        s_fired = 1'b1;
      end
      // 出口握手
      if (m_valid === 1'b1 && m_ready === 1'b1) begin
        if ((^m_data) === 1'bx) fail("m_data has X/Z on handshake");
        if (exp_q.size() == 0) begin
          fail($sformatf("unexpected beat 0x%0h (scoreboard empty)", m_data));
        end else begin
          exp_beat = exp_q.pop_front();
          if (m_data !== exp_beat)
            fail($sformatf("data mismatch: got 0x%0h expect 0x%0h", m_data, exp_beat));
          else
            n_checked++;
        end
      end
      // AXIS 保持语义: 上拍 valid&&!ready => 本拍 valid 保持且 data 不变
      if (p_m_valid && !p_m_ready) begin
        if (m_valid !== 1'b1)          fail("m_valid deasserted while stalled");
        else if (m_data !== p_m_data)  fail("m_data changed while stalled");
      end
      // 零气泡吞吐窗口
      if (tp_window) begin
        tp_cycle++;
        if (tp_cycle > WARMUP && m_valid !== 1'b1)
          fail("throughput bubble in full-rate window");
      end else begin
        tp_cycle = 0;
      end
    end
    p_m_valid <= rst ? 1'b0 : (m_valid === 1'b1);
    p_m_ready <= m_ready;
    p_m_data  <= m_data;
    p_rst     <= rst;
  end

  //---------------------------------------------------------------------------
  // 驱动
  //---------------------------------------------------------------------------
  // 主侧: 遵守 AXIS 主协议(valid 置位后保持到握手)
  task automatic drive_master(int duty_pct, int n_cycles);
    repeat (n_cycles) begin
      @(negedge clk);
      if (!(s_hold && !s_fired)) begin
        s_hold  = 0;
        s_fired = 0;
        if ($urandom_range(0, 99) < duty_pct) begin
          s_valid = 1'b1;
          s_data  = $urandom;
          s_hold  = 1;
        end else begin
          s_valid = 1'b0;
        end
      end
    end
    // 收尾: 等保持中的 beat 被吃掉(调用方保证 m_ready 收尾抬高,不会死等)
    while (s_hold && !s_fired) @(negedge clk);
    @(negedge clk);
    s_valid = 1'b0;
    s_hold  = 0;
    s_fired = 0;
  endtask

  // 从侧: 随机背压,收尾抬高 ready 保证主侧能排空
  task automatic drive_mready(int duty_pct, int n_cycles);
    repeat (n_cycles) begin
      @(negedge clk);
      m_ready = ($urandom_range(0, 99) < duty_pct);
    end
    @(negedge clk);
    m_ready = 1'b1;
  endtask

  //---------------------------------------------------------------------------
  // 主序列
  //---------------------------------------------------------------------------
  initial begin
    s_valid = 1'b0;
    s_data  = '0;
    m_ready = 1'b0;
    rst     = 1'b1;
    repeat (4) @(negedge clk);
    rst = 1'b0;
    repeat (2) @(negedge clk);

    // ---- S5: 零气泡满吞吐窗口 ----
    m_ready   = 1'b1;
    tp_window = 1;
    drive_master(100, 300);
    tp_window = 0;

    // ---- S1: 基础(全通 ready,随机 valid) ----
    fork
      drive_master(70, 300);
      drive_mready(100, 310);
    join

    // ---- S2: 背压矩阵 ----
    fork drive_master(100, 400); drive_mready(70, 410); join
    fork drive_master(100, 400); drive_mready(30, 410); join
    fork drive_master(100, 400); drive_mready(10, 410); join
    fork drive_master(50,  400); drive_mready(50, 410); join
    fork drive_master(30,  400); drive_mready(70, 410); join

    // ---- S4: 中段复位(先堵出口把缓冲塞满,复位必须清掉残留) ----
    @(negedge clk);
    m_ready = 1'b0;
    s_valid = 1'b1;
    s_data  = $urandom;
    s_hold  = 1; s_fired = 0;
    repeat (8) begin
      @(negedge clk);
      if (s_fired) begin
        s_data  = $urandom;
        s_fired = 0;
      end
    end
    @(negedge clk);
    s_valid = 1'b0; s_hold = 0; s_fired = 0;
    rst = 1'b1;
    exp_q.delete();
    repeat (3) @(negedge clk);
    rst = 1'b0;
    // 复位后无新输入,不得冒出残留 beat
    m_ready = 1'b1;
    repeat (6) begin
      @(posedge clk);
      if (m_valid === 1'b1) fail("stale beat after mid-test reset");
    end
    // 复位后恢复流量
    fork drive_master(80, 300); drive_mready(80, 310); join

    // ---- 收尾排空与总量核对 ----
    m_ready = 1'b1;
    repeat (20) @(negedge clk);
    if (exp_q.size() != 0)
      fail($sformatf("%0d beats lost (accepted but never output)", exp_q.size()));
    if (n_checked < 500)
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
