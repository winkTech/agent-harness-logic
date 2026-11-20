// ============================================================================
// cp_insert — 循环前缀插入
// 功能: 在 IFFT 输出的每个 OFDM 符号前拼接其末尾 CP_LEN 个样点作为循环前缀
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (IFFT 输出 I/Q, Q3.13);
//       m_axis_tdata = {I[15:0], Q[15:0]} 打包输出
// 主要逻辑: ri_ 输入寄存 -> 双 RAM 乒乓写入 -> 三段式 FSM 控制读地址
//           (先读末 CP_LEN 个, 再读整符号) -> 同步 RAM 读 -> 寄存输出
// 定点: Q3.13, 16bit I/Q
// 复位: 同步高有效; RAM 阵列与 RAM 读出寄存器按红线 3 豁免不加复位 (见下)
//
// 本文件为 hdl-coding 规范修复版。相对修复前的差异:
//   (1) 复位由 `negedge rst_n` 异步低有效改为同步高有效 i_rst;
//   (2) 端口 clk/rst_n -> i_clk/i_rst;
//   (3) **位宽修正 (SKILL.md §5)**: m_axis_tdata 原声明 [DATA_WIDTH-1:0]=16 位,
//       却被赋值 32 位的 {rd_i, rd_q} —— 高 16 位 (I 路) 被静默截断, 实际只输出
//       Q 路。现改为 [DATA_WIDTH*2-1:0], 与文件头/README 声明的 {I,Q} 打包语义一致。
//       **这是接口位宽变更, 顶层与 TB 已同步更新。**
//   (4) m_axis_tvalid 原为 `output_valid && m_axis_tready` —— 既违红线 2 (组合直出,
//       且把输入 tready 直接灌进输出), 也违 AXI4-Stream 协议 (tvalid 不得依赖
//       tready)。现改为纯寄存输出, 与 tready 解耦;
//   (5) RAM 读由组合 always@(*) 直出改为同步读 + 寄存 (红线 2) -> 输出延迟 +1 拍;
//   (6) 新增 ri_ 输入寄存级 (红线 1) -> 输入到输出再 +1 拍;
//   (7) FSM 补为三段式 (红线 4)。
//
// 红线 3 豁免声明: r_ram_* 阵列与 RAM 读出寄存器 r_rd_i/r_rd_q **有意不带复位** ——
//   给 BRAM 及其输出寄存器加复位会阻断 Xilinx block RAM 硬件宏推断。此为
//   docs/rules/01-hdl.md 列明的唯一豁免项之一; 生效条件是用 report_utilization
//   确认确实推断为 RAMB，**本包尚未跑 Vivado, 该确认未完成**。
//
// !! 遗留功能缺陷 (承自原始代码, 本次**未改**, 仅如实标注) !!
//   [F1] r_wr_bank **没有翻转逻辑** —— 乒乓机制未实现。修复前它连复位值都没有,
//        仿真恒 X; 现已确定性复位为 0 (与综合器对无驱动寄存器的处理一致), 但
//        "写完一个符号就换 bank" 的翻转仍然缺失: 写永远进 bank A, 读永远读 bank B
//        (bank B 从未被写过, 输出恒 0)。补翻转需要定义读写符号边界的交接协议,
//        属架构决策。
//   [F2] FSM 死状态: P_WRITE_SYM / P_DONE 已声明但次态永不到达; 而 s_axis_tready
//        的表达式引用了 P_WRITE_SYM, 即该条件恒假。
//   [F3] r_sym_cnt 只有 6 位 (0..63), 但 P_READ_SYM 要数到 FFT_LEN+CP_LEN-1 = 79,
//        计数器回绕后条件永不成立 —— 读状态出不去。
//   以上三项叠加的结果是: 本模块当前不能产出正确的 CP 符号流。修复须整体重做
//   乒乓与符号计数的架构, 属设计工作, 不在编码规范修复范围内。
// ============================================================================

