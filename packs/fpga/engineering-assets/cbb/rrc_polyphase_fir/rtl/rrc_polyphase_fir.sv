//==============================================================================
// rrc_polyphase_fir — RRC 根升余弦脉冲成形多相 FIR 滤波器核
// 功能: 33 抽头(alpha=0.5, sps=4, span=8) 4 相多相插值; 符号率入(AXI-S), 4x 采样率出
// 端口: i_clk/i_rst(同步高有效); s_axis(符号 I/Q Q2.14); m_axis(样点 I/Q Q2.14)
// 主要逻辑: 9 深符号缓存 -> 槽计数相位调度 -> 9 抽头 MAC(乘积寄存 + 3 级寄存加法树) ->
//           round-half-away(/2^15)+对称饱和(±32767), 与 golden 定点语义逐位一致
// 延迟: 7 拍 (输入寄存 1 + mac/addA/addB/sum/mag/ro 6); 分级理由见下方说明
// 系数: models/comm/rrc/rrc_coeff.hex (Q1.15) 逐相展开, 相1-3 补零至 9 抽头
// 约束: 输入符号间隔 >= 4 拍 (s_axis_tready 恒 1, 无内部背压缓冲)
//==============================================================================
module rrc_polyphase_fir #(
    parameter int DATA_W  = 16,
    parameter int COEFF_W = 16,
    parameter int ACC_W   = 38,
    parameter int SPS     = 4,
    parameter int TAPS_PP = 9      // 每相抽头数 (33 taps / 4 相, 零补齐)
)(
    input  logic                i_clk,
    input  logic                i_rst,          // 同步复位, 高有效
    input  logic                s_axis_tvalid,
    output logic                s_axis_tready,
    input  logic [DATA_W*2-1:0] s_axis_tdata,
    output logic                m_axis_tvalid,
    input  logic                m_axis_tready,
    output logic [DATA_W*2-1:0] m_axis_tdata
);

    //==========================================================================
    // 多相系数表 H[p][k] = h[p + 4k] (h = rrc_coeff.hex, Q1.15; 越界补零)
    //==========================================================================
    typedef logic signed [COEFF_W-1:0] coeff_t;
    localparam coeff_t H [SPS][TAPS_PP] = '{
        '{16'shFF5A, 16'sh0032, 16'sh02B7, 16'shF936, 16'sh48BE, 16'shF936, 16'sh02B7, 16'sh0032, 16'shFF5A},
        '{16'shFFC1, 16'shFEF2, 16'sh00FD, 16'sh0A0A, 16'sh3E5E, 16'shF5F6, 16'sh00FD, 16'sh010E, 16'sh0000},
        '{16'sh00B0, 16'shFF0A, 16'shFB33, 16'sh2508, 16'sh2508, 16'shFB33, 16'shFF0A, 16'sh00B0, 16'sh0000},
        '{16'sh010E, 16'sh00FD, 16'shF5F6, 16'sh3E5E, 16'sh0A0A, 16'sh00FD, 16'shFEF2, 16'shFFC1, 16'sh0000}
    };

    typedef logic signed [DATA_W-1:0] data_t;
    typedef logic signed [ACC_W-1:0]  acc_t;

    //==========================================================================
    // 关于布线后 hold 未收敛 —— 曾试过"把 i_rst 寄存一拍"并已证伪, 勿重复尝试
    //
    // 现象: OOC 布线后 WHS < 0, 违例路径**全部**起于输入端口, 内部 reg-to-reg
    // 始终是干净的 (+0.094ns)。
    //
    // 1.0.1 试过的方案: 把 i_rst 先在核内寄存一拍再驱动各级, 想让当时最差的那条
    // i_rst -> addA_i_reg[0]/RSTM (DSP48E1 复位脚) 变成 reg-to-reg。
    // 结果: 该条确实消失了, 但 WHS 从 -0.163ns 变成 -0.189ns —— 新的最差路径是
    // s_axis_tdata[5] -> sym_buf_i_reg[0][5]/D, 一个普通 FDRE, 其 hold 需求
    // 0.227ns 比 DSP48E1 RSTM 的 0.201ns 还大。
    //
    // 根因: 问题从来不在 i_rst, 而在 XDC 里 `set_input_delay -min 0.100` 这个
    // **占位假设**对所有输入一视同仁地过小。任何输入端口最终都要落进某个触发器,
    // 而触发器就有 hold 需求; sym_buf_i_reg[0] 本身就已经是输入寄存级 ——
    // **没有任何 RTL 变换能消掉输入端口的 hold 路径**, 唯一的杠杆是那个输入延时数值。
    // 所以该项只能由集成方以真实板级 I/O 时序判定, 核内改不动。
    //
    // 结论: 不做这个寄存 —— 它换不来 hold 收敛, 却要付出"复位晚一拍"的行为契约
    // 变更。详见 docs/limitations.md 第 5 条与 var/gates/pg/<uid>/hold-closure.json。
    //==========================================================================

    //==========================================================================
    // round-half-away-from-zero(acc / 2^15) + 对称饱和 ±32767
    // 与 golden 一致: round(y*2^14), clip ±max_q (rrc_pulse_shaping.m L41-42)
    //
    // 原为单个组合 function, 内含 取模(38b) -> 舍入加(38b) -> 饱和比较(38b) ->
    // 还原符号(16b) 四条串联进位链, 实测 19 逻辑级 / 15 个 CARRY4 / 4.56ns,
    // 是分级加法树之后的新瓶颈。现拆成两半, 由两级寄存分担 (见下方级5/级6):
    //   前半 round_mag: 取模 + 舍入加 + 右移
    //   后半 sat_sign : 饱和 + 还原符号
    // 两半合起来与原 function 语义完全相同, 输出逐位不变。
    //==========================================================================
    function automatic acc_t round_mag(input acc_t acc);
        acc_t mag;
        mag = (acc < 0) ? -acc : acc;
        round_mag = (mag + acc_t'(1 <<< 14)) >>> 15;
    endfunction

    function automatic data_t sat_sign(input acc_t q_in, input logic neg);
        acc_t q;
        q = (q_in > acc_t'(32767)) ? acc_t'(32767) : q_in;
        sat_sign = neg ? data_t'(-q) : data_t'(q);
    endfunction

    //==========================================================================
    // 输入符号缓存 (9 深: 相0 需 9 抽头)
    //==========================================================================
    data_t sym_buf_i[0:TAPS_PP-1];
    data_t sym_buf_q[0:TAPS_PP-1];
    //==========================================================================
    // AXI4-Stream 流控 (0.4.0 新增)
    //
    // 0.3.0 之前: s_axis_tready 恒 1 且 m_axis_tready 完全不参与节流 —— 该核
    // 对两侧都不做流控, 集成方必须自行保证"输入间隔 >= 4 拍且下游无条件收下
    // 4x 采样率输出", 这使 G-C-05 的背压子结果无法通过, 也不符合 AXI 语义。
    //
    // 现在:
    //   入口 — 仅在空闲(上一符号的 4 个相位算完)且未被下游堵住时接收;
    //   出口 — 下游未就绪且当前输出有效时, 用 w_en 冻结整条数据通路,
    //          数据与 tvalid 保持不变直到被接收 (AXI 要求 valid 不得撤回)。
    //==========================================================================
    logic [2:0] r_slots;          // 剩余计算槽 (声明前置: 入口 ready 依赖它)
    logic       w_stall, w_en;
    logic       w_accept;

    assign w_stall       = m_axis_tvalid && !m_axis_tready;
    assign w_en          = !w_stall;
    assign s_axis_tready = (r_slots == '0) && w_en;
    assign w_accept      = s_axis_tvalid && s_axis_tready;

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int i = 0; i < TAPS_PP; i++) begin
                sym_buf_i[i] <= '0;
                sym_buf_q[i] <= '0;
            end
        end else if (w_accept) begin
            for (int i = TAPS_PP-1; i > 0; i--) begin
                sym_buf_i[i] <= sym_buf_i[i-1];
                sym_buf_q[i] <= sym_buf_q[i-1];
            end
            sym_buf_i[0] <= data_t'(s_axis_tdata[DATA_W-1:0]);
            sym_buf_q[0] <= data_t'(s_axis_tdata[DATA_W*2-1:DATA_W]);
        end
    end

    //==========================================================================
    // 相位调度: 接收后调度 4 个计算槽 (缓存移位后逐相计算, 停止即静默)
    //==========================================================================
    logic [$clog2(SPS)-1:0] r_phase;
    logic                   w_slot_go;
    assign w_slot_go = (r_slots != 0);

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_slots <= '0;
            r_phase <= '0;
        end else if (w_accept) begin
            r_slots <= 3'd4;           // 下一拍起计算相 0..3
            r_phase <= '0;
        end else if (w_en && w_slot_go) begin
            r_slots <= r_slots - 3'd1;
            r_phase <= r_phase + 1'b1;
        end
    end

    //==========================================================================
    // MAC 流水 — 级1: 9 乘积寄存; 级2/3/4: 寄存加法树 9->5->3->1; 级5: 舍入/饱和
    //
    // 为何分级: 9 项 38-bit 写成单拍连加时, 综合器把它映射成 7 级 DSP48 PCOUT
    // 级联(实测组合路径 ~11ns), 在 4ns 约束下 WNS = -6.211ns, 实际 fmax 仅 ~98MHz。
    // 分级后每级组合深度 <= 2 个加法器。
    // 数值等价: ACC_W=38 足以容纳 9 项 16x16 乘积之和且无截断, 重新结合律不改变
    // 结果, 输出与分级前逐位相同 —— 时序修复不以数值一致性为代价。
    //==========================================================================
    acc_t mac_i [TAPS_PP];
    acc_t mac_q [TAPS_PP];
    acc_t addA_i [5], addA_q [5];   // 级2: 9 -> 5
    acc_t addB_i [3], addB_q [3];   // 级3: 5 -> 3
    acc_t sum_i, sum_q;             // 级4: 3 -> 1
    acc_t r_mag_i, r_mag_q;         // 级5: |acc| 舍入后的幅值
    logic r_neg_i, r_neg_q;         // 级5: 随幅值同行的符号
    data_t ro_i, ro_q;              // 级6: 饱和 + 还原符号

    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k < TAPS_PP; k++) begin
                mac_i[k] <= '0;
                mac_q[k] <= '0;
            end
        end else if (w_en && w_slot_go) begin
            for (int k = 0; k < TAPS_PP; k++) begin
                mac_i[k] <= acc_t'(sym_buf_i[k]) * acc_t'(H[r_phase][k]);
                mac_q[k] <= acc_t'(sym_buf_q[k]) * acc_t'(H[r_phase][k]);
            end
        end
    end

    // 级2: 9 -> 5 (深度 1)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k < 5; k++) begin
                addA_i[k] <= '0;
                addA_q[k] <= '0;
            end
        end else if (w_en) begin
            addA_i[0] <= mac_i[0] + mac_i[1];
            addA_i[1] <= mac_i[2] + mac_i[3];
            addA_i[2] <= mac_i[4] + mac_i[5];
            addA_i[3] <= mac_i[6] + mac_i[7];
            addA_i[4] <= mac_i[8];
            addA_q[0] <= mac_q[0] + mac_q[1];
            addA_q[1] <= mac_q[2] + mac_q[3];
            addA_q[2] <= mac_q[4] + mac_q[5];
            addA_q[3] <= mac_q[6] + mac_q[7];
            addA_q[4] <= mac_q[8];
        end
    end

    // 级3: 5 -> 3 (深度 1)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            for (int k = 0; k < 3; k++) begin
                addB_i[k] <= '0;
                addB_q[k] <= '0;
            end
        end else if (w_en) begin
            addB_i[0] <= addA_i[0] + addA_i[1];
            addB_i[1] <= addA_i[2] + addA_i[3];
            addB_i[2] <= addA_i[4];
            addB_q[0] <= addA_q[0] + addA_q[1];
            addB_q[1] <= addA_q[2] + addA_q[3];
            addB_q[2] <= addA_q[4];
        end
    end

    // 级4: 3 -> 1 (深度 2)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            sum_i <= '0;
            sum_q <= '0;
        end else if (w_en) begin
            sum_i <= (addB_i[0] + addB_i[1]) + addB_i[2];
            sum_q <= (addB_q[0] + addB_q[1]) + addB_q[2];
        end
    end

    // 级5: 取模 + 舍入加 (记住符号, 后半用)
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            r_mag_i <= '0;
            r_mag_q <= '0;
            r_neg_i <= 1'b0;
            r_neg_q <= 1'b0;
        end else if (w_en) begin
            r_mag_i <= round_mag(sum_i);
            r_mag_q <= round_mag(sum_q);
            r_neg_i <= sum_i[ACC_W-1];
            r_neg_q <= sum_q[ACC_W-1];
        end
    end

    // 级6: 饱和 + 还原符号
    always_ff @(posedge i_clk) begin
        if (i_rst) begin
            ro_i <= '0;
            ro_q <= '0;
        end else if (w_en) begin
            ro_i <= sat_sign(r_mag_i, r_neg_i);
            ro_q <= sat_sign(r_mag_q, r_neg_q);
        end
    end

    //==========================================================================
    // 输出 valid: 计算槽标志沿数据流水对齐延迟 6 级
    // (mac -> addA -> addB -> sum -> mag -> ro)
    //==========================================================================
    logic [5:0] r_vpipe;

    always_ff @(posedge i_clk) begin
        if (i_rst)
            r_vpipe <= '0;
        else if (w_en)
            r_vpipe <= {r_vpipe[4:0], w_slot_go};
    end

    assign m_axis_tdata  = {ro_q, ro_i};
    assign m_axis_tvalid = r_vpipe[5];

endmodule : rrc_polyphase_fir
