//-----------------------------------------------------------------
//               QC-LDPC Encoder Top (802.11n R=1/2 N=648)
//-----------------------------------------------------------------
// 名称: ldpc_encoder_top
// 功能描述: 802.11n QC-LDPC 编码器 — 双对角结构 (Dual-Diagonal)
// 端口: i_clk_sys/i_rst_sys (同步复位, 高有效);
//       s_axis_info (信息位, 1 bit/cycle); m_axis_code (码字, 1 bit/cycle)
//
// 算法 (三遍):
//   Phase 1: 加载 K=324 信息位, 存储于 r_info[0..11] (Z=27/block)
//   Phase 2: 逐 block row 计算 λ_i = Σ shift(info_j, P(i,j))
//            → 双对角回代: p_0 = rot_r(Σλ_i,1)
//              p_1 = rot_l(p_0, P(0,12)) + λ_0
//              p_i = p_{i-1} + λ_{i-1} (i=2..11)
//   Phase 3: 输出码字 [信息位 | 校验位], N=648 bits
//
// 接口: AXI4-Stream (1 bit/cycle)
// 延迟: 324 + 12×8 + 12 + 648 ≈ 1080 cycles @ 100MHz → 10.8μs
//-----------------------------------------------------------------
// 本文件为 hdl-coding 规范整改版 (2026-07-28)。改动:
//
//   (1) **消除 initial (G-C-03 / rtl-semantic-oracle)**。原文件有两个 initial:
//       - `p_rom` 的常量初始化;
//       - 用 `if (p_rom[...] != 5'd31)` 扫描构建 sys_col/sys_shf/sys_cnt。
//       后者的条件依赖 reg 数组内容, Vivado 判为非常量条件并报 [Synth 8-6896]
//       **丢弃整个 initial 块** —— 仿真里三张表有值, 综合后无驱动源
//       ([Synth 8-3848]), 上板行为与仿真不一致。这与 h_matrix_addr.v 里
//       已经修过的是同一个坑。
//       现全部改为编译期 localparam 扁平常量 (P_ROM_FLAT / SYS_*_FLAT),
//       用变量基址位选 `[idx*W +: W]` 取值。常量由
//       scratchpad 生成脚本从下方 provenance 注释块按**原扫描算法**展开,
//       与原实现逐条等价 (脚本内置行重自检)。P 矩阵变更后须重新生成。
//
//   (2) **修复挂死 (功能缺陷, 非编码规范)**。原 `s_axis_info_tready` 在
//       S_IDLE 就为高, 于是进 S_LOAD 之前的那一拍已经完成 AXI 握手把第一个
//       信息位收走了, 而 bit_cnt 与 r_info 只在 S_LOAD 态更新 —— **第一位既
//       不计数也不存储**。324 拍激励下 bit_cnt 最多到 322, `bit_cnt == K-1`
//       永不成立, 状态机出不了 S_LOAD, 整个编码器挂死。
//       (实测: 整改前 tb_ldpc_encoder_top 的 Test 2 随机输入超时, 而 TB 当时
//        没有 $fatal, 超时也退出 0 —— 所以这个挂死一直没被当成失败。)
//       现改为 ready 只在 S_LOAD 态有效: S_IDLE 只观察 tvalid 决定跳转,
//       不收数据; 第一个握手发生在 S_LOAD, 差一消除。
//
//   (3) 红线 2: s_axis_info_tready 由组合直出改为 ro_ 寄存输出。
//   (4) 红线 4/5: 次态 case 补 default 分支。
//   (5) 命名: localparam 加 P_ 前缀、内部寄存器加 r_/w_ 前缀。
//
// !! 遗留项 (本次**未改**) !!
//   [D1] 红线 1: s_axis_info_tvalid/tdata 仍被直接消费, 未经 ri_ 寄存。加载相位
//        与状态机计数强耦合 (bit_cnt 既当写地址又当状态出口判据), 插入 ri_ 级属
//        控制通路重构; 且本模块尚无 bit-true golden 对标, 重构后无法证明数值不变。
// P 矩阵 provenance 与常量表生成脚本说明见本包 README "编码器整改" 一节。
//-----------------------------------------------------------------

