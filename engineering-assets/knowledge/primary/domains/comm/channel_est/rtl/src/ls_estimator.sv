//==============================================================================
// ls_estimator — OFDM 信道估计的导频提取 (LS)
// 功能: 从 FFT 输出流中按子载波序号抽取 4 个导频, 按 BPSK 导频序列 [1,1,-1,1]
//       做符号校正 (LS 估计在 BPSK 下退化为取符号), 输出 4 个复数导频值
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (FFT 输出 Y, I/Q 打包);
//       o_pilot_valid / o_pilot_h_i / o_pilot_h_q / o_symbol_done
// 主要逻辑: ri_ 输入寄存 -> 子载波计数 -> 导频位命中则锁存 -> 三段式 FSM ->
//           ro_ 寄存输出
// 复位: 同步高有效
//
// 本文件为 hdl-coding 规范修复版。相对修复前的差异:
//   (1) 复位由 `negedge rst_n` 异步低有效改为同步高有效 i_rst;
//   (2) 端口 clk/rst_n -> i_clk/i_rst, 非 AXI 输出补 o_ 前缀;
//   (3) 新增 ri_ 输入寄存级 (红线 1);
//   (4) s_axis_tready / pilot_valid / symbol_done 三个输出原为组合直出 (违红线 2),
//       现全部 ro_ 寄存;
//   (5) FSM 补为三段式, case 补 default (红线 4/5);
//   (6) **位宽修正 (SKILL.md §5)**: sub_idx 原声明 [N_FFT-1:0] = 64 位, 实际只需
//       数到 63 -> 改 $clog2(N_FFT)=6 位; pilot_cnt 原声明 [N_PILOT-1:0] = 4 位,
//       同样是把"计数上限"误当"位宽"写 -> 改 $clog2(N_PILOT+1)=3 位。
//       原写法白白占用 64 位触发器, 且 pilot_cnt 会越界索引 4 元素数组。
//   (7) 删除声明后从未使用的 all_pilots_captured。
//
// !! 整改中发现并修复的两个致命功能缺陷 (记录在此以免回退) !!
//   (8) **子载波计数差一**: 原计数条件是 `state == CAPTURE && 握手`, 而
//       IDLE->CAPTURE 恰由第一个握手拍触发 —— 第一拍不计数。64 拍激励下
//       sub_idx 最多到 62, `sub_idx == N_FFT-1` 永不成立, 状态机出不了 CAPTURE,
//       **o_symbol_done 从未置位过, 整条信道估计链从未产出过一个符号**。
//       现改为只要有效拍就计数、数满回绕。
//   (9) **导频计数不按符号清零**: r_pilot_cnt 原先只有复位才清零, 第一个符号
//       抓满 4 个导频后停在 4, 之后所有符号的导频写入全部越界被丢弃 ——
//       即便修好 (8), 也只有第一个符号能用。现改为在 P_DONE 态清零。
//       同时保留显式范围保护 w_cnt_in_range, 使越界写是明确的"不写"而非
//       未定义行为。
//   上述两项此前之所以一直没暴露, 是因为原 TB 用裸 #5000 延时后直接读
//   m_axis_tdata (读到的是残留值), 从未按握手捕获整个符号再比对。
//
// !! 遗留功能缺陷 (承自原始代码, 本次**未改**, 仅如实标注) !!
//   [F1] 导频极性表硬编码为"只有第 3 个导频取负" (neg_pilot 仅比较 PILOT_POS[2]),
//        与 802.11a 规定的按符号序号变化的导频扰码序列不符。
//==============================================================================
module ls_estimator #(
    parameter int N_FFT   = 64,
    parameter int N_PILOT = 4,
    parameter int DATA_W  = 16
)(
    input  logic                i_clk,
    input  logic                i_rst,        // 同步复位, 高有效

    // FFT output (AXI4-Stream slave)
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,

    // Pilot output (4 complex values)
    output logic                o_pilot_valid,
    output logic [N_PILOT-1:0][DATA_W-1:0] o_pilot_h_i,
    output logic [N_PILOT-1:0][DATA_W-1:0] o_pilot_h_q,

    // Symbol boundary
    output logic                o_symbol_done
);

    //==========================================================================
    // Pilot positions (0-based, after FFT)
    // 802.11a: pilots at subcarriers {-21,-7,7,21} mapped to indices
    //==========================================================================
    localparam int PILOT_POS[N_PILOT] = '{11, 25, 39, 53};

    localparam int P_IDX_W = $clog2(N_FFT);       // 子载波序号位宽 (0..63 -> 6)
    localparam int P_CNT_W = $clog2(N_PILOT + 1); // 导频计数位宽 (0..4 -> 3)

    //==========================================================================
    // 状态编码 (红线/命名: 状态用 P_ 前缀)
    //==========================================================================
    typedef enum logic [1:0] {P_IDLE, P_CAPTURE, P_DONE} state_t;
    state_t r_state, w_state_nxt;

    logic [P_IDX_W-1:0] r_sub_idx;
    logic [P_CNT_W-1:0] r_pilot_cnt;

    //==========================================================================
    // ri_ 输入寄存 (红线 1)
    //==========================================================================
    logic [DATA_W*2-1:0] ri_tdata;
    logic                ri_tvalid;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_tdata  <= '0;
            ri_tvalid <= 1'b0;
        end else begin
            ri_tdata  <= s_axis_tdata;
            ri_tvalid <= s_axis_tvalid && s_axis_tready;
        end
    end

    //==========================================================================
    // Subcarrier index counter
    // r_sub_idx 表示"当前停在 ri_tdata 上的这一拍是本符号的第几个子载波"。
    //
    // 修复前这里写的是 `else if (state == CAPTURE && 握手)` 才计数, 而
    // IDLE->CAPTURE 恰好由第一个握手拍触发 —— 于是**第一拍不计数**, 64 拍激励
    // 下 sub_idx 最多到 62, `sub_idx == N_FFT-1` 永不成立, 状态机出不了 CAPTURE,
    // o_symbol_done 永不置位, 整条信道估计链从来没产出过一个符号。
    // (原 TB 用裸 #5000 延时后直接读 m_axis_tdata, 读到的是残留值, 所以这个
    //  先天缺陷一直没被暴露。)
    // 现改为: 只要有效拍就计数, 数满一个符号回绕。差一消除。
    //==========================================================================
    always_ff @(posedge i_clk) begin
        if (i_rst)
            r_sub_idx <= '0;
        else if (ri_tvalid) begin
            if (r_sub_idx == P_IDX_W'(N_FFT-1)) r_sub_idx <= '0;
            else                                r_sub_idx <= r_sub_idx + 1'b1;
        end
    end

    //==========================================================================
    // Pilot capture
    //==========================================================================
    logic w_pilot_match;
    logic w_neg_pilot;
    logic w_cnt_in_range;

    assign w_pilot_match = (r_state == P_CAPTURE) && ri_tvalid &&
                           (r_sub_idx inside {P_IDX_W'(PILOT_POS[0]), P_IDX_W'(PILOT_POS[1]),
                                              P_IDX_W'(PILOT_POS[2]), P_IDX_W'(PILOT_POS[3])});

    // AXI4-Stream BPSK pilot sequence [1, 1, -1, 1]: +1 直通, -1 取负 (见 [F2])
    assign w_neg_pilot = (r_sub_idx == P_IDX_W'(PILOT_POS[2]));

    // [F1] 显式范围保护: 越界写在原代码里是未定义行为, 这里明确成"不写"
    assign w_cnt_in_range = (r_pilot_cnt < P_CNT_W'(N_PILOT));

    logic [N_PILOT-1:0][DATA_W-1:0] ro_pilot_h_i;
    logic [N_PILOT-1:0][DATA_W-1:0] ro_pilot_h_q;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int p = 0; p < N_PILOT; p++) begin
                ro_pilot_h_i[p] <= '0;
                ro_pilot_h_q[p] <= '0;
            end
            r_pilot_cnt <= '0;
        end else if (r_state == P_DONE) begin
            // 符号边界清零 —— 见文件头 (8): 修复前只有复位才清零, 于是第一个符号
            // 抓满 4 个导频后计数停在 4, 之后所有符号的导频写入全部越界被丢弃。
            r_pilot_cnt <= '0;
        end else if (w_pilot_match && w_cnt_in_range) begin
            if (w_neg_pilot) begin
                ro_pilot_h_i[r_pilot_cnt] <= -(ri_tdata[DATA_W-1:0]);
                ro_pilot_h_q[r_pilot_cnt] <= -(ri_tdata[DATA_W*2-1:DATA_W]);
            end else begin
                ro_pilot_h_i[r_pilot_cnt] <= ri_tdata[DATA_W-1:0];
                ro_pilot_h_q[r_pilot_cnt] <= ri_tdata[DATA_W*2-1:DATA_W];
            end
            r_pilot_cnt <= r_pilot_cnt + 1'b1;
        end
    end

    assign o_pilot_h_i = ro_pilot_h_i;
    assign o_pilot_h_q = ro_pilot_h_q;

    //==========================================================================
    // 三段式状态机 (红线 4)
    //   段 1: 次态组合 (含 default, 红线 5)
    //==========================================================================
    always_comb begin
        w_state_nxt = r_state;
        case (r_state)
            P_IDLE: begin
                if (ri_tvalid)
                    w_state_nxt = P_CAPTURE;
            end
            P_CAPTURE: begin
                if (ri_tvalid && (r_sub_idx == P_IDX_W'(N_FFT-1)))
                    w_state_nxt = P_DONE;
            end
            P_DONE: begin
                w_state_nxt = P_IDLE;
            end
            default: w_state_nxt = P_IDLE;
        endcase
    end

    //   段 2: 状态寄存
    always_ff @(posedge i_clk) begin
        if (i_rst) r_state <= P_IDLE;
        else       r_state <= w_state_nxt;
    end

    //   段 3: ro_ 输出寄存 (红线 2)
    logic ro_tready, ro_pilot_valid, ro_symbol_done;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_tready      <= 1'b0;
            ro_pilot_valid <= 1'b0;
            ro_symbol_done <= 1'b0;
        end else begin
            // 用次态计算, 使 ready 与其所描述的状态同拍生效
            ro_tready      <= (w_state_nxt == P_IDLE) || (w_state_nxt == P_CAPTURE);
            ro_pilot_valid <= w_pilot_match && w_cnt_in_range;
            ro_symbol_done <= (w_state_nxt == P_DONE);
        end
    end

    assign s_axis_tready = ro_tready;
    assign o_pilot_valid = ro_pilot_valid;
    assign o_symbol_done = ro_symbol_done;

endmodule : ls_estimator
