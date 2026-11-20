// ============================================================================
// 通用 Agent — 适用于所有 AXI-Stream 算法模块
// 封装: sequencer + driver + input monitor + output monitor
// 子类只需 set_type_override 替换专用组件
// ============================================================================

class generic_agent extends uvm_agent;

    // ---- 子组件 ----
    axi_stream_sequencer             sqr;
    axi_stream_driver                drv;
    axi_stream_monitor               in_mon;
    axi_stream_output_monitor        out_mon;

    `uvm_component_utils(generic_agent)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        sqr    = axi_stream_sequencer::type_id::create("sqr", this);
        drv    = axi_stream_driver::type_id::create("drv", this);
        in_mon = axi_stream_monitor::type_id::create("in_mon", this);
        out_mon = axi_stream_output_monitor::type_id::create("out_mon", this);
    endfunction

    function void connect_phase(uvm_phase phase);
        drv.seq_item_port.connect(sqr.seq_item_export);
    endfunction

endclass
