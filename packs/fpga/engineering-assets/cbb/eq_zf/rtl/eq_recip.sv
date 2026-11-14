//==============================================================================
// eq_recip — 归一化倒数 1/|H|^2 (eq_zf 的算术核心)
// 功能: 入 |H|^2 (u32, Q4.28), 出 r1 (u16, Q2.14, ≈1/M) 与移位量 sh, 供上层按
//       x = (num*r1 + 2^(sh-1)) >>> sh 完成定标; |H|^2==0 时拉 o_zero (裁定④)。
//       重构关系: 1/|H|^2 = r1 · 2^(16-sh)。
// 规格来源: models/comm/ofdm/src/rtl_mirror_eq.m 第 3-6 步 —— **需求侧单一事实源**,
//       本模块逐级照其实现; cosim 失配时修本模块而非改镜像。ROM 内容按闭式在综合期
//       算出 (见 f_lut), 与镜像导出的 rtl/eq_recip_lut.hex 由 TB 断言逐项相同。
// 端口: i_clk/i_rst (同步高有效); i_valid/i_h2 -> o_valid/o_r1/o_sh/o_zero
// 主要逻辑: ri_ 输入寄存 -> 前导零定 s 并归一化 -> 查表 r0 -> Newton 两拍 -> ro_ 输出
// 延迟: i_valid 到 o_valid 固定 **6 拍** —— ri_(红线1) + 归一化 + 查表 + Newton 两级
//       + ro_(红线2)。无反压 (节流由上层的 Y 路 FIFO 与 H 路 tready 做)
// 复位: 同步高有效; 仅 valid 链复位, 数据通路少复位 (hdl 红线 3 + §1.1)
//==============================================================================
`default_nettype none

module eq_recip (
    input  wire        i_clk,
    input  wire        i_rst,

    input  wire        i_valid,
    input  wire [31:0] i_h2,        // u32, Q4.28; 取值 [0, 2^31]

    output wire        o_valid,
    output wire [15:0] o_r1,        // u16, Q2.14, ≈ 1/M, M∈[0.5,1)
    output wire [5:0]  o_sh,        // sh = 34 - lz ∈ [3, 34]
    output wire [5:0]  o_man,       // M16[14:9] —— |H|² 的归一化尾数高 6 位
    output wire        o_zero       // i_h2 == 0
);

    // o_man 与 o_sh 合起来就是上层的 o_conf: |H|² = M · 2^(sh-30), M = M16/2^16。
    // 位宽由端到端实测定 (6 位尾数 -> LLR 相对误差 0.0027, 已在 Q(10,4) 自身量化地板
    // ~0.005 的一半以下, 再加位无收益), 见 incubator/intake/mod_demapper/analysis/
    // fixed-point-study.md §4。**M16 是归一化时就算出来的**, 导出它不增加任何运算。

    //==========================================================================
    // 红线 1: 输入寄存, 禁止直通
    //==========================================================================
    logic        ri_valid;
    logic [31:0] ri_h2;

    always_ff @(posedge i_clk) begin
        if (i_rst) ri_valid <= 1'b0;
        else       ri_valid <= i_valid;
    end

    always_ff @(posedge i_clk) begin          // 数据通路少复位, 由 valid 屏蔽
        ri_h2 <= i_h2;
    end

    //==========================================================================
    // 级 1: 前导零 -> s = lz-1, sh = 34-lz; 归一化到 [2^30, 2^31) 后取高 16 位
    //   h2 = 2^31 (Hre=Him=-32768) -> lz=0  -> s=-1, **右**移一位
    //   h2 = 1                     -> lz=31 -> s=30
    //   M16 = norm[30:15]; norm 的 bit30 恒为 1, 故 M16 的 bit15 恒为 1
    //==========================================================================
    // 从低位向高位扫, 后写覆盖先写 —— 循环结束时保留的就是**最高**置位。
    // 不用 break: iverilog 不支持它, 而本模块要保持 iverilog/xsim 双仿真器可跑。
    logic [5:0] w_lz;
    always_comb begin
        w_lz = 6'd32;                                 // i_h2==0 的哨兵 (由 o_zero 兜住)
        for (int b = 0; b < 32; b++) begin
            if (ri_h2[b]) w_lz = 6'(31 - b);
        end
    end

    // iverilog 不接受 always_* 进程内的常量位选, 故位选一律落到连续赋值上,
    // 进程内只出现整名。功能等价, 且保持双仿真器可跑。
    logic [31:0] w_sh32;
    always_comb begin
        if (w_lz == 6'd0) w_sh32 = ri_h2 >> 1;        // s = -1
        else              w_sh32 = ri_h2 << (w_lz - 6'd1);
    end

    logic [15:0] w_m16;
    assign w_m16 = w_sh32[30:15];                     // norm[30:15]; norm 的 bit30 恒为 1

    logic        r1_valid, r1_zero;
    logic [15:0] r1_m16;
    logic [5:0]  r1_sh;

    always_ff @(posedge i_clk) begin
        if (i_rst) r1_valid <= 1'b0;
        else       r1_valid <= ri_valid;
    end

    always_ff @(posedge i_clk) begin
        r1_zero <= (ri_h2 == 32'd0);
        r1_m16  <= w_m16;
        r1_sh   <= 6'd34 - w_lz;
    end

    //==========================================================================
    // 级 2: 查表 r0 = LUT[M16[14:7]]
    //   红线 8: 地址先经 assign 落到 wire 再索引, 不在 NBA 左值里写表达式
    //==========================================================================
    // ROM 内容按**闭式**在综合期算出, 不读外部文件。
    //   Mc = 0.5 + (a+0.5)/512 = (2a+513)/1024
    //   LUT[a] = round(2^14 / Mc) = round(2^24 / (2a+513)) = (2^25 + D) / (2D), D=2a+513
    // 为什么不用 $readmemh: pg-synth 让 Vivado 跑在 var/gates/pg/<uid>/ 而不是包目录,
    // 相对路径的 hex 找不到; 传绝对路径不可移植, 靠 incdir 又依赖各版本不一致的搜索行为。
    // 生成块里每个 f_lut(gi) 的实参都是常数, 综合期折叠成常量 -> 推出 ROM 而非除法器。
    // **rtl/eq_recip_lut.hex 仍是镜像 (rtl_mirror_eq 的 info.lut) 的权威导出并保留**,
    // 由 tb_eq_recip 断言本闭式与它逐项相同 —— 两者一旦漂开立刻红, 而不是悄悄分家。
    function automatic logic [15:0] f_lut(input int a);
        int d;
        d = 2*a + 513;
        f_lut = 16'((33554432 + d) / (2*d));      // (2^25 + D) / 2D = round(2^24/D)
    endfunction

    wire [15:0] w_lut [0:255];
    genvar gi;
    generate
        for (gi = 0; gi < 256; gi++) begin : g_lut
            assign w_lut[gi] = f_lut(gi);
        end
    endgenerate

    logic [7:0] w_addr;
    logic [5:0] w_man;
    assign w_addr = r1_m16[14:7];
    assign w_man  = r1_m16[14:9];               // 尾数高 6 位, 与查表地址同源

    logic        r2_valid, r2_zero;
    logic [15:0] r2_r0, r2_m16;
    logic [5:0]  r2_sh, r2_man;

    always_ff @(posedge i_clk) begin
        if (i_rst) r2_valid <= 1'b0;
        else       r2_valid <= r1_valid;
    end

    always_ff @(posedge i_clk) begin
        r2_r0   <= w_lut[w_addr];
        r2_m16  <= r1_m16;
        r2_sh   <= r1_sh;
        r2_man  <= w_man;
        r2_zero <= r1_zero;
    end

    //==========================================================================
    // 级 3: Newton 第一步  p = (M16*r0) >> 16 ; t = 2^15 - p
    //==========================================================================
    logic [31:0] w_mr;
    logic [15:0] w_p;
    assign w_mr = r2_m16 * r2_r0;
    assign w_p  = w_mr[31:16];

    logic        r3_valid, r3_zero;
    logic [15:0] r3_t, r3_r0;
    logic [5:0]  r3_sh, r3_man;

    always_ff @(posedge i_clk) begin
        if (i_rst) r3_valid <= 1'b0;
        else       r3_valid <= r2_valid;
    end

    always_ff @(posedge i_clk) begin
        r3_t    <= 16'h8000 - w_p;                // Q2.14 的 (2 - M·r0)
        r3_r0   <= r2_r0;
        r3_sh   <= r2_sh;
        r3_man  <= r2_man;
        r3_zero <= r2_zero;
    end

    //==========================================================================
    // 级 4: Newton 第二步  r1 = (r0*t) >> 14
    //==========================================================================
    logic [31:0] w_rt;
    logic [15:0] w_r1;
    assign w_rt = r3_r0 * r3_t;
    assign w_r1 = w_rt[29:14];

    logic        r4_valid, r4_zero;
    logic [15:0] r4_r1;
    logic [5:0]  r4_sh, r4_man;

    always_ff @(posedge i_clk) begin
        if (i_rst) r4_valid <= 1'b0;
        else       r4_valid <= r3_valid;
    end

    always_ff @(posedge i_clk) begin
        r4_r1   <= w_r1;
        r4_sh   <= r3_sh;
        r4_man  <= r3_man;
        r4_zero <= r3_zero;
    end

    //==========================================================================
    // 红线 2: 输出由 ro_ 驱动, 禁止组合直出
    //==========================================================================
    logic        ro_valid, ro_zero;
    logic [15:0] ro_r1;
    logic [5:0]  ro_sh, ro_man;

    always_ff @(posedge i_clk) begin
        if (i_rst) ro_valid <= 1'b0;
        else       ro_valid <= r4_valid;
    end

    always_ff @(posedge i_clk) begin
        ro_r1   <= r4_r1;
        ro_sh   <= r4_sh;
        ro_man  <= r4_man;
        ro_zero <= r4_zero;
    end

    assign o_valid = ro_valid;
    assign o_r1    = ro_r1;
    assign o_sh    = ro_sh;
    assign o_man   = ro_man;
    assign o_zero  = ro_zero;

endmodule

`default_nettype wire
