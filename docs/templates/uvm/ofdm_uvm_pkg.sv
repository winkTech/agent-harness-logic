// ============================================================================
// OFDM UVM Package
// 汇总所有 UVM 组件, 简化编译
// 编译顺序: interface → package → top
// ============================================================================

package ofdm_uvm_pkg;

    // ---- UVM library ----
    import uvm_pkg::*;
    `include "uvm_macros.svh"

    // ---- 组件 ----
    `include "axi_stream_seq_item.sv"
    `include "axi_stream_sequencer.sv"
    `include "axi_stream_driver.sv"
    `include "axi_stream_monitor.sv"
    `include "axi_stream_output_monitor.sv"
    `include "ofdm_scoreboard.sv"
    `include "ofdm_agent.sv"
    `include "ofdm_env.sv"
    `include "ofdm_sequences.sv"
    `include "ofdm_base_test.sv"
    `include "ofdm_basic_test.sv"
    `include "ofdm_additional_tests.sv"

endpackage : ofdm_uvm_pkg
