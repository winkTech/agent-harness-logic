// template: lru_counter
// version: 1.0.0
// domain: internet
// description: LRU 替换计数器 — 外部资料改编
// requires: 命名未按 ri_/ro_ 规范, 复用前必须按 SKILL.md §1/§2 重写接口与命名
//-----------------------------------------------------------------
//                         LRU计数器模块
//-----------------------------------------------------------------
// 功能描述: 基于计数器的LRU（最近最少使用）算法实现
// 应用场景: Cache管理、路由表更新、缓冲区管理
// 算法原理: 计数器法LRU，访问时清零当前计数器，其他递增
//-----------------------------------------------------------------
// 输入:
//   i_clk_sys      - 系统时钟
//   i_rst_sys      - 系统复位（高有效）
//   i_access       - 访问信号
//   i_addr         - 访问地址
// 输出:
//   o_lru_addr     - LRU地址
//-----------------------------------------------------------------

module lru_counter #(
    parameter P_WIDTH = 4,
    parameter P_DEPTH = 16
)(
    input  wire                    i_clk_sys,
    input  wire                    i_rst_sys,
    input  wire                    i_access,
    input  wire [P_WIDTH-1:0]      i_addr,
    output reg  [P_WIDTH-1:0]      o_lru_addr
);

    //-----------------------------------------------------------------
    // 参数定义
    //-----------------------------------------------------------------
    localparam P_COUNTER_WIDTH = 8;  // 计数器位宽

    //-----------------------------------------------------------------
    // LRU计数器
    //-----------------------------------------------------------------
    reg [P_COUNTER_WIDTH-1:0] r_counter [0:P_DEPTH-1];
    reg [P_COUNTER_WIDTH-1:0] r_max_counter;
    reg [P_WIDTH-1:0] r_max_addr;

    //-----------------------------------------------------------------
    // 计数器更新
    //-----------------------------------------------------------------
    integer i;
    always @(posedge i_clk_sys) begin
        if (i_rst_sys) begin
            for (i = 0; i < P_DEPTH; i = i + 1) begin
                r_counter[i] <= 0;
            end
        end else if (i_access) begin
            // 访问时清零当前地址计数器
            r_counter[i_addr] <= 0;
            // 其他计数器递增
            for (i = 0; i < P_DEPTH; i = i + 1) begin
                if (i != i_addr) begin
                    r_counter[i] <= r_counter[i] + 1;
                end
            end
        end
    end

    //-----------------------------------------------------------------
    // 查找LRU地址
    //-----------------------------------------------------------------
    always @(posedge i_clk_sys) begin
        r_max_counter <= 0;
        r_max_addr <= 0;
        for (i = 0; i < P_DEPTH; i = i + 1) begin
            if (r_counter[i] > r_max_counter) begin
                r_max_counter <= r_counter[i];
                r_max_addr <= i[P_WIDTH-1:0];
            end
        end
        o_lru_addr <= r_max_addr;
    end

endmodule