`timescale 1ns / 1ps

module cp_insert #(
    parameter FFT_LEN    = 64,
    parameter CP_LEN     = 16,
    parameter DATA_WIDTH = 16
)(
    input  wire         i_clk,
    input  wire         i_rst,        // 同步复位, 高有效

    // Input from IFFT
    input  wire [15:0]  s_axis_i,
    input  wire [15:0]  s_axis_q,
    input  wire         s_axis_tvalid,
    output wire         s_axis_tready,
    input  wire         s_axis_tlast,

    // Output ({I[15:0], Q[15:0]} 打包)
    output wire [DATA_WIDTH*2-1:0] m_axis_tdata,
    output wire                    m_axis_tvalid,
    input  wire                    m_axis_tready,
    output wire                    m_axis_tlast
);

    // ========================================================================
    // 状态编码 (红线/命名: 状态用 P_ 前缀)
    // ========================================================================
    typedef enum logic [2:0] {
        P_IDLE,
        P_WRITE_SYM,
        P_READ_CP,
        P_READ_SYM,
        P_DONE
    } state_t;

    state_t r_state, w_state_nxt;

    // RAM banks (红线 3 豁免: BRAM 推断, 不加复位)
    reg [15:0] r_ram_i_a [0:FFT_LEN-1];
    reg [15:0] r_ram_q_a [0:FFT_LEN-1];
    reg [15:0] r_ram_i_b [0:FFT_LEN-1];
    reg [15:0] r_ram_q_b [0:FFT_LEN-1];

    // Control
    reg        r_wr_bank;      // 0: write A / read B; 1: 反之 —— 见 [F1], 无翻转逻辑
    reg [5:0]  r_wr_addr;
    reg [5:0]  r_rd_addr;
    reg        r_wr_en;
    reg [5:0]  r_sym_cnt;      // sample count within current symbol
    reg        r_out_valid;
    reg        r_out_last;

    // ========================================================================
    // ri_ 输入寄存 (红线 1)
    // ========================================================================
    reg [15:0] ri_axis_i, ri_axis_q;
    reg        ri_tvalid, ri_tlast;

    always @(posedge i_clk) begin
        if (i_rst) begin
            ri_axis_i <= 16'd0;
            ri_axis_q <= 16'd0;
            ri_tvalid <= 1'b0;
            ri_tlast  <= 1'b0;
        end else begin
            ri_axis_i <= s_axis_i;
            ri_axis_q <= s_axis_q;
            ri_tvalid <= s_axis_tvalid && s_axis_tready;
            ri_tlast  <= s_axis_tlast;
        end
    end

    // ========================================================================
    // Write logic
    // ========================================================================
    always @(posedge i_clk) begin
        if (i_rst) begin
            r_wr_addr <= 6'd0;
            r_wr_en   <= 1'b0;
            // [F1] 乒乓翻转未实现, 此处只给确定初值, 之后永不改变
            r_wr_bank <= 1'b0;
        end else if (ri_tvalid) begin
            // Write to current active bank
            if (r_wr_bank) begin
                r_ram_i_b[r_wr_addr] <= ri_axis_i;
                r_ram_q_b[r_wr_addr] <= ri_axis_q;
            end else begin
                r_ram_i_a[r_wr_addr] <= ri_axis_i;
                r_ram_q_a[r_wr_addr] <= ri_axis_q;
            end
            r_wr_en <= 1'b1;

            if (r_wr_addr == FFT_LEN-1) r_wr_addr <= 6'd0;
            else                        r_wr_addr <= r_wr_addr + 1'd1;
        end else begin
            r_wr_en <= 1'b0;
        end
    end

    // ========================================================================
    // Read logic (CP + full symbol)
    // ========================================================================
    always @(posedge i_clk) begin
        if (i_rst) begin
            r_rd_addr   <= 6'd0;
            r_out_valid <= 1'b0;
            r_out_last  <= 1'b0;
            r_sym_cnt   <= 6'd0;
        end else begin
            case (r_state)
                P_READ_CP: begin
                    // Read last CP_LEN samples
                    r_rd_addr   <= FFT_LEN - CP_LEN + r_sym_cnt;
                    r_out_valid <= 1'b1;
                    r_out_last  <= 1'b0;
                    r_sym_cnt   <= r_sym_cnt + 1'd1;
                end

                P_READ_SYM: begin
                    // Read full symbol
                    r_rd_addr   <= r_sym_cnt - CP_LEN;
                    r_out_valid <= 1'b1;
                    // [F3] r_sym_cnt 只有 6 位, 数不到 FFT_LEN+CP_LEN-1
                    r_out_last  <= (r_sym_cnt == FFT_LEN + CP_LEN - 1);
                    r_sym_cnt   <= r_sym_cnt + 1'd1;
                end

                default: begin
                    r_out_valid <= 1'b0;
                    r_out_last  <= 1'b0;
                    r_sym_cnt   <= 6'd0;
                end
            endcase
        end
    end

    // ========================================================================
    // 同步 RAM 读 + 输出寄存 (红线 2)
    // r_rd_i/r_rd_q 是 BRAM 输出寄存器, 按红线 3 豁免不加复位
    // ========================================================================
    reg [15:0] r_rd_i, r_rd_q;

    always @(posedge i_clk) begin
        if (r_wr_bank) begin
            r_rd_i <= r_ram_i_a[r_rd_addr];
            r_rd_q <= r_ram_q_a[r_rd_addr];
        end else begin
            r_rd_i <= r_ram_i_b[r_rd_addr];
            r_rd_q <= r_ram_q_b[r_rd_addr];
        end
    end

    reg ro_tvalid, ro_tlast;

    always @(posedge i_clk) begin
        if (i_rst) begin
            ro_tvalid <= 1'b0;
            ro_tlast  <= 1'b0;
        end else begin
            // 与同步 RAM 读数据对齐; **不依赖 m_axis_tready** (AXI-S 协议要求)
            ro_tvalid <= r_out_valid;
            ro_tlast  <= r_out_last;
        end
    end

    // Output: packed I/Q (Q3.13)
    assign m_axis_tdata  = {r_rd_i, r_rd_q};
    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tlast  = ro_tlast;

    // ========================================================================
    // 三段式状态机 (红线 4)
    // ========================================================================
    always @(*) begin
        w_state_nxt = r_state;
        case (r_state)
            P_IDLE: begin
                if (r_wr_en && r_wr_addr == FFT_LEN-1)
                    w_state_nxt = P_READ_CP;
            end

            P_READ_CP: begin
                if (r_sym_cnt == CP_LEN)
                    w_state_nxt = P_READ_SYM;
            end

            P_READ_SYM: begin
                // [F3] 该条件因计数器位宽不足而永不成立
                if (r_sym_cnt == FFT_LEN + CP_LEN)
                    w_state_nxt = P_IDLE;
            end

            // [F2] 以下两态当前不可达 —— 承自原始代码, 保留声明未改
            P_WRITE_SYM: w_state_nxt = P_IDLE;
            P_DONE:      w_state_nxt = P_IDLE;

            default:     w_state_nxt = P_IDLE;
        endcase
    end

    always @(posedge i_clk) begin
        if (i_rst) r_state <= P_IDLE;
        else       r_state <= w_state_nxt;
    end

    // 反压输出寄存 (红线 2)
    reg ro_tready;
    always @(posedge i_clk) begin
        if (i_rst) ro_tready <= 1'b0;
        // [F2] P_WRITE_SYM 分支恒假 —— 承自原始表达式, 未改其逻辑
        else       ro_tready <= (w_state_nxt == P_IDLE)
                             || (w_state_nxt == P_WRITE_SYM && r_wr_addr < FFT_LEN-1);
    end

    assign s_axis_tready = ro_tready;

endmodule
