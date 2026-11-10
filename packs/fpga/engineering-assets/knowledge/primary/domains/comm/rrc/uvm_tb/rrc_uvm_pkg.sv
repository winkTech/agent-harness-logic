// ============================================================================
// RRC UVM Package
// 编译顺序: interface → package → top
// ============================================================================

package rrc_uvm_pkg;

    import uvm_pkg::*;
    `include "uvm_macros.svh"

    // ---- 共用组件 (来自 templates) ----
    `include "../../../../../docs/templates/uvm/axi_stream_seq_item.sv"
    `include "../../../../../docs/templates/uvm/axi_stream_sequencer.sv"
    `include "../../../../../docs/templates/uvm/axi_stream_driver.sv"
    `include "../../../../../docs/templates/uvm/axi_stream_monitor.sv"
    `include "../../../../../docs/templates/uvm/axi_stream_output_monitor.sv"
    `include "../../../../../docs/templates/uvm/generic_scoreboard.sv"
    `include "../../../../../docs/templates/uvm/generic_agent.sv"
    `include "../../../../../docs/templates/uvm/generic_env.sv"
    `include "../../../../../docs/templates/uvm/generic_base_test.sv"

    // ---- RRC 专属组件 ----
    `include "rrc_scoreboard.sv"
    `include "rrc_sequences.sv"
    `include "rrc_base_test.sv"
    `include "rrc_basic_test.sv"

endpackage : rrc_uvm_pkg