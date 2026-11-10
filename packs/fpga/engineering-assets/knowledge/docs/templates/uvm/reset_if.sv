// ============================================================================
// Reset Control Interface
// 允许 UVM 测试代码控制 DUT 复位 (通过 config_db)
// ============================================================================

interface reset_if (input clk);
    logic rst_n;  // 驱动此信号到 DUT

    clocking cb @(posedge clk);
        default input #1 output #1;
        output rst_n;
    endclocking

    modport CTRL(clocking cb);

endinterface
