// ============================================================================
// pilot_insert — 导频插入 + 子载波映射 (802.11a)
// 功能: 把调制符号映射到 64 点 IFFT 的子载波格, 在导频位插 BPSK 导频,
//       在 DC/Guard 位插 0
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (调制符号 I/Q, Q2.14);
//       m_axis (子载波格 I/Q, Q2.14)
// 主要逻辑: ri_ 输入寄存 -> 三段式 FSM (IDLE/FILL_DATA/...) + bin 计数 ->
//           按 bin 位置选择 数据/导频/零 -> ro_ 寄存输出
// 定点: Q2.14, 16bit
// 复位: 同步高有效
//
// 本文件为 hdl-coding 规范修复版。相对修复前的差异:
//   (1) 复位由 `negedge rst_n` 异步低有效改为同步高有效 i_rst;
//   (2) 端口 clk/rst_n -> i_clk/i_rst;
//   (3) 新增 ri_ 输入寄存级 (红线 1) -> 数据通路延迟 +1 拍;
//   (4) 输出改由 ro_ 寄存器驱动 (红线 2), s_axis_tready 由组合直出改为寄存输出;
//   (5) FSM 补为三段式并补 default (红线 4/5)。
//
// !! 遗留功能缺陷 (承自原始代码, 本次**未改**, 仅如实标注) !!
//   [F1] FSM 死状态: FILL_GUARD_DC / FLUSH 已声明但次态逻辑永远到不了,
//        即"守护/DC 单独成态"的设计意图没有实现, 实际只在 IDLE/FILL_DATA 之间跑。
//   [F2] bin_cnt 在 FILL_DATA 态无条件递增, **不受 s_axis 握手门控** ——
//        上游无数据时子载波索引照样走, 符号边界会漂。
//   [F3] 导频极性只由 first_sym 区分 (首符号 +1, 其余 -1), 与 802.11a 规定的
//        导频扰码序列 (127 长 PRBS) 不符。
//   以上均需算法侧决策, 不在编码规范修复范围内。
// ============================================================================

