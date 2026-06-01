//-----------------------------------------------------------------
//                         哈希表模块
//-----------------------------------------------------------------
// 功能描述: 基于链表结构的哈希查找电路
// 应用场景: 路由查找、数据索引、缓存管理
// 算法原理: 哈希散列 + 链表法冲突处理
//-----------------------------------------------------------------
// 输入:
//   i_clk_sys      - 系统时钟
//   i_rst_sys      - 系统复位（高有效）
//   i_wr_en        - 写使能
//   i_hash         - 哈希值
//   i_data         - 写入数据
//   i_rd_en        - 读使能
// 输出:
//   o_rd_data      - 读出数据
//   o_valid        - 输出有效
//-----------------------------------------------------------------

module hash_table #(
    parameter P_HASH_WIDTH = 8,
    parameter P_DATA_WIDTH = 32,
    parameter P_DEPTH = 256
)(
    input  wire                    i_clk_sys,
    input  wire                    i_rst_sys,
    input  wire                    i_wr_en,
    input  wire [P_HASH_WIDTH-1:0] i_hash,
    input  wire [P_DATA_WIDTH-1:0] i_data,
    input  wire                    i_rd_en,
    output reg  [P_DATA_WIDTH-1:0] o_rd_data,
    output reg                     o_valid
);

    //-----------------------------------------------------------------
    // 存储器定义
    //-----------------------------------------------------------------
    reg [P_HASH_WIDTH-1:0] r_head_ptr [0:P_DEPTH-1];  // 链表头指针
    reg [P_DATA_WIDTH-1:0] r_data [0:P_DEPTH-1];      // 数据存储
    reg [P_HASH_WIDTH-1:0] r_next [0:P_DEPTH-1];      // 下一个指针
    reg [P_HASH_WIDTH-1:0] r_free_ptr;                 // 空闲指针

    //-----------------------------------------------------------------
    // 空闲链表管理
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_free_ptr <= 0;
        end else if (i_wr_en) begin
            r_free_ptr <= r_free_ptr + 1;
        end
    end

    //-----------------------------------------------------------------
    // 写操作
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            integer i;
            for (i = 0; i < P_DEPTH; i = i + 1) begin
                r_head_ptr[i] <= 0;
                r_next[i] <= 0;
            end
        end else if (i_wr_en) begin
            r_data[r_free_ptr] <= i_data;
            r_next[r_free_ptr] <= r_head_ptr[i_hash];
            r_head_ptr[i_hash] <= r_free_ptr;
        end
    end

    //-----------------------------------------------------------------
    // 读操作
    //-----------------------------------------------------------------
    reg [P_HASH_WIDTH-1:0] r_rd_ptr;
    reg r_rd_valid;

    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            r_rd_ptr <= 0;
            r_rd_valid <= 0;
            o_valid <= 0;
        end else if (i_rd_en) begin
            r_rd_ptr <= r_head_ptr[i_hash];
            r_rd_valid <= 1;
        end else if (r_rd_valid) begin
            o_rd_data <= r_data[r_rd_ptr];
            o_valid <= 1;
            r_rd_valid <= 0;
        end else begin
            o_valid <= 0;
        end
    end

endmodule
