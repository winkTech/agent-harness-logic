//==============================================================================
// cp_remove — 802.11a 帧结构切窗 (去 CP + 对齐 FFT 窗)
// 功能: 在 sync_top 的样点流上按 802.11a 帧结构切窗, 每符号输出连续 64 拍给
//       fft64_sdf。纯选通与计数, 无算术、无存储。
// 帧结构 (取自 models/comm/synch/config.m, 该 golden 引 IEEE 802.11a-1999 §17.3.3):
//       STS = 10x16 = 160; GI2 = 32; T1 = T2 = 64 (长前导 32+64+64 = 160);
//       数据符号 = CP(16) + 64 = 80。
//       **GI2 由 sync_top 在上游消化** —— 其 o_fft_start 与 m_axis 上 T1 首样点
//       同拍 (ADR-003), 故本模块从 T1 首点起算, 不见 STS 也不见 GI2。
// 切窗序列: i_fft_start 起 -> T1(取 64) -> T2(取 64) -> {跳 16 取 64} x i_cfg_n_sym
//       -> **冲刷 64 拍零样点** -> 回 UNSYNC。前半段正好喂出 channel_est_top 期待的
//       [LTS1, LTS2, 数据符号...] (见 cbb/channel_est_top/rtl/channel_est_top.sv 头注释)。
// 帧尾冲刷 (1.1.0 新增): 数满后再吐 64 拍**有效零样点**。fft64_sdf 的各级 FIFO 只在
//       valid 拍移位, 帧后直接静默会把它流水里最后一个真符号永久冻住 —— 每帧稳定丢
//       一个数据符号 (2026-08-04 实链实测 TAIL_STUCK 64)。这 64 拍推出最后一个真符号
//       的同时自己成为新的"卡住的那一个", 故**不会给下游造出假符号**。
// 帧尾: 由 i_cfg_n_sym 侧带静态给定 (owner 裁定 2026-08-03)。sync_top 是单突发
//       语义、无帧尾信号, 而 SIGNAL 解码在范围外 —— 若改为"自由流转到复位",
//       帧尾之后会把噪声当符号吐给下游。
// 反压: 上游 sync_top 无反压契约 (m_axis_tready 被忽略, 稳态须恒高), 下游
//       fft64_sdf 亦无 ready。故本模块**不得停顿输入**, 也不提供 tready。
//       CP 期间输出无效 (16 拍空档), 由 fft64 的 i_beat/i_valid 消化。
// 侧带: o_sb 只在 LTS1 首拍打一拍, 供 fft64_sdf 透传, 使 channel_est_top 的
//       i_frame_start 与 LTS1 的 FFT 输出自动对齐 (需求门禁 2026-08-03 裁定)。
// 复位: 同步高有效; 复位后处于 UNSYNC, 静默丢弃样点直到 i_fft_start。
//==============================================================================
`default_nettype none

module cp_remove #(
    parameter int DATA_W = 16
)(
    input  wire                      i_clk,
    input  wire                      i_rst,          // 同步复位, 高有效

    input  wire                      i_fft_start,    // 与 T1 首样点同拍的单拍脉冲
    input  wire [7:0]                i_cfg_n_sym,    // 本帧数据符号数 (帧内须稳定)

    // 上游 sync_top m_axis (无 tready —— 其契约即无反压)
    input  wire                      s_axis_tvalid,
    input  wire [DATA_W*2-1:0]       s_axis_tdata,   // {Q, I}, Q2.14

    // 下游 fft64_sdf (无 ready)
    output wire                      o_valid,
    output wire signed [DATA_W-1:0]  o_re,           // I
    output wire signed [DATA_W-1:0]  o_im,           // Q
    output wire                      o_sb            // 帧起始侧带 (仅 LTS1 首拍)
);

    localparam int N    = 64;
    localparam int N_CP = 16;

    // 三段式 FSM。
    // **时序约定 (关键)**: w_seg/w_idx 描述**当前寄存在 ri_data 里的那个样点**,
    // r_seg/r_idx 是它们的寄存版 (即上一个样点的归属)。
    // 反过来用 r_seg 去判定当前样点会丢掉每段的首点 —— ri_fs 那一拍 ri_data 已经
    // 是 T1[0], 而 r_seg 还停在 UNSYNC; 实测表现为 LTS 起点晚 1 拍, 并连锁使 CP
    // 段判断错位、多吐一个符号。
    // S_FLUSH: 帧尾冲刷段 —— 数满后再吐 64 拍**有效零样点**, 专供下游 fft64_sdf
    //   排空它流水里的最后一个真符号。fft64 的各级 FIFO 只在 i_beat && valid 时
    //   移位, 拉低 valid 不排空、只是把在途样点冻住 (见其 limitations 5); 帧结束
    //   后本模块若直接静默, 每帧最后一个数据符号就**永远出不来** —— 2026-08-04
    //   用 cp_remove->fft64_sdf->channel_est_top 实链在 xsim 上实测到 (TAIL_STUCK
    //   64 样点), 需求门禁裁定由本模块负责补。
    //   64 这个数不是推的: fft64 的 tb_fft64_tail 双向实测钉定 (撤 valid 恰好卡住
    //   1 个符号; 补 64 拍全部排空)。
    //   冲刷**不会给下游造出假符号**: 这 64 拍推出最后一个真符号的同时, 自己成为
    //   fft64 流水里新的"卡住的那一个", 永不出现在其输出上。
    // 枚举扩到 3 位: 原 2 位的四个取值已用满。
    typedef enum logic [2:0] { S_UNSYNC, S_LTS, S_CP, S_DATA, S_FLUSH } seg_t;
    seg_t       r_seg,  w_seg;
    logic [6:0] r_idx,  w_idx;      // 段内序号 (0..63 / 0..15)
    logic       r_lts2, w_lts2;     // 当前 LTS 段是 T2
    logic [7:0] r_sym,  w_sym;      // 已完成的数据符号数

    //==========================================================================
    // 输入寄存 (红线 1)
    //==========================================================================
    logic                     ri_valid, ri_fs;
    logic [DATA_W*2-1:0]      ri_data;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_valid <= 1'b0;
            ri_fs    <= 1'b0;
        end else begin
            ri_valid <= s_axis_tvalid;
            ri_fs    <= i_fft_start && s_axis_tvalid;
        end
    end
    // 显式 begin/end: 单行 always 没有块边界, G-A-04 的行数检查会一路数到下一个
    // end, 把紧随其后的 always_comb 也算进来 (2026-08-04 因此误报 59 行 > 50)。
    always_ff @(posedge i_clk) begin
        ri_data <= s_axis_tdata;
    end

    //==========================================================================
    // 当前样点的归属 (组合)。切窗序列:
    //   UNSYNC --ri_fs--> LTS(T1,64) --> LTS(T2,64) --> CP(16) --> DATA(64)
    //                     --{未数满}--> CP(16) --> DATA(64) ... --{数满}--> FLUSH(64)
    //                     --> UNSYNC
    //
    // S_FLUSH 也响应 i_fft_start (新帧一来即中止冲刷直接起窗): 冲刷的唯一目的是把
    //   上一帧最后一个符号挤出 fft64 的流水, 而新帧的样点本来就会把它挤出去。此时
    //   再占着 64 拍反而把帧间最小间隔从 1 拍抬到 65 拍 —— 实测中它吞掉过第二帧的
    //   fft_start, 整帧丢失。
    //==========================================================================
    always_comb begin
        w_seg  = r_seg;
        w_idx  = r_idx + 7'd1;
        w_lts2 = r_lts2;
        w_sym  = r_sym;

        case (r_seg)
            S_UNSYNC: begin
                w_idx = '0;
                if (ri_fs) begin                       // 本拍 ri_data 即 T1[0]
                    w_seg  = S_LTS;
                    w_lts2 = 1'b0;
                    w_sym  = '0;
                end
            end
            S_LTS: if (r_idx == 7'(N-1)) begin         // 上一点是本段末点
                w_idx = '0;
                if (r_lts2) w_seg  = S_CP;             // T2 走完 -> 进数据段
                else        w_lts2 = 1'b1;             // T1 走完 -> 再走 T2
            end
            S_CP: if (r_idx == 7'(N_CP-1)) begin
                w_seg = S_DATA;
                w_idx = '0;
            end
            S_DATA: if (r_idx == 7'(N-1)) begin
                w_idx = '0;
                if (r_sym + 8'd1 >= i_cfg_n_sym) begin // 数满 -> 进冲刷段
                    w_seg = S_FLUSH;
                    w_sym = '0;
                end else begin
                    w_seg = S_CP;
                    w_sym = r_sym + 8'd1;
                end
            end
            S_FLUSH: if (ri_fs) begin                   // 新帧 -> 中止冲刷直接起窗
                w_seg  = S_LTS;
                w_idx  = '0;
                w_lts2 = 1'b0;
                w_sym  = '0;
            end else if (r_idx == 7'(N-1)) begin        // 64 拍走完 -> 回 UNSYNC
                w_seg = S_UNSYNC;
                w_idx = '0;
            end
            default: w_seg = S_UNSYNC;
        endcase
    end

    //==========================================================================
    // 寄存 (仅在有效拍推进)
    //==========================================================================
    // w_self: 无需输入拍即可推进的两种情形 ——
    //   (1) 已在冲刷段;
    //   (2) 数据段最后一点已过且符号数已满 (即"下一拍就该进冲刷") —— 这一拍若也
    //       要等 ri_valid, 冲刷入口仍会卡在上游是否续流上。
    logic w_self;
    assign w_self = (r_seg == S_FLUSH)
                 || ((r_seg == S_DATA) && (r_idx == 7'(N-1)) && (r_sym + 8'd1 >= i_cfg_n_sym));

    // 推进条件含 w_self: 冲刷段与冲刷入口**自驱**, 不等 ri_valid。
    //   若冲刷也要靠输入拍推进, 则"最后一个符号能不能出来"就取决于上游在帧尾之后
    //   还送不送样点 —— 那是个隐藏依赖, 而"靠上游行为碰巧成立"正是本次功能洞的
    //   成因 (帧后 cp_remove 静默 -> fft64 饿死 -> 丢符号)。自驱后该依赖消失:
    //   无论上游是否续流, 帧尾都必定吐满 64 拍。
    //   安全性: 冲刷段的输出是常量零、与输入无关, 期间不消费也不丢弃任何输入样点
    //   (S_FLUSH 不取 ri_data); 上游若在此期间送样点, 那些样点本就属于帧后噪声。
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_seg  <= S_UNSYNC;
            r_idx  <= '0;
            r_lts2 <= 1'b0;
            r_sym  <= '0;
        end else if (ri_valid || w_self) begin
            r_seg  <= w_seg;
            r_idx  <= w_idx;
            r_lts2 <= w_lts2;
            r_sym  <= w_sym;
        end
    end

    //==========================================================================
    // 输出寄存 (红线 2): LTS 与 DATA 段有效, CP 与 UNSYNC 段无效
    //==========================================================================
    logic                     ro_valid, ro_sb;
    logic signed [DATA_W-1:0] ro_re, ro_im;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_valid <= 1'b0;
            ro_sb    <= 1'b0;
        end else begin
            // 用 w_seg (当前 ri_data 那个样点的归属), 不是 r_seg (上一个样点的)
            // 冲刷段的有效拍不由 ri_valid 门控 —— 它是自驱的 (见 w_self)
            ro_valid <= (w_seg == S_FLUSH)
                     || (ri_valid && ((w_seg == S_LTS) || (w_seg == S_DATA)));
            // 侧带只在 T1 首点: LTS 段、段内序号 0、且不是 T2
            ro_sb    <= ri_valid && (w_seg == S_LTS) && (w_idx == '0) && !w_lts2;
        end
    end

    // 冲刷段吐**零**而非透传帧后样点: 零是确定值, golden 能精确建模、cosim 保持
    // 0 容差; 透传噪声会把判据和帧后激励无谓地耦合起来。
    always_ff @(posedge i_clk) begin
        if (w_seg == S_FLUSH) begin
            ro_re <= '0;
            ro_im <= '0;
        end else begin
            ro_re <= $signed(ri_data[DATA_W-1:0]);
            ro_im <= $signed(ri_data[DATA_W*2-1:DATA_W]);
        end
    end

    assign o_valid = ro_valid;
    assign o_re    = ro_re;
    assign o_im    = ro_im;
    assign o_sb    = ro_sb;

endmodule : cp_remove

`default_nettype wire
