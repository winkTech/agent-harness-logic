// ============================================================================
// LDPC Environment — 封装 LDPC agent + scoreboard
// 输入: 10-bit signed LLR, 输出: 1-bit decoded
// ============================================================================

class ldpc_env extends uvm_env;

    ldpc_agent     agent;
    ldpc_scoreboard sb;

    `uvm_component_utils(ldpc_env)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        agent = ldpc_agent::type_id::create("agent", this);
        sb    = ldpc_scoreboard::type_id::create("sb", this);
    endfunction

    function void connect_phase(uvm_phase phase);
        // Monitor → Scoreboard
        agent.mon.item_collected_port.connect(sb.output_export);
    endfunction

endclass : ldpc_env
