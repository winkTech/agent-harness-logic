// ============================================================================
// AXI4-Stream Sequencer
// 简单继承 uvcm_sequencer, 自动获得 seq_item_export
// ============================================================================

class axi_stream_sequencer extends uvm_sequencer #(axi_stream_seq_item);

    `uvm_component_utils(axi_stream_sequencer)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

endclass
