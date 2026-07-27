// ============================================================================
// Synchronization UVM Package
// ============================================================================

package sync_uvm_pkg;

    import uvm_pkg::*;
    `include "uvm_macros.svh"

    `include "../../../../../docs/templates/uvm/axi_stream_seq_item.sv"
    `include "../../../../../docs/templates/uvm/axi_stream_sequencer.sv"
    `include "../../../../../docs/templates/uvm/axi_stream_driver.sv"
    `include "../../../../../docs/templates/uvm/axi_stream_monitor.sv"
    `include "../../../../../docs/templates/uvm/axi_stream_output_monitor.sv"
    `include "../../../../../docs/templates/uvm/generic_scoreboard.sv"
    `include "../../../../../docs/templates/uvm/generic_agent.sv"
    `include "../../../../../docs/templates/uvm/generic_env.sv"
    `include "../../../../../docs/templates/uvm/generic_base_test.sv"

    `include "sync_scoreboard.sv"
    `include "sync_sequences.sv"
    `include "sync_base_test.sv"
    `include "sync_basic_test.sv"

endpackage : sync_uvm_pkg