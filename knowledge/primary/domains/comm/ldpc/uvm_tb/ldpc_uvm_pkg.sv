// ============================================================================
// LDPC UVM Package
// LDPC decoder: 10-bit LLR input (streaming), 1-bit decoded output (streaming)
// ============================================================================

package ldpc_uvm_pkg;

    import uvm_pkg::*;
    `include "uvm_macros.svh"

    // ---- 共用组件 (来自 templates) ----
    `include "../../../../../docs/templates/uvm/reset_if.sv"
    `include "../../../../../docs/templates/uvm/generic_scoreboard.sv"
    `include "../../../../../docs/templates/uvm/generic_env.sv"
    `include "../../../../../docs/templates/uvm/generic_base_test.sv"

    // ---- LDPC 专属组件 ----
    `include "ldpc_scoreboard.sv"
    `include "ldpc_sequences.sv"
    `include "ldpc_base_test.sv"
    `include "ldpc_basic_test.sv"

endpackage : ldpc_uvm_pkg
