// ============================================================================
// AXI4-Stream Driver
// 从 sequencer 获取 sequence_item → 驱动到物理接口 (tvalid/tready 握手)
// TODO: 修改 DATA_WIDTH 匹配 DUT 输入位宽
// ============================================================================

class axi_stream_driver extends uvm_driver #(axi_stream_seq_item);

    // ---- Virtual interface ----
    // TODO: 修改 #() 参数匹配 DUT 输入接口位宽
    virtual axi_stream_if #(16) vif;

    `uvm_component_utils(axi_stream_driver)

    // ---- Constructor ----
    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    // ---- Build phase: 获取虚接口 ----
    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        // TODO: 修改 #() 参数匹配接口位宽
        if (!uvm_config_db #(virtual axi_stream_if #(16))::get(this, "", "vif", vif))
            `uvm_fatal("NOVIF", "axi_stream_driver: virtual interface not set")
    endfunction

    // ---- Run phase: 持续驱动 ----
    task run_phase(uvm_phase phase);
        // 复位初始状态
        vif.drv_cb.tvalid <= 1'b0;
        vif.drv_cb.tdata  <= '0;
        vif.drv_cb.tlast  <= 1'b0;

        forever begin
            seq_item_port.get_next_item(req);
            drive_item(req);
            seq_item_port.item_done();
        end
    endtask

    // ---- 驱动一笔交易 (AXI4-Stream 握手) ----
    task drive_item(axi_stream_seq_item item);
        @(vif.drv_cb);
        vif.drv_cb.tdata  <= item.data;
        vif.drv_cb.tvalid <= 1'b1;
        vif.drv_cb.tlast  <= item.last;

        // 等待 slave 就绪
        wait(vif.drv_cb.tready);

        // 等待下一个时钟沿并撤销 valid
        @(vif.drv_cb);
        vif.drv_cb.tvalid <= 1'b0;
    endtask

endclass
