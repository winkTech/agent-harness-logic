//-----------------------------------------------------------------
// axi-stream-vip.sv — AXI-Stream 验证 IP
//-----------------------------------------------------------------
// 功能: AXI-Stream 驱动 + 监视器 + 记分板
// 协议: 兼容 ARM AMBA 4 AXI-Stream
// 依赖: axi_stream_if.sv (virtual interface)
// 不依赖 UVM，纯 SystemVerilog，可直接编译
//-----------------------------------------------------------------

package axi_stream_vip_pkg;

  //=================================================================
  // 公共类型定义
  //=================================================================

  // AXI-Stream 接口配置参数
  typedef struct {
    int    DATA_WIDTH  = 32;
    int    USER_WIDTH  = 1;
    int    ID_WIDTH    = 1;
    int    DEST_WIDTH  = 1;
    time   CLK_PERIOD  = 10ns;
    int    MAX_BURST   = 64;
  } axis_cfg_t;

  // Ready 行为模式
  typedef enum int {
    ALWAYS_READY       = 0,  // tready 持续为高
    HANDSHAKE_ONLY     = 1,  // 仅握手模式：每拍 valid 有效时 ready 立刻响应
    RANDOM_BACKPRESSURE= 2,  // 随机插入背压间隙
    GAPPED             = 3   // 固定间隔模式：每 N 拍 ready 一次
  } ready_mode_t;

  // 比对结果
  typedef struct {
    int pass_count;
    int fail_count;
    int first_fail_at;       // 第一个失败的索引 (-1 = 无失败)
    int max_error_lsb;       // 最大逐位误差位置 (-1 = 无误差)
    int compared_points;
  } axis_result_t;

  //=================================================================
  // axis_driver — AXI-Stream 驱动类
  //-----------------------------------------------------------------
  // 负责产生 valid-ready 握手序列驱动 DUT
  // 支持四种背压模式通过 set_ready_mode() 切换
  //=================================================================
  class axis_driver #(int DW=32);

    // Virtual interface (master modport: 驱动 tvalid/tdata/tlast/tkeep)
    virtual axi_stream_if #(DW).master vif;

    // 配置
    ready_mode_t ready_mode = ALWAYS_READY;
    int          gap_cycles = 0;     // GAPPED 模式下的间隙周期
    int          rng_min_gap = 0;    // RANDOM 模式最小间隙
    int          rng_max_gap = 5;    // RANDOM 模式最大间隙

    // 内部状态
    protected int     transaction_count;
    protected time    last_handshake_time;
    protected string  log_file;
    protected int     log_fd;

    // 随机化种子
    protected int     seed;

    //-----------------------------------------------------------------
    // 构造函数
    //-----------------------------------------------------------------
    function new(virtual axi_stream_if #(DW).master vif);
      this.vif = vif;
      this.transaction_count = 0;
      this.log_fd = -1;
      this.seed = $time;
    endfunction

    //-----------------------------------------------------------------
    // set_ready_mode — 设置 ready 行为模式
    //   mode:        ready 模式
    //   gap_cycles:  GAPPED 模式下每次 ready 之间的等待周期数
    //-----------------------------------------------------------------
    function void set_ready_mode(ready_mode_t mode, int gap_cycles=0);
      this.ready_mode  = mode;
      this.gap_cycles  = gap_cycles;
    endfunction

    //-----------------------------------------------------------------
    // set_backpressure_range — 设置随机背压范围
    //   min_gap: 最小等待周期
    //   max_gap: 最大等待周期
    //-----------------------------------------------------------------
    function void set_backpressure_range(int min_gap, int max_gap);
      this.rng_min_gap = min_gap;
      this.rng_max_gap = max_gap;
    endfunction

    //-----------------------------------------------------------------
    // enable_logging — 启用事务日志（写模式）
    //-----------------------------------------------------------------
    function void enable_logging(string file);
      this.log_file = file;
      this.log_fd = $fopen(file, "w");
      if (this.log_fd == 0) begin
        $error("axis_driver: cannot open log file %s", file);
      end else begin
        $fdisplay(this.log_fd, "# axis_driver transaction log");
        $fdisplay(this.log_fd, "# time, data, last, keep");
      end
    endfunction

    //-----------------------------------------------------------------
    // disable_logging — 关闭事务日志
    //-----------------------------------------------------------------
    function void disable_logging();
      if (this.log_fd != -1) begin
        $fclose(this.log_fd);
        this.log_fd = -1;
      end
    endfunction

    //-----------------------------------------------------------------
    // send_vector — 发送一个数据向量
    //   在时钟上升沿同步驱动 tvalid, tdata, tlast, tkeep,
    //   等待 tready 为高完成握手后释放 tvalid
    //
    //   data: 待发送数据
    //   last: tlast 信号（默认 0，burst 最后一拍设为 1）
    //   keep: tkeep 信号（默认全 1）
    //-----------------------------------------------------------------
    task send_vector(input bit [DW-1:0] data, input bit last=1'b0, input bit [DW/8-1:0] keep=-1);
      @(posedge vif.clk);
      vif.tvalid <= 1'b1;
      vif.tdata  <= data;
      vif.tlast  <= last;
      vif.tkeep  <= keep;
      vif.tuser  <= 0;

      // 等待握手完成 (valid & ready)
      wait (vif.tready === 1'b1);
      @(posedge vif.clk);

      // 释放 valid
      vif.tvalid <= 1'b0;
      vif.tdata  <= 'x;
      vif.tlast  <= 'x;
      vif.tkeep  <= 'x;
      vif.tuser  <= 'x;

      this.transaction_count++;
      this.last_handshake_time = $time;

      // 日志输出
      if (this.log_fd != -1) begin
        $fdisplay(this.log_fd, "%0t, 0x%h, %b, 0x%h", $time, data, last, keep);
      end
    endtask

    //-----------------------------------------------------------------
    // send_burst — 连续发送 burst（自动处理 tlast）
    //   data: 数据数组，最后一拍 tlast 自动设为 1
    //   gap:  每拍之间的空闲周期 (0 = 无间隙流水)
    //-----------------------------------------------------------------
    task send_burst(input bit [DW-1:0] data[], input int gap=0);
      int last_idx = data.size() - 1;

      for (int i = 0; i < data.size(); i++) begin
        bit last = (i == last_idx) ? 1'b1 : 1'b0;
        this.send_vector(data[i], last);

        // 拍间间隙
        if (gap > 0 && i < last_idx) begin
          repeat (gap) @(posedge vif.clk);
        end
      end
    endtask

    //-----------------------------------------------------------------
    // send_idle — 发送空闲周期（tvalid 保持低）
    //-----------------------------------------------------------------
    task send_idle(int cycles=1);
      repeat (cycles) begin
        @(posedge vif.clk);
        vif.tvalid <= 1'b0;
        vif.tdata  <= 'x;
        vif.tlast  <= 'x;
        vif.tkeep  <= 'x;
        vif.tuser  <= 'x;
      end
    endtask

    //-----------------------------------------------------------------
    // wait_ready — 根据当前 ready_mode 驱动 tready (slave 模式)
    //   当 VIP 作为接收端 (slave modport) 使用时调用此任务
    //-----------------------------------------------------------------
    task wait_ready();
      case (this.ready_mode)
        ALWAYS_READY: begin
          @(posedge vif.clk);
          vif.tready <= 1'b1;
        end

        HANDSHAKE_ONLY: begin
          @(posedge vif.clk);
          if (vif.tvalid === 1'b1)
            vif.tready <= 1'b1;
          else
            vif.tready <= 1'b0;
        end

        RANDOM_BACKPRESSURE: begin
          int delay;
          if (vif.tvalid === 1'b1) begin
            delay = this.rng_min_gap +
                    ($urandom(this.seed) % (this.rng_max_gap - this.rng_min_gap + 1));
            this.seed++;
            vif.tready <= 1'b0;
            repeat (delay) @(posedge vif.clk);
            vif.tready <= 1'b1;
          end else begin
            vif.tready <= 1'b0;
          end
        end

        GAPPED: begin
          if (this.gap_cycles > 0) begin
            vif.tready <= 1'b1;
            repeat (this.gap_cycles) begin
              @(posedge vif.clk);
              vif.tready <= 1'b0;
            end
          end else begin
            vif.tready <= 1'b1;
          end
        end

        default: begin
          vif.tready <= 1'b1;
        end
      endcase
    endtask

    //-----------------------------------------------------------------
    // get_transaction_count — 返回已发送事务数
    //-----------------------------------------------------------------
    function int get_transaction_count();
      return this.transaction_count;
    endfunction

    //-----------------------------------------------------------------
    // reset_dut — 驱动复位 (master modport)
    //   cycles: 复位保持周期数
    //-----------------------------------------------------------------
    task reset_dut(int cycles=4);
      @(posedge vif.clk);
      vif.tvalid <= 1'b0;
      vif.tdata  <= 'x;
      vif.tlast  <= 'x;
      vif.tkeep  <= 'x;
      vif.tuser  <= 'x;
      repeat (cycles) @(posedge vif.clk);
    endtask

  endclass


  //=================================================================
  // axis_monitor — AXI-Stream 监视器类
  //-----------------------------------------------------------------
  // 捕获 AXI-Stream 总线上所有事务 (valid & ready 同时为高的拍)
  // 提供缓冲和日志能力，可被 scoreboard 消费
  //=================================================================
  class axis_monitor #(int DW=32);

    // Virtual interface (monitor modport: 所有信号 input)
    virtual axi_stream_if #(DW).monitor vif;

    // 捕获缓冲区（并行队列，避免参数化 struct）
    protected bit [DW-1:0]   data_q[$];
    protected bit            last_q[$];
    protected bit [DW/8-1:0] keep_q[$];
    protected int unsigned   cycle_q[$];

    // 状态
    protected int     capture_count;
    protected int     max_capture;       // 最大捕获数 (0 = 无限)
    protected int     log_fd;
    protected string  log_file;
    protected bit     logging_enabled;

    //-----------------------------------------------------------------
    // 构造函数
    //-----------------------------------------------------------------
    function new(virtual axi_stream_if #(DW).monitor vif);
      this.vif = vif;
      this.capture_count = 0;
      this.max_capture   = 0;
      this.log_fd        = -1;
      this.logging_enabled = 0;
    endfunction

    //-----------------------------------------------------------------
    // set_max_capture — 设置最大捕获量
    //-----------------------------------------------------------------
    function void set_max_capture(int max);
      this.max_capture = max;
    endfunction

    //-----------------------------------------------------------------
    // enable_logging — 启用事务日志
    //-----------------------------------------------------------------
    function void enable_logging(string file);
      this.log_file = file;
      this.log_fd = $fopen(file, "w");
      if (this.log_fd == 0) begin
        $error("axis_monitor: cannot open log file %s", file);
      end else begin
        this.logging_enabled = 1;
        $fdisplay(this.log_fd, "# axis_monitor transaction log");
        $fdisplay(this.log_fd, "# time, data, last, keep");
      end
    endfunction

    //-----------------------------------------------------------------
    // disable_logging — 关闭事务日志
    //-----------------------------------------------------------------
    function void disable_logging();
      if (this.log_fd != -1) begin
        $fclose(this.log_fd);
        this.log_fd = -1;
      end
      this.logging_enabled = 0;
    endfunction

    //-----------------------------------------------------------------
    // capture — 捕获事务（阻塞，循环等待握手完成）
    //   在时钟上升沿采样，valid&ready 时记录到缓冲区
    //   到达 max_capture 后返回
    //-----------------------------------------------------------------
    task capture();
      int unsigned cycle_cnt = 0;

      forever begin
        @(posedge vif.clk);
        cycle_cnt++;

        if (vif.tvalid === 1'b1 && vif.tready === 1'b1) begin
          data_q.push_back(vif.tdata);
          last_q.push_back(vif.tlast);
          keep_q.push_back(vif.tkeep);
          cycle_q.push_back(cycle_cnt);
          this.capture_count++;

          // 日志
          if (this.logging_enabled && this.log_fd != -1) begin
            $fdisplay(this.log_fd, "%0t, 0x%h, %b, 0x%h",
                      $time, vif.tdata, vif.tlast, vif.tkeep);
          end

          // 到达上限时停止
          if (this.max_capture > 0 && this.capture_count >= this.max_capture)
            break;
        end
      end
    endtask

    //-----------------------------------------------------------------
    // capture_n — 捕获 N 个事务
    //-----------------------------------------------------------------
    task capture_n(int n);
      this.set_max_capture(n);
      this.capture();
    endtask

    //-----------------------------------------------------------------
    // get_transaction_count — 返回已捕获事务数
    //-----------------------------------------------------------------
    function int get_transaction_count();
      return this.capture_count;
    endfunction

    //-----------------------------------------------------------------
    // get_last_data — 返回最后捕获的数据
    //-----------------------------------------------------------------
    function bit [DW-1:0] get_last_data();
      if (this.data_q.size() == 0)
        return 'x;
      return this.data_q[$];
    endfunction

    //-----------------------------------------------------------------
    // get_all_data — 将所有捕获数据复制到动态数组
    //-----------------------------------------------------------------
    function void get_all_data(ref bit [DW-1:0] data[]);
      data = new[this.data_q.size()];
      for (int i = 0; i < this.data_q.size(); i++) begin
        data[i] = this.data_q[i];
      end
    endfunction

    //-----------------------------------------------------------------
    // get_all_last — 将所有 tlast 复制到动态数组
    //-----------------------------------------------------------------
    function void get_all_last(ref bit last[]);
      last = new[this.last_q.size()];
      for (int i = 0; i < this.last_q.size(); i++) begin
        last[i] = this.last_q[i];
      end
    endfunction

    //-----------------------------------------------------------------
    // get_size — 返回缓冲区大小
    //-----------------------------------------------------------------
    function int get_size();
      return this.data_q.size();
    endfunction

    //-----------------------------------------------------------------
    // clear — 清空缓冲区
    //-----------------------------------------------------------------
    function void clear();
      this.data_q.delete();
      this.last_q.delete();
      this.keep_q.delete();
      this.cycle_q.delete();
      this.capture_count = 0;
    endfunction

  endclass


  //=================================================================
  // axis_scoreboard — AXI-Stream 记分板类
  //-----------------------------------------------------------------
  // FIFO 结构: push_expected / push_actual 入队，compare 比对
  // 输出 JSON 证据文件兼容 Phase 4.5 证据门禁格式
  //=================================================================
  class axis_scoreboard #(int DW=32);

    // 期望值与实际值 FIFO
    protected bit [DW-1:0] expected_q[$];
    protected bit [DW-1:0] actual_q[$];

    // 比对结果
    protected int     pass_count;
    protected int     fail_count;
    protected int     first_fail_idx;   // 首错索引 (-1 = 无)
    protected int     max_error_bit;    // 最大误差位位置 (-1 = 无)
    protected int     compared_points;
    protected string  module_name;
    protected int     verbosity;

    //-----------------------------------------------------------------
    // 构造函数
    //-----------------------------------------------------------------
    function new(string module_name="unnamed");
      this.module_name     = module_name;
      this.pass_count      = 0;
      this.fail_count      = 0;
      this.first_fail_idx  = -1;
      this.max_error_bit   = -1;
      this.compared_points = 0;
      this.verbosity       = 1;
    endfunction

    //-----------------------------------------------------------------
    // set_verbosity — 设置详细程度 (0=静默, 1=摘要, 2=详细)
    //-----------------------------------------------------------------
    function void set_verbosity(int v);
      this.verbosity = v;
    endfunction

    //-----------------------------------------------------------------
    // push_expected — 从 Golden Model 推入一个期望值
    //-----------------------------------------------------------------
    function void push_expected(ref bit [DW-1:0] data);
      this.expected_q.push_back(data);
    endfunction

    //-----------------------------------------------------------------
    // push_expected_array — 批量推入期望值
    //-----------------------------------------------------------------
    function void push_expected_array(ref bit [DW-1:0] data[]);
      for (int i = 0; i < data.size(); i++) begin
        this.expected_q.push_back(data[i]);
      end
    endfunction

    //-----------------------------------------------------------------
    // push_actual — 从 DUT 推入一个实际值
    //-----------------------------------------------------------------
    function void push_actual(ref bit [DW-1:0] data);
      this.actual_q.push_back(data);
    endfunction

    //-----------------------------------------------------------------
    // push_actual_array — 批量推入实际值
    //-----------------------------------------------------------------
    function void push_actual_array(ref bit [DW-1:0] data[]);
      for (int i = 0; i < data.size(); i++) begin
        this.actual_q.push_back(data[i]);
      end
    endfunction

    //-----------------------------------------------------------------
    // compare — 比对所有数据
    //   verbosity: 覆盖默认详细程度
    //   返回 1 表示 PASS, 0 表示 FAIL
    //-----------------------------------------------------------------
    function bit compare(int verbosity=-1);
      int n_expected, n_actual;
      int n_compare;
      bit all_pass = 1'b1;

      if (verbosity < 0) verbosity = this.verbosity;

      n_expected = this.expected_q.size();
      n_actual   = this.actual_q.size();
      n_compare  = (n_expected < n_actual) ? n_expected : n_actual;

      if (n_expected != n_actual) begin
        $display("[SCOREBOARD] %s: WARNING — expected count (%0d) != actual count (%0d)",
                 this.module_name, n_expected, n_actual);
        if (verbosity >= 1)
          $display("[SCOREBOARD] %s: Will compare min(%0d, %0d) = %0d points",
                   this.module_name, n_expected, n_actual, n_compare);
      end

      for (int i = 0; i < n_compare; i++) begin
        bit [DW-1:0] exp = this.expected_q[i];
        bit [DW-1:0] act = this.actual_q[i];
        bit match;

        match = (exp == act);

        if (match) begin
          this.pass_count++;
        end else begin
          this.fail_count++;
          all_pass = 1'b0;

          // 记录首错
          if (this.first_fail_idx < 0)
            this.first_fail_idx = i;

          // 定位最大误差位
          for (int b = 0; b < DW; b++) begin
            if (exp[b] !== act[b]) begin
              if (b > this.max_error_bit)
                this.max_error_bit = b;
            end
          end

          if (verbosity >= 2) begin
            $display("[SCOREBOARD] %s: FAIL at index %0d — exp=0x%h, act=0x%h",
                     this.module_name, i, exp, act);
          end
        end

        this.compared_points++;
      end

      // 输出摘要
      if (verbosity >= 1) begin
        if (all_pass)
          $display("[SCOREBOARD] %s: PASS — %0d/%0d compared, all match",
                   this.module_name, n_compare, n_compare);
        else
          $display("[SCOREBOARD] %s: FAIL — %0d/%0d pass, %0d/%0d fail, first_fail=%0d, max_error_bit=%0d",
                   this.module_name, this.pass_count, n_compare,
                   this.fail_count, n_compare, this.first_fail_idx, this.max_error_bit);
      end

      return all_pass;
    endfunction

    //-----------------------------------------------------------------
    // compare_all — 完整比对（每个点都输出详细信息）
    //-----------------------------------------------------------------
    function bit compare_all();
      return this.compare(2);
    endfunction

    //-----------------------------------------------------------------
    // get_results — 返回比对结果结构体
    //-----------------------------------------------------------------
    function axis_result_t get_results();
      axis_result_t r;
      r.pass_count      = this.pass_count;
      r.fail_count      = this.fail_count;
      r.first_fail_at   = this.first_fail_idx;
      r.max_error_lsb   = this.max_error_bit;
      r.compared_points = this.compared_points;
      return r;
    endfunction

    //-----------------------------------------------------------------
    // get_pass_count — 返回通过数
    //-----------------------------------------------------------------
    function int get_pass_count();
      return this.pass_count;
    endfunction

    //-----------------------------------------------------------------
    // get_fail_count — 返回失败数
    //-----------------------------------------------------------------
    function int get_fail_count();
      return this.fail_count;
    endfunction

    //-----------------------------------------------------------------
    // clear — 清空 FIFO 和结果统计
    //-----------------------------------------------------------------
    function void clear();
      this.expected_q.delete();
      this.actual_q.delete();
      this.pass_count      = 0;
      this.fail_count      = 0;
      this.first_fail_idx  = -1;
      this.max_error_bit   = -1;
      this.compared_points = 0;
    endfunction

    //-----------------------------------------------------------------
    // dump_json — 输出 JSON 证据文件 (Phase 4.5 证据门禁兼容)
    //
    //   JSON 格式:
    //     {"module":"<name>","status":"PASS|FAIL",
    //      "compared_points":N,"max_error_lsb":E,"first_fail_at":null}
    //
    //   注意: 调用前必须先执行 compare() 否则结果为空
    //-----------------------------------------------------------------
    function void dump_json(string file);
      int fd;
      string status_str;

      fd = $fopen(file, "w");
      if (fd == 0) begin
        $error("axis_scoreboard: cannot open evidence file %s", file);
        return;
      end

      status_str = (this.fail_count == 0) ? "PASS" : "FAIL";

      $fwrite(fd, "{\n");
      $fwrite(fd, "  \"module\": \"%s\",\n", this.module_name);
      $fwrite(fd, "  \"status\": \"%s\",\n", status_str);
      $fwrite(fd, "  \"compared_points\": %0d,\n", this.compared_points);

      if (this.max_error_bit >= 0)
        $fwrite(fd, "  \"max_error_lsb\": %0d,\n", this.max_error_bit);
      else
        $fwrite(fd, "  \"max_error_lsb\": null,\n");

      if (this.first_fail_idx >= 0)
        $fwrite(fd, "  \"first_fail_at\": %0d\n", this.first_fail_idx);
      else
        $fwrite(fd, "  \"first_fail_at\": null\n");

      $fwrite(fd, "}\n");
      $fclose(fd);

      $display("[SCOREBOARD] Evidence written to %s: %s (%0d points)",
               file, status_str, this.compared_points);
    endfunction

  endclass


endpackage
