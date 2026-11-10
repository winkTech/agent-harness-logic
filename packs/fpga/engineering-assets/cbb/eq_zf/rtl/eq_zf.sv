//==============================================================================
// eq_zf — ZF 频域均衡 + 64->48 数据子载波提取 (均衡器顶层)
// 功能: X = Y·conj(H)·(1/|H|²), 只在 48 个数据子载波上算 (裁定①②③)。
//       |H|²=0 时输出 0 并拉 o_erasure, 只判精确零 (裁定④)。输出 Q4.12 + 显式饱和。
// 规格来源: models/comm/ofdm/src/rtl_mirror_eq.m —— **需求侧单一事实源**;
//       判卷向量 vectors/*.hex 由该镜像导出, 0 容差。失配时修本模块而非改镜像。
// 端口: Y 侧直连 fft64_sdf (不可反压, 故自带 Y 路 FIFO); H 侧为 channel_est_top 的
//       m_axis (tready 节流); 出 m_axis (Q4.12 {im,re}) + o_conf + o_erasure。
//       字序 {im,re}, 同 cp_remove/channel_est_top。
// 主要逻辑: ri_ 输入寄存 -> Y 符号/载波选择 -> Y FIFO -> 与 H 按序配对 -> 共轭乘
//           + eq_recip -> 定标舍入饱和 -> 出侧 FIFO -> eq_reorder -> ro_ 输出
// 延迟: H 被接受到该点出现在出侧 FIFO 约 12 拍; 配对**按序不按时刻**
// 复位: 同步高有效; FSM/指针/计数器/valid 复位, 数据通路少复位
//==============================================================================
`default_nettype none

module eq_zf #(
    parameter int DATA_W     = 16,
    // Y 路 FIFO 深度。实测下界 158 (tb_y_depth), 取 256 留裕量。
    // **必须是 2 的幂**: 指针按 r_ywr[YAW-1:0] 回绕, 非 2 的幂时回绕点是 2^YAW 而不是
    // P_YDEPTH, 越界地址会读出 X。首版本取 192 (YAW=8) 正是这样, 前 192 点全对、
    // 第 193 点起开始吐 xxxxxxxx。
    parameter int P_YDEPTH   = 256
)(
    input  wire                    i_clk,
    input  wire                    i_rst,

    // Y 侧 — 直连 fft64_sdf, 结构上不可反压
    input  wire                    i_y_valid,
    input  wire signed [DATA_W-1:0] i_y_re,
    input  wire signed [DATA_W-1:0] i_y_im,
    input  wire [5:0]              i_y_idx,  // 自然序 bin 号
    input  wire                    i_y_sb,   // 帧起始 (LTS1 首拍, 每帧仅一拍)

    // H 侧 — channel_est_top 的 m_axis
    input  wire                    s_axis_h_tvalid,
    output wire                    s_axis_h_tready,
    input  wire [DATA_W*2-1:0]     s_axis_h_tdata,

    // 出
    output wire                    m_axis_tvalid,
    input  wire                    m_axis_tready,
    output wire [DATA_W*2-1:0]     m_axis_tdata,
    output wire [11:0]             o_conf,    // {sh[5:0], man[5:0]}: |H|² = M·2^(sh-30)
    output wire                    o_erasure,
    output wire                    o_y_overflow
);
    // o_conf = 逐载波可靠度, 供下游给 LLR 加权 (裁定⑤): ZF 归一化掉了幅度, 不带它则
    // 深衰落载波会以与强载波相同的置信度进译码器。12 位由端到端 BER 实测定, 二者均为
    // eq_recip 归一化时已有的中间量, 无新增运算。

    // 48 个数据子载波的 bin 掩码 (自然序)。由有符号载波集
    // setdiff([-26:-1 1:26],[-21,-7,7,21]) 经 k<0 -> 64+k 换算而来, 置位数恰 48。
    localparam logic [63:0] P_DMASK = 64'hFDFFF7C007DFFF7E;
    localparam int          P_ODEPTH = 32;   // 出侧 FIFO; 在途最多 ~12, 见 w_can_start

    //==========================================================================
    // 红线 1: 输入寄存
    //==========================================================================
    logic                ri_yv, ri_ysb;
    logic [DATA_W*2-1:0] ri_ydat;
    logic [5:0]          ri_yidx;
    always_ff @(posedge i_clk) begin
        if (i_rst) begin ri_yv <= 1'b0; ri_ysb <= 1'b0; end
        else       begin ri_yv <= i_y_valid; ri_ysb <= i_y_valid && i_y_sb; end
    end
    always_ff @(posedge i_clk) begin
        ri_ydat <= {i_y_im, i_y_re};
        ri_yidx <= i_y_idx;
    end

    //==========================================================================
    // Y 侧符号相位: sb 标记 LTS1; 其后每次 idx 回绕到 0 递增。序 0/1 是 LTS (不产 H),
    // 序 >=2 才是数据符号。cp_remove 的 o_sb 每帧只打一拍, 不能当符号边界用。
    //==========================================================================
    logic [7:0] r_fsym;
    logic       r_seen, w_wrap, w_is_data_sym, w_push;
    assign w_wrap        = ri_yv && !ri_ysb && (ri_yidx == 6'd0);
    assign w_is_data_sym = r_seen && (r_fsym >= 8'd2);
    assign w_push        = ri_yv && !ri_ysb && w_is_data_sym && P_DMASK[ri_yidx];

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_fsym <= 8'd0; r_seen <= 1'b0;
        end else if (ri_ysb) begin
            r_fsym <= 8'd0; r_seen <= 1'b1;          // 新帧: LTS1
        end else if (w_wrap) begin
            r_fsym <= r_fsym + 8'd1;
        end
    end

    //==========================================================================
    // Y 路 FIFO —— 上游停不下来, 而 H 要等整个符号收齐后才产出, 这段差必须存住
    //==========================================================================
    localparam int YAW = $clog2(P_YDEPTH);

    logic [DATA_W*2-1:0] r_yfifo [0:P_YDEPTH-1];
    logic [YAW:0]        r_ywr, r_yrd, w_ycnt;
    logic                ro_yovf, w_yempty, w_yfull, w_ypop;
    logic [YAW-1:0]      w_ywa, w_yra;

    assign w_ycnt   = r_ywr - r_yrd;
    assign w_yempty = (w_ycnt == '0);
    assign w_yfull  = (w_ycnt >= (YAW+1)'(P_YDEPTH));
    assign w_ywa    = r_ywr[YAW-1:0];            // 红线 8: 地址先落 wire 再索引
    assign w_yra    = r_yrd[YAW-1:0];

    always_ff @(posedge i_clk) begin
        if (w_push && !w_yfull) r_yfifo[w_ywa] <= ri_ydat;
    end
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_ywr <= '0; r_yrd <= '0; ro_yovf <= 1'b0;
        end else begin
            if (w_push && !w_yfull) r_ywr <= r_ywr + 1'b1;
            if (w_ypop)             r_yrd <= r_yrd + 1'b1;
            if (w_push && w_yfull)  ro_yovf <= 1'b1;      // 粘滞, 供可见性
        end
    end

    //==========================================================================
    // H 侧: 每数据符号 64 拍, 按 bin 序到达。非数据 bin 照收但直接丢弃, 不动 Y。
    //==========================================================================
    logic [5:0] r_hidx;
    logic       w_hacc, w_h_isdata, w_can_start;

    assign w_h_isdata = P_DMASK[r_hidx];
    assign w_hacc     = s_axis_h_tvalid && s_axis_h_tready;
    assign w_ypop     = w_hacc && w_h_isdata;

    always_ff @(posedge i_clk) begin
        if (i_rst)       r_hidx <= 6'd0;
        else if (w_hacc) r_hidx <= r_hidx + 6'd1;        // 自然回绕 64
    end

    //==========================================================================
    // 级 A: 取操作数 (Y 出队 + 本拍 H); 级 B: |H|² -> eq_recip 并起对齐延迟线
    //==========================================================================
    logic                     rA_valid;
    logic [DATA_W*2-1:0]      rA_y, rA_h;
    logic signed [DATA_W-1:0] w_hre, w_him;
    logic [31:0]              w_h2;

    always_ff @(posedge i_clk) begin
        if (i_rst) rA_valid <= 1'b0;
        else       rA_valid <= w_ypop;
    end
    always_ff @(posedge i_clk) begin
        rA_y <= r_yfifo[w_yra];
        rA_h <= s_axis_h_tdata;
    end

    assign w_hre = rA_h[DATA_W-1:0];
    assign w_him = rA_h[DATA_W*2-1:DATA_W];
    assign w_h2  = 32'($signed(w_hre)*$signed(w_hre) + $signed(w_him)*$signed(w_him));

    logic        rB_valid;
    logic [31:0] rB_h2;
    wire         w_rc_valid, w_rc_zero;
    wire  [15:0] w_rc_r1;   wire [5:0] w_rc_sh, w_rc_man;

    always_ff @(posedge i_clk) begin
        if (i_rst) rB_valid <= 1'b0;
        else       rB_valid <= rA_valid;
    end
    always_ff @(posedge i_clk) rB_h2 <= w_h2;

    eq_recip u_recip (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(rB_valid), .i_h2(rB_h2),
        .o_valid(w_rc_valid), .o_r1(w_rc_r1), .o_sh(w_rc_sh),
        .o_man(w_rc_man), .o_zero(w_rc_zero));

    // (Y,H) 延迟 7 拍与 eq_recip 的 6 拍 + 级 B 的 1 拍对齐
    localparam int P_DLY = 7;
    logic [DATA_W*4-1:0] r_dly [0:P_DLY-1];
    always_ff @(posedge i_clk) begin
        r_dly[0] <= {rA_h, rA_y};
        for (int k = 1; k < P_DLY; k++) r_dly[k] <= r_dly[k-1];
    end

    logic signed [DATA_W-1:0] w_dy_re, w_dy_im, w_dh_re, w_dh_im;
    assign w_dy_re = r_dly[P_DLY-1][DATA_W-1:0];
    assign w_dy_im = r_dly[P_DLY-1][DATA_W*2-1:DATA_W];
    assign w_dh_re = r_dly[P_DLY-1][DATA_W*3-1:DATA_W*2];
    assign w_dh_im = r_dly[P_DLY-1][DATA_W*4-1:DATA_W*3];

    //==========================================================================
    // 级 C: 共轭乘 num = Y·conj(H) (s33, Q4.28)
    //==========================================================================
    logic signed [32:0] w_num_re, w_num_im, rC_nre, rC_nim;
    logic               rC_valid, rC_zero;
    logic [15:0]        rC_r1;   logic [5:0] rC_sh, rC_man;

    assign w_num_re = 33'($signed(w_dy_re)*$signed(w_dh_re) + $signed(w_dy_im)*$signed(w_dh_im));
    assign w_num_im = 33'($signed(w_dy_im)*$signed(w_dh_re) - $signed(w_dy_re)*$signed(w_dh_im));

    always_ff @(posedge i_clk) begin
        if (i_rst) rC_valid <= 1'b0;
        else       rC_valid <= w_rc_valid;
    end
    always_ff @(posedge i_clk) begin
        rC_nre <= w_num_re;  rC_nim <= w_num_im;  rC_man  <= w_rc_man;
        rC_r1  <= w_rc_r1;   rC_sh  <= w_rc_sh;   rC_zero <= w_rc_zero;
    end

    //==========================================================================
    // 级 D: num*r1 (s49); 级 E: 加半右移 + 饱和 (必须饱和, 回绕会让误差无界)
    //==========================================================================
    // 加半再算术右移 (round-half-up), 与镜像的 shift_round 同形
    logic signed [48:0] w_pre, w_pim, rD_pre, rD_pim, w_half, w_sre, w_sim;
    logic               rD_valid, rD_zero;   logic [5:0] rD_sh, rD_man;
    assign w_pre = $signed(rC_nre) * $signed({1'b0, rC_r1});
    assign w_pim = $signed(rC_nim) * $signed({1'b0, rC_r1});

    always_ff @(posedge i_clk) begin
        if (i_rst) rD_valid <= 1'b0;
        else       rD_valid <= rC_valid;
    end
    always_ff @(posedge i_clk) begin
        rD_pre <= w_pre; rD_pim <= w_pim; rD_sh <= rC_sh;
        rD_man <= rC_man; rD_zero <= rC_zero;
    end

    assign w_half = 49'sd1 <<< (rD_sh - 6'd1);
    assign w_sre  = (rD_pre + w_half) >>> rD_sh;
    assign w_sim  = (rD_pim + w_half) >>> rD_sh;

    function automatic logic signed [DATA_W-1:0] sat16(input logic signed [48:0] v);
        if (v > 49'sd32767)       sat16 = 16'sh7FFF;
        else if (v < -49'sd32768) sat16 = 16'sh8000;
        else                      sat16 = v[DATA_W-1:0];
    endfunction

    logic [DATA_W*2-1:0] w_xdat;
    assign w_xdat = rD_zero ? '0 : {sat16(w_sim), sat16(w_sre)};

    //==========================================================================
    // 出侧 FIFO。在途最多 ~12 拍且停不下来, 故留 16 空位才放行新点。
    //==========================================================================
    // FIFO 表项带上 conf: 它必须与 X **同行同列**地走完出侧 FIFO 与重排,
    // 否则权重会和别的载波配对 —— 那种错不报警, 只表现为 BER 略差。
    localparam int OAW = $clog2(P_ODEPTH);
    logic [DATA_W*2+12:0] r_ofifo [0:P_ODEPTH-1];   // {erasure, conf[11:0], xdat}
    logic [OAW:0]      r_owr, r_ord, w_ocnt;
    logic              w_oempty, w_opop;
    logic [OAW-1:0]    w_owa, w_ora;

    assign w_ocnt   = r_owr - r_ord;
    assign w_oempty = (w_ocnt == '0);
    assign w_can_start = ((OAW+1)'(P_ODEPTH) - w_ocnt) > (OAW+1)'(16);
    assign w_owa = r_owr[OAW-1:0];                  // 红线 8: 地址先落 wire
    assign w_ora = r_ord[OAW-1:0];

    always_ff @(posedge i_clk) begin
        // erasure 点 conf 一并置零, 与镜像一致。不置零则前导零哨兵会算出 0x080,
        // 那是实现副产物而非规格 —— **镜像是事实源, 不一致时修 RTL**。
        if (rD_valid) r_ofifo[w_owa] <= {rD_zero, (rD_zero ? 12'd0 : {rD_sh, rD_man}), w_xdat};
    end
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_owr <= '0; r_ord <= '0;
        end else begin
            if (rD_valid) r_owr <= r_owr + 1'b1;
            if (w_opop)   r_ord <= r_ord + 1'b1;
        end
    end

    // 出侧 FIFO -> eq_reorder -> m_axis。
    // 重排把自然 bin 升序转成 golden 序 (cfg.data_idx 序) —— 系统契约见 eq_reorder
    // 头注释与 rx_chain.m 第 3 步。红线 2 的输出寄存由 eq_reorder 承担。
    logic w_fv;
    wire  w_fr;
    assign w_fv   = !w_oempty;
    assign w_opop = w_fv && w_fr;

    logic [DATA_W*2-1:0] w_fdat;
    logic [11:0]         w_fconf;
    logic                w_fer;
    assign w_fdat  = r_ofifo[w_ora][DATA_W*2-1:0];
    assign w_fconf = r_ofifo[w_ora][DATA_W*2+11:DATA_W*2];
    assign w_fer   = r_ofifo[w_ora][DATA_W*2+12];

    eq_reorder #(.DATA_W(DATA_W), .P_NDATA(48), .P_ROT(24)) u_reorder (
        .i_clk(i_clk), .i_rst(i_rst),
        .i_valid(w_fv), .o_ready(w_fr), .i_data(w_fdat),
        .i_conf(w_fconf), .i_erasure(w_fer),
        .m_axis_tvalid(m_axis_tvalid), .m_axis_tready(m_axis_tready),
        .m_axis_tdata(m_axis_tdata), .o_conf(o_conf), .o_erasure(o_erasure));

    // 非数据 bin 不占 Y 也不占出侧空间, 故不受 w_can_start 约束
    assign s_axis_h_tready = w_h_isdata ? (!w_yempty && w_can_start) : 1'b1;

    assign o_y_overflow  = ro_yovf;

endmodule

`default_nettype wire
