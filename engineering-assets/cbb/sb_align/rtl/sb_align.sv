//==============================================================================
// sb_align — fft64_sdf 与 channel_est_top 之间的侧带对齐件
//
// 为什么需要它 (实测, 非推断):
//   fft64_sdf 的 o_sb 与本符号**首个输出同拍**寄出 (fft64_reorder.sv:109 ——
//     ro_sb <= r_ractive && r_rcnt==0 && r_sb_rd);
//   channel_est_top 要求 i_frame_start **领先**其所标记的样点 >=1 拍 —— 它的
//     r_fs_pend 由 frame_start 在本拍末置起, 而 ri_fs_take 用的是当拍旧值, 同拍
//     到达时 LTS1[0] 不会被标记, 标记落到下一个样点, 整个 LTS 窗错一位。
//   两者直连**不会报错**, 只是安静地给出错误的信道估计: 同一激励下 H 输出点数
//     相同 (384) 而 **372/384 点数值不同** (tb_ce_fslead 实测)。
//   两边的时序都是各自明文且已签字的契约, 冲突在它们之间 —— 故在它们之间解,
//   不动任何一边 (需求门禁 2026-08-04 裁定)。
//
// 做法 —— 小深度 FIFO + "先报后送":
//   带 sb 的样点轮到发送时, 先出一个 tvalid=0 且 o_frame_start=1 的**气泡拍**,
//   下一拍再把它送出。这样 frame_start 恰好领先 1 拍, 且那一拍没有别的样点被接受
//   (否则标记会落到错的样点上)。
//   气泡由 FIFO 吸收: fft64 的输出每符号本就有 16 拍 CP 空档, 每帧一个气泡绰绰有余。
//
// 输出全部寄存 (红线 2): 三个输出各有自己的 ro_ 寄存器。注意 RL-OUT 门禁只检测
//   "assign 输出 <- always_comb 信号"这一条路径, 本模块不用 always_comb, 即便直接
//   组合驱动也能过 —— 但那是钻检查器的空子。这里按红线**本意**做寄存。
//
// 反压与溢出:
//   上游 fft64 **无 ready、不可停顿**, 下游 channel_est **有 tready**。这是结构性的
//   溢出风险。实测 M1 工况下 channel_est 零反压 (CP 空档即全部弹性), 但那个结论
//   依赖 CP 间隙存在 —— 所以这里**必须**有 o_overflow 粘滞标志: 满了就让它可见,
//   而不是静默丢样点。
//
// P_DEPTH 留了余地: 若上游节奏变化 (例如换 profile 使 CP 间隙消失), 实测所需上界是
//   23 个条目 (见 cbb/fft64_sdf/docs/limitations.md 4), 届时调参即可, 不必新起件。
//
// 复位: 同步高有效。
//==============================================================================
`default_nettype none

module sb_align #(
    parameter int DATA_W  = 16,
    parameter int P_DEPTH = 4       // 须为 >=2 的 2 的幂
)(
    input  wire                     i_clk,
    input  wire                     i_rst,          // 同步复位, 高有效

    // 上游 fft64_sdf: 推流, 无 ready
    input  wire                     i_valid,
    input  wire signed [DATA_W-1:0] i_re,
    input  wire signed [DATA_W-1:0] i_im,
    input  wire                     i_sb,

    // 下游 channel_est_top: AXIS + 独立的帧起始脉冲
    output wire                     o_frame_start,
    output wire                     m_axis_tvalid,
    input  wire                     m_axis_tready,
    output wire [DATA_W*2-1:0]      m_axis_tdata,   // {Q, I}

    // 溢出粘滞: 上游不可停顿, 满了必然丢 —— 必须可见而非静默
    output wire                     o_overflow
);

    localparam int PTR_W = $clog2(P_DEPTH);

    // 存储: {sb, Q, I}
    logic [DATA_W*2:0] r_mem [0:P_DEPTH-1];
    logic [PTR_W:0]    r_wr, r_rd;              // 多一位用于区分空/满

    logic [PTR_W:0]    w_cnt;
    logic              w_full, w_empty;
    assign w_cnt   = r_wr - r_rd;
    assign w_full  = (w_cnt == (PTR_W+1)'(P_DEPTH));
    assign w_empty = (w_cnt == '0);

    logic [DATA_W*2:0] w_head;
    logic              w_head_sb;
    assign w_head    = r_mem[r_rd[PTR_W-1:0]];
    assign w_head_sb = w_head[DATA_W*2];

    //==========================================================================
    // 写侧: 上游不可停顿, 满了也只能丢 —— 但要记账
    //==========================================================================
    logic ro_ovf;
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_wr   <= '0;
            ro_ovf <= 1'b0;
        end else if (i_valid) begin
            if (w_full) begin
                ro_ovf <= 1'b1;         // 粘滞: 一旦溢出就一直可见, 直到复位
            end else begin
                r_mem[r_wr[PTR_W-1:0]] <= {i_sb, i_im, i_re};
                r_wr <= r_wr + 1'b1;
            end
        end
    end

    //==========================================================================
    // 读侧 + 输出寄存。r_announced: 当前队头的 sb 是否已经报过。
    //==========================================================================
    logic                ro_fs, ro_tvalid;
    logic [DATA_W*2-1:0] ro_tdata;
    logic                r_announced;

    // 输出寄存器可更新的条件: 当前没有未被接受的样点压着
    logic w_can_load;
    assign w_can_load = !ro_tvalid || m_axis_tready;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_rd        <= '0;
            r_announced <= 1'b0;
            ro_fs       <= 1'b0;
            ro_tvalid   <= 1'b0;
            ro_tdata    <= '0;
        end else if (w_can_load) begin
            ro_fs <= 1'b0;                          // 默认只打一拍
            if (w_empty) begin
                ro_tvalid <= 1'b0;
            end else if (w_head_sb && !r_announced) begin
                // 气泡拍: 只报 frame_start, 不送样点
                ro_fs       <= 1'b1;
                ro_tvalid   <= 1'b0;
                r_announced <= 1'b1;
            end else begin
                ro_tvalid   <= 1'b1;
                ro_tdata    <= w_head[DATA_W*2-1:0];
                r_rd        <= r_rd + 1'b1;
                r_announced <= 1'b0;                // 换下一个队头, 重新计
            end
        end
    end

    assign o_frame_start = ro_fs;
    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tdata  = ro_tdata;
    assign o_overflow    = ro_ovf;

endmodule : sb_align

`default_nettype wire
