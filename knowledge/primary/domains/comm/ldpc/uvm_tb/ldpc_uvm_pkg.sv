// ============================================================================
// LDPC UVM Package v2 — LDPC 专用组件
// 使用自定义 driver/monitor/agent/scoreboard 替代 generic 版
// 输入: 10-bit signed LLR, 输出: 1-bit decoded
// ============================================================================

package ldpc_uvm_pkg;

    import uvm_pkg::*;
    `include "uvm_macros.svh"

    // ---- 接口定义 ----
    `include "../../../../../docs/templates/uvm/reset_if.sv"

    // ---- LDPC 专属 seq_item (含 covergroup) ----
    `include "ldpc_seq_item.sv"

    // ---- LDPC 专属 driver/monitor/agent/env ----
    `include "ldpc_driver.sv"
    `include "ldpc_monitor.sv"
    `include "ldpc_agent.sv"
    `include "ldpc_env.sv"

    // ---- LDPC 专属 scoreboard (独立, 不依赖 generic) ----
    `include "ldpc_scoreboard.sv"

    // ---- LDPC 专属 sequences ----
    `include "ldpc_sequences.sv"

    // ---- LDPC 专属 tests ----
    `include "ldpc_base_test.sv"
    `include "ldpc_basic_test.sv"

endpackage : ldpc_uvm_pkg
