// ============================================================================
// AXI4-Stream Monitor
// 监测 AXI4-Stream 接口, 当 (tvalid && tready) 时捕获一笔交易
// 通过 analysis_port 发送给 scoreboard/coverage
// ============================================================================

class axi_stream_monitor extends uvm_monitor;

    // ---- Virtual interface ----
    // TODO: 修改 #() 参数匹配接口位宽
    virtual axi_stream_if #(16) vif;

    // ---- TLM 分析端口 ----
    uvm_analysis_port #(axi_stream_seq_item) item_collected_port;

    `uvm_component_utils(axi_stream_monitor)

    // ---- Constructor ----
    function new(string name, uvm_component parent);
        super.new(name, parent);
        item_collected_port = new("item_collected_port", this);
    endfunction

    // ---- Build phase ----
    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        // TODO: 修改 #() 参数匹配接口位宽
        if (!uvm_config_db #(virtual axi_stream_if #(16))::get(this, "", "vif", vif))
            `uvm_fatal("NOVIF", "axi_stream_monitor: virtual interface not set")
    endfunction

    // ---- Run phase ----
    task run_phase(uvm_phase phase);
        forever begin
            @(vif.mon_cb);
            // 当 valid && ready 时采样一笔交易
            if (vif.mon_cb.tvalid && vif.mon_cb.tready) begin
                axi_stream_seq_item item = axi_stream_seq_item::type_id::create("item", this);
                item.data = vif.mon_cb.tdata;
                item.last = vif.mon_cb.tlast;
                item_collected_port.write(item);
            end
        end
    endtask

endclass
