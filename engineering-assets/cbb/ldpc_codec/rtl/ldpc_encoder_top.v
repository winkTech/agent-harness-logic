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
// D1 (输入未寄存) 已于 1.1.0 还清，见下方"输入寄存级"注释块。
// 契约变化: 每帧 S_LOAD 晚一拍进入、tready 晚一拍拉高（不丢首位）。
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

    //-----------------------------------------------------------------
    // 输入寄存级 (红线 1 / 遗留项 D1, 2026-08-02 补)
    //
    // 此前 s_axis_info_tvalid / tdata 被直接消费: FSM 次态、r_bit_cnt、r_info 写入
    // 三处都挂在裸输入上。现按同包 ldpc_stream_io 的既有模式改造 —— payload 无条件
    // 寄存一拍, 握手成立的事实与写地址各寄一拍, 消费方一律用寄存后的三元组。
    //
    // 保留为组合的只有握手限定 w_load_accept 本身: AXI 的 ready/valid 判定必须在
    // 同一拍看到 tvalid 才能决定是否接收, 这是协议要求, 无法寄存。ldpc_stream_io
    // 的 w_load_accept 同理。红线 1 要挡的是"裸输入直接驱动数据通路/状态",
    // 不是"禁止在握手判定里读 tvalid"。
    //
    // 时序核对: 末位 (r_bit_cnt==P_K-1) 的写入因寄存而落在**进入 S_ACCUM 的那一拍**,
    // 而 S_ACCUM 的 r_acc_idx 从 0 起, 要再过 P_K-1 拍才读到 r_info[P_K-1] —— 不冲突;
    // 且写的是数组不同元素, 与同拍的 r_parity 更新互不影响。
    //
    // 帧起始 arming 也改用寄存后的 ri_info_tvalid: 代价是 S_LOAD 晚一拍进入、
    // tready 晚一拍拉高。AXI 要求 tvalid 在被接收前必须保持, 故不丢首位,
    // 只是每帧多一拍延迟 —— 已记入 CHANGELOG 的接口契约变化。
    //-----------------------------------------------------------------
    reg       ri_info_tdata;      // 输入 payload 寄存
    reg       ri_info_tvalid;     // 输入 tvalid 寄存 (仅供 IDLE 的 arming)
    reg       r_info_wr_en;       // 握手成立的寄存副本
    reg [9:0] r_info_wr_addr;     // 写地址的寄存副本

    wire w_load_accept = (r_state == P_S_LOAD) && s_axis_info_tvalid && ro_tready;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ri_info_tdata  <= 1'b0;
            ri_info_tvalid <= 1'b0;
            r_info_wr_en   <= 1'b0;
            r_info_wr_addr <= 10'd0;
        end else begin
            ri_info_tdata  <= s_axis_info_tdata;
            ri_info_tvalid <= s_axis_info_tvalid;
            r_info_wr_en   <= w_load_accept;
            r_info_wr_addr <= r_bit_cnt;
        end
    end

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
            // arming 用寄存后的 tvalid (D1); 末位判定用握手限定 w_load_accept
            P_S_IDLE:   if (ri_info_tvalid)                w_nxt = P_S_LOAD;
            P_S_LOAD:   if (r_bit_cnt == P_K-1 && w_load_accept)
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
                    if (w_load_accept)
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
        // D1: 写入用寄存后的三元组 (使能/地址/数据), 不再挂裸输入。
        // 地址来自 r_info_wr_addr 这个普通寄存器 —— 不在 NBA 左值下标里调用函数
        // (hdl 硬约束 8)。
        end else if (r_info_wr_en) begin
            r_info[r_info_wr_addr] <= ri_info_tdata;
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
