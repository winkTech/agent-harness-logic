// ============================================================================
// DDR MIG AXI4 读写控制器 — 参考设计
//
// 功能: 提供简化的命令接口，封装 AXI4 突发读写时序
// 用途: 作为用户逻辑与 Xilinx MIG IP (AXI4 Slave) 之间的桥接层
//
// 状态机:
//   IDLE → WRITE_ADDR → WRITE_DATA → WRITE_RESP → IDLE
//   IDLE → READ_ADDR  → READ_DATA  → IDLE
//
// 例化:
//   ddr_axi4_controller #(
//       .DATA_WIDTH(512), .ADDR_WIDTH(32), .ID_WIDTH(4)
//   ) u_ddr_ctrl (
//       .clk                  (ui_clk),
//       .rst_n                (~ui_clk_sync_rst),
//       .init_calib_complete  (init_calib_complete),
//       .cmd_valid            (cmd_valid),
//       .cmd_ready            (cmd_ready),
//       .cmd_write_nread      (1'b1),  // 1=read
//       .cmd_addr             (32'h1000_0000),
//       .cmd_burst_len        (16),
//       .m_axi_*              (...MIG 接口...)
//   );
// ============================================================================

module ddr_axi4_controller #(
    parameter int DATA_WIDTH = 512,       // MIG AXI4 数据宽度
    parameter int ADDR_WIDTH = 32,        // AXI4 地址宽度
    parameter int ID_WIDTH   = 4,         // AXI4 ID 宽度
    parameter int BURST_LEN  = 16,        // 最大突发长度 (1-256)
    parameter int TIMEOUT_MAX = 4096      // 超时保护周期数
) (
    input  logic                     clk,
    input  logic                     rst_n,

    // ---- 用户命令接口 ----
    input  logic                     cmd_valid,
    output logic                     cmd_ready,
    input  logic                     cmd_write_nread,  // 0=写, 1=读
    input  logic [ADDR_WIDTH-1:0]    cmd_addr,
    input  logic [15:0]              cmd_burst_len,    // 突发拍数
    input  logic [DATA_WIDTH-1:0]    cmd_wdata,        // 写数据 (写命令时有效)

    // ---- 用户读数据接口 ----
    output logic                     rdata_valid,
    output logic [DATA_WIDTH-1:0]    rdata,
    output logic                     rdata_last,

    // ---- 状态 ----
    output logic                     ctrl_idle,
    output logic                     ctrl_busy,
    output logic                     ctrl_timeout_err,
    input  logic                     init_calib_complete,

    // ---- AXI4 Master 到 MIG ----
    // 写地址通道
    output logic [ID_WIDTH-1:0]      m_axi_awid,
    output logic [ADDR_WIDTH-1:0]    m_axi_awaddr,
    output logic [7:0]               m_axi_awlen,
    output logic [2:0]               m_axi_awsize,
    output logic [1:0]               m_axi_awburst,
    output logic                     m_axi_awvalid,
    input  logic                     m_axi_awready,
    // 写数据通道
    output logic [DATA_WIDTH-1:0]    m_axi_wdata,
    output logic [DATA_WIDTH/8-1:0]  m_axi_wstrb,
    output logic                     m_axi_wlast,
    output logic                     m_axi_wvalid,
    input  logic                     m_axi_wready,
    // 写响应通道
    input  logic [ID_WIDTH-1:0]      m_axi_bid,
    input  logic [1:0]               m_axi_bresp,
    input  logic                     m_axi_bvalid,
    output logic                     m_axi_bready,
    // 读地址通道
    output logic [ID_WIDTH-1:0]      m_axi_arid,
    output logic [ADDR_WIDTH-1:0]    m_axi_araddr,
    output logic [7:0]               m_axi_arlen,
    output logic [2:0]               m_axi_arsize,
    output logic [1:0]               m_axi_arburst,
    output logic                     m_axi_arvalid,
    input  logic                     m_axi_arready,
    // 读数据通道
    input  logic [ID_WIDTH-1:0]      m_axi_rid,
    input  logic [DATA_WIDTH-1:0]    m_axi_rdata,
    input  logic [1:0]               m_axi_rresp,
    input  logic                     m_axi_rlast,
    input  logic                     m_axi_rvalid,
    output logic                     m_axi_rready,

    // ---- ILA 调试探针 ----
    output logic [3:0]               dbg_state,
    output logic                     dbg_write_active,
    output logic                     dbg_read_active,
    output logic [7:0]              dbg_burst_cnt
);

    // ========================================================================
    // 常量与参数
    // ========================================================================
    // AXI burst size = DATA_WIDTH/8 bytes, expressed as log2
    localparam int AW_SIZE = (DATA_WIDTH == 512) ? 6 :  // 64 bytes
                             (DATA_WIDTH == 256) ? 5 :  // 32 bytes
                             (DATA_WIDTH == 128) ? 4 :  // 16 bytes
                             (DATA_WIDTH == 64)  ? 3 :  // 8 bytes
                             2;                         // 4 bytes

    // 所有位为 1 的写 strobe (全字节使能)
    localparam logic [DATA_WIDTH/8-1:0] ALL_STRB = {DATA_WIDTH/8{1'b1}};

    // ========================================================================
    // 状态机编码
    // ========================================================================
    typedef enum logic [2:0] {
        ST_IDLE       = 3'd0,
        ST_WR_ADDR    = 3'd1,  // 写地址 (AW)
        ST_WR_DATA    = 3'd2,  // 写数据 (W)
        ST_WR_RESP    = 3'd3,  // 写响应 (B)
        ST_RD_ADDR    = 3'd4,  // 读地址 (AR)
        ST_RD_DATA    = 3'd5   // 读数据 (R)
    } state_t;

    state_t state, next_state;

    // ========================================================================
    // 内部寄存器
    // ========================================================================
    logic [ADDR_WIDTH-1:0]    r_addr;           // 当前命令地址 (寄存器)
    logic [15:0]              r_burst_len;       // 当前突发长度
    logic                     r_write_nread;     // 当前命令方向
    logic [7:0]               burst_cnt;         // 突发计数 (已传输拍数)
    logic [15:0]              timeout_cnt;       // 超时计数
    logic                     start_timeout;     // 超时使能

    // ========================================================================
    // 状态机: 次态与输出
    // ========================================================================
    always_comb begin
        // 默认值: 保持当前状态
        next_state = state;

        // 默认输出
        cmd_ready      = 1'b0;
        rdata_valid    = 1'b0;
        rdata_last     = 1'b0;
        ctrl_idle      = 1'b0;
        ctrl_busy      = 1'b0;
        ctrl_timeout_err = 1'b0;

        m_axi_awid     = {ID_WIDTH{1'b0}};
        m_axi_awaddr   = {ADDR_WIDTH{1'b0}};
        m_axi_awlen    = 8'd0;
        m_axi_awsize   = AW_SIZE;
        m_axi_awburst  = 2'b01;  // INCR
        m_axi_awvalid  = 1'b0;

        m_axi_wdata    = {DATA_WIDTH{1'b0}};
        m_axi_wstrb    = {DATA_WIDTH/8{1'b0}};
        m_axi_wlast    = 1'b0;
        m_axi_wvalid   = 1'b0;

        m_axi_bready   = 1'b0;

        m_axi_arid     = {ID_WIDTH{1'b0}};
        m_axi_araddr   = {ADDR_WIDTH{1'b0}};
        m_axi_arlen    = 8'd0;
        m_axi_arsize   = AW_SIZE;
        m_axi_arburst  = 2'b01;  // INCR
        m_axi_arvalid  = 1'b0;

        m_axi_rready   = 1'b0;

        // ILA 调试
        dbg_state        = state;
        dbg_write_active = 1'b0;
        dbg_read_active  = 1'b0;
        dbg_burst_cnt    = burst_cnt;

        start_timeout = 1'b0;

        unique case (state)
            ST_IDLE: begin
                ctrl_idle = 1'b1;
                // 等待校准完成 && 命令有效
                if (init_calib_complete && cmd_valid) begin
                    cmd_ready    = 1'b1;
                    if (cmd_write_nread) begin
                        next_state = ST_RD_ADDR;  // 读操作
                    end else begin
                        next_state = ST_WR_ADDR;  // 写操作
                    end
                end
            end

            // ================================================================
            // 写操作: 地址 → 数据 → 响应
            // ================================================================
            ST_WR_ADDR: begin
                ctrl_busy = 1'b1;
                m_axi_awid    = {ID_WIDTH{1'b0}};
                m_axi_awaddr  = r_addr;
                m_axi_awlen   = r_burst_len[7:0];  // 拍数 - 1
                m_axi_awsize  = AW_SIZE;
                m_axi_awburst = 2'b01;  // INCR
                m_axi_awvalid = 1'b1;
                start_timeout = 1'b1;

                if (m_axi_awready) begin
                    next_state = ST_WR_DATA;
                end
            end

            ST_WR_DATA: begin
                ctrl_busy = 1'b1;
                dbg_write_active = 1'b1;
                m_axi_wdata = cmd_wdata;          // 写数据
                m_axi_wstrb = ALL_STRB;           // 全字节使能
                m_axi_wlast = (burst_cnt == r_burst_len - 1);  // ILA_PROBE
                m_axi_wvalid = 1'b1;
                start_timeout = 1'b1;

                if (m_axi_wready) begin
                    if (m_axi_wlast) begin
                        next_state = ST_WR_RESP;  // 写数据完成 -> 等待响应
                    end
                    // 否则停留在 WR_DATA, burst_cnt 在外围时序中递增
                end
            end

            ST_WR_RESP: begin
                ctrl_busy = 1'b1;
                m_axi_bready = 1'b1;
                start_timeout = 1'b1;

                if (m_axi_bvalid) begin
                    // bresp=2'b00 (OKAY) 或 2'b01 (EXOKAY) 为成功
                    if (m_axi_bresp inside {2'b00, 2'b01}) begin
                        next_state = ST_IDLE;
                    end else begin
                        // SLVERR/DECERR — 上报但不死锁
                        ctrl_timeout_err = 1'b1;
                        next_state = ST_IDLE;
                    end
                end
            end

            // ================================================================
            // 读操作: 地址 → 数据
            // ================================================================
            ST_RD_ADDR: begin
                ctrl_busy = 1'b1;
                m_axi_arid    = {ID_WIDTH{1'b0}};
                m_axi_araddr  = r_addr;
                m_axi_arlen   = r_burst_len[7:0];  // 拍数 - 1
                m_axi_arsize  = AW_SIZE;
                m_axi_arburst = 2'b01;  // INCR
                m_axi_arvalid = 1'b1;
                start_timeout = 1'b1;

                if (m_axi_arready) begin
                    next_state = ST_RD_DATA;
                end
            end

            ST_RD_DATA: begin
                ctrl_busy = 1'b1;
                dbg_read_active = 1'b1;
                m_axi_rready = 1'b1;
                start_timeout = 1'b1;

                if (m_axi_rvalid) begin
                    rdata_valid = 1'b1;      // ILA_PROBE
                    rdata       = m_axi_rdata;
                    rdata_last  = m_axi_rlast;  // ILA_PROBE

                    if (m_axi_rlast) begin
                        next_state = ST_IDLE;  // 读完成
                    end
                end
            end

            default: begin
                next_state = ST_IDLE;
            end
        endcase
    end

    // ========================================================================
    // 时序逻辑: 状态寄存器 & 命令锁存
    // ========================================================================
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state       <= ST_IDLE;
            r_addr      <= {ADDR_WIDTH{1'b0}};
            r_burst_len <= 16'd0;
            r_write_nread <= 1'b0;
            burst_cnt   <= 8'd0;
            timeout_cnt <= 16'd0;
        end else begin
            state <= next_state;

            // 在 IDLE 锁存命令参数
            if (state == ST_IDLE && cmd_valid && init_calib_complete) begin
                r_addr        <= cmd_addr;
                r_burst_len   <= cmd_burst_len;
                r_write_nread <= cmd_write_nread;
                burst_cnt     <= 8'd0;
                timeout_cnt   <= 16'd0;
            end

            // 突发计数递增
            if (state == ST_WR_DATA && m_axi_wready) begin
                burst_cnt <= burst_cnt + 1'b1;
            end else if (state == ST_RD_DATA && m_axi_rvalid) begin
                burst_cnt <= burst_cnt + 1'b1;
            end else if (state != next_state && next_state != state) begin
                // 状态切换时清空计数 (非写/读状态)
                if (next_state != ST_WR_DATA && next_state != ST_RD_DATA) begin
                    burst_cnt <= 8'd0;
                end
            end

            // 超时计数器
            if (start_timeout) begin
                if (timeout_cnt < TIMEOUT_MAX) begin
                    timeout_cnt <= timeout_cnt + 1'b1;
                end else begin
                    // 超时 → 回到 IDLE, 上报错误
                    state <= ST_IDLE;
                    timeout_cnt <= 16'd0;
                end
            end else begin
                timeout_cnt <= 16'd0;
            end
        end
    end

    // ========================================================================
    // 断言: 基本协议检查
    // ========================================================================
    // synopsys translate_off
    assert property (@(posedge clk) disable iff (!rst_n)
        (m_axi_awvalid && m_axi_awready) |=>
            state == ST_WR_DATA)
        else $warning("[DDR_CTRL] AW handshake but not transitioning to WR_DATA");

    assert property (@(posedge clk) disable iff (!rst_n)
        (m_axi_bvalid && m_axi_bready) |->
            m_axi_bresp inside {2'b00, 2'b01, 2'b10, 2'b11})
        else $error("[DDR_CTRL] Unknown bresp: %0b", m_axi_bresp);

    cov_no_cmd: cover property (@(posedge clk)
        state == ST_IDLE && cmd_valid && init_calib_complete);
    // synopsys translate_on

endmodule : ddr_axi4_controller
