//==============================================================================
// eq_reorder — 子载波序重排: 自然 bin 升序 -> golden 序 (cfg.data_idx 序)
// 功能: 硬件顺着 fft64_sdf 的输出流只能按 bin **升序**出, 而系统契约是 golden 序 ——
//       rx_chain.m 第 3 步按 cfg.data_idx(d) 取 bin 再把 data_sym(:) 喂 mod_demapper,
//       发端 subcarrier_map 用同一个序放数据。**比特与子载波的对应关系由该序定义**,
//       换序等于把比特打乱, 不是外观问题。故必须有人转, 按裁定③ 的同一理由放在件内。
//         升序   bin [1..6, 8..20, 22..26, 38..42, 44..56, 58..63]
//         golden bin [38..42, 44..56, 58..63, 1..6, 8..20, 22..26]
//       两者恰为**左旋 P_ROT=24**, 故不需要置换表: 写入时按 (j+ROT)%N 落址, 读出顺序扫描。
// 端口: i_clk/i_rst; 入 i_valid/o_ready/i_data/i_erasure; 出 m_axis + o_erasure
// 主要逻辑: ri_ 输入寄存 -> 双 bank 乒乓 (写满一个符号才可读) -> ro_ 输出寄存
// 延迟: 重排天然要等整符号收齐, 约 P_NDATA 拍
// 复位: 同步高有效; 指针/满标志/valid 复位, 存储阵列不复位
//==============================================================================
`default_nettype none

module eq_reorder #(
    parameter int DATA_W  = 16,
    parameter int P_NDATA = 48,      // 每符号数据子载波数
    parameter int P_ROT   = 24       // 左旋量 (升序 -> golden)
)(
    input  wire                i_clk,
    input  wire                i_rst,

    input  wire                i_valid,
    output wire                o_ready,
    input  wire [DATA_W*2-1:0] i_data,
    input  wire [11:0]         i_conf,      // 逐载波可靠度, 必须与 data 同行同列地旋转
    input  wire                i_erasure,

    output wire                m_axis_tvalid,
    input  wire                m_axis_tready,
    output wire [DATA_W*2-1:0] m_axis_tdata,
    output wire [11:0]         o_conf,
    output wire                o_erasure
);

    localparam int AW = $clog2(P_NDATA);

    //==========================================================================
    // 红线 1: 输入寄存。o_ready 是组合的 (握手需要), 数据打一拍再用。
    //==========================================================================
    logic                ri_valid;
    logic [DATA_W*2-1:0] ri_data;
    logic [11:0]         ri_conf;
    logic                ri_er;

    logic w_acc;
    assign w_acc = i_valid && o_ready;

    always_ff @(posedge i_clk) begin
        if (i_rst) ri_valid <= 1'b0;
        else       ri_valid <= w_acc;
    end
    always_ff @(posedge i_clk) begin
        ri_data <= i_data;
        ri_conf <= i_conf;
        ri_er   <= i_erasure;
    end

    //==========================================================================
    // 双 bank 乒乓。写 bank 收满 P_NDATA 个才置满标志并换手; 读 bank 只在满时输出。
    // 单 bank 做不到: 重排必须等整符号收齐, 而收齐期间下一符号已经在进来了。
    //==========================================================================
    logic [DATA_W*2+12:0] r_mem0 [0:P_NDATA-1];   // {erasure, conf[11:0], data}
    logic [DATA_W*2+12:0] r_mem1 [0:P_NDATA-1];

    logic [AW-1:0] r_wj, r_rp;                    // 写侧到达序号 / 读侧输出序号
    logic          r_wb, r_rb;                    // 写/读 bank 选择
    logic [1:0]    r_full;

    // 写地址 = (到达序号 + ROT) mod N —— 读侧顺序扫描出来就是 golden 序
    logic [AW:0]   w_wsum;
    logic [AW-1:0] w_wa;
    assign w_wsum = {1'b0, r_wj} + (AW+1)'(P_ROT);
    assign w_wa   = (w_wsum >= (AW+1)'(P_NDATA)) ? AW'(w_wsum - (AW+1)'(P_NDATA)) : AW'(w_wsum);

    assign o_ready = !r_full[r_wb];

    logic w_wlast, w_rlast, w_rd_go;
    assign w_wlast = ri_valid && (r_wj == AW'(P_NDATA-1));

    // 写入 (红线 8: 地址已经是 wire)
    always_ff @(posedge i_clk) begin
        if (ri_valid && !r_wb) r_mem0[w_wa] <= {ri_er, ri_conf, ri_data};
        if (ri_valid &&  r_wb) r_mem1[w_wa] <= {ri_er, ri_conf, ri_data};
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_wj <= '0; r_wb <= 1'b0;
        end else if (ri_valid) begin
            if (w_wlast) begin r_wj <= '0; r_wb <= ~r_wb; end
            else               r_wj <= r_wj + 1'b1;
        end
    end

    //==========================================================================
    // 红线 2: 输出寄存
    //==========================================================================
    logic                ro_tvalid;
    logic [DATA_W*2-1:0] ro_tdata;
    logic [11:0]         ro_conf;
    logic                ro_er;

    logic w_oload;
    assign w_oload = !ro_tvalid || m_axis_tready;
    assign w_rd_go = w_oload && r_full[r_rb];
    assign w_rlast = w_rd_go && (r_rp == AW'(P_NDATA-1));

    logic [DATA_W*2+12:0] w_rdat;
    assign w_rdat = r_rb ? r_mem1[r_rp] : r_mem0[r_rp];

    always_ff @(posedge i_clk) begin
        if (i_rst)        ro_tvalid <= 1'b0;
        else if (w_oload) ro_tvalid <= r_full[r_rb];
    end
    always_ff @(posedge i_clk) begin
        if (w_rd_go) begin
            ro_tdata <= w_rdat[DATA_W*2-1:0];
            ro_conf  <= w_rdat[DATA_W*2+11:DATA_W*2];
            ro_er    <= w_rdat[DATA_W*2+12];
        end
    end

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_rp <= '0; r_rb <= 1'b0;
        end else if (w_rd_go) begin
            if (w_rlast) begin r_rp <= '0; r_rb <= ~r_rb; end
            else               r_rp <= r_rp + 1'b1;
        end
    end

    // 满标志: 写满置位, 读完清位。两侧作用于不同 bank 时互不相干; 只有在同一 bank
    // 上同拍既写满又读完时才有冲突 —— 那种情况置位优先 (数据刚写进去, 不能当读完)。
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_full <= 2'b00;
        end else begin
            if (w_rlast && !(w_wlast && (r_rb == r_wb))) r_full[r_rb] <= 1'b0;
            if (w_wlast)                                 r_full[r_wb] <= 1'b1;
        end
    end

    assign m_axis_tvalid = ro_tvalid;
    assign m_axis_tdata  = ro_tdata;
    assign o_conf        = ro_conf;
    assign o_erasure     = ro_er;

endmodule

`default_nettype wire
