// ============================================================================
// OFDM Agent
// 封装: sequencer + driver + input monitor + output monitor
// TODO: 修改接口位宽参数匹配 DUT
// ============================================================================

class ofdm_agent extends uvm_agent;

    // ---- 子组件 ----
    axi_stream_sequencer             sqr;       // sequencer
    axi_stream_driver                drv;       // driver (驱动 s_axis)
    axi_stream_monitor               in_mon;    // 输入 monitor (监测 s_axis, 16-bit)
    axi_stream_output_monitor        out_mon;   // 输出 monitor (监测 m_axis, 32-bit)

    `uvm_component_utils(ofdm_agent)

    // ---- Constructor ----
    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    // ---- Build phase ----
    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        sqr    = axi_stream_sequencer::type_id::create("sqr", this);
        drv    = axi_stream_driver::type_id::create("drv", this);
        in_mon = axi_stream_monitor::type_id::create("in_mon", this);
        out_mon = axi_stream_output_monitor::type_id::create("out_mon", this);
    endfunction

    // ---- Connect phase ----
    function void connect_phase(uvm_phase phase);
        drv.seq_item_port.connect(sqr.seq_item_export);
    endfunction

endclass
