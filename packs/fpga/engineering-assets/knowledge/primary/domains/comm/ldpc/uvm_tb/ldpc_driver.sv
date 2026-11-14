// ============================================================================
// LDPC Decoder Driver — 驱动 LLR 输入到 DUT
// 特性: signed 10-bit LLR, AXI-Stream 接口
// ============================================================================

class ldpc_driver extends uvm_driver #(ldpc_seq_item);

    virtual axi_stream_if #(10) vif;   // 10-bit LLR interface

    `uvm_component_utils(ldpc_driver)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        if (!uvm_config_db #(virtual axi_stream_if #(10))::get(this, "", "vif", vif))
            `uvm_fatal("NOVIF", "ldpc_driver: vif #10 not set")
    endfunction

    task run_phase(uvm_phase phase);
        // 初始化
        vif.drv_cb.tvalid <= 1'b0;
        vif.drv_cb.tdata  <= '0;
        vif.drv_cb.tlast  <= 1'b0;
        wait(vif.rst_n);

        forever begin
            seq_item_port.get_next_item(req);

            // 驱动单笔 LLR 数据
            @(vif.drv_cb);
            vif.drv_cb.tdata  <= $signed(req.llr_data);  // signed 10-bit
            vif.drv_cb.tvalid <= 1'b1;
            vif.drv_cb.tlast  <= req.last;

            // 等待 DUT 接收
            wait(vif.drv_cb.tready);
            @(vif.drv_cb);
            vif.drv_cb.tvalid <= 1'b0;

            seq_item_port.item_done();
        end
    endtask

endclass : ldpc_driver
