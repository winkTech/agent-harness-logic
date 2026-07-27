// ⛔ SUPERSEDED (2026-07-27): 修复前旧版, 无写回相位 (缺陷根因所在文件)。
// 权威版本: engineering-assets/incubator/intake/ldpc_codec/ (bit-true 0 失配)。
// 禁止引用/复制/例化; 详见 ../_SUPERSEDED.md。仅作历史对照保留。
//-----------------------------------------------------------------
//                     LDPC Controller Module
//-----------------------------------------------------------------
// 功能描述: 译码器主状态机 (三段式, 独热码)
//
// 状态转换:
//   IDLE     → INIT     (LLR 加载完毕)
//   INIT     → PROCESS  (开始迭代)
//   PROCESS  → CHECK    (一行 8 连接处理完毕)
//   CHECK    → PROCESS  (syndrome != 0, 继续下一行)
//   CHECK    → ITER_INC (所有 324 行处理完毕)
//   CHECK    → DONE     (早停: syndrome == 0)
//   ITER_INC → PROCESS  (iter < max_iter)
//   ITER_INC → DONE     (iter >= max_iter)
//   DONE     → OUTPUT   (准备输出)
//   OUTPUT   → IDLE     (输出完毕)
//
// 时序:
//   PROCESS 每 P_MAX_ROW_WT 周期完成一行
//   三层嵌套: iter (外层) → row (中层) → conn (内层)
//-----------------------------------------------------------------
// 主要逻辑:
//   1. 三段式状态机: 状态寄存器 → 转移逻辑 → 输出逻辑
//   2. 计数器在独立时序块中更新
//   3. 所有输出通过寄存器驱动 (ro_ 前缀)
//-----------------------------------------------------------------

