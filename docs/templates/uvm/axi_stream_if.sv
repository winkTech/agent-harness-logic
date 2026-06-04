// ============================================================================
// AXI4-Stream Interface — UVM 验证用
// 参数化 DATA_WIDTH, 支持 DRIVER/MONITOR 两个 clocking block
// 用法: 顶层例化, 通过 uvm_config_db 注入到 UVM 组件
// ============================================================================

interface axi_stream_if #(
    parameter int DATA_WIDTH = 16
) (
    input logic clk
);
    // ---- 物理信号 ----
    logic [DATA_WIDTH-1:0] tdata;
    logic                  tvalid;
    logic                  tready;
    logic                  tlast;

    // ---- Driver clocking block ----
    // 驱动侧: 在时钟上升沿后输出 tdata/tvalid/tlast, 采样 tready
    clocking drv_cb @(posedge clk);
        default input #1 output #1;
        output tdata, tvalid, tlast;
        input  tready;
    endclocking

    // ---- Monitor clocking block ----
    // 监测侧: 在时钟上升沿采样所有信号
    clocking mon_cb @(posedge clk);
        default input #1 output #1;
        input tdata, tvalid, tready, tlast;
    endclocking

    // ---- Modport ----
    modport DRIVER(clocking drv_cb, input clk);
    modport MONITOR(clocking mon_cb, input clk);

endinterface
