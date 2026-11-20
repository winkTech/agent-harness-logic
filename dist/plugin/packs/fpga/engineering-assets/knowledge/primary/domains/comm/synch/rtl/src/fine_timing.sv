//==============================================================================
// fine_timing — 长前导码 64 抽头互相关精定时 (802.11a)
// 功能: 输入样点与已知 T1 序列做互相关, 逐样点跟踪相关峰位置
// 端口: i_clk/i_rst (同步复位, 高有效); i_enable (包检测后开启搜索);
//       s_axis (输入样点 I/Q, Q2.14); o_fft_window_start (FFT 窗触发);
//       o_timing_offset (峰位, 调试用)
// 主要逻辑: ri_ 输入寄存 -> 64 深样点移位链 -> 64 路复乘 -> 组合加法树 +
//           寄存 -> 峰值跟踪 -> ro_ 寄存输出
// 延迟: 输入样点到峰值寄存器更新共 5 拍 (ri_ 1 + 移位 1 + 乘 1 + 加法树 1 +
//       峰值 1); 全流水由同一使能 ri_valid 逐级推进
// 复位: 同步高有效; 修复前 mul/加法树两级完全无复位, 现已统一复位
//
// 本文件为 hdl-coding 规范修复版。相对修复前 (git 历史) 的行为差异:
//   (1) 复位由 "异步低有效 negedge rst_n" 改为 "同步高有效 i_rst";
//       原 peak 段写的是 `always_ff @(posedge clk)` 里 `if (!rst_n)`, 即把
//       异步复位当同步复位用, 与同文件其它段的异步写法自相矛盾, 现已统一;
//   (2) 新增 ri_ 输入寄存级 -> 全链路延迟整体后移 1 拍, 数值不变;
//   (3) 删除一个只有注释的空 always_ff 死块 (原 84-88 行);
//   (4) 原 mul/corr_sum 两级无复位, 现补同步复位。
//   除上述外全部流水级沿用同一使能 (原为 s_axis_tvalid, 现为其寄存版
//   ri_valid), 因此复位释放后输出与修复前逐拍逐位一致 (仅整体延后 1 拍)。
//
// !! 遗留功能缺陷 (承自原始代码, 本次规范修复**未改其逻辑**, 仅如实标注) !!
//   [F1] o_fft_window_start 恒为 0 —— 全模块只有复位分支和 !i_enable 分支把它
//        写 0, 没有任何一条路径把它置 1。即本模块**从不产生 FFT 窗触发**,
//        而它正是本模块对外的主输出。上层 sync_top 的 FSM 依赖该信号跳转,
//        因此 DETECT->TRACK 永不发生。补上触发条件需要定义"峰搜索窗结束"的
//        判据 (典型做法: i_enable 后计满 N 个样点或峰值超过门限并回落),
//        属算法决策而非编码规范问题, 故此处不擅自发明。
//   [F2] 相关和 w_corr_comb 只累加实部 mul_i, 完全丢弃虚部 mul_q, 因此比较的
//        不是相关幅度 |corr|, 对载波相位敏感 —— 相位偏转时峰值会被削平甚至反号。
//   [F3] 峰值比较 `r_corr_sum > r_peak_val` 用有符号比较而非取模, 负相关峰被漏检。
//   [F4] o_timing_offset 计数的是"当前输入样点序号", 而比较的相关值来自 4 拍前的
//        样点, 存在固定流水偏移, 未做补偿。
//==============================================================================
module fine_timing #(
    parameter int DATA_W   = 16,
    parameter int ACC_W    = 32,
    parameter int N_LONG   = 64,
    parameter int OFFSET_W = 9    // = $clog2(512), 峰位计数器位宽
)(
    input  logic                i_clk,
    input  logic                i_rst,              // 同步复位, 高有效
    input  logic                i_enable,
    input  logic                s_axis_tvalid,
    input  logic [DATA_W*2-1:0] s_axis_tdata,
    output logic                o_fft_window_start, // FFT capture trigger
    output logic [OFFSET_W-1:0] o_timing_offset     // timing offset for debug
);

    typedef logic signed [DATA_W-1:0] data_t;
    typedef logic signed [ACC_W-1:0]  acc_t;
    // 相关累加器类型: 64 个 32 位积求和, 需与 r_corr_sum/w_corr_comb 同宽,
    // 转型加宽后再累加, 防止 DATA_W*2 积宽被截断。
    typedef logic signed [ACC_W*2-1:0] corr_t;

    // T1 sequence coefficients (Q1.15, from 802.11a long preamble)
    // 53 non-zero BPSK values in frequency domain -> time domain
    localparam data_t T1_COEFF_I [0:N_LONG-1] = '{
        -192,  -419,   393,   420,    65,   -15,  -213,  -647,
          98,   865,   459,  -186,  -294,  -512,   179,   789,
         204,  -396,  -174,  -137,   244,   206,  -237,  -335,
          89,   628,   511,  -123,  -420,  -304,   238,   740,
         368,  -342,  -543,   112,   676,   397,  -297,  -529,
        -138,   520,   560,  -108,  -649,  -413,   282,   556,
         137,  -482,  -382,   247,   657,   298,  -369,  -279,
         117,   649,   329,  -319,  -397,     5,   379,   175
    };
    localparam data_t T1_COEFF_Q [0:N_LONG-1] = '{
         -32,    83,   250,   418,   454,   337,   133,  -111,
        -316,  -400,  -362,  -218,   -15,   192,   344,   401,
         362,   253,   109,   -33,  -133,  -171,  -154,   -98,
         -26,    31,    48,    28,   -17,   -71,  -110,  -114,
         -80,   -21,    43,    94,   114,   103,    70,    32,
           2,   -15,   -17,   -13,   -14,   -24,   -40,   -53,
         -52,   -32,     1,    38,    64,    65,    39,    -6,
         -52,   -80,   -77,   -44,     4,    49,    70,    59
    };

    //==========================================================================
    // ri_ 输入寄存 (红线 1) —— 输入端口不得直通到任何组合逻辑
    // ri_valid 是全流水唯一使能, 与修复前用 s_axis_tvalid 做唯一使能同构
    //==========================================================================
    data_t ri_sample_i, ri_sample_q;
    logic  ri_valid;
    logic  ri_enable;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_sample_i <= '0;
            ri_sample_q <= '0;
            ri_valid    <= 1'b0;
            ri_enable   <= 1'b0;
        end else begin
            ri_valid  <= s_axis_tvalid;
            ri_enable <= i_enable;
            if (s_axis_tvalid) begin
                ri_sample_i <= data_t'(s_axis_tdata[DATA_W-1:0]);
                ri_sample_q <= data_t'(s_axis_tdata[DATA_W*2-1:DATA_W]);
            end
        end
    end

    //==========================================================================
    // 样点移位链
    //==========================================================================
    data_t r_sr_i [0:N_LONG-1];
    data_t r_sr_q [0:N_LONG-1];

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k < N_LONG; k++) begin
                r_sr_i[k] <= '0; r_sr_q[k] <= '0;
            end
        end else if (ri_valid) begin
            r_sr_i[0] <= ri_sample_i;
            r_sr_q[0] <= ri_sample_q;
            for (int k = 1; k < N_LONG; k++) begin
                r_sr_i[k] <= r_sr_i[k-1]; r_sr_q[k] <= r_sr_q[k-1];
            end
        end
    end

    //==========================================================================
    // 复乘阵列: r * conj(T1)
    //==========================================================================
    logic signed [DATA_W*2-1:0] r_mul_i [0:N_LONG-1];
    logic signed [DATA_W*2-1:0] r_mul_q [0:N_LONG-1];

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k < N_LONG; k++) begin
                r_mul_i[k] <= '0; r_mul_q[k] <= '0;
            end
        end else if (ri_valid) begin
            for (int k = 0; k < N_LONG; k++) begin
                r_mul_i[k] <= $signed(r_sr_i[k]) * $signed(T1_COEFF_I[k])
                            + $signed(r_sr_q[k]) * $signed(T1_COEFF_Q[k]);
                r_mul_q[k] <= $signed(r_sr_q[k]) * $signed(T1_COEFF_I[k])
                            - $signed(r_sr_i[k]) * $signed(T1_COEFF_Q[k]);
            end
        end
    end

    //==========================================================================
    // 组合加法树 + 寄存
    // 注: 只累加 mul_i, 见文件头 [F2] —— 属遗留算法缺陷, 本次未改
    //==========================================================================
    logic signed [ACC_W*2-1:0] w_corr_comb;
    always_comb begin
        w_corr_comb = '0;
        for (int k = 0; k < N_LONG; k++)
            w_corr_comb = w_corr_comb + corr_t'($signed(r_mul_i[k]));
    end

    logic signed [ACC_W*2-1:0] r_corr_sum;

    always_ff @(posedge i_clk) begin
        if (i_rst)          r_corr_sum <= '0;
        else if (ri_valid)  r_corr_sum <= w_corr_comb;
    end

    //==========================================================================
    // 峰值跟踪 + ro_ 输出寄存 (红线 2)
    //==========================================================================
    logic signed [ACC_W*2-1:0] r_peak_val;
    logic [OFFSET_W-1:0]       r_sample_cnt;
    logic [OFFSET_W-1:0]       ro_timing_offset;
    logic                      ro_fft_window_start;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_peak_val          <= '0;
            ro_timing_offset    <= '0;
            r_sample_cnt        <= '0;
            ro_fft_window_start <= 1'b0;
        end else if (ri_enable && ri_valid) begin
            r_sample_cnt <= r_sample_cnt + 1'b1;
            if (r_corr_sum > r_peak_val) begin
                r_peak_val       <= r_corr_sum;
                ro_timing_offset <= r_sample_cnt;
            end
        end else if (!ri_enable) begin
            // 搜索关闭: 清峰值与计数, 等待下一次包检测开启
            r_peak_val          <= '0;
            ro_timing_offset    <= '0;
            r_sample_cnt        <= '0;
            ro_fft_window_start <= 1'b0;
        end
    end

    assign o_timing_offset    = ro_timing_offset;
    assign o_fft_window_start = ro_fft_window_start;

endmodule : fine_timing
