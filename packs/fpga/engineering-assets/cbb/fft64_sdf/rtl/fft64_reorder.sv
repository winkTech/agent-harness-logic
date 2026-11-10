//==============================================================================
// fft64_reorder — 位反序 -> 自然序重排 (乒乓, 64 点)
// 功能: 接 fft64_sdf_core 的位反序输出流, 还原为自然序。写侧按 bitrev(i_idx)
//       写地址吸收重排 (零额外重排逻辑), 读侧按 0..63 顺序读出。
//       手法与 cbb/ofdm_tx_top/rtl/tx_cp_insert.sv 的写地址反序一致。
// 为什么 RX 需要而 TX 不需要: TX 侧 CP 插入本来就要一块乒乓 RAM, 顺手用
//       bitrev 写地址就吸收了; RX 侧 FFT 输出要**扇出**给 channel_est_top 与
//       均衡器两路, 必须在扇出前就已是自然序, 而 channel_est_top 已认证、按
//       自然序流式吃 64 拍且无索引口, 不能让它自己吸收。
// 侧带: i_sb 标记输入符号首拍 (即 i_idx==0 那拍); o_sb 标记**自然序**符号首拍。
//       侧带随符号整体延迟一个符号 (乒乓深度), 与数据同步。
// 延迟: 一个符号 (64 拍) + 少量流水; 写满 64 点后切 bank 开始读出。
// 复位: 同步高有效, 仅控制链复位; RAM 不复位 (§1.1/§10.2)
//==============================================================================
`default_nettype none

module fft64_reorder #(
    parameter int DATA_W = 16
)(
    input  wire                      i_clk,
    input  wire                      i_rst,       // 同步复位, 高有效
    input  wire                      i_beat,      // 样点拍 (CE)

    // 写侧 (core 的位反序输出流)
    input  wire                      i_valid,
    input  wire [5:0]                i_idx,       // 顺序号 n; 写地址 = bitrev(n)
    input  wire signed [DATA_W-1:0]  i_re,
    input  wire signed [DATA_W-1:0]  i_im,
    input  wire                      i_sb,

    // 读侧 (自然序)
    output wire                      o_valid,
    output wire [5:0]                o_idx,       // 自然序号 0..63 (= 读地址)
    output wire signed [DATA_W-1:0]  o_re,
    output wire signed [DATA_W-1:0]  o_im,
    output wire                      o_sb
);

    function automatic logic [5:0] f_bitrev(input logic [5:0] n);
        f_bitrev = {n[0], n[1], n[2], n[3], n[4], n[5]};
    endfunction

    // 乒乓存储: bank 0/1 各 64 点
    logic signed [DATA_W-1:0] mem_re [0:1][0:63];
    logic signed [DATA_W-1:0] mem_im [0:1][0:63];

    logic       r_wbank;          // 当前写入的 bank
    logic       r_rbank;          // 当前读出的 bank
    logic [5:0] r_rcnt;           // 读地址 0..63
    logic       r_ractive;        // 读出进行中
    logic       r_sb_pend;        // 本写入符号带侧带 -> 读出时在首拍打出
    logic       r_sb_rd;          // 读出符号带侧带

    logic [5:0] w_waddr;
    assign w_waddr = f_bitrev(i_idx);

    // ---- 写侧 ----
    always_ff @(posedge i_clk) begin
        if (i_beat && i_valid) begin
            mem_re[r_wbank][w_waddr] <= i_re;
            mem_im[r_wbank][w_waddr] <= i_im;
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_wbank   <= 1'b0;
            r_sb_pend <= 1'b0;
        end else if (i_beat && i_valid) begin
            if (i_sb)          r_sb_pend <= 1'b1;
            if (i_idx == 6'd63) begin        // 本符号写满 -> 换 bank
                r_wbank   <= ~r_wbank;
                r_sb_pend <= 1'b0;
            end
        end
    end

    // ---- 读侧: 写满一符号即开始读出该 bank ----
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_ractive <= 1'b0;
            r_rcnt    <= '0;
            r_rbank   <= 1'b0;
            r_sb_rd   <= 1'b0;
        end else if (i_beat) begin
            if (i_valid && i_idx == 6'd63) begin
                r_ractive <= 1'b1;
                r_rcnt    <= '0;
                r_rbank   <= r_wbank;        // 刚写满的那个 bank
                r_sb_rd   <= r_sb_pend || i_sb;
            end else if (r_ractive) begin
                if (r_rcnt == 6'd63) r_ractive <= 1'b0;
                r_rcnt <= r_rcnt + 1'b1;
            end
        end
    end

    // ---- 输出寄存 (红线 2) ----
    logic                     ro_valid, ro_sb;
    logic [5:0]               ro_idx;
    logic signed [DATA_W-1:0] ro_re, ro_im;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid <= 1'b0;
            ro_sb    <= 1'b0;
        end else if (i_beat) begin
            ro_valid <= r_ractive;
            ro_sb    <= r_ractive && (r_rcnt == 6'd0) && r_sb_rd;
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            ro_re  <= mem_re[r_rbank][r_rcnt];
            ro_im  <= mem_im[r_rbank][r_rcnt];
            ro_idx <= r_rcnt;              // 与数据同拍寄存, 即该点的自然序号
        end
    end

    assign o_valid = ro_valid;
    assign o_idx   = ro_idx;
    assign o_re    = ro_re;
    assign o_im    = ro_im;
    assign o_sb    = ro_sb;

endmodule : fft64_reorder

`default_nettype wire
