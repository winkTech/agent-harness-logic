//==============================================================================
// packet_detect — 短前导码滑窗自相关包检测 (802.11a)
// 功能: 对输入样点做 r[n]·conj(r[n-16]) 自相关, 16 点滑窗累加得 C[n],
//       同步累加接收能量 P[n], 用免除法判据 |C|^2 > (0.5·P)^2 判定包到达
// 端口: i_clk/i_rst (同步复位, 高有效); s_axis (输入样点 I/Q, Q2.14);
//       o_packet_detected / o_metric_q15 / o_metric_valid (检测结果与度量)
// 主要逻辑: ri_ 输入寄存 -> 33 深样点延迟线 -> 复乘 -> 17 深积延迟线 +
//           滑窗累加(加新减旧) -> 平方比较 -> ro_ 寄存输出
// 延迟: 输入样点到对应 o_metric_valid 共 6 拍 (ri_ 1 + dl 1 + 积 1 + 累加 1 +
//       平方 1 + 度量 1); 各级由 valid 链逐级使能, 与数据严格同步
// 复位: 同步高有效, 全部流水寄存器统一复位 (无异步复位, 无未复位寄存器)
//
// 本文件为 hdl-coding 规范修复版。相对修复前 (git 历史) 的行为差异:
//   (1) 复位由 "异步低有效 negedge rst_n" 改为 "同步高有效 i_rst";
//   (2) 新增 ri_ 输入寄存级 -> 全链路延迟 5 拍变 6 拍;
//   (3) 原 c2/se/mtr/packet_detected 四级不受 s_axis_tvalid 使能 (前三级受),
//       断续 valid 下会串道; 现全链统一由 valid 链使能。
//
// !! 修复前版本的致命缺陷 (本次修复已消除, 记录在此以免回退) !!
//   [X-LOCK] 修复前 r_p_i/r_p_q (原 p_i/p_q) **没有复位**。上电后它们是 X,
//   而累加器是自反馈的 `acc_i <= acc_i + p_i - pd_i[L_CORR]` —— 第一个 tvalid
//   拍就把 X 吸进 acc_i, 此后 X 永远出不去。于是 c2 恒为 X, 判定条件恒为 X
//   (被当假), **该模块修复前从未检出过任何包**。已用 TB 取证 (old.acc_i=xxxxxxxx,
//   修复版同时刻为确定值)。这正是红线 3 "必须有同步复位" 要防的事故类型。
//
// !! 遗留数值缺陷 (承自原始设计, 本次**未改**, 需 golden model 支撑后另行决策) !!
//   [F1] 门限溢出 —— `r_se <= (TH_Q * energy) * (TH_Q * energy)` 之后 `>>> 30`,
//        数学意图是 E^2/4 (TH_Q=2^14: (2^14·E)^2 / 2^30 = E^2/4)。但中间量
//        2^28·E^2 会溢出 64 位: 典型噪声功率下 E ≈ 2^23, 2^28·E^2 ≈ 2^75。
//        回绕后门限失真, 实测**噪声虚警率 99%** —— 检测器基本没有判别力。
//        该缺陷此前被 [X-LOCK] 掩盖 (旧版从不检出, 暴露不出来), 修好复位才显形。
//        正确写法是直接比 `c2 > (E^2 >>> 2)` 并按上式重新核算 acc/energy/c2 位宽,
//        属定点定标与乘法器面积的权衡, 不是编码规范问题, 故此处不擅改。
//   [F2] acc_i/acc_q 与 r_energy 均为 ACC_W=32 位, 但 16 点滑窗累加 16 个
//        最大 2^31 的项需要 ~36 位, 存在静默溢出风险; 同属上面的定标问题。
//==============================================================================
module packet_detect #(
    parameter int DATA_W = 16,
    parameter int ACC_W  = 32,
    parameter int N_SHORT = 16,
    parameter int L_CORR  = 16
)(
    input  logic                i_clk,
    input  logic                i_rst,            // 同步复位, 高有效
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,
    output logic                o_packet_detected,
    output logic [DATA_W-1:0]   o_metric_q15,
    output logic                o_metric_valid
);

    typedef logic signed [DATA_W-1:0] data_t;
    typedef logic signed [ACC_W-1:0]  acc_t;

    localparam int TH_Q = 16384;  // 判据门限 0.5, Q0.15

    //==========================================================================
    // ri_ 输入寄存 (红线 1) —— 输入端口不得直通到任何组合逻辑
    //==========================================================================
    data_t ri_sample_i, ri_sample_q;
    logic  ri_valid;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ri_sample_i <= '0;
            ri_sample_q <= '0;
            ri_valid    <= 1'b0;
        end else begin
            ri_valid <= s_axis_tvalid;
            if (s_axis_tvalid) begin
                ri_sample_i <= data_t'(s_axis_tdata[DATA_W-1:0]);
                ri_sample_q <= data_t'(s_axis_tdata[DATA_W*2-1:DATA_W]);
            end
        end
    end

    //==========================================================================
    // valid 流水链 —— 每一级数据寄存对应一级 valid, 保证断续 valid 不串道
    //   r_valid[0] : 样点延迟线已更新
    //   r_valid[1] : 复乘积已就绪
    //   r_valid[2] : 滑窗累加已就绪
    //   r_valid[3] : 平方项已就绪
    //   r_valid[4] : 度量/判定已就绪 -> 驱动 o_metric_valid
    //==========================================================================
    logic [4:0] r_valid;

    always_ff @(posedge i_clk) begin
        if (i_rst) r_valid <= 5'b0;
        else       r_valid <= {r_valid[3:0], ri_valid};
    end

    //==========================================================================
    // 样点延迟线 (N_SHORT + L_CORR + 1 深)
    //==========================================================================
    data_t r_dl_i [0:N_SHORT+L_CORR];
    data_t r_dl_q [0:N_SHORT+L_CORR];

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k <= N_SHORT+L_CORR; k++) begin
                r_dl_i[k] <= '0; r_dl_q[k] <= '0;
            end
        end else if (ri_valid) begin
            r_dl_i[0] <= ri_sample_i;
            r_dl_q[0] <= ri_sample_q;
            for (int k = 1; k <= N_SHORT+L_CORR; k++) begin
                r_dl_i[k] <= r_dl_i[k-1]; r_dl_q[k] <= r_dl_q[k-1];
            end
        end
    end

    //==========================================================================
    // 复乘: r[n] * conj(r[n-16])
    //==========================================================================
    logic signed [DATA_W*2-1:0] r_p_i, r_p_q;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_p_i <= '0; r_p_q <= '0;
        end else if (r_valid[0]) begin
            r_p_i <= $signed(r_dl_i[0]) * $signed(r_dl_i[N_SHORT])
                   + $signed(r_dl_q[0]) * $signed(r_dl_q[N_SHORT]);
            r_p_q <= $signed(r_dl_q[0]) * $signed(r_dl_i[N_SHORT])
                   - $signed(r_dl_i[0]) * $signed(r_dl_q[N_SHORT]);
        end
    end

    //==========================================================================
    // 积延迟线 (L_CORR + 1 深, 供滑窗"减旧"用)
    //==========================================================================
    logic signed [DATA_W*2-1:0] r_pd_i [0:L_CORR];
    logic signed [DATA_W*2-1:0] r_pd_q [0:L_CORR];

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k <= L_CORR; k++) begin
                r_pd_i[k] <= '0; r_pd_q[k] <= '0;
            end
        end else if (r_valid[1]) begin
            r_pd_i[0] <= r_p_i; r_pd_q[0] <= r_p_q;
            for (int k = 1; k <= L_CORR; k++) begin
                r_pd_i[k] <= r_pd_i[k-1]; r_pd_q[k] <= r_pd_q[k-1];
            end
        end
    end

    //==========================================================================
    // 滑窗累加: C[n] += 新 - 旧; 能量 P[n] 同法累加
    //==========================================================================
    acc_t r_acc_i, r_acc_q;
    logic signed [DATA_W*2-1:0] r_energy;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_acc_i <= '0; r_acc_q <= '0; r_energy <= '0;
        end else if (r_valid[1]) begin
            r_acc_i <= r_acc_i + r_p_i - r_pd_i[L_CORR];
            r_acc_q <= r_acc_q + r_p_q - r_pd_q[L_CORR];
            // 能量 = |r(n-16)|^2 的滑窗和
            r_energy <= r_energy
                + ($signed(r_dl_i[N_SHORT]) * $signed(r_dl_i[N_SHORT])
                 + $signed(r_dl_q[N_SHORT]) * $signed(r_dl_q[N_SHORT]))
                - ($signed(r_dl_i[N_SHORT+L_CORR]) * $signed(r_dl_i[N_SHORT+L_CORR])
                 + $signed(r_dl_q[N_SHORT+L_CORR]) * $signed(r_dl_q[N_SHORT+L_CORR]));
        end
    end

    //==========================================================================
    // 免除法判据的两个平方项
    //==========================================================================
    logic signed [ACC_W*2-1:0] r_c2, r_se;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_c2 <= '0; r_se <= '0;
        end else if (r_valid[2]) begin
            r_c2 <= $signed(r_acc_i) * $signed(r_acc_i)
                  + $signed(r_acc_q) * $signed(r_acc_q);
            r_se <= (TH_Q * $signed(r_energy)) * (TH_Q * $signed(r_energy));
        end
    end

    //==========================================================================
    // ro_ 输出寄存 (红线 2) —— 判定 + 度量, 与 r_valid[4] 同拍
    //==========================================================================
    logic                ro_packet_detected;
    logic [DATA_W-1:0]   ro_metric_q15;
    logic                ro_metric_valid;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_packet_detected <= 1'b0;
            ro_metric_q15      <= '0;
            ro_metric_valid    <= 1'b0;
        end else begin
            ro_metric_valid <= r_valid[3];
            if (r_valid[3]) begin
                ro_packet_detected <= (r_c2 > (r_se >>> 30)) && ($signed(r_energy) > 0);
                ro_metric_q15      <= ($signed(r_energy) > 0)
                                    ? r_c2[ACC_W+DATA_W-1:ACC_W-DATA_W+1]
                                    : '0;
            end else begin
                ro_packet_detected <= 1'b0;
            end
        end
    end

    assign o_packet_detected = ro_packet_detected;
    assign o_metric_q15      = ro_metric_q15;
    assign o_metric_valid    = ro_metric_valid;
    // 本模块无内部缓冲, 恒可收样点 (常量驱动, 非组合直出)
    assign s_axis_tready     = 1'b1;

endmodule : packet_detect
