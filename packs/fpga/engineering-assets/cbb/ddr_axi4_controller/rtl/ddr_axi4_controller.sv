`default_nettype none
//==============================================================================
// ddr_axi4_controller — DDR MIG AXI4 读写桥接控制器 (单事务, 全寄存输出)
// 功能: 命令接口 + 写数据流/读数据流 <-> AXI4 主机 (对接 Xilinx MIG slave)
// 端口: i_clk/i_rst(同步高有效); 命令 i_cmd_*(valid/ready, write=1 为写);
//       写流 i_wr_*(valid/ready); 读流 o_rd_*(无背压); m_axi_*(AXI 协议名豁免)
// 主要逻辑: 命令锁存(ri_) -> 三段式 FSM -> AXI 通道全 ro_ 寄存; 写数据内联 skid
// 延迟: 命令成交到 AW/AR 1 拍, 读数据寄存转发 1 拍。复位: 同步高有效,
//       丢弃在途事务 (须系统级复位, 正常运行勿复位)
// 错误: o_err 粘滞 = 超时(P_TIMEOUT 拍无进展)/bresp/rresp 错, 下一命令成交清;
//       超时撤 AXI valid 回 IDLE —— 严格 AXI 不允许, 仅作 MIG 挂死恢复路径
// 契约: i_cmd_len = 拍数 1..P_MAX_LEN; 单 ID 单事务; o_rd_* 无背压
//       (需背压下游例化 axis_skid_buffer)
//
// 来源: 改写自 knowledge/primary/domains/fpga/ddr_axi4_controller.sv (参考设计)
//   原件七条缺陷 (本模块逐条修复): (1) 写通路只有单字段 cmd_wdata 无数据流
//   接口, burst>1 时 N 拍写同一数据 (本版新增 i_wr_* 流); (2) awlen 填拍数
//   而 wlast 按拍数-1 判, 协议矛盾; (3) 红线 3: 异步低有效复位无同步释放;
//   (4) 红线 1/2: 端口无前缀且全组合直出, wdata 输入直通; (5) 红线 5: 组合块
//   rdata 无默认值 (锁存器); (6) 超时静默 (单拍组合脉冲错误指示, 本版 o_err
//   粘滞); (7) cmd_write_nread 命名与语义相反 (代码里 1=读)。
//==============================================================================
module ddr_axi4_controller #(
    parameter int P_DATA_W  = 512,
    parameter int P_ADDR_W  = 32,
    parameter int P_ID_W    = 4,
    parameter int P_MAX_LEN = 256,     // 最大突发拍数
    parameter int P_TIMEOUT = 4096     // 单相位无进展看门狗拍数
)(
    input  wire logic                 i_clk,
    input  wire logic                 i_rst,          // 同步复位, 高有效
    input  wire logic                 i_calib_done,   // MIG init_calib_complete

    // 命令接口
    input  wire logic                 i_cmd_valid,
    output logic                      o_cmd_ready,
    input  wire logic                 i_cmd_write,    // 1=写, 0=读
    input  wire logic [P_ADDR_W-1:0]  i_cmd_addr,
    input  wire logic [8:0]           i_cmd_len,      // 拍数 1..P_MAX_LEN

    // 写数据流 (命令成交后逐拍供给)
    input  wire logic                 i_wr_valid,
    output logic                      o_wr_ready,
    input  wire logic [P_DATA_W-1:0]  i_wr_data,

    // 读数据流 (无背压)
    output logic                      o_rd_valid,
    output logic                      o_rd_last,
    output logic [P_DATA_W-1:0]       o_rd_data,

    // 状态
    output logic                      o_busy,
    output logic                      o_err,          // 粘滞, 下一命令成交清

    // AXI4 Master (对接 MIG, 总线协议名豁免)
    output logic [P_ID_W-1:0]         m_axi_awid,
    output logic [P_ADDR_W-1:0]       m_axi_awaddr,
    output logic [7:0]                m_axi_awlen,
    output logic [2:0]                m_axi_awsize,
    output logic [1:0]                m_axi_awburst,
    output logic                      m_axi_awvalid,
    input  wire logic                 m_axi_awready,
    output logic [P_DATA_W-1:0]       m_axi_wdata,
    output logic [P_DATA_W/8-1:0]     m_axi_wstrb,
    output logic                      m_axi_wlast,
    output logic                      m_axi_wvalid,
    input  wire logic                 m_axi_wready,
    input  wire logic [P_ID_W-1:0]    m_axi_bid,
    input  wire logic [1:0]           m_axi_bresp,
    input  wire logic                 m_axi_bvalid,
    output logic                      m_axi_bready,
    output logic [P_ID_W-1:0]         m_axi_arid,
    output logic [P_ADDR_W-1:0]       m_axi_araddr,
    output logic [7:0]                m_axi_arlen,
    output logic [2:0]                m_axi_arsize,
    output logic [1:0]                m_axi_arburst,
    output logic                      m_axi_arvalid,
    input  wire logic                 m_axi_arready,
    input  wire logic [P_ID_W-1:0]    m_axi_rid,
    input  wire logic [P_DATA_W-1:0]  m_axi_rdata,
    input  wire logic [1:0]           m_axi_rresp,
    input  wire logic                 m_axi_rlast,
    input  wire logic                 m_axi_rvalid,
    output logic                      m_axi_rready
);

    localparam int P_SIZE = $clog2(P_DATA_W / 8);   // AXI size = log2(字节/拍)

    // 状态编码 (三段式)
    localparam logic [5:0] P_ST_IDLE    = 6'b000001;
    localparam logic [5:0] P_ST_WR_ADDR = 6'b000010;
    localparam logic [5:0] P_ST_WR_DATA = 6'b000100;
    localparam logic [5:0] P_ST_WR_RESP = 6'b001000;
    localparam logic [5:0] P_ST_RD_ADDR = 6'b010000;
    localparam logic [5:0] P_ST_RD_DATA = 6'b100000;

    logic [5:0] r_cur_state, r_nxt_state;

    //==========================================================================
    // 命令成交与锁存 (红线 1)
    //==========================================================================
    logic                  ro_cmd_ready;
    logic [P_ADDR_W-1:0]   ri_addr;
    logic [8:0]            ri_len;
    logic                  w_cmd_fire;
    logic                  w_aw_fire, w_ar_fire, w_b_fire, w_r_fire;
    logic                  w_wlast_fire;
    logic                  r_wlast_done;
    logic                  w_timeout;

    assign w_cmd_fire = i_cmd_valid && ro_cmd_ready;
    assign w_aw_fire  = m_axi_awvalid && m_axi_awready;
    assign w_ar_fire  = m_axi_arvalid && m_axi_arready;
    assign w_b_fire   = m_axi_bvalid && m_axi_bready;
    assign w_r_fire   = m_axi_rvalid && m_axi_rready;
    assign w_wlast_fire = m_axi_wvalid && m_axi_wready && m_axi_wlast;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_addr      <= {P_ADDR_W{1'b0}};
            ri_len       <= 9'd1;
            r_wlast_done <= 1'b0;
        end else begin
            if (w_cmd_fire) begin
                ri_addr      <= i_cmd_addr;
                ri_len       <= i_cmd_len;
                r_wlast_done <= 1'b0;
            end else if (w_wlast_fire) begin
                r_wlast_done <= 1'b1;   // wlast 可能早于 FSM 进入 WR_DATA
            end
        end
    end

    //==========================================================================
    // 状态寄存 (段 1)
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst) r_cur_state <= P_ST_IDLE;
        else       r_cur_state <= r_nxt_state;
    end

    //==========================================================================
    // 次态组合 (段 2)
    //==========================================================================
    always_comb begin
        r_nxt_state = r_cur_state;
        unique case (r_cur_state)
            P_ST_IDLE:    if (w_cmd_fire) r_nxt_state = i_cmd_write ? P_ST_WR_ADDR : P_ST_RD_ADDR;
            P_ST_WR_ADDR: if (w_timeout)  r_nxt_state = P_ST_IDLE;
                          else if (w_aw_fire) r_nxt_state = P_ST_WR_DATA;
            P_ST_WR_DATA: if (w_timeout)  r_nxt_state = P_ST_IDLE;
                          else if (r_wlast_done || w_wlast_fire) r_nxt_state = P_ST_WR_RESP;
            P_ST_WR_RESP: if (w_timeout || w_b_fire) r_nxt_state = P_ST_IDLE;
            P_ST_RD_ADDR: if (w_timeout)  r_nxt_state = P_ST_IDLE;
                          else if (w_ar_fire) r_nxt_state = P_ST_RD_DATA;
            P_ST_RD_DATA: if (w_timeout || (w_r_fire && m_axi_rlast)) r_nxt_state = P_ST_IDLE;
            default:      r_nxt_state = P_ST_IDLE;
        endcase
    end

    //==========================================================================
    // 看门狗: 同一状态内无握手进展累计, 达 P_TIMEOUT 强制回 IDLE + 粘滞错
    //==========================================================================
    logic [$clog2(P_TIMEOUT):0] r_tout_cnt;
    logic w_any_fire;

    assign w_any_fire = w_aw_fire || w_ar_fire || w_b_fire || w_r_fire
                      || (m_axi_wvalid && m_axi_wready);
    assign w_timeout  = (r_tout_cnt >= P_TIMEOUT[$clog2(P_TIMEOUT):0]);

    always_ff @(posedge i_clk) begin
        if (i_rst)                                        r_tout_cnt <= '0;
        else if (r_cur_state == P_ST_IDLE || w_any_fire
                 || r_cur_state != r_nxt_state)           r_tout_cnt <= '0;
        else                                              r_tout_cnt <= r_tout_cnt + 1'b1;
    end

    //==========================================================================
    // 写数据通路: 上游流 -> 内联 skid -> m_axi_w* (全寄存, 满吞吐)
    //==========================================================================
    logic                  ro_wvalid, ro_wlast, ro_wr_ready;
    logic [P_DATA_W-1:0]   ro_wdata;
    logic                  r_skid_v, r_skid_l;
    logic [P_DATA_W-1:0]   r_skid_d;
    logic [8:0]            r_wr_rem;          // 尚未从上游接收的拍数
    logic                  w_up_fire, w_dn_fire, w_in_last, w_skid_v_nxt;
    logic [8:0]            w_wr_rem_nxt;

    assign w_up_fire  = ro_wr_ready && i_wr_valid;
    assign w_dn_fire  = ro_wvalid && m_axi_wready;
    assign w_in_last  = (r_wr_rem == 9'd1);
    assign w_wr_rem_nxt = (w_cmd_fire && i_cmd_write) ? i_cmd_len
                        : (w_up_fire ? r_wr_rem - 9'd1 : r_wr_rem);
    assign w_skid_v_nxt = r_skid_v ? !w_dn_fire
                                   : (w_up_fire && ro_wvalid && !w_dn_fire);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_wvalid <= 1'b0;  ro_wlast <= 1'b0;
            r_skid_v  <= 1'b0;  r_skid_l <= 1'b0;
            r_wr_rem  <= 9'd0;  ro_wr_ready <= 1'b0;
        end else begin
            r_wr_rem    <= w_wr_rem_nxt;
            ro_wr_ready <= (w_wr_rem_nxt != 9'd0) && !w_skid_v_nxt;
            if (w_dn_fire) begin
                if (r_skid_v) begin
                    ro_wdata <= r_skid_d;  ro_wlast <= r_skid_l;
                    r_skid_v <= 1'b0;
                end else if (w_up_fire) begin
                    ro_wdata <= i_wr_data; ro_wlast <= w_in_last;
                end else begin
                    ro_wvalid <= 1'b0;
                end
            end else if (w_up_fire) begin
                if (!ro_wvalid) begin
                    ro_wvalid <= 1'b1;
                    ro_wdata  <= i_wr_data; ro_wlast <= w_in_last;
                end else begin
                    r_skid_v <= 1'b1;
                    r_skid_d <= i_wr_data;  r_skid_l <= w_in_last;
                end
            end
        end
    end

    //==========================================================================
    // AXI 地址/响应通道与用户侧输出寄存 (红线 2)
    //==========================================================================
    logic ro_awvalid, ro_arvalid, ro_bready, ro_rready;
    logic ro_rd_valid, ro_rd_last;
    logic [P_DATA_W-1:0] ro_rd_data;
    logic ro_busy, ro_err;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_awvalid <= 1'b0; ro_arvalid <= 1'b0;
            ro_bready  <= 1'b0; ro_rready  <= 1'b0;
            ro_busy    <= 1'b0; ro_cmd_ready <= 1'b0;
        end else begin
            ro_awvalid   <= (r_nxt_state == P_ST_WR_ADDR);
            ro_arvalid   <= (r_nxt_state == P_ST_RD_ADDR);
            ro_bready    <= (r_nxt_state == P_ST_WR_RESP);
            ro_rready    <= (r_nxt_state == P_ST_RD_DATA);
            ro_busy      <= (r_nxt_state != P_ST_IDLE);
            ro_cmd_ready <= (r_nxt_state == P_ST_IDLE) && i_calib_done && !w_cmd_fire;
        end
    end

    // 读数据寄存转发 + 粘滞错误
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_rd_valid <= 1'b0; ro_rd_last <= 1'b0;
            ro_rd_data  <= {P_DATA_W{1'b0}};
            ro_err      <= 1'b0;
        end else begin
            ro_rd_valid <= w_r_fire;
            if (w_r_fire) begin
                ro_rd_data <= m_axi_rdata;
                ro_rd_last <= m_axi_rlast;
            end
            if (w_cmd_fire)                                   ro_err <= 1'b0;
            else if (w_timeout && r_cur_state != P_ST_IDLE)   ro_err <= 1'b1;
            else if (w_b_fire && m_axi_bresp[1])              ro_err <= 1'b1;
            else if (w_r_fire && m_axi_rresp[1])              ro_err <= 1'b1;
        end
    end

    //==========================================================================
    // 输出接线 (常量通道属性 = 常量驱动)
    //==========================================================================
    assign o_cmd_ready  = ro_cmd_ready;
    assign o_wr_ready   = ro_wr_ready;
    assign o_rd_valid   = ro_rd_valid;
    assign o_rd_last    = ro_rd_last;
    assign o_rd_data    = ro_rd_data;
    assign o_busy       = ro_busy;
    assign o_err        = ro_err;

    assign m_axi_awid   = {P_ID_W{1'b0}};
    assign m_axi_awaddr = ri_addr;
    assign m_axi_awlen  = 8'(ri_len - 9'd1);   // AXI: 拍数-1 (修原件缺陷 2)
    assign m_axi_awsize = 3'(P_SIZE);
    assign m_axi_awburst = 2'b01;              // INCR
    assign m_axi_awvalid = ro_awvalid;
    assign m_axi_wdata  = ro_wdata;
    assign m_axi_wstrb  = {P_DATA_W/8{1'b1}};
    assign m_axi_wlast  = ro_wlast;
    assign m_axi_wvalid = ro_wvalid;
    assign m_axi_bready = ro_bready;
    assign m_axi_arid   = {P_ID_W{1'b0}};
    assign m_axi_araddr = ri_addr;
    assign m_axi_arlen  = 8'(ri_len - 9'd1);
    assign m_axi_arsize = 3'(P_SIZE);
    assign m_axi_arburst = 2'b01;
    assign m_axi_arvalid = ro_arvalid;
    assign m_axi_rready = ro_rready;

endmodule
`default_nettype wire
