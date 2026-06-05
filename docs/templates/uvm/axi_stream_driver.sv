// ============================================================================
// AXI4-Stream Driver (统一 32-bit)
// 从 sequencer 获取 sequence_item → 驱动到物理接口
// 注: 所有算法共用 32-bit, DUT 连接在顶层截位
// 注: 通过 package 编译, 无需 include uvm_macros.svh
// ============================================================================

class axi_stream_driver extends uvm_driver #(axi_stream_seq_item);

    virtual axi_stream_if #(32) vif;

    `uvm_component_utils(axi_stream_driver)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        if (!uvm_config_db #(virtual axi_stream_if #(32))::get(this, "", "vif", vif))
            `uvm_fatal("NOVIF", "axi_stream_driver: vif #32 not set")
    endfunction

    task run_phase(uvm_phase phase);
        vif.drv_cb.tvalid <= 1'b0;
        vif.drv_cb.tdata  <= '0;
        vif.drv_cb.tlast  <= 1'b0;

        forever begin
            seq_item_port.get_next_item(req);
            drive_item(req);
            seq_item_port.item_done();
        end
    endtask

    task drive_item(axi_stream_seq_item item);
        @(vif.drv_cb);
        vif.drv_cb.tdata  <= item.data[31:0];
        vif.drv_cb.tvalid <= 1'b1;
        vif.drv_cb.tlast  <= item.last;
        wait(vif.drv_cb.tready);
        @(vif.drv_cb);
        vif.drv_cb.tvalid <= 1'b0;
    endtask

endclass