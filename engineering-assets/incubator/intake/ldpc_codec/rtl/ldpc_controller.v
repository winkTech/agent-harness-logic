//                     LDPC Controller Module
// 功能描述: 译码器主状态机 (三段式, 独热码)。逐行驱动 READ / WB 两个相位,
//   每完成一整迭代再走一遍 SYND 扫描判早停; msg_buffer 清零由顶层完成,
//   本模块只发 o_clear_req 并等 i_clear_done。
//
// 端口要点:
//   i_conn_count  当前行连接数 (h_matrix_addr 给出, 有 5 拍延迟)
//   i_synd_fail   顶层汇总的 syndrome 结果 (SYND 扫描期间累积)
//   o_phase_*     本拍节拍归属; o_addr_en 与 o_cur_row/o_cur_conn 严格同拍
//   o_row_start   每行一个脉冲, 两种模式共用 (清 cn_update 累加器)
//
// 相位/时序契约与位宽依据见 README.md 的"控制架构"一节 —— 那里同时写着
// 顶层侧的另一半约束, 改一侧必须同时改另一侧。
//-----------------------------------------------------------------

module ldpc_controller #(
    parameter P_M                = 324,
    parameter P_H_NNZ            = 2376,
    parameter P_MAX_ITER         = 20,
    parameter P_ROW_ADDR_W       = 9,
    parameter P_CONN_CNT_W       = 4,
    parameter P_MSG_ADDR_W       = 12,
    parameter P_PIPE_RD          = 5,    // READ 排空 (>= 地址2 + 存储器1 + cn 输入1)
    parameter P_PIPE_WB          = 4,    // WB   排空 (>= cn 输出2 + 写 1)
    parameter P_WS_LAT           = 5,    // ROWSTART 等待 (>= conn_count 总延迟)
    // SYND 排空: 数据流水 3 拍 + 顶层折算奇偶 + ri_synd_fail 输入寄存
    parameter P_PIPE_SD          = 10
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    input  wire                             i_llr_loaded,
    input  wire [P_CONN_CNT_W-1:0]          i_conn_count,   // 来自 h_matrix_addr
    input  wire                             i_synd_fail,    // 顶层汇总: 有行校验非零
    input  wire                             i_clear_done,   // 顶层 msg_buffer 清零完成

    // 遍历节拍
    output wire                             o_addr_en,      // h_matrix_addr.i_en
    output wire [P_ROW_ADDR_W-1:0]          o_cur_row,
    output wire [P_CONN_CNT_W-1:0]          o_cur_conn,

    output wire                             o_phase_read,
    output wire                             o_phase_wb,
    output wire                             o_phase_synd,
    output wire                             o_row_start,    // 每行一个脉冲 (两种模式共用)
    output wire                             o_synd_clear,   // 开始一轮 syndrome 扫描
    output wire                             o_synd_eval,    // 扫描末尾: 折算本行
    output wire                             o_clear_req,    // 请求顶层清零 msg_buffer

    output wire                             o_decode_done,
    output wire                             o_busy
);

    // 状态定义 (独热码, 10 状态)
    localparam P_ST_IDLE      = 10'b0000000001;
    localparam P_ST_CLEAR     = 10'b0000000010;
    localparam P_ST_ROWSTART  = 10'b0000000100;
    localparam P_ST_READ      = 10'b0000001000;
    localparam P_ST_RDRAIN    = 10'b0000010000;
    localparam P_ST_WB        = 10'b0000100000;
    localparam P_ST_WDRAIN    = 10'b0001000000;
    localparam P_ST_SYND      = 10'b0010000000;
    localparam P_ST_SDRAIN    = 10'b0100000000;
    localparam P_ST_DONE      = 10'b1000000000;

    // 输入寄存 (红线1)
    reg                         ri_llr_loaded;
    reg [P_CONN_CNT_W-1:0]      ri_conn_count;
    reg                         ri_synd_fail;
    reg                         ri_clear_done;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ri_llr_loaded <= 1'b0;
            ri_conn_count <= {P_CONN_CNT_W{1'b0}};
            ri_synd_fail  <= 1'b0;
            ri_clear_done <= 1'b0;
        end else begin
            ri_llr_loaded <= i_llr_loaded;
            ri_conn_count <= i_conn_count;
            ri_synd_fail  <= i_synd_fail;
            ri_clear_done <= i_clear_done;
        end
    end

    // 状态与计数器
    reg [9:0]                   r_cur_state;
    reg [9:0]                   r_nxt_state;

    reg [P_ROW_ADDR_W-1:0]      r_row_cnt;
    reg [P_CONN_CNT_W-1:0]      r_conn_cnt;
    reg [5:0]                   r_iter_cnt;
    reg [3:0]                   r_drain_cnt;
    reg [3:0]                   r_ws_cnt;
    reg [P_CONN_CNT_W-1:0]      r_row_wt;
    reg                         r_synd_mode;   // 1 = 本轮行遍历是 syndrome 扫描

    wire w_last_conn, w_last_row, w_last_iter, w_ws_done;
    wire w_drain_done_rd, w_drain_done_wb, w_drain_done_sd;
    assign w_drain_done_sd = (r_drain_cnt == (P_PIPE_SD - 1));
    assign w_ws_done       = (r_ws_cnt == (P_WS_LAT - 1));
    assign w_last_conn     = (r_conn_cnt == (r_row_wt - 1'b1));
    assign w_last_row      = (r_row_cnt  == (P_M - 1));
    assign w_last_iter     = (r_iter_cnt >= (P_MAX_ITER - 1));
    assign w_drain_done_rd = (r_drain_cnt == (P_PIPE_RD - 1));
    assign w_drain_done_wb = (r_drain_cnt == (P_PIPE_WB - 1));

    // 第一段: 状态寄存器
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) r_cur_state <= P_ST_IDLE;
        else           r_cur_state <= r_nxt_state;
    end

    // 第二段: 状态转移 (组合)
    always @(*) begin
        r_nxt_state = r_cur_state;

        case (r_cur_state)
            P_ST_IDLE:  if (ri_llr_loaded) r_nxt_state = P_ST_CLEAR;
            P_ST_CLEAR: if (ri_clear_done) r_nxt_state = P_ST_ROWSTART;

            P_ST_ROWSTART:
                if (w_ws_done) r_nxt_state = r_synd_mode ? P_ST_SYND : P_ST_READ;

            P_ST_READ:   if (w_last_conn)     r_nxt_state = P_ST_RDRAIN;
            P_ST_RDRAIN: if (w_drain_done_rd) r_nxt_state = P_ST_WB;
            P_ST_WB:     if (w_last_conn)     r_nxt_state = P_ST_WDRAIN;
            // 行遍历结束: 下一行或转 syndrome 扫描, 都从 ROWSTART 起头
            P_ST_WDRAIN: if (w_drain_done_wb) r_nxt_state = P_ST_ROWSTART;
            P_ST_SYND:   if (w_last_conn)     r_nxt_state = P_ST_SDRAIN;

            P_ST_SDRAIN: begin
                if (w_drain_done_sd) begin
                    if (!w_last_row) begin
                        r_nxt_state = P_ST_ROWSTART;      // 扫描下一行
                    end else if (!ri_synd_fail) begin
                        r_nxt_state = P_ST_DONE;          // syndrome 全 0 -> 早停
                    end else if (w_last_iter) begin
                        r_nxt_state = P_ST_DONE;          // 迭代用尽
                    end else begin
                        r_nxt_state = P_ST_ROWSTART;      // 进入下一次迭代
                    end
                end
            end

            P_ST_DONE:  r_nxt_state = P_ST_IDLE;
            default:    r_nxt_state = P_ST_IDLE;
        endcase
    end

    // 第三段 A1: 行内遍历 (连接索引 / 行重锁存 / ROWSTART 等待)
    wire w_in_walk = (r_cur_state == P_ST_READ) || (r_cur_state == P_ST_WB)
                                                || (r_cur_state == P_ST_SYND);

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_conn_cnt <= {P_CONN_CNT_W{1'b0}};
            r_ws_cnt   <= 4'd0;
            r_row_wt   <= {P_CONN_CNT_W{1'b0}};
        end else if (r_cur_state == P_ST_IDLE) begin
            r_conn_cnt <= {P_CONN_CNT_W{1'b0}};
            r_ws_cnt   <= 4'd0;
        end else if (r_cur_state == P_ST_ROWSTART) begin
            r_row_wt   <= ri_conn_count;   // 等待期内持续跟随, 退出时已稳定
            r_conn_cnt <= {P_CONN_CNT_W{1'b0}};
            r_ws_cnt   <= w_ws_done ? 4'd0 : (r_ws_cnt + 1'b1);
        end else if (w_in_walk) begin
            // READ / WB / SYND 三个相位的推进完全相同
            r_conn_cnt <= w_last_conn ? {P_CONN_CNT_W{1'b0}} : (r_conn_cnt + 1'b1);
        end
    end

    // 第三段 A2: 相位排空计数 / 行号 / 迭代号 / 扫描模式
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_row_cnt   <= {P_ROW_ADDR_W{1'b0}};
            r_iter_cnt  <= 6'd0;
            r_drain_cnt <= 4'd0;
            r_synd_mode <= 1'b0;
        end else begin
            case (r_cur_state)
                P_ST_IDLE: begin
                    r_row_cnt   <= {P_ROW_ADDR_W{1'b0}};
                    r_iter_cnt  <= 6'd0;
                    r_drain_cnt <= 4'd0;
                    r_synd_mode <= 1'b0;
                end

                P_ST_READ, P_ST_WB, P_ST_SYND:
                    if (w_last_conn) r_drain_cnt <= 4'd0;

                P_ST_RDRAIN:
                    r_drain_cnt <= w_drain_done_rd ? 4'd0 : (r_drain_cnt + 1'b1);

                P_ST_WDRAIN: begin
                    if (!w_drain_done_wb) begin
                        r_drain_cnt <= r_drain_cnt + 1'b1;
                    end else begin
                        r_drain_cnt <= 4'd0;
                        // 一次迭代的 324 行做完 -> 转 syndrome 扫描
                        r_row_cnt   <= w_last_row ? {P_ROW_ADDR_W{1'b0}} : (r_row_cnt + 1'b1);
                        if (w_last_row) r_synd_mode <= 1'b1;
                    end
                end

                P_ST_SDRAIN: begin
                    if (!w_drain_done_sd) begin
                        r_drain_cnt <= r_drain_cnt + 1'b1;
                    end else begin
                        r_drain_cnt <= 4'd0;
                        // 扫描完成: 未收敛且还有迭代额度 -> 回行遍历
                        r_row_cnt   <= w_last_row ? {P_ROW_ADDR_W{1'b0}} : (r_row_cnt + 1'b1);
                        if (w_last_row) begin
                            r_synd_mode <= 1'b0;
                            if (ri_synd_fail && !w_last_iter) r_iter_cnt <= r_iter_cnt + 1'b1;
                        end
                    end
                end
                default: ;
            endcase
        end
    end

    // 第三段 B: 输出寄存 (红线2)
    reg                         ro_addr_en;
    reg [P_ROW_ADDR_W-1:0]      ro_cur_row;
    reg [P_CONN_CNT_W-1:0]      ro_cur_conn;
    reg                         ro_phase_read;
    reg                         ro_phase_wb;
    reg                         ro_phase_synd;
    reg                         ro_row_start;
    reg                         ro_synd_clear;
    reg                         ro_synd_eval;
    reg                         ro_clear_req;
    reg                         ro_decode_done;
    reg                         ro_busy;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_addr_en     <= 1'b0;
            ro_cur_row     <= {P_ROW_ADDR_W{1'b0}};
            ro_cur_conn    <= {P_CONN_CNT_W{1'b0}};
            ro_phase_read  <= 1'b0;
            ro_phase_wb    <= 1'b0;
            ro_phase_synd  <= 1'b0;
            ro_row_start   <= 1'b0;
            ro_synd_clear  <= 1'b0;
            ro_synd_eval   <= 1'b0;
            ro_clear_req   <= 1'b0;
            ro_decode_done <= 1'b0;
            ro_busy        <= 1'b0;
        end else begin
            // 地址使能与 (row, conn) 严格同拍寄存 —— 原实现用 r_nxt_state 判使能
            // 却用 r_cur_state 的计数值出地址, 每行最后一条边不被取、第 0 条取两次。
            ro_addr_en  <= (r_cur_state == P_ST_READ)
                        || (r_cur_state == P_ST_WB)
                        || (r_cur_state == P_ST_SYND);
            ro_cur_row  <= r_row_cnt;
            ro_cur_conn <= r_conn_cnt;

            ro_phase_read <= (r_cur_state == P_ST_READ);
            ro_phase_wb   <= (r_cur_state == P_ST_WB);
            ro_phase_synd <= (r_cur_state == P_ST_SYND);

            // 行起始单拍脉冲: ROWSTART 的最后一拍
            ro_row_start  <= (r_cur_state == P_ST_ROWSTART) && w_ws_done;

            // syndrome 扫描的开始 / 逐行折算。末条边数据在 SDRAIN 第 3 拍到达,
            // 折算放第 5 拍留 2 拍余量 (少于此会把该行最后一条边漏掉)。
            ro_synd_clear <= (r_cur_state == P_ST_WDRAIN) && w_drain_done_wb && w_last_row;
            ro_synd_eval  <= (r_cur_state == P_ST_SDRAIN) && (r_drain_cnt == 4'd4);

            ro_clear_req   <= (r_cur_state == P_ST_CLEAR);
            ro_decode_done <= (r_nxt_state == P_ST_DONE) && (r_cur_state != P_ST_DONE);
            ro_busy        <= (r_cur_state != P_ST_IDLE);
        end
    end

    assign o_addr_en     = ro_addr_en;
    assign o_cur_row     = ro_cur_row;
    assign o_cur_conn    = ro_cur_conn;
    assign o_phase_read  = ro_phase_read;
    assign o_phase_wb    = ro_phase_wb;
    assign o_phase_synd  = ro_phase_synd;
    assign o_row_start   = ro_row_start;
    assign o_synd_clear  = ro_synd_clear;
    assign o_synd_eval   = ro_synd_eval;
    assign o_clear_req   = ro_clear_req;
    assign o_decode_done = ro_decode_done;
    assign o_busy        = ro_busy;

endmodule
