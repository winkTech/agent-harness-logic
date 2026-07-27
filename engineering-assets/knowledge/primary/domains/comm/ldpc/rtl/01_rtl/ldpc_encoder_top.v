// ⛔ SUPERSEDED (2026-07-27): 旧版副本。权威版本:
// engineering-assets/incubator/intake/ldpc_codec/ 。
// 禁止引用/复制/例化; 详见 ../_SUPERSEDED.md。仅作历史对照保留。
//-----------------------------------------------------------------
//               QC-LDPC Encoder Top (802.11n R=1/2 N=648)
//-----------------------------------------------------------------
// 功能描述: 802.11n QC-LDPC 编码器 — 双对角结构 (Dual-Diagonal)
//
// 算法 (三遍):
//   Phase 1: 加载 K=324 信息位, 存储于 info_blocks[0..11] (Z=27/block)
//   Phase 2: 逐 block row 计算 λ_i = Σ shift(info_j, P(i,j))
//            → 双对角回代: p_0 = rot_r(Σλ_i,1)
//              p_1 = rot_l(p_0, P(0,12)) + λ_0
//              p_i = p_{i-1} + λ_{i-1} (i=2..11)
//   Phase 3: 输出码字 [信息位 | 校验位], N=648 bits
//
// 接口: AXI4-Stream (1 bit/cycle)
// 延迟: 324 + 12×8 + 12 + 648 ≈ 1080 cycles @ 100MHz → 10.8μs
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
    localparam N    = 648;
    localparam K    = 324;
    localparam M    = 324;
    localparam Z    = 27;
    localparam MB   = 12;
    localparam NB   = 24;
    localparam MAX_WT = 8;
    localparam SHIFT_W = 5;
    localparam BIT_W = 10;

    //=================================================================
    // P 矩阵 ROM (12×24, -1=31, 有效 0..26)
    //=================================================================
    reg [4:0] p_rom [0:MB*NB-1];
    integer i;
    initial begin
        for (i = 0; i < MB*NB; i = i + 1) p_rom[i] = 5'd31;
        p_rom[  0]=5'd0;  p_rom[  4]=5'd0;  p_rom[  5]=5'd0;  p_rom[  8]=5'd0;
        p_rom[ 11]=5'd0;  p_rom[ 12]=5'd1;  p_rom[ 13]=5'd0;
        p_rom[ 24]=5'd22; p_rom[ 25]=5'd0;  p_rom[ 28]=5'd17; p_rom[ 30]=5'd0;
        p_rom[ 31]=5'd0;  p_rom[ 32]=5'd12; p_rom[ 37]=5'd0;  p_rom[ 38]=5'd0;
        p_rom[ 48]=5'd6;  p_rom[ 50]=5'd0;  p_rom[ 52]=5'd10; p_rom[ 56]=5'd24;
        p_rom[ 58]=5'd0;  p_rom[ 62]=5'd0;  p_rom[ 63]=5'd0;
        p_rom[ 72]=5'd2;  p_rom[ 75]=5'd0;  p_rom[ 76]=5'd20; p_rom[ 80]=5'd25;
        p_rom[ 81]=5'd0;  p_rom[ 87]=5'd0;  p_rom[ 88]=5'd0;
        p_rom[ 96]=5'd23; p_rom[100]=5'd3;  p_rom[104]=5'd0;  p_rom[106]=5'd9;
        p_rom[107]=5'd11; p_rom[112]=5'd0;  p_rom[113]=5'd0;
        p_rom[120]=5'd24; p_rom[122]=5'd23; p_rom[123]=5'd1;  p_rom[124]=5'd17;
        p_rom[126]=5'd3;  p_rom[128]=5'd10; p_rom[137]=5'd0;  p_rom[138]=5'd0;
        p_rom[144]=5'd25; p_rom[148]=5'd8;  p_rom[152]=5'd7;  p_rom[153]=5'd18;
        p_rom[156]=5'd0;  p_rom[162]=5'd0;  p_rom[163]=5'd0;
        p_rom[168]=5'd13; p_rom[169]=5'd24; p_rom[172]=5'd0;  p_rom[174]=5'd8;
        p_rom[176]=5'd6;  p_rom[186]=5'd0;  p_rom[187]=5'd0;
        p_rom[192]=5'd7;  p_rom[193]=5'd20; p_rom[195]=5'd16; p_rom[196]=5'd22;
        p_rom[197]=5'd10; p_rom[200]=5'd23; p_rom[210]=5'd0;  p_rom[211]=5'd0;
        p_rom[216]=5'd11; p_rom[220]=5'd19; p_rom[224]=5'd13; p_rom[226]=5'd3;
        p_rom[227]=5'd17; p_rom[235]=5'd0;  p_rom[236]=5'd0;
        p_rom[240]=5'd25; p_rom[242]=5'd8;  p_rom[244]=5'd23; p_rom[245]=5'd18;
        p_rom[247]=5'd14; p_rom[248]=5'd9;  p_rom[260]=5'd0;  p_rom[261]=5'd0;
        p_rom[264]=5'd3;  p_rom[268]=5'd16; p_rom[271]=5'd2;  p_rom[272]=5'd25;
        p_rom[273]=5'd5;  p_rom[276]=5'd1;  p_rom[287]=5'd0;
    end

    // 系统部分连接表: [block_row][conn_idx] → {col, shift}
    localparam K_BLKS = K / Z;
    reg [5:0]           sys_col [0:MB-1][0:MAX_WT-1];
    reg [4:0]           sys_shf [0:MB-1][0:MAX_WT-1];
    reg [3:0]           sys_cnt [0:MB-1];

    integer br, bc, ci;
    initial begin
        for (br = 0; br < MB; br = br + 1) begin
            ci = 0;
            for (bc = 0; bc < K_BLKS; bc = bc + 1) begin
                if (p_rom[br * NB + bc] != 5'd31) begin
                    sys_col[br][ci] = bc;
                    sys_shf[br][ci] = p_rom[br * NB + bc];
                    ci = ci + 1;
                end
            end
            sys_cnt[br] = ci;
        end
    end

    //=================================================================
    // 循环移位器 (barrel shifter, Z=27)
    //=================================================================
    function [Z-1:0] rot_left;
        input [Z-1:0] d;
        input [4:0] s;
        reg [2*Z-1:0] t;
    begin
        t = {d, d};
        rot_left = t[s % 32 +: Z];
    end
    endfunction

    function [Z-1:0] rot_right;
        input [Z-1:0] d;
        input [4:0] s;
        reg [2*Z-1:0] t;
    begin
        t = {d, d};
        rot_right = t[(Z - (s % Z)) % 32 +: Z];
    end
    endfunction

    //=================================================================
    // 状态机
    //=================================================================
    localparam S_IDLE   = 0,
               S_LOAD   = 1,
               S_LAMBDA = 2,
               S_PARITY = 3,
               S_OUTPUT = 4;

    reg [2:0] state, nxt;
    reg [9:0] bit_cnt;      // 0..647
    reg [3:0] blk;          // 0..11
    reg [3:0] conn;         // 0..7

    reg [Z-1:0] info  [0:K_BLKS-1];   // 信息位 blocks
    reg [Z-1:0] par   [0:MB-1];       // 校验位 blocks
    reg [Z-1:0] lambda[0:MB-1];       // λ_i 累加

    reg ro_data, ro_valid;

    //-----------------------------------------------------------------
    // 状态寄存器
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) state <= S_IDLE;
        else           state <= nxt;
    end

    always @(*) begin
        nxt = state;
        case (state)
            S_IDLE:   if (s_axis_info_tvalid)        nxt = S_LOAD;
            S_LOAD:   if (bit_cnt == K-1)             nxt = S_LAMBDA;
            S_LAMBDA: if (blk == MB-1 && conn == MAX_WT) nxt = S_PARITY;
            S_PARITY: if (blk == MB-1)                nxt = S_OUTPUT;
            S_OUTPUT: if (bit_cnt == N-1)             nxt = S_IDLE;
        endcase
    end

    //-----------------------------------------------------------------
    // 计数器
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            bit_cnt <= 0;
            blk     <= 0;
            conn    <= 0;
        end else begin
            case (state)
                S_LOAD: begin
                    if (s_axis_info_tvalid)
                        bit_cnt <= (bit_cnt == K-1) ? 0 : bit_cnt + 1;
                end
                S_LAMBDA: begin
                    if (conn == MAX_WT) begin
                        conn <= 0;
                        blk  <= (blk == MB-1) ? 0 : blk + 1;
                    end else begin
                        conn <= conn + 1;
                    end
                end
                S_PARITY: begin
                    blk <= (blk == MB-1) ? 0 : blk + 1;
                end
                S_OUTPUT: begin
                    if (m_axis_code_tready || !ro_valid)
                        bit_cnt <= (bit_cnt == N-1) ? 0 : bit_cnt + 1;
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
            for (i = 0; i < K_BLKS; i = i + 1) info[i] <= 0;
        end else if (state == S_LOAD && s_axis_info_tvalid) begin
            info[bit_cnt / Z][bit_cnt % Z] <= s_axis_info_tdata;
        end
    end

    //-----------------------------------------------------------------
    // Phase 2a: 计算 λ_i = Σ shift(info_j, P(i,j))
    //   每个周期处理一个连接, MAX_WT=8 个周期/block row
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            for (i = 0; i < MB; i = i + 1) lambda[i] <= 0;
        end else if (state == S_LAMBDA) begin
            if (conn < sys_cnt[blk]) begin
                lambda[blk] <= lambda[blk] ^
                    rot_left(info[sys_col[blk][conn]], sys_shf[blk][conn]);
            end
        end else if (state == S_PARITY) begin
            // Phase 2b 开始后清空 λ (使用完毕)
            for (i = 0; i < MB; i = i + 1) lambda[i] <= 0;
        end
    end

    //-----------------------------------------------------------------
    // Phase 2b: 双对角回代 (Σλ 在组合逻辑中计算)
    //   p_0 = rot_r(Σλ_i, 1)
    //   p_1 = rot_l(p_0, P(0,12)) + λ_0
    //   p_i = p_{i-1} + λ_{i-1}, i=2..11
    //-----------------------------------------------------------------
    wire [Z-1:0] w_lam_sum;
    reg  [Z-1:0] r_lam_sum;
    always @(*) begin
        r_lam_sum = 0;
        for (i = 0; i < MB; i = i + 1) r_lam_sum = r_lam_sum ^ lambda[i];
    end

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            for (i = 0; i < MB; i = i + 1) par[i] <= 0;
        end else if (state == S_PARITY) begin
            // blk 从 0 递增到 11
            if (blk == 0) begin
                par[0] <= rot_right(r_lam_sum, 1);
            end else if (blk == 1) begin
                par[1] <= rot_left(par[0], p_rom[12]) ^ lambda[0];
            end else if (blk <= 11) begin
                par[blk] <= par[blk-1] ^ lambda[blk-1];
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
        end else if (state == S_OUTPUT) begin
            if (m_axis_code_tready || !ro_valid) begin
                if (bit_cnt < K) begin
                    ro_data <= info[bit_cnt / Z][bit_cnt % Z];
                end else begin
                    ro_data <= par[(bit_cnt - K) / Z][(bit_cnt - K) % Z];
                end
                ro_valid <= 1;
            end
        end else begin
            ro_valid <= 0;
        end
    end

    //-----------------------------------------------------------------
    // 端口赋值
    //-----------------------------------------------------------------
    assign s_axis_info_tready = (state == S_IDLE) || (state == S_LOAD);
    assign m_axis_code_tdata  = ro_data;
    assign m_axis_code_tvalid = ro_valid;

endmodule
