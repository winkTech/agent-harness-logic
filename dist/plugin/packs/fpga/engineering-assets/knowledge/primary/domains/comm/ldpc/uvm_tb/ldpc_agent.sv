// ============================================================================
// LDPC Agent — 封装 LDPC 专用 driver + monitor + sequencer
// 替换 generic_agent (原 32-bit AXI-Stream 通用版)
// 输入: 10-bit signed LLR, 输出: 1-bit decoded
// ============================================================================

class ldpc_agent extends uvm_agent;

    // ---- 子组件 ----
    ldpc_driver                    drv;
    ldpc_monitor                   mon;
    uvm_sequencer #(ldpc_seq_item) sqr;

    `uvm_component_utils(ldpc_agent)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);

        // 创建 LDPC 专用组件
        sqr = uvm_sequencer #(ldpc_seq_item)::type_id::create("sqr", this);
        drv = ldpc_driver::type_id::create("drv", this);
        mon = ldpc_monitor::type_id::create("mon", this);
    endfunction

    function void connect_phase(uvm_phase phase);
        // Driver ← Sequencer
        drv.seq_item_port.connect(sqr.seq_item_export);
    endfunction

endclass : ldpc_agent
