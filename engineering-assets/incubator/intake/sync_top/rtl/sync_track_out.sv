//==============================================================================
// sync_track_out — 精定时峰值搜索 + T2 防错锁 + 对齐输出级 (sync_top 子模块)
// 功能: 消费校正样点流: (1) 例化 sync_correlator 求 |R(m)|²;
//       (2) P_SEARCH 态峰值搜索 (候选 c = 窗尾-63 ∈ [n_peak, n_peak+P_WIN],
//       同值取先到者) 并把各候选 |R|² 存档;
//       (3) T2 防错锁 (ADR-003 因果结构性): corr_start 落于 GI2/T1 边界时
//       T1 前段未校正、相干受损, T2 (=T1+64, 全校正) 峰值更高 — 峰值定格后
//       回查 pk-64: 若 pk-64 >= n_peak 且 |R(pk-64)|² >= |R(pk)|²>>2,
//       n_fine = pk-64, 否则 pk;
//       (4) P_DLY 深延迟线对齐: o_fft_start 与 m_axis 上 n_fine 样点同拍,
//       o_sync_locked 置位保持到复位。
// 端口: FSM 相位使能 i_search/i_t2rd/i_t2cmp/i_track 由顶层三段式 FSM 译码;
//       o_search_done 驱动顶层 FSM SEARCH->T2RD 迁移
// 复位: 同步高有效, 控制链复位; RAM/数据级不复位 (§1.1)
//   // [复位豁免] r_dl_mem/r_r2mem 为 RAM, 读数据寄存器不复位 (§10.2)
// 定点约定 (与 generate_vectors.m 位真镜像逐字一致): 见文件头 (3) 判据式
//==============================================================================
module sync_track_out #(
    parameter int DATA_W = 16,
    parameter int P_IDXW = 32,
    parameter int P_DLY  = 384,         // 对齐延迟线深度 (< 512)
    parameter int P_WIN  = 256          // 精定时搜索窗宽
)(
    input  logic                      i_clk,
    input  logic                      i_rst,      // 同步复位, 高有效

    // FSM 相位使能 (顶层译码)
    input  logic                      i_search,
    input  logic                      i_t2rd,
    input  logic                      i_t2cmp,
    input  logic                      i_track,
    input  logic [P_IDXW-1:0]         i_n_peak,
    output logic                      o_search_done,

    // 校正样点流
    input  logic                      i_beat,
    input  logic signed [DATA_W-1:0]  i_di,
    input  logic signed [DATA_W-1:0]  i_dq,
    input  logic [P_IDXW-1:0]         i_idx,

    // 输出
    output logic                      m_axis_tvalid,
    output logic [DATA_W*2-1:0]       m_axis_tdata,
    output logic                      o_fft_start,
    output logic                      o_sync_locked
);

    //==========================================================================
    // 符号量化互相关
    //==========================================================================
    logic              w_r2_v;
    logic [46:0]       w_r2;
    logic [P_IDXW-1:0] w_r2_end;

    sync_correlator #(
        .DATA_W (DATA_W),
        .P_IDXW (P_IDXW)
    ) u_corr (
        .i_clk     (i_clk),
        .i_rst     (i_rst),
        .i_beat    (i_beat),
        .i_di      (i_di),
        .i_dq      (i_dq),
        .i_idx     (i_idx),
        .o_r2_v    (w_r2_v),
        .o_r2      (w_r2),
        .o_end_idx (w_r2_end)
    );

    //==========================================================================
    // 峰值搜索 + 候选存档
    //==========================================================================
    logic [46:0]       r_pk_val;
    logic [P_IDXW-1:0] r_pk_idx, r_n_fine;
    logic [P_IDXW-1:0] w_cand;
    logic              ro_search_done;

    assign w_cand = w_r2_end - P_IDXW'(63);

    // 候选 |R|² 存档 (T2 防错锁回查用; 窗宽 <=257, 512 深索引不冲突)
    logic [46:0] r_r2mem [0:511];
    logic [46:0] r_r2rd;

    always_ff @(posedge i_clk) begin
        if (i_search && w_r2_v) r_r2mem[w_cand[8:0]] <= w_r2;
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_pk_val       <= '0;
            ro_search_done <= 1'b0;
        end else if (i_search && w_r2_v) begin
            if (w_cand >= i_n_peak && w_cand <= i_n_peak + P_IDXW'(P_WIN)) begin
                if (w_r2 > r_pk_val) begin
                    r_pk_val <= w_r2;
                    r_pk_idx <= w_cand;
                end
            end else if (w_cand > i_n_peak + P_IDXW'(P_WIN)) begin
                ro_search_done <= 1'b1;
            end
        end
    end

    assign o_search_done = ro_search_done;

    // T2 防错锁: 读档 pk-64, 若 >= 峰值/4 且候选合法则取 pk-64 (见文件头)
    // [复位豁免] r_r2rd 为 RAM 读数据寄存器, 不复位 (§10.2)
    always_ff @(posedge i_clk) begin
        if (i_t2rd)
            r_r2rd <= r_r2mem[9'(r_pk_idx - P_IDXW'(64))];
    end

    always_ff @(posedge i_clk) begin
        if (i_t2cmp) begin
            if ((r_pk_idx >= i_n_peak + P_IDXW'(64)) &&
                (r_r2rd >= (r_pk_val >> 2)))
                r_n_fine <= r_pk_idx - P_IDXW'(64);
            else
                r_n_fine <= r_pk_idx;
        end
    end

    //==========================================================================
    // 对齐延迟线 (BRAM 512×32) + m_axis / fft_start / locked 输出
    //==========================================================================
    logic [31:0] r_dl_mem [0:511];
    logic [31:0] ro_tdata;
    logic        ro_tvalid, ro_fft, ro_locked, r_fft_fired;
    logic        w_out_hit;

    always_ff @(posedge i_clk) begin
        if (i_beat) r_dl_mem[i_idx[8:0]] <= {i_dq, i_di};
    end

    // [复位豁免] BRAM 读数据寄存器不复位 (§10.2)
    always_ff @(posedge i_clk) begin
        if (i_beat) ro_tdata <= r_dl_mem[9'(i_idx - P_IDXW'(P_DLY))];
    end

    assign w_out_hit = i_beat && i_track && !r_fft_fired &&
                       (i_idx >= P_IDXW'(P_DLY)) &&
                       ((i_idx - P_IDXW'(P_DLY)) == r_n_fine);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_tvalid   <= 1'b0;
            ro_fft      <= 1'b0;
            ro_locked   <= 1'b0;
            r_fft_fired <= 1'b0;
        end else begin
            ro_tvalid <= i_beat && (i_idx >= P_IDXW'(P_DLY));
            ro_fft    <= w_out_hit;
            if (w_out_hit) r_fft_fired <= 1'b1;
            if (i_track)   ro_locked   <= 1'b1;
        end
    end

    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tdata  = ro_tdata;
    assign o_fft_start   = ro_fft;
    assign o_sync_locked = ro_locked;

endmodule : sync_track_out