`timescale 1ns / 1ps

module pilot_insert #(
    parameter FFT_LEN    = 64,
    parameter DATA_WIDTH = 16
)(
    input  wire         i_clk,
    input  wire         i_rst,        // 同步复位, 高有效

    // Input from mod mapper
    input  wire [15:0]  s_axis_i,
    input  wire [15:0]  s_axis_q,
    input  wire         s_axis_tvalid,
    output wire         s_axis_tready,
    input  wire         s_axis_tlast,

    // Output to IFFT
    output wire [15:0]  m_axis_i,
    output wire [15:0]  m_axis_q,
    output wire         m_axis_tvalid,
    input  wire         m_axis_tready
);

    // ========================================================================
    // 802.11a subcarrier allocation (64-point FFT)
    // Bin mapping (0-based, after FFT shift correction):
    //   - Bins 0..31  → negative frequency
    //   - Bins 32     → DC
    //   - Bins 33..63 → positive frequency
    // ========================================================================

    // Pilot values (BPSK, normalized to Q2.14)
    localparam P_PILOT_POS = 16'h4000;  // +1.0
    localparam P_PILOT_NEG = 16'hC000;  // -1.0

    // ========================================================================
    // 状态编码 (红线/命名: 状态用 P_ 前缀)
    // ========================================================================
    typedef enum logic [1:0] {
        P_IDLE,
        P_FILL_DATA,
        P_FILL_GUARD_DC,
        P_FLUSH
    } state_t;

    state_t r_state, w_state_nxt;

    // Counters
    reg [5:0]  r_bin_cnt;      // 0..63 subcarrier index
    reg [5:0]  r_data_cnt;     // data subcarrier count (0..47)
    reg        r_first_sym;    // first symbol flag

    // ========================================================================
    // ri_ 输入寄存 (红线 1)
    // ========================================================================
    reg [15:0] ri_axis_i, ri_axis_q;
    reg        ri_tvalid;

    always @(posedge i_clk) begin
        if (i_rst) begin
            ri_axis_i <= 16'd0;
            ri_axis_q <= 16'd0;
            ri_tvalid <= 1'b0;
        end else begin
            ri_axis_i <= s_axis_i;
            ri_axis_q <= s_axis_q;
            ri_tvalid <= s_axis_tvalid;
        end
    end

    // ========================================================================
    // Control logic (计数器)
    // ========================================================================
    always @(posedge i_clk) begin
        if (i_rst) begin
            r_bin_cnt   <= 6'd0;
            r_data_cnt  <= 6'd0;
            r_first_sym <= 1'b1;
        end else begin
            case (r_state)
                P_FILL_DATA: begin
                    if (s_axis_tvalid && s_axis_tready) begin
                        if (r_data_cnt == 6'd47) r_data_cnt <= 6'd0;
                        else                     r_data_cnt <= r_data_cnt + 1'd1;
                    end
                    // [F2] 此处不受握手门控 —— 承自原始代码, 未改
                    r_bin_cnt <= r_bin_cnt + 1'd1;
                    if (r_bin_cnt == 6'd63) r_first_sym <= 1'b0;
                end

                P_FILL_GUARD_DC: begin
                    r_bin_cnt <= r_bin_cnt + 1'd1;
                end

                default: begin
                    r_bin_cnt  <= 6'd0;
                    r_data_cnt <= 6'd0;
                end
            endcase
        end
    end

    // ========================================================================
    // ro_ 输出寄存 (红线 2)
    // ========================================================================
    reg [15:0] ro_axis_i, ro_axis_q;
    reg        ro_tvalid;
    reg        ro_tready;

    always @(posedge i_clk) begin
        if (i_rst) begin
            ro_axis_i <= 16'd0;
            ro_axis_q <= 16'd0;
            ro_tvalid <= 1'b0;
        end else begin
            ro_tvalid <= 1'b1;

            // Default: zero for guard/DC bins
            ro_axis_i <= 16'd0;
            ro_axis_q <= 16'd0;

            case (r_state)
                P_FILL_DATA: begin
                    // Data bins: output modulated symbol (已经过 ri_ 寄存)
                    ro_axis_i <= ri_axis_i;
                    ro_axis_q <= ri_axis_q;
                end

                P_FILL_GUARD_DC: begin
                    // Already zero (guard and DC)
                end

                default: begin
                    ro_tvalid <= 1'b0;
                end
            endcase

            // Pilot insertion (override data bins at pilot positions)
            if (is_pilot_bin(r_bin_cnt)) begin
                // 导频极性: 奇符号反转 (见 [F3])
                ro_axis_i <= r_first_sym ? P_PILOT_POS : P_PILOT_NEG;
                ro_axis_q <= 16'd0;
            end

            // DC bin: always zero
            if (r_bin_cnt == 6'd32) begin
                ro_axis_i <= 16'd0;
                ro_axis_q <= 16'd0;
            end
        end
    end

    // ready 在 IDLE 和 FILL_DATA 都必须为高, 否则状态机无法跳出 IDLE
    always @(posedge i_clk) begin
        if (i_rst) ro_tready <= 1'b0;
        else       ro_tready <= (w_state_nxt == P_IDLE || w_state_nxt == P_FILL_DATA)
                                && m_axis_tready;
    end

    assign m_axis_i      = ro_axis_i;
    assign m_axis_q      = ro_axis_q;
    assign m_axis_tvalid = ro_tvalid;
    assign s_axis_tready = ro_tready;

    // ========================================================================
    // 三段式状态机 (红线 4)
    //   段 1: 次态组合 (含 default, 红线 5)
    //   段 2: 状态寄存
    //   段 3: 输出寄存 (上方 ro_ 段)
    // ========================================================================
    always @(*) begin
        w_state_nxt = r_state;
        case (r_state)
            P_IDLE: begin
                if (s_axis_tvalid && s_axis_tready)
                    w_state_nxt = P_FILL_DATA;
            end

            P_FILL_DATA: begin
                // 64 subcarriers per symbol
                if (r_bin_cnt == 6'd63 && m_axis_tready)
                    w_state_nxt = P_FILL_DATA;  // continuous
            end

            // [F1] 以下两态当前不可达 —— 承自原始代码, 保留声明未改
            P_FILL_GUARD_DC: w_state_nxt = P_IDLE;
            P_FLUSH:         w_state_nxt = P_IDLE;

            default:         w_state_nxt = P_IDLE;
        endcase
    end

    always @(posedge i_clk) begin
        if (i_rst) r_state <= P_IDLE;
        else       r_state <= w_state_nxt;
    end

    // ========================================================================
    // Functions
    // ========================================================================
    function automatic logic is_pilot_bin(input [5:0] bin);
        // Pilot bins in 802.11a (after shift correction):
        // -21→bin 43, -7→bin 57, +7→bin 39, +21→bin 53
        case (bin)
            6'd43, 6'd57, 6'd39, 6'd53: return 1'b1;
            default: return 1'b0;
        endcase
    endfunction

endmodule
