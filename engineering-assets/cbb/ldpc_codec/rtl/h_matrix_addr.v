//-----------------------------------------------------------------
//                    H Matrix Address Generator
//-----------------------------------------------------------------
// 功能描述: QC-LDPC H 矩阵地址生成器
//   存储 P 矩阵 (12×24×5 bit ROM)，实时生成展开后 H 矩阵的列地址
//
// 展开规则:
//   对 expanded row r, 其所属 block row b = r / Z, 块内偏移 o = r mod Z
//   对 P(b, j) != -1: col_addr = j*Z + mod(o + P(b,j), Z)
//   (+P 而非 -P: 与 golden 的 ldpcQuasiCyclicMatrix 同向, 见 Stage 2 注释)
//
// 输入: i_cur_row (0~323) / i_cur_conn (0~row_wt-1) / i_en
// 输出: o_col_addr (0~647) / o_shift / o_conn_count / o_msg_addr / o_valid
//   两级流水: 输入寄存 -> 查表 -> 输出寄存, 故比 i_en 晚 2 拍。
//-----------------------------------------------------------------

module h_matrix_addr #(
    parameter P_Z                = 27,
    parameter P_MB               = 12,
    parameter P_NB               = 24,
    parameter P_MAX_ROW_WT       = 8,
    parameter P_ROW_ADDR_W       = 9,
    parameter P_COL_ADDR_W       = 10,
    parameter P_SHIFT_W          = 5,
    parameter P_CONN_CNT_W       = 4,
    parameter P_MSG_ADDR_W       = 12   // msg_buffer 深度 2376 -> 12 bit
)(
    // 时钟和复位
    input  wire                             i_clk_sys,
    input  wire                             i_rst_sys,

    // 控制输入
    input  wire [P_ROW_ADDR_W-1:0]          i_cur_row,
    input  wire [P_CONN_CNT_W-1:0]          i_cur_conn,
    input  wire                             i_en,

    // 输出
    output wire [P_COL_ADDR_W-1:0]          o_col_addr,
    output wire [P_SHIFT_W-1:0]             o_shift,
    output wire [P_CONN_CNT_W-1:0]          o_conn_count,
    // msg_buffer 地址 = row_base[row]+conn (msg_buffer.v 契约); 与 o_col_addr
    // 同级寄存。原 decoder 自拼 {row,conn} 方案不符且越界, 见 ARCHITECTURE-GAP.md
    output wire [P_MSG_ADDR_W-1:0]          o_msg_addr,
    output wire                             o_valid
);

    //-----------------------------------------------------------------
    // P 矩阵 ROM (12×24, 值 ∈ {-1, 0..26})
    // 存储为 288 条目的查找表
    //-----------------------------------------------------------------
    localparam P_ROM_DEPTH = P_MB * P_NB;
    localparam P_ROM_W     = 5;

    // P_ROM(i,j) = P 矩阵值, -1 编码为 5'b11111
    reg [P_ROM_W-1:0] r_p_rom [0:P_ROM_DEPTH-1];

    // 初始化 P 矩阵 (802.11n R=1/2, Z=27)
    // -1 = 5'd31, 有效值 0..26
    integer init_i;
    initial begin
        for (init_i = 0; init_i < P_ROM_DEPTH; init_i = init_i + 1)
            r_p_rom[init_i] = 5'd31;
        // Row 0
        r_p_rom[  0]=5'd0;                         r_p_rom[  4]=5'd0;  r_p_rom[  5]=5'd0;
        r_p_rom[  8]=5'd0;  r_p_rom[ 11]=5'd0;  r_p_rom[ 12]=5'd1;  r_p_rom[ 13]=5'd0;
        // Row 1
        r_p_rom[ 24]=5'd22; r_p_rom[ 25]=5'd0;  r_p_rom[ 28]=5'd17; r_p_rom[ 30]=5'd0;
        r_p_rom[ 31]=5'd0;  r_p_rom[ 32]=5'd12; r_p_rom[ 37]=5'd0;  r_p_rom[ 38]=5'd0;
        // Row 2
        r_p_rom[ 48]=5'd6;  r_p_rom[ 50]=5'd0;  r_p_rom[ 52]=5'd10; r_p_rom[ 56]=5'd24;
        r_p_rom[ 58]=5'd0;  r_p_rom[ 62]=5'd0;  r_p_rom[ 63]=5'd0;
        // Row 3
        r_p_rom[ 72]=5'd2;  r_p_rom[ 75]=5'd0;  r_p_rom[ 76]=5'd20; r_p_rom[ 80]=5'd25;
        r_p_rom[ 81]=5'd0;  r_p_rom[ 87]=5'd0;  r_p_rom[ 88]=5'd0;
        // Row 4
        r_p_rom[ 96]=5'd23; r_p_rom[100]=5'd3;  r_p_rom[104]=5'd0;  r_p_rom[106]=5'd9;
        r_p_rom[107]=5'd11; r_p_rom[112]=5'd0;  r_p_rom[113]=5'd0;
        // Row 5
        r_p_rom[120]=5'd24; r_p_rom[122]=5'd23; r_p_rom[123]=5'd1;  r_p_rom[124]=5'd17;
        r_p_rom[126]=5'd3;  r_p_rom[128]=5'd10; r_p_rom[137]=5'd0;  r_p_rom[138]=5'd0;
        // Row 6
        r_p_rom[144]=5'd25; r_p_rom[148]=5'd8;  r_p_rom[152]=5'd7;  r_p_rom[153]=5'd18;
        r_p_rom[156]=5'd0;  r_p_rom[162]=5'd0;  r_p_rom[163]=5'd0;
        // Row 7
        r_p_rom[168]=5'd13; r_p_rom[169]=5'd24; r_p_rom[172]=5'd0;  r_p_rom[174]=5'd8;
        // 块行 7~10 的双对角校验列原先未随块行递进(差 1~2 列), 已按 cfg.P 校正;
        // tools/check-ldpc-h-matrix.cjs 逐元素守住与参考模型的一致性。
        r_p_rom[176]=5'd6;  r_p_rom[187]=5'd0;  r_p_rom[188]=5'd0;
        // Row 8
        r_p_rom[192]=5'd7;  r_p_rom[193]=5'd20; r_p_rom[195]=5'd16; r_p_rom[196]=5'd22;
        r_p_rom[197]=5'd10; r_p_rom[200]=5'd23; r_p_rom[212]=5'd0;  r_p_rom[213]=5'd0;
        // Row 9
        r_p_rom[216]=5'd11; r_p_rom[220]=5'd19; r_p_rom[224]=5'd13; r_p_rom[226]=5'd3;
        r_p_rom[227]=5'd17; r_p_rom[237]=5'd0;  r_p_rom[238]=5'd0;
        // Row 10
        r_p_rom[240]=5'd25; r_p_rom[242]=5'd8;  r_p_rom[244]=5'd23; r_p_rom[245]=5'd18;
        r_p_rom[247]=5'd14; r_p_rom[248]=5'd9;  r_p_rom[262]=5'd0;  r_p_rom[263]=5'd0;
        // Row 11
        r_p_rom[264]=5'd3;  r_p_rom[268]=5'd16; r_p_rom[271]=5'd2;  r_p_rom[272]=5'd25;
        r_p_rom[273]=5'd5;  r_p_rom[276]=5'd1;  r_p_rom[287]=5'd0;
    end

    localparam P_M_LOC             = 324;

    //-----------------------------------------------------------------
    // 展开行 → block_row/block_off 查找表 (替代不可综合的 / 和 %)
    //-----------------------------------------------------------------
    // Z=27 非 2 的幂，传统除法不可综合。使用 LUT 预计算：
    //   block_row = row / 27,  block_off = row % 27
    reg [3:0]              r_block_row_lut [0:P_M_LOC-1];
    reg [P_SHIFT_W-1:0]    r_block_off_lut [0:P_M_LOC-1];

    integer ri;
    initial begin
        for (ri = 0; ri < P_M_LOC; ri = ri + 1) begin
            r_block_row_lut[ri] = ri / P_Z;
            r_block_off_lut[ri] = ri % P_Z;
        end
    end

    //-----------------------------------------------------------------
    // 连接索引表 (替代运行时 24 选 1 组合扫描)
    // 预计算每 block row 的第 conn_idx 个有效连接的 column 和 shift
    //-----------------------------------------------------------------
    reg [5:0]              r_conn_col  [0:P_MB-1][0:P_MAX_ROW_WT-1];
    reg [P_SHIFT_W-1:0]    r_conn_shft [0:P_MB-1][0:P_MAX_ROW_WT-1];
    reg [P_CONN_CNT_W-1:0] r_conn_cnt  [0:P_MB-1];
    reg [P_MSG_ADDR_W-1:0] r_blk_base  [0:P_MB-1];   // 块行在 msg_buffer 中的起始地址

    // 原实现在此用 `if (r_p_rom[...] != 5'd31)` 扫描构建三张表。该条件依赖 reg
    // 数组内容, Vivado 判为非常量条件并报 [Synth 8-6896] **丢弃整个 initial 块**:
    // 仿真里表有值, 综合后三张表无驱动源 ([Synth 8-3848]), 上板行为与仿真不一致。
    // 现改为纯常量赋值 —— 与上方 r_p_rom 相同的写法, 该写法已被同一综合器正确推断。
    // 常量由 tools/gen-ldpc-conn-tables.cjs 从本文件的 r_p_rom 解析并按原算法展开,
    // 与原实现逐条等价 (脚本内置自检)。P 矩阵变更后须重跑该脚本重新生成。
    integer br, ci;
    initial begin
        // 未用槽位清零 (常量边界循环, 可综合)
        for (br = 0; br < P_MB; br = br + 1) begin
            r_conn_cnt[br] = {P_CONN_CNT_W{1'b0}};
            for (ci = 0; ci < P_MAX_ROW_WT; ci = ci + 1) begin
                r_conn_col [br][ci] = 6'd0;
                r_conn_shft[br][ci] = {P_SHIFT_W{1'b0}};
            end
        end

        // ==== 以下由 tools/gen-ldpc-conn-tables.cjs 生成; 请勿手改 ====
        r_conn_cnt[0] = 4'd7;
        r_conn_col[0][0]=6'd0;  r_conn_shft[0][0]=5'd0;   r_conn_col[0][1]=6'd4;  r_conn_shft[0][1]=5'd0;
        r_conn_col[0][2]=6'd5;  r_conn_shft[0][2]=5'd0;   r_conn_col[0][3]=6'd8;  r_conn_shft[0][3]=5'd0;
        r_conn_col[0][4]=6'd11; r_conn_shft[0][4]=5'd0;   r_conn_col[0][5]=6'd12; r_conn_shft[0][5]=5'd1;
        r_conn_col[0][6]=6'd13; r_conn_shft[0][6]=5'd0;
        r_conn_cnt[1] = 4'd8;
        r_conn_col[1][0]=6'd0;  r_conn_shft[1][0]=5'd22;  r_conn_col[1][1]=6'd1;  r_conn_shft[1][1]=5'd0;
        r_conn_col[1][2]=6'd4;  r_conn_shft[1][2]=5'd17;  r_conn_col[1][3]=6'd6;  r_conn_shft[1][3]=5'd0;
        r_conn_col[1][4]=6'd7;  r_conn_shft[1][4]=5'd0;   r_conn_col[1][5]=6'd8;  r_conn_shft[1][5]=5'd12;
        r_conn_col[1][6]=6'd13; r_conn_shft[1][6]=5'd0;   r_conn_col[1][7]=6'd14; r_conn_shft[1][7]=5'd0;
        r_conn_cnt[2] = 4'd7;
        r_conn_col[2][0]=6'd0;  r_conn_shft[2][0]=5'd6;   r_conn_col[2][1]=6'd2;  r_conn_shft[2][1]=5'd0;
        r_conn_col[2][2]=6'd4;  r_conn_shft[2][2]=5'd10;  r_conn_col[2][3]=6'd8;  r_conn_shft[2][3]=5'd24;
        r_conn_col[2][4]=6'd10; r_conn_shft[2][4]=5'd0;   r_conn_col[2][5]=6'd14; r_conn_shft[2][5]=5'd0;
        r_conn_col[2][6]=6'd15; r_conn_shft[2][6]=5'd0;
        r_conn_cnt[3] = 4'd7;
        r_conn_col[3][0]=6'd0;  r_conn_shft[3][0]=5'd2;   r_conn_col[3][1]=6'd3;  r_conn_shft[3][1]=5'd0;
        r_conn_col[3][2]=6'd4;  r_conn_shft[3][2]=5'd20;  r_conn_col[3][3]=6'd8;  r_conn_shft[3][3]=5'd25;
        r_conn_col[3][4]=6'd9;  r_conn_shft[3][4]=5'd0;   r_conn_col[3][5]=6'd15; r_conn_shft[3][5]=5'd0;
        r_conn_col[3][6]=6'd16; r_conn_shft[3][6]=5'd0;
        r_conn_cnt[4] = 4'd7;
        r_conn_col[4][0]=6'd0;  r_conn_shft[4][0]=5'd23;  r_conn_col[4][1]=6'd4;  r_conn_shft[4][1]=5'd3;
        r_conn_col[4][2]=6'd8;  r_conn_shft[4][2]=5'd0;   r_conn_col[4][3]=6'd10; r_conn_shft[4][3]=5'd9;
        r_conn_col[4][4]=6'd11; r_conn_shft[4][4]=5'd11;  r_conn_col[4][5]=6'd16; r_conn_shft[4][5]=5'd0;
        r_conn_col[4][6]=6'd17; r_conn_shft[4][6]=5'd0;
        r_conn_cnt[5] = 4'd8;
        r_conn_col[5][0]=6'd0;  r_conn_shft[5][0]=5'd24;  r_conn_col[5][1]=6'd2;  r_conn_shft[5][1]=5'd23;
        r_conn_col[5][2]=6'd3;  r_conn_shft[5][2]=5'd1;   r_conn_col[5][3]=6'd4;  r_conn_shft[5][3]=5'd17;
        r_conn_col[5][4]=6'd6;  r_conn_shft[5][4]=5'd3;   r_conn_col[5][5]=6'd8;  r_conn_shft[5][5]=5'd10;
        r_conn_col[5][6]=6'd17; r_conn_shft[5][6]=5'd0;   r_conn_col[5][7]=6'd18; r_conn_shft[5][7]=5'd0;
        r_conn_cnt[6] = 4'd7;
        r_conn_col[6][0]=6'd0;  r_conn_shft[6][0]=5'd25;  r_conn_col[6][1]=6'd4;  r_conn_shft[6][1]=5'd8;
        r_conn_col[6][2]=6'd8;  r_conn_shft[6][2]=5'd7;   r_conn_col[6][3]=6'd9;  r_conn_shft[6][3]=5'd18;
        r_conn_col[6][4]=6'd12; r_conn_shft[6][4]=5'd0;   r_conn_col[6][5]=6'd18; r_conn_shft[6][5]=5'd0;
        r_conn_col[6][6]=6'd19; r_conn_shft[6][6]=5'd0;
        r_conn_cnt[7] = 4'd7;
        r_conn_col[7][0]=6'd0;  r_conn_shft[7][0]=5'd13;  r_conn_col[7][1]=6'd1;  r_conn_shft[7][1]=5'd24;
        r_conn_col[7][2]=6'd4;  r_conn_shft[7][2]=5'd0;   r_conn_col[7][3]=6'd6;  r_conn_shft[7][3]=5'd8;
        r_conn_col[7][4]=6'd8;  r_conn_shft[7][4]=5'd6;   r_conn_col[7][5]=6'd19; r_conn_shft[7][5]=5'd0;
        r_conn_col[7][6]=6'd20; r_conn_shft[7][6]=5'd0;
        r_conn_cnt[8] = 4'd8;
        r_conn_col[8][0]=6'd0;  r_conn_shft[8][0]=5'd7;   r_conn_col[8][1]=6'd1;  r_conn_shft[8][1]=5'd20;
        r_conn_col[8][2]=6'd3;  r_conn_shft[8][2]=5'd16;  r_conn_col[8][3]=6'd4;  r_conn_shft[8][3]=5'd22;
        r_conn_col[8][4]=6'd5;  r_conn_shft[8][4]=5'd10;  r_conn_col[8][5]=6'd8;  r_conn_shft[8][5]=5'd23;
        r_conn_col[8][6]=6'd20; r_conn_shft[8][6]=5'd0;   r_conn_col[8][7]=6'd21; r_conn_shft[8][7]=5'd0;
        r_conn_cnt[9] = 4'd7;
        r_conn_col[9][0]=6'd0;  r_conn_shft[9][0]=5'd11;  r_conn_col[9][1]=6'd4;  r_conn_shft[9][1]=5'd19;
        r_conn_col[9][2]=6'd8;  r_conn_shft[9][2]=5'd13;  r_conn_col[9][3]=6'd10; r_conn_shft[9][3]=5'd3;
        r_conn_col[9][4]=6'd11; r_conn_shft[9][4]=5'd17;  r_conn_col[9][5]=6'd21; r_conn_shft[9][5]=5'd0;
        r_conn_col[9][6]=6'd22; r_conn_shft[9][6]=5'd0;
        r_conn_cnt[10] = 4'd8;
        r_conn_col[10][0]=6'd0; r_conn_shft[10][0]=5'd25; r_conn_col[10][1]=6'd2; r_conn_shft[10][1]=5'd8;
        r_conn_col[10][2]=6'd4; r_conn_shft[10][2]=5'd23; r_conn_col[10][3]=6'd5; r_conn_shft[10][3]=5'd18;
        r_conn_col[10][4]=6'd7; r_conn_shft[10][4]=5'd14; r_conn_col[10][5]=6'd8; r_conn_shft[10][5]=5'd9;
        r_conn_col[10][6]=6'd22;r_conn_shft[10][6]=5'd0;  r_conn_col[10][7]=6'd23;r_conn_shft[10][7]=5'd0;
        r_conn_cnt[11] = 4'd7;
        r_conn_col[11][0]=6'd0; r_conn_shft[11][0]=5'd3;  r_conn_col[11][1]=6'd4; r_conn_shft[11][1]=5'd16;
        r_conn_col[11][2]=6'd7; r_conn_shft[11][2]=5'd2;  r_conn_col[11][3]=6'd8; r_conn_shft[11][3]=5'd25;
        r_conn_col[11][4]=6'd9; r_conn_shft[11][4]=5'd5;  r_conn_col[11][5]=6'd12;r_conn_shft[11][5]=5'd1;
        r_conn_col[11][6]=6'd23;r_conn_shft[11][6]=5'd0;

        // ---- msg_buffer 块基址 (同源生成): base[b] = sum_{b'<b} Z*cnt[b'] ----
        r_blk_base[0]=12'd0;  r_blk_base[1]=12'd189;r_blk_base[2]=12'd405;r_blk_base[3]=12'd594;
        r_blk_base[4]=12'd783;r_blk_base[5]=12'd972;r_blk_base[6]=12'd1188;r_blk_base[7]=12'd1377;
        r_blk_base[8]=12'd1566;r_blk_base[9]=12'd1782;r_blk_base[10]=12'd1971;r_blk_base[11]=12'd2187;
        // 总边数 2187+27*7 = 2376, 与 msg_buffer 的 P_H_NNZ 深度一致
    end

    //-----------------------------------------------------------------
    // 实时地址生成 (流水线: Stage 1 → reg → Stage 2)
    //-----------------------------------------------------------------
    reg [P_ROW_ADDR_W-1:0]  ri_row;
    reg [P_CONN_CNT_W-1:0]  ri_conn;
    reg                      ri_en;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ri_row  <= 'd0;
            ri_conn <= 'd0;
            ri_en   <= 1'b0;
        end else begin
            ri_row  <= i_cur_row;
            ri_conn <= i_cur_conn;
            ri_en   <= i_en;
        end
    end

    // Stage 1: 查表得到 block_row / block_off / 连接索引信息
    wire [3:0]              w_block_row;
    wire [P_SHIFT_W-1:0]    w_block_off;
    wire [P_CONN_CNT_W-1:0] w_conn_count;
    wire [5:0]              w_block_col;

    assign w_block_row  = r_block_row_lut[ri_row];
    assign w_block_off  = r_block_off_lut[ri_row];
    assign w_conn_count = r_conn_cnt[w_block_row];
    assign w_block_col  = r_conn_col[w_block_row][ri_conn];

    // Stage 2: col_addr = j*Z + mod(offset + shift, Z)
    //  +P 而非 -P: 参考模型调 ldpcQuasiCyclicMatrix, 单位阵**循环右移 P 位**。
    //  实证: 第 0 行块列 12 上 P=1 -> 参考 col 325, 原 RTL(-P) col 350。
    wire [P_SHIFT_W-1:0]    w_shift_val;
    wire [P_SHIFT_W:0]      w_sum;
    wire [P_SHIFT_W-1:0]    w_mod_result;

    assign w_shift_val  = r_conn_shft[w_block_row][ri_conn];
    assign w_sum        = {1'b0, w_block_off} + {1'b0, w_shift_val};
    assign w_mod_result = (w_sum >= P_Z) ? (w_sum[P_SHIFT_W-1:0] - P_Z[P_SHIFT_W-1:0])
                                         :  w_sum[P_SHIFT_W-1:0];

    // 输出寄存器
    // msg 地址 = 块基址 + 块内行偏移*该块行连接数 + 连接索引; 上界
    // 2187+26*7+6 = 2375 < 2376, 前提是 conn < conn_count (见 GAP 文档 G1)
    wire [P_MSG_ADDR_W-1:0] w_msg_addr;
    assign w_msg_addr = r_blk_base[w_block_row]
                      + (w_block_off * w_conn_count)
                      + ri_conn;

    reg [P_COL_ADDR_W-1:0]     ro_col_addr;
    reg [P_SHIFT_W-1:0]        ro_shift;
    reg [P_CONN_CNT_W-1:0]     ro_conn_count;
    reg [P_MSG_ADDR_W-1:0]     ro_msg_addr;
    reg                         ro_valid;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_col_addr   <= 'd0;
            ro_shift      <= 'd0;
            ro_conn_count <= 'd0;
            ro_msg_addr   <= 'd0;
            ro_valid      <= 1'b0;
        end else begin
            ro_col_addr   <= w_block_col * P_Z + w_mod_result;
            ro_shift      <= w_shift_val;
            ro_conn_count <= w_conn_count;
            ro_msg_addr   <= w_msg_addr;
            ro_valid      <= ri_en;
        end
    end

    assign o_col_addr   = ro_col_addr;
    assign o_shift      = ro_shift;
    assign o_conn_count = ro_conn_count;
    assign o_msg_addr   = ro_msg_addr;
    assign o_valid      = ro_valid;

endmodule
