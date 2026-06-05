// ============================================================================
// AXI4-Stream Monitor (统一 32-bit)
// (tvalid && tready) 时捕获一笔交易 → analysis_port
// ============================================================================

class axi_stream_monitor extends uvm_monitor;

    virtual axi_stream_if #(32) vif;
    uvm_analysis_port #(axi_stream_seq_item) item_collected_port;

    `uvm_component_utils(axi_stream_monitor)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        item_collected_port = new("item_collected_port", this);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        if (!uvm_config_db #(virtual axi_stream_if #(32))::get(this, "", "vif", vif))
            `uvm_fatal("NOVIF", "axi_stream_monitor: vif #32 not set")
    endfunction

    task run_phase(uvm_phase phase);
        forever begin
            @(vif.mon_cb);
            if (vif.mon_cb.tvalid && vif.mon_cb.tready) begin
                axi_stream_seq_item item = axi_stream_seq_item::type_id::create("item", this);
                item.data = vif.mon_cb.tdata;
                item.last = vif.mon_cb.tlast;
                item_collected_port.write(item);
            end
        end
    endtask

endclass