// ⛔ SUPERSEDED (2026-07-27): 修复前旧版, 无 o_msg_addr/o_conn_count 侧。
// 权威版本: engineering-assets/incubator/intake/ldpc_codec/ (bit-true 0 失配)。
// 禁止引用/复制/例化; 详见 ../_SUPERSEDED.md。仅作历史对照保留。
//-----------------------------------------------------------------
//                    H Matrix Address Generator
//-----------------------------------------------------------------
// 功能描述: QC-LDPC H 矩阵地址生成器
//   存储 P 矩阵 (12×24×5 bit ROM)，实时生成展开后 H 矩阵的列地址
//
// 展开规则:
//   对 expanded row r, 其所属 block row b = r / Z, 块内偏移 o = r mod Z
//   对 P(b, j) != -1: col_addr = j*Z + mod(o - P(b,j), Z)
//
// 输入:
//   i_cur_row  - 当前展开行号 (0~323)
//   i_cur_conn - 当前连接索引 (0~row_wt-1)
// 输出:
//   o_col_addr - 对应 H 矩阵列地址 (0~647)
//   o_shift    - 循环移位值
//   o_conn_count - 当前行连接数
//-----------------------------------------------------------------
// 主要逻辑:
//   1. ROM 存储 P 矩阵 (12×24=288 entries × 5 bits)
//   2. 行开始: 扫描 P block row, 记录所有非 -1 列
//   3. 每个连接: 计算展开后的列地址
//-----------------------------------------------------------------

module h_matrix_addr #(
    parameter P_Z                = 27,
    parameter P_MB               = 12,
    parameter P_NB               = 24,
    parameter P_MAX_ROW_WT       = 8,
    parameter P_ROW_ADDR_W       = 9,
    parameter P_COL_ADDR_W       = 10,
    parameter P_SHIFT_W          = 5,
    parameter P_CONN_CNT_W       = 4
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
        r_p_rom[176]=5'd6;  r_p_rom[186]=5'd0;  r_p_rom[187]=5'd0;
        // Row 8
        r_p_rom[192]=5'd7;  r_p_rom[193]=5'd20; r_p_rom[195]=5'd16; r_p_rom[196]=5'd22;
        r_p_rom[197]=5'd10; r_p_rom[200]=5'd23; r_p_rom[210]=5'd0;  r_p_rom[211]=5'd0;
        // Row 9
        r_p_rom[216]=5'd11; r_p_rom[220]=5'd19; r_p_rom[224]=5'd13; r_p_rom[226]=5'd3;
        r_p_rom[227]=5'd17; r_p_rom[235]=5'd0;  r_p_rom[236]=5'd0;
        // Row 10
        r_p_rom[240]=5'd25; r_p_rom[242]=5'd8;  r_p_rom[244]=5'd23; r_p_rom[245]=5'd18;
        r_p_rom[247]=5'd14; r_p_rom[248]=5'd9;  r_p_rom[260]=5'd0;  r_p_rom[261]=5'd0;
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

    integer br, bc, ci;
    initial begin
        ci = 0;
        for (br = 0; br < P_MB; br = br + 1) begin
            ci = 0;
            for (bc = 0; bc < P_NB; bc = bc + 1) begin
                if (r_p_rom[br * P_NB + bc] != 5'd31) begin
                    r_conn_col [br][ci] = bc;
                    r_conn_shft[br][ci] = r_p_rom[br * P_NB + bc];
                    ci = ci + 1;
                end
            end
            r_conn_cnt[br] = ci;
        end
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

    // Stage 2: 展开列地址
    // col_addr = j * Z + mod(offset - shift, Z)
    wire [P_SHIFT_W-1:0]    w_shift_val;
    wire signed [P_SHIFT_W:0] w_diff;
    wire [P_SHIFT_W-1:0]    w_mod_result;

    assign w_shift_val  = r_conn_shft[w_block_row][ri_conn];
    assign w_diff       = {1'b0, w_block_off} - {1'b0, w_shift_val};
    assign w_mod_result = (w_diff >= 0) ? w_diff[P_SHIFT_W-1:0] :
                                          (w_diff[P_SHIFT_W-1:0] + P_Z[P_SHIFT_W-1:0]);

    // 输出寄存器
    reg [P_COL_ADDR_W-1:0]     ro_col_addr;
    reg [P_SHIFT_W-1:0]        ro_shift;
    reg [P_CONN_CNT_W-1:0]     ro_conn_count;
    reg                         ro_valid;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            ro_col_addr   <= 'd0;
            ro_shift      <= 'd0;
            ro_conn_count <= 'd0;
            ro_valid      <= 1'b0;
        end else begin
            ro_col_addr   <= w_block_col * P_Z + w_mod_result;
            ro_shift      <= w_shift_val;
            ro_conn_count <= w_conn_count;
            ro_valid      <= ri_en;
        end
    end

    assign o_col_addr   = ro_col_addr;
    assign o_shift      = ro_shift;
    assign o_conn_count = ro_conn_count;
    assign o_valid      = ro_valid;

endmodule