module ldpc_encoder_top (
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    input  wire                             s_axis_info_tdata,
    input  wire                             s_axis_info_tvalid,
    output wire                             s_axis_info_tready,

    output wire                             m_axis_code_tdata,
    output wire                             m_axis_code_tvalid,
    input  wire                             m_axis_code_tready
);

    //=================================================================
    // 本地常量 (替代 `include, 避免 lint 对 `define 的误报)
    //=================================================================
    localparam P_N       = 648;
    localparam P_K       = 324;
    localparam P_M       = 324;
    localparam P_Z       = 27;
    localparam P_MB      = 12;
    localparam P_NB      = 24;
    localparam P_MAX_WT  = 8;
    localparam P_SHIFT_W = 5;
    localparam P_BIT_W   = 10;
    localparam P_K_BLKS  = P_K / P_Z;

    //=================================================================
    // 编译期常量表 (无 initial, 见文件头 (1))
    // 元素 (br,ci) 占 [(br*P_MAX_WT+ci)*W +: W]; 由 P 矩阵按原扫描算法编译前
    // 展开而来, P 矩阵 provenance 与生成脚本说明见 README "编码器整改" 一节。
    //=================================================================
    localparam [4:0] P_P0_12 = 5'd1;   // P(0,12), 双对角回代唯一需运行时读的元素
    localparam [6*P_MB*P_MAX_WT-1:0] SYS_COL_FLAT = {
        6'd0,6'd0,6'd0,6'd9,6'd8,6'd7,6'd4,6'd0,6'd0,6'd0,6'd8,6'd7,6'd5,6'd4,6'd2,6'd0,6'd0,6'd0,6'd0,6'd11,6'd10,6'd8,6'd4,6'd0,
        6'd0,6'd0,6'd8,6'd5,6'd4,6'd3,6'd1,6'd0,6'd0,6'd0,6'd0,6'd8,6'd6,6'd4,6'd1,6'd0,6'd0,6'd0,6'd0,6'd0,6'd9,6'd8,6'd4,6'd0,
        6'd0,6'd0,6'd8,6'd6,6'd4,6'd3,6'd2,6'd0,6'd0,6'd0,6'd0,6'd11,6'd10,6'd8,6'd4,6'd0,6'd0,6'd0,6'd0,6'd9,6'd8,6'd4,6'd3,6'd0,
        6'd0,6'd0,6'd0,6'd10,6'd8,6'd4,6'd2,6'd0,6'd0,6'd0,6'd8,6'd7,6'd6,6'd4,6'd1,6'd0,6'd0,6'd0,6'd0,6'd11,6'd8,6'd5,6'd4,6'd0
    };
    localparam [5*P_MB*P_MAX_WT-1:0] SYS_SHF_FLAT = {
        5'd0,5'd0,5'd0,5'd5,5'd25,5'd2,5'd16,5'd3,5'd0,5'd0,5'd9,5'd14,5'd18,5'd23,5'd8,5'd25,5'd0,5'd0,5'd0,5'd17,5'd3,5'd13,5'd19,5'd11,
        5'd0,5'd0,5'd23,5'd10,5'd22,5'd16,5'd20,5'd7,5'd0,5'd0,5'd0,5'd6,5'd8,5'd0,5'd24,5'd13,5'd0,5'd0,5'd0,5'd0,5'd18,5'd7,5'd8,5'd25,
        5'd0,5'd0,5'd10,5'd3,5'd17,5'd1,5'd23,5'd24,5'd0,5'd0,5'd0,5'd11,5'd9,5'd0,5'd3,5'd23,5'd0,5'd0,5'd0,5'd0,5'd25,5'd20,5'd0,5'd2,
        5'd0,5'd0,5'd0,5'd0,5'd24,5'd10,5'd0,5'd6,5'd0,5'd0,5'd12,5'd0,5'd0,5'd17,5'd0,5'd22,5'd0,5'd0,5'd0,5'd0,5'd0,5'd0,5'd0,5'd0
    };
    localparam [4*P_MB-1:0] SYS_CNT_FLAT = {
        4'd5,4'd6,4'd5,4'd6,4'd5,4'd4,4'd6,4'd5,4'd5,4'd5,4'd6,4'd5
    };

    //=================================================================
    // 循环移位器 (barrel shifter, Z=27)
    //=================================================================
    function [P_Z-1:0] rot_left;
        input [P_Z-1:0] d;
        input [4:0] s;
        reg [2*P_Z-1:0] t;
    begin
        t = {d, d};
        rot_left = t[s % 32 +: P_Z];
    end
    endfunction

    function [P_Z-1:0] rot_right;
        input [P_Z-1:0] d;
        input [4:0] s;
        reg [2*P_Z-1:0] t;
    begin
        t = {d, d};
        rot_right = t[(P_Z - (s % P_Z)) % 32 +: P_Z];
    end
    endfunction

    //=================================================================
    // 状态机
    //=================================================================
    localparam P_S_IDLE   = 0,
               P_S_LOAD   = 1,
               P_S_LAMBDA = 2,
               P_S_PARITY = 3,
               P_S_OUTPUT = 4;

    reg [2:0] r_state, w_nxt;
    reg [9:0] r_bit_cnt;      // 0..647
    reg [3:0] r_blk;          // 0..11
    reg [3:0] r_conn;         // 0..8

    reg [P_Z-1:0] r_info  [0:P_K_BLKS-1];   // 信息位 blocks
    reg [P_Z-1:0] r_par   [0:P_MB-1];       // 校验位 blocks
    reg [P_Z-1:0] r_lambda[0:P_MB-1];       // λ_i 累加

    reg ro_data, ro_valid, ro_tready;

    integer i;

    // 常量表取值 (变量基址位选 —— 综合为 LUT/ROM, 无仿真-综合差异)
    wire [5:0] w_sys_col = SYS_COL_FLAT[(r_blk*P_MAX_WT + r_conn)*6 +: 6];
    wire [4:0] w_sys_shf = SYS_SHF_FLAT[(r_blk*P_MAX_WT + r_conn)*5 +: 5];
    wire [3:0] w_sys_cnt = SYS_CNT_FLAT[r_blk*4 +: 4];
    wire [4:0] w_p_0_12  = P_P0_12;                 // P(0,12), 双对角回代用

    //-----------------------------------------------------------------
    // 状态寄存器
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) r_state <= P_S_IDLE;
        else           r_state <= w_nxt;
    end

    always @(*) begin
        w_nxt = r_state;
        case (r_state)
            P_S_IDLE:   if (s_axis_info_tvalid)               w_nxt = P_S_LOAD;
            P_S_LOAD:   if (r_bit_cnt == P_K-1)                w_nxt = P_S_LAMBDA;
            P_S_LAMBDA: if (r_blk == P_MB-1 && r_conn == P_MAX_WT) w_nxt = P_S_PARITY;
            P_S_PARITY: if (r_blk == P_MB-1)                   w_nxt = P_S_OUTPUT;
            P_S_OUTPUT: if (r_bit_cnt == P_N-1)                w_nxt = P_S_IDLE;
            default:                                           w_nxt = P_S_IDLE;
        endcase
    end

    //-----------------------------------------------------------------
    // 计数器
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_bit_cnt <= 0;
            r_blk     <= 0;
            r_conn    <= 0;
        end else begin
            case (r_state)
                P_S_LOAD: begin
                    if (s_axis_info_tvalid && s_axis_info_tready)
                        r_bit_cnt <= (r_bit_cnt == P_K-1) ? 0 : r_bit_cnt + 1;
                end
                P_S_LAMBDA: begin
                    if (r_conn == P_MAX_WT) begin
                        r_conn <= 0;
                        r_blk  <= (r_blk == P_MB-1) ? 0 : r_blk + 1;
                    end else begin
                        r_conn <= r_conn + 1;
                    end
                end
                P_S_PARITY: begin
                    r_blk <= (r_blk == P_MB-1) ? 0 : r_blk + 1;
                end
                P_S_OUTPUT: begin
                    if (m_axis_code_tready || !ro_valid)
                        r_bit_cnt <= (r_bit_cnt == P_N-1) ? 0 : r_bit_cnt + 1;
                end
                default: ;
            endcase
        end
    end

    //-----------------------------------------------------------------
    // Phase 1: 加载信息位
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            for (i = 0; i < P_K_BLKS; i = i + 1) r_info[i] <= 0;
        end else if (r_state == P_S_LOAD && s_axis_info_tvalid && s_axis_info_tready) begin
            r_info[r_bit_cnt / P_Z][r_bit_cnt % P_Z] <= s_axis_info_tdata;
        end
    end

    //-----------------------------------------------------------------
    // Phase 2a: 计算 λ_i = Σ shift(info_j, P(i,j))
    //   每个周期处理一个连接, MAX_WT=8 个周期/block row
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            for (i = 0; i < P_MB; i = i + 1) r_lambda[i] <= 0;
        end else if (r_state == P_S_LAMBDA) begin
            if (r_conn < w_sys_cnt) begin
                r_lambda[r_blk] <= r_lambda[r_blk] ^
                    rot_left(r_info[w_sys_col], w_sys_shf);
            end
        end else if (r_state == P_S_PARITY) begin
            // Phase 2b 开始后清空 λ (使用完毕)
            for (i = 0; i < P_MB; i = i + 1) r_lambda[i] <= 0;
        end
    end

    //-----------------------------------------------------------------
    // Phase 2b: 双对角回代 (Σλ 在组合逻辑中计算)
    //-----------------------------------------------------------------
    reg [P_Z-1:0] w_lam_sum;
    always @(*) begin
        w_lam_sum = 0;
        for (i = 0; i < P_MB; i = i + 1) w_lam_sum = w_lam_sum ^ r_lambda[i];
    end

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            for (i = 0; i < P_MB; i = i + 1) r_par[i] <= 0;
        end else if (r_state == P_S_PARITY) begin
            if (r_blk == 0) begin
                r_par[0] <= rot_right(w_lam_sum, 1);
            end else if (r_blk == 1) begin
                r_par[1] <= rot_left(r_par[0], w_p_0_12) ^ r_lambda[0];
            end else if (r_blk <= 11) begin
                r_par[r_blk] <= r_par[r_blk-1] ^ r_lambda[r_blk-1];
            end
        end
    end

    //-----------------------------------------------------------------
    // Phase 3: 输出码字 [info bits | parity bits]
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_data  <= 0;
            ro_valid <= 0;
        end else if (r_state == P_S_OUTPUT) begin
            if (m_axis_code_tready || !ro_valid) begin
                if (r_bit_cnt < P_K) begin
                    ro_data <= r_info[r_bit_cnt / P_Z][r_bit_cnt % P_Z];
                end else begin
                    ro_data <= r_par[(r_bit_cnt - P_K) / P_Z][(r_bit_cnt - P_K) % P_Z];
                end
                ro_valid <= 1;
            end
        end else begin
            ro_valid <= 0;
        end
    end

    //-----------------------------------------------------------------
    // 输入反压 (红线 2: 寄存输出)
    // ready 只在 S_LOAD 有效 —— 见文件头 (2): 原实现在 S_IDLE 就拉高 ready,
    // 第一个信息位被握手收走却不计数不存储, 导致永远出不了 S_LOAD。
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) ro_tready <= 1'b0;
        else           ro_tready <= (w_nxt == P_S_LOAD);
    end

    //-----------------------------------------------------------------
    // 端口赋值
    //-----------------------------------------------------------------
    assign s_axis_info_tready = ro_tready;
    assign m_axis_code_tdata  = ro_data;
    assign m_axis_code_tvalid = ro_valid;

endmodule
