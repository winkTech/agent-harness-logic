//==============================================================================
// tx_pilot_map — 子载波映射: 48 数据 + 4 导频 + DC/保护带 (ADR-004)
// 功能: 乒乓收集每 OFDM 符号的 48 个星座点 (到达顺序 = golden data_idx 升序
//       [-26..-22,-20..-8,-6..-1,1..6,8..20,22..26], 跳过导频 ±21/±7),
//       随后按自然 IFFT 序 bin 0..63 流出: DC(0)/保护带(27..37) 置 0,
//       导频 bin {7,21,43,57} = [+1,-1,+1,+1]·极性 (对应 pilot_idx
//       [7,21,-21,-7] 的 golden pilot_val), 极性逐符号 ±1 交替 (首符号 +,
//       golden subcarrier_map 契约, ADR-004 锚)。
// 端口: 收集侧 i_beat/i_valid/i_re/i_im (无停顿吸收, 上游以符号信用节流,
//       见 ofdm_tx_top); 流出侧 o_valid/o_re/o_im (64 拍连续, 馈 IFFT)。
//       计数一律受 valid 门控 (修 0.1.0 F5)。
// 复位: 同步高有效, 控制链复位; 乒乓 RAM/数据不复位 (§1.1/§10.2)
// 定点: 直通 Q2.14; 导频 ±16384
//==============================================================================
module tx_pilot_map #(
    parameter int DATA_W = 16
)(
    input  logic                     i_clk,
    input  logic                     i_rst,       // 同步复位, 高有效
    input  logic                     i_beat,

    // 收集侧 (星座点流)
    input  logic                     i_valid,
    input  logic signed [DATA_W-1:0] i_re,
    input  logic signed [DATA_W-1:0] i_im,

    // 流出侧 (自然序 64 拍 -> IFFT)
    output logic                     o_valid,
    output logic signed [DATA_W-1:0] o_re,
    output logic signed [DATA_W-1:0] o_im
);

    // 数据序号 -> 自然 bin LUT (golden data_idx 升序; idx<0 -> 64+idx)
    function automatic logic [5:0] f_bin(input int d);
        int idx_list [0:47];
        int n;
        n = 0;
        for (int i = -26; i <= 26; i++) begin
            if (i == 0 || i == -21 || i == -7 || i == 7 || i == 21) continue;
            idx_list[n] = i;
            n++;
        end
        f_bin = 6'((idx_list[d] < 0) ? (64 + idx_list[d]) : idx_list[d]);
    endfunction

    // 收集侧: 计数 + 乒乓写 (valid 门控)
    logic       r_wbank;
    logic [5:0] r_wcnt;
    logic [31:0] r_mem0 [0:63];
    logic [31:0] r_mem1 [0:63];
    logic       r_col_done;                       // 收满脉冲 (单拍)

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_wbank    <= 1'b0;
            r_wcnt     <= '0;
            r_col_done <= 1'b0;
        end else if (i_beat) begin
            r_col_done <= 1'b0;
            if (i_valid) begin
                if (r_wcnt == 6'd47) begin
                    r_wcnt     <= '0;
                    r_wbank    <= ~r_wbank;
                    r_col_done <= 1'b1;
                end else begin
                    r_wcnt <= r_wcnt + 1'b1;
                end
            end
        end else begin
            r_col_done <= r_col_done;
        end
    end

    // 写地址先落到 wire 再索引: 函数调用直接做非阻塞赋值左值下标时,
    // ModelSim 10.6c 会用 r_wcnt 自增后的值 (违反 IEEE 1800 §10.4.2 的
    // active 区求值), 导致整个符号错位一个子载波 —— 综合侧无此偏差,
    // 属仿真/综合不一致, 必须以 wire 形式规避。
    logic [5:0] w_waddr;
    assign w_waddr = f_bin(int'(r_wcnt));

    always_ff @(posedge i_clk) begin
        if (i_beat && i_valid) begin
            if (r_wbank) r_mem1[w_waddr] <= {i_im, i_re};
            else         r_mem0[w_waddr] <= {i_im, i_re};
        end
    end

    //==========================================================================
    // 流出侧: 收满即流 (乒乓对侧); 待流符号数 r_pend (上游信用保证 <=2)
    //==========================================================================
    logic [1:0] r_pend;                           // 已收满未启流符号数
    logic       r_sbank, r_sact;
    logic [5:0] r_scnt;
    logic       r_pol;                            // 导频极性 (首符号 +)
    logic       w_s_last, w_start;
    logic [1:0] w_avail;

    assign w_s_last = r_sact && (r_scnt == 6'd63);
    // 显式记账: 可用 = pend + 本拍收满; 启流 (新启或背靠背续流) 即扣减
    assign w_avail  = r_pend + (r_col_done ? 2'd1 : 2'd0);
    assign w_start  = (!r_sact || w_s_last) && (w_avail != 0);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_pend  <= '0;
            r_sbank <= 1'b0;
            r_sact  <= 1'b0;
            r_scnt  <= '0;
            r_pol   <= 1'b0;                      // 0 => +1
        end else if (i_beat) begin
            r_pend <= w_avail - (w_start ? 2'd1 : 2'd0);

            if (w_start) begin
                r_sact <= 1'b1;
                r_scnt <= '0;
                if (w_s_last) begin               // 背靠背: 换 bank 翻极性
                    r_sbank <= ~r_sbank;
                    r_pol   <= ~r_pol;
                end
            end else if (r_sact) begin
                if (w_s_last) begin
                    r_sact  <= 1'b0;
                    r_scnt  <= '0;
                    r_sbank <= ~r_sbank;
                    r_pol   <= ~r_pol;
                end else begin
                    r_scnt <= r_scnt + 1'b1;
                end
            end
        end
    end

    // 读数据 (同拍组合读 LUTRAM, 输出级寄存)
    logic [31:0] w_rd;
    assign w_rd = r_sbank ? r_mem1[r_scnt] : r_mem0[r_scnt];

    logic                     ro_valid;
    logic signed [DATA_W-1:0] ro_re, ro_im;
    logic signed [DATA_W-1:0] w_pval;

    // 导频值×极性: bin7:+1, bin21:-1, bin43:+1, bin57:+1 (golden pilot_val)
    assign w_pval = ((r_scnt == 6'd21) ^ r_pol) ? -16'sd16384 : 16'sd16384;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_valid <= 1'b0;
        else if (i_beat) ro_valid <= r_sact;
    end

    always_ff @(posedge i_clk) begin
        if (i_beat) begin
            if (r_scnt == 6'd0 || (r_scnt >= 6'd27 && r_scnt <= 6'd37)) begin
                ro_re <= '0;  ro_im <= '0;                    // DC / 保护带
            end else if (r_scnt == 6'd7 || r_scnt == 6'd21 ||
                         r_scnt == 6'd43 || r_scnt == 6'd57) begin
                ro_re <= w_pval;  ro_im <= '0;                // 导频
            end else begin
                ro_re <= $signed(w_rd[DATA_W-1:0]);           // 数据
                ro_im <= $signed(w_rd[2*DATA_W-1:DATA_W]);
            end
        end
    end

    assign o_valid = ro_valid;
    assign o_re    = ro_re;
    assign o_im    = ro_im;

endmodule : tx_pilot_map