module ldpc_controller #(
    parameter P_M                = 324,
    parameter P_MAX_ROW_WT       = 8,
    parameter P_MAX_ITER         = 20,
    parameter P_ROW_ADDR_W       = 9,
    parameter P_CONN_CNT_W       = 4
)(
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    input  wire                             i_llr_loaded,
    input  wire                             i_early_term,

    output wire                             o_start_proc,
    output wire [P_ROW_ADDR_W-1:0]          o_cur_row,
    output wire [P_CONN_CNT_W-1:0]          o_cur_conn,
    output wire [5:0]                       o_cur_iter,
    output wire                             o_row_done,
    output wire                             o_iter_done,
    output wire                             o_decode_done
);

    //-----------------------------------------------------------------
    // 状态定义 (独热码, 7 状态)
    //-----------------------------------------------------------------
    localparam P_ST_IDLE       = 7'b0000001;
    localparam P_ST_INIT       = 7'b0000010;
    localparam P_ST_PROCESS    = 7'b0000100;
    localparam P_ST_CHECK      = 7'b0001000;
    localparam P_ST_ITER_INC   = 7'b0010000;
    localparam P_ST_DONE       = 7'b0100000;
    localparam P_ST_OUTPUT     = 7'b1000000;

    //-----------------------------------------------------------------
    // 输入信号寄存
    //-----------------------------------------------------------------
    reg                         ri_llr_loaded;
    reg                         ri_early_term;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ri_llr_loaded <= 1'b0;
            ri_early_term <= 1'b0;
        end else begin
            ri_llr_loaded <= i_llr_loaded;
            ri_early_term <= i_early_term;
        end
    end

    //-----------------------------------------------------------------
    // 状态寄存器
    //-----------------------------------------------------------------
    reg [6:0]                   r_cur_state;
    reg [6:0]                   r_nxt_state;

    //-----------------------------------------------------------------
    // 计数器
    //-----------------------------------------------------------------
    reg [P_ROW_ADDR_W-1:0]      r_row_cnt;
    reg [P_CONN_CNT_W-1:0]      r_conn_cnt;
    reg [5:0]                   r_iter_cnt;

    //-----------------------------------------------------------------
    // 条件信号提取 (提高可读性)
    //-----------------------------------------------------------------
    wire w_row_last_conn;
    wire w_row_is_last;
    wire w_iter_is_last;

    assign w_row_last_conn = (r_conn_cnt == (P_MAX_ROW_WT - 1));
    assign w_row_is_last   = (r_row_cnt  == (P_M - 1));
    assign w_iter_is_last  = (r_iter_cnt >= (P_MAX_ITER - 1));

    //-----------------------------------------------------------------
    // 第一段: 状态寄存器 (时序逻辑)
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_cur_state <= P_ST_IDLE;
        end else begin
            r_cur_state <= r_nxt_state;
        end
    end

    //-----------------------------------------------------------------
    // 第二段: 状态转移逻辑 (组合逻辑)
    //-----------------------------------------------------------------
    always @(*) begin
        r_nxt_state = r_cur_state;

        case (r_cur_state)
            P_ST_IDLE: begin
                if (ri_llr_loaded) begin
                    r_nxt_state = P_ST_INIT;
                end
            end

            P_ST_INIT: begin
                r_nxt_state = P_ST_PROCESS;
            end

            P_ST_PROCESS: begin
                if (w_row_last_conn) begin
                    r_nxt_state = P_ST_CHECK;
                end
            end

            P_ST_CHECK: begin
                if (ri_early_term) begin
                    r_nxt_state = P_ST_DONE;
                end else if (w_row_is_last) begin
                    r_nxt_state = P_ST_ITER_INC;
                end else begin
                    r_nxt_state = P_ST_PROCESS;
                end
            end

            P_ST_ITER_INC: begin
                if (w_iter_is_last) begin
                    r_nxt_state = P_ST_DONE;
                end else begin
                    r_nxt_state = P_ST_PROCESS;
                end
            end

            P_ST_DONE: begin
                r_nxt_state = P_ST_OUTPUT;
            end

            P_ST_OUTPUT: begin
                r_nxt_state = P_ST_IDLE;
            end

            default: begin
                r_nxt_state = P_ST_IDLE;
            end
        endcase
    end

    //-----------------------------------------------------------------
    // 第三段 A: 计数器更新 (时序逻辑, 基于当前状态)
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_row_cnt  <= 'd0;
            r_conn_cnt <= 'd0;
            r_iter_cnt <= 'd0;
        end else begin
            case (r_cur_state)
                P_ST_INIT: begin
                    r_row_cnt  <= 'd0;
                    r_conn_cnt <= 'd0;
                    r_iter_cnt <= 'd0;
                end

                P_ST_PROCESS: begin
                    if (w_row_last_conn) begin
                        r_conn_cnt <= 'd0;
                    end else begin
                        r_conn_cnt <= r_conn_cnt + 1'b1;
                    end
                end

                P_ST_CHECK: begin
                    if (!ri_early_term && !w_row_is_last) begin
                        r_row_cnt <= r_row_cnt + 1'b1;
                    end
                end

                P_ST_ITER_INC: begin
                    r_row_cnt  <= 'd0;
                    r_iter_cnt <= r_iter_cnt + 1'b1;
                end

                default: begin
                end
            endcase
        end
    end

    //-----------------------------------------------------------------
    // 第三段 B: 输出寄存器 (时序逻辑, ro_ 前缀)
    //-----------------------------------------------------------------
    reg                         ro_start_proc;
    reg [P_ROW_ADDR_W-1:0]      ro_cur_row;
    reg [P_CONN_CNT_W-1:0]      ro_cur_conn;
    reg [5:0]                   ro_cur_iter;
    reg                         ro_row_done;
    reg                         ro_iter_done;
    reg                         ro_decode_done;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_start_proc  <= 1'b0;
            ro_cur_row     <= 'd0;
            ro_cur_conn    <= 'd0;
            ro_cur_iter    <= 'd0;
            ro_row_done    <= 1'b0;
            ro_iter_done   <= 1'b0;
            ro_decode_done <= 1'b0;
        end else begin
            ro_start_proc  <= (r_nxt_state == P_ST_PROCESS);
            ro_cur_row     <= r_row_cnt;
            ro_cur_conn    <= r_conn_cnt;
            ro_cur_iter    <= r_iter_cnt;
            ro_row_done    <= (r_cur_state == P_ST_PROCESS) && w_row_last_conn;
            ro_iter_done   <= (r_nxt_state == P_ST_ITER_INC);
            ro_decode_done <= (r_nxt_state == P_ST_OUTPUT);
        end
    end

    //-----------------------------------------------------------------
    // 输出赋值
    //-----------------------------------------------------------------
    assign o_start_proc  = ro_start_proc;
    assign o_cur_row     = ro_cur_row;
    assign o_cur_conn    = ro_cur_conn;
    assign o_cur_iter    = ro_cur_iter;
    assign o_row_done    = ro_row_done;
    assign o_iter_done   = ro_iter_done;
    assign o_decode_done = ro_decode_done;

endmodule
