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
        // Row 0
        r_p_rom[  0]=5'd0;  r_p_rom[  1]=5'd31; r_p_rom[  2]=5'd31; r_p_rom[  3]=5'd31;
        r_p_rom[  4]=5'd0;  r_p_rom[  5]=5'd0;  r_p_rom[  6]=5'd31; r_p_rom[  7]=5'd31;
        r_p_rom[  8]=5'd0;  r_p_rom[  9]=5'd31; r_p_rom[ 10]=5'd31; r_p_rom[ 11]=5'd0;
        r_p_rom[ 12]=5'd1;  r_p_rom[ 13]=5'd0;  r_p_rom[ 14]=5'd31; r_p_rom[ 15]=5'd31;
        r_p_rom[ 16]=5'd31; r_p_rom[ 17]=5'd31; r_p_rom[ 18]=5'd31; r_p_rom[ 19]=5'd31;
        r_p_rom[ 20]=5'd31; r_p_rom[ 21]=5'd31; r_p_rom[ 22]=5'd31; r_p_rom[ 23]=5'd31;
        // Row 1
        r_p_rom[ 24]=5'd22; r_p_rom[ 25]=5'd0;  r_p_rom[ 26]=5'd31; r_p_rom[ 27]=5'd31;
        r_p_rom[ 28]=5'd17; r_p_rom[ 29]=5'd31; r_p_rom[ 30]=5'd0;  r_p_rom[ 31]=5'd0;
        r_p_rom[ 32]=5'd12; r_p_rom[ 33]=5'd31; r_p_rom[ 34]=5'd31; r_p_rom[ 35]=5'd31;
        r_p_rom[ 36]=5'd31; r_p_rom[ 37]=5'd0;  r_p_rom[ 38]=5'd0;  r_p_rom[ 39]=5'd31;
        r_p_rom[ 40]=5'd31; r_p_rom[ 41]=5'd31; r_p_rom[ 42]=5'd31; r_p_rom[ 43]=5'd31;
        r_p_rom[ 44]=5'd31; r_p_rom[ 45]=5'd31; r_p_rom[ 46]=5'd31; r_p_rom[ 47]=5'd31;
        // Row 2
        r_p_rom[ 48]=5'd6;  r_p_rom[ 49]=5'd31; r_p_rom[ 50]=5'd0;  r_p_rom[ 51]=5'd31;
        r_p_rom[ 52]=5'd10; r_p_rom[ 53]=5'd31; r_p_rom[ 54]=5'd31; r_p_rom[ 55]=5'd31;
        r_p_rom[ 56]=5'd24; r_p_rom[ 57]=5'd31; r_p_rom[ 58]=5'd0;  r_p_rom[ 59]=5'd31;
        r_p_rom[ 60]=5'd31; r_p_rom[ 61]=5'd31; r_p_rom[ 62]=5'd0;  r_p_rom[ 63]=5'd0;
        r_p_rom[ 64]=5'd31; r_p_rom[ 65]=5'd31; r_p_rom[ 66]=5'd31; r_p_rom[ 67]=5'd31;
        r_p_rom[ 68]=5'd31; r_p_rom[ 69]=5'd31; r_p_rom[ 70]=5'd31; r_p_rom[ 71]=5'd31;
        // Row 3
        r_p_rom[ 72]=5'd2;  r_p_rom[ 73]=5'd31; r_p_rom[ 74]=5'd31; r_p_rom[ 75]=5'd0;
        r_p_rom[ 76]=5'd20; r_p_rom[ 77]=5'd31; r_p_rom[ 78]=5'd31; r_p_rom[ 79]=5'd31;
        r_p_rom[ 80]=5'd25; r_p_rom[ 81]=5'd0;  r_p_rom[ 82]=5'd31; r_p_rom[ 83]=5'd31;
        r_p_rom[ 84]=5'd31; r_p_rom[ 85]=5'd31; r_p_rom[ 86]=5'd31; r_p_rom[ 87]=5'd0;
        r_p_rom[ 88]=5'd0;  r_p_rom[ 89]=5'd31; r_p_rom[ 90]=5'd31; r_p_rom[ 91]=5'd31;
        r_p_rom[ 92]=5'd31; r_p_rom[ 93]=5'd31; r_p_rom[ 94]=5'd31; r_p_rom[ 95]=5'd31;
        // Row 4
        r_p_rom[ 96]=5'd23; r_p_rom[ 97]=5'd31; r_p_rom[ 98]=5'd31; r_p_rom[ 99]=5'd31;
        r_p_rom[100]=5'd3;  r_p_rom[101]=5'd31; r_p_rom[102]=5'd31; r_p_rom[103]=5'd31;
        r_p_rom[104]=5'd0;  r_p_rom[105]=5'd31; r_p_rom[106]=5'd9;  r_p_rom[107]=5'd11;
        r_p_rom[108]=5'd31; r_p_rom[109]=5'd31; r_p_rom[110]=5'd31; r_p_rom[111]=5'd31;
        r_p_rom[112]=5'd0;  r_p_rom[113]=5'd0;  r_p_rom[114]=5'd31; r_p_rom[115]=5'd31;
        r_p_rom[116]=5'd31; r_p_rom[117]=5'd31; r_p_rom[118]=5'd31; r_p_rom[119]=5'd31;
        // Row 5
        r_p_rom[120]=5'd24; r_p_rom[121]=5'd31; r_p_rom[122]=5'd23; r_p_rom[123]=5'd1;
        r_p_rom[124]=5'd17; r_p_rom[125]=5'd31; r_p_rom[126]=5'd3;  r_p_rom[127]=5'd31;
        r_p_rom[128]=5'd10; r_p_rom[129]=5'd31; r_p_rom[130]=5'd31; r_p_rom[131]=5'd31;
        r_p_rom[132]=5'd31; r_p_rom[133]=5'd31; r_p_rom[134]=5'd31; r_p_rom[135]=5'd31;
        r_p_rom[136]=5'd31; r_p_rom[137]=5'd0;  r_p_rom[138]=5'd0;  r_p_rom[139]=5'd31;
        r_p_rom[140]=5'd31; r_p_rom[141]=5'd31; r_p_rom[142]=5'd31; r_p_rom[143]=5'd31;
        // Row 6
        r_p_rom[144]=5'd25; r_p_rom[145]=5'd31; r_p_rom[146]=5'd31; r_p_rom[147]=5'd31;
        r_p_rom[148]=5'd8;  r_p_rom[149]=5'd31; r_p_rom[150]=5'd31; r_p_rom[151]=5'd31;
        r_p_rom[152]=5'd7;  r_p_rom[153]=5'd18; r_p_rom[154]=5'd31; r_p_rom[155]=5'd31;
        r_p_rom[156]=5'd0;  r_p_rom[157]=5'd31; r_p_rom[158]=5'd31; r_p_rom[159]=5'd31;
        r_p_rom[160]=5'd31; r_p_rom[161]=5'd31; r_p_rom[162]=5'd0;  r_p_rom[163]=5'd0;
        r_p_rom[164]=5'd31; r_p_rom[165]=5'd31; r_p_rom[166]=5'd31; r_p_rom[167]=5'd31;
        // Row 7
        r_p_rom[168]=5'd13; r_p_rom[169]=5'd24; r_p_rom[170]=5'd31; r_p_rom[171]=5'd31;
        r_p_rom[172]=5'd0;  r_p_rom[173]=5'd31; r_p_rom[174]=5'd8;  r_p_rom[175]=5'd31;
        r_p_rom[176]=5'd6;  r_p_rom[177]=5'd31; r_p_rom[178]=5'd31; r_p_rom[179]=5'd31;
        r_p_rom[180]=5'd31; r_p_rom[181]=5'd31; r_p_rom[182]=5'd31; r_p_rom[183]=5'd31;
        r_p_rom[184]=5'd31; r_p_rom[185]=5'd31; r_p_rom[186]=5'd0;  r_p_rom[187]=5'd0;
        r_p_rom[188]=5'd31; r_p_rom[189]=5'd31; r_p_rom[190]=5'd31; r_p_rom[191]=5'd31;
        // Row 8
        r_p_rom[192]=5'd7;  r_p_rom[193]=5'd20; r_p_rom[194]=5'd31; r_p_rom[195]=5'd16;
        r_p_rom[196]=5'd22; r_p_rom[197]=5'd10; r_p_rom[198]=5'd31; r_p_rom[199]=5'd31;
        r_p_rom[200]=5'd23; r_p_rom[201]=5'd31; r_p_rom[202]=5'd31; r_p_rom[203]=5'd31;
        r_p_rom[204]=5'd31; r_p_rom[205]=5'd31; r_p_rom[206]=5'd31; r_p_rom[207]=5'd31;
        r_p_rom[208]=5'd31; r_p_rom[209]=5'd31; r_p_rom[210]=5'd0;  r_p_rom[211]=5'd0;
        r_p_rom[212]=5'd31; r_p_rom[213]=5'd31; r_p_rom[214]=5'd31; r_p_rom[215]=5'd31;
        // Row 9
        r_p_rom[216]=5'd11; r_p_rom[217]=5'd31; r_p_rom[218]=5'd31; r_p_rom[219]=5'd31;
        r_p_rom[220]=5'd19; r_p_rom[221]=5'd31; r_p_rom[222]=5'd31; r_p_rom[223]=5'd31;
        r_p_rom[224]=5'd13; r_p_rom[225]=5'd31; r_p_rom[226]=5'd3;  r_p_rom[227]=5'd17;
        r_p_rom[228]=5'd31; r_p_rom[229]=5'd31; r_p_rom[230]=5'd31; r_p_rom[231]=5'd31;
        r_p_rom[232]=5'd31; r_p_rom[233]=5'd31; r_p_rom[234]=5'd31; r_p_rom[235]=5'd0;
        r_p_rom[236]=5'd0;  r_p_rom[237]=5'd31; r_p_rom[238]=5'd31; r_p_rom[239]=5'd31;
        // Row 10
        r_p_rom[240]=5'd25; r_p_rom[241]=5'd31; r_p_rom[242]=5'd8;  r_p_rom[243]=5'd31;
        r_p_rom[244]=5'd23; r_p_rom[245]=5'd18; r_p_rom[246]=5'd31; r_p_rom[247]=5'd14;
        r_p_rom[248]=5'd9;  r_p_rom[249]=5'd31; r_p_rom[250]=5'd31; r_p_rom[251]=5'd31;
        r_p_rom[252]=5'd31; r_p_rom[253]=5'd31; r_p_rom[254]=5'd31; r_p_rom[255]=5'd31;
        r_p_rom[256]=5'd31; r_p_rom[257]=5'd31; r_p_rom[258]=5'd31; r_p_rom[259]=5'd31;
        r_p_rom[260]=5'd0;  r_p_rom[261]=5'd0;  r_p_rom[262]=5'd31; r_p_rom[263]=5'd31;
        // Row 11
        r_p_rom[264]=5'd3;  r_p_rom[265]=5'd31; r_p_rom[266]=5'd31; r_p_rom[267]=5'd31;
        r_p_rom[268]=5'd16; r_p_rom[269]=5'd31; r_p_rom[270]=5'd31; r_p_rom[271]=5'd2;
        r_p_rom[272]=5'd25; r_p_rom[273]=5'd5;  r_p_rom[274]=5'd31; r_p_rom[275]=5'd31;
        r_p_rom[276]=5'd1;  r_p_rom[277]=5'd31; r_p_rom[278]=5'd31; r_p_rom[279]=5'd31;
        r_p_rom[280]=5'd31; r_p_rom[281]=5'd31; r_p_rom[282]=5'd31; r_p_rom[283]=5'd31;
        r_p_rom[284]=5'd31; r_p_rom[285]=5'd31; r_p_rom[286]=5'd31; r_p_rom[287]=5'd0;
    end

    //-----------------------------------------------------------------
    // 行连接信息缓存
    // 当进入新行时, 扫描 P block row, 记录所有非 -1 列索引和移位值
    //-----------------------------------------------------------------
    reg [P_NB-1:0]          r_conn_valid [0:P_MB-1];    // 每 block row 的有效连接位图
    reg [P_SHIFT_W-1:0]     r_conn_shift [0:P_MB-1][0:P_NB-1];  // 每 block row 每列的移位值
    reg [P_CONN_CNT_W-1:0]  r_conn_count [0:P_MB-1];   // 每 block row 的连接数

    // 预计算: 在初始化时扫描所有 block row
    integer br, bc;
    reg [P_ROM_W-1:0] w_p_val;
    reg [P_CONN_CNT_W-1:0] w_cnt;
    initial begin
        for (br = 0; br < P_MB; br = br + 1) begin
            w_cnt = 'd0;
            r_conn_valid[br] = {P_NB{1'b0}};
            for (bc = 0; bc < P_NB; bc = bc + 1) begin
                w_p_val = r_p_rom[br * P_NB + bc];
                r_conn_shift[br][bc] = w_p_val[P_SHIFT_W-1:0];
                if (w_p_val != 5'd31) begin
                    r_conn_valid[br][bc] = 1'b1;
                    w_cnt = w_cnt + 1'b1;
                end else begin
                    r_conn_valid[br][bc] = 1'b0;
                end
            end
            r_conn_count[br] = w_cnt;
        end
    end

    //-----------------------------------------------------------------
    // 实时地址生成
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

    // 计算 block row 和偏移
    wire [3:0]              w_block_row;
    wire [P_SHIFT_W-1:0]    w_block_off;

    assign w_block_row = ri_row / P_Z;
    assign w_block_off = ri_row % P_Z;

    // 查找当前连接对应的 block column
    reg [5:0]               r_block_col;
    reg [P_SHIFT_W-1:0]     r_shift_val;
    reg                      r_valid;
    reg [P_CONN_CNT_W-1:0]  r_found_cnt;

    integer bc2;
    always @(*) begin
        r_block_col  = 'd0;
        r_shift_val  = 'd0;
        r_valid      = 1'b0;
        r_found_cnt  = 'd0;

        for (bc2 = 0; bc2 < P_NB; bc2 = bc2 + 1) begin
            if (r_conn_valid[w_block_row][bc2]) begin
                if (r_found_cnt == ri_conn) begin
                    r_block_col = bc2[5:0];
                    r_shift_val = r_conn_shift[w_block_row][bc2];
                    r_valid     = 1'b1;
                end
                r_found_cnt = r_found_cnt + 1'b1;
            end
        end
    end

    // 计算展开后的列地址
    // col_addr = j * Z + mod(offset - shift, Z)
    wire signed [P_SHIFT_W:0] w_diff;
    wire [P_SHIFT_W-1:0]      w_mod_result;

    assign w_diff       = {1'b0, w_block_off} - {1'b0, r_shift_val};
    assign w_mod_result = (w_diff >= 0) ? w_diff[P_SHIFT_W-1:0] :
                                          (w_diff[P_SHIFT_W-1:0] + P_Z[P_SHIFT_W-1:0]);

    assign o_col_addr   = r_block_col * P_Z + w_mod_result;
    assign o_shift      = r_shift_val;
    assign o_conn_count = r_conn_count[w_block_row];
    assign o_valid      = ri_en && r_valid;

endmodule
