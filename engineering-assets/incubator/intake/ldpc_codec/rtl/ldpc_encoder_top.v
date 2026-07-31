//-----------------------------------------------------------------
//               QC-LDPC Encoder Top (802.11n R=1/2 N=648)
//-----------------------------------------------------------------
// 名称: ldpc_encoder_top
// 功能: 802.11n QC-LDPC 系统编码器
//
// 算法 (与 models/comm/ldpc 的 PT_1_2_648.mat / ldpc_encode_80211n 一致):
//   parity = PT * info  (GF(2))
//   code   = [info | parity]
// 其中 PT = H_p^{-1} * H_s，预计算后按**列**存于 pt_columns.hex。
//
// 为何不用双对角回代: 本包旧实现的双对角回代对随机信息位 syndrome ≠ 0
// (H*c ≠ 0)，与 MATLAB/WLAN golden 不一致。权威编码见
// knowledge/.../ldpc/encoding_spec.md §7.3。
//
// 时序:
//   S_LOAD  : 收 K=324 信息位
//   S_ACCUM : 324 拍，info[j]==1 时 parity ^= PT(:,j)
//   S_OUTPUT: 送出 N=648 码字
//
// PT ROM: +PT_MEM=<path/to/pt_columns.hex>
//   文件 324 行，每行 324 个 '0'/'1' 字符，MSB(bit323) 在左。
//   权威副本: models/comm/ldpc/vectors/pt_columns.hex
//   包内镜像: rtl/pt_columns.hex (与权威同内容，供综合/离线)
//
// 接口: AXI4-Stream 1 bit/cycle; 同步高有效 i_rst_sys
// 遗留 D1: 输入未做 ri_ 寄存 (与加载计数耦合，golden 闭环后再做)
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

    localparam P_N = 648;
    localparam P_K = 324;
    localparam P_M = 324;

    localparam P_S_IDLE   = 3'd0;
    localparam P_S_LOAD   = 3'd1;
    localparam P_S_ACCUM  = 3'd2;
    localparam P_S_OUTPUT = 3'd3;

    reg [2:0]  r_state, w_nxt;
    reg [9:0]  r_bit_cnt;              // 0..647
    reg [8:0]  r_acc_idx;              // 0..323 during ACCUM

    reg        r_info   [0:P_K-1];
    reg        r_parity [0:P_M-1];

    // PT columns: pt_rom[j][i] = PT(i,j), vector [323:0] with bit0 = PT(0,j)
    // 仅存储器阵列上电初值 — 符合 G-C-03 / UG901
    reg [P_M-1:0] pt_rom [0:P_K-1];

    reg ro_data, ro_valid, ro_tready;

    integer i;

    //-----------------------------------------------------------------
    // PT ROM 上电初值: 文件与本模块同目录 rtl/pt_columns.hex
    // 仿真时请将 work 目录设为含该文件的路径, 或 vlog 前 copy 到 CWD。
    // 使用 begin/end 单任务块, 避免门禁扫描吞并后续 always (单行分号解析陷阱)
    //-----------------------------------------------------------------
    initial begin
        $readmemb("pt_columns.hex", pt_rom);
    end

    //-----------------------------------------------------------------
    // 状态机
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) r_state <= P_S_IDLE;
        else           r_state <= w_nxt;
    end

    always @(*) begin
        w_nxt = r_state;
        case (r_state)
            P_S_IDLE:   if (s_axis_info_tvalid)            w_nxt = P_S_LOAD;
            P_S_LOAD:   if (r_bit_cnt == P_K-1 &&
                            s_axis_info_tvalid && ro_tready)
                                                       w_nxt = P_S_ACCUM;
            P_S_ACCUM:  if (r_acc_idx == P_K-1)            w_nxt = P_S_OUTPUT;
            P_S_OUTPUT: if (r_bit_cnt == P_N-1 &&
                            (m_axis_code_tready || !ro_valid))
                                                       w_nxt = P_S_IDLE;
            default:                                       w_nxt = P_S_IDLE;
        endcase
    end

    //-----------------------------------------------------------------
    // 计数
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_bit_cnt <= 10'd0;
            r_acc_idx <= 9'd0;
        end else begin
            case (r_state)
                P_S_LOAD: begin
                    if (s_axis_info_tvalid && ro_tready)
                        r_bit_cnt <= (r_bit_cnt == P_K-1) ? 10'd0 : (r_bit_cnt + 10'd1);
                end
                P_S_ACCUM: begin
                    r_acc_idx <= (r_acc_idx == P_K-1) ? 9'd0 : (r_acc_idx + 9'd1);
                end
                P_S_OUTPUT: begin
                    if (m_axis_code_tready || !ro_valid)
                        r_bit_cnt <= (r_bit_cnt == P_N-1) ? 10'd0 : (r_bit_cnt + 10'd1);
                end
                P_S_IDLE: begin
                    r_bit_cnt <= 10'd0;
                    r_acc_idx <= 9'd0;
                end
                default: ;
            endcase
        end
    end

    //-----------------------------------------------------------------
    // Phase 1: 装载信息位
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            for (i = 0; i < P_K; i = i + 1) r_info[i] <= 1'b0;
        end else if (r_state == P_S_LOAD && s_axis_info_tvalid && ro_tready) begin
            r_info[r_bit_cnt] <= s_axis_info_tdata;
        end
    end

    //-----------------------------------------------------------------
    // Phase 2: parity ^= PT(:,j) if info[j]
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            for (i = 0; i < P_M; i = i + 1) r_parity[i] <= 1'b0;
        end else if (r_state == P_S_IDLE || r_state == P_S_LOAD) begin
            // 新帧开始前清零
            if (r_state == P_S_IDLE) begin
                for (i = 0; i < P_M; i = i + 1) r_parity[i] <= 1'b0;
            end
        end else if (r_state == P_S_ACCUM) begin
            if (r_info[r_acc_idx]) begin
                for (i = 0; i < P_M; i = i + 1)
                    r_parity[i] <= r_parity[i] ^ pt_rom[r_acc_idx][i];
            end
        end
    end

    //-----------------------------------------------------------------
    // Phase 3: 输出 [info | parity]
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_data  <= 1'b0;
            ro_valid <= 1'b0;
        end else if (r_state == P_S_OUTPUT) begin
            if (m_axis_code_tready || !ro_valid) begin
                if (r_bit_cnt < P_K)
                    ro_data <= r_info[r_bit_cnt];
                else
                    ro_data <= r_parity[r_bit_cnt - P_K];
                ro_valid <= 1'b1;
            end
        end else begin
            ro_valid <= 1'b0;
        end
    end

    //-----------------------------------------------------------------
    // ready: 仅 S_LOAD (避免 IDLE 偷握手)
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) ro_tready <= 1'b0;
        else           ro_tready <= (w_nxt == P_S_LOAD);
    end

    assign s_axis_info_tready = ro_tready;
    assign m_axis_code_tdata  = ro_data;
    assign m_axis_code_tvalid = ro_valid;

endmodule
