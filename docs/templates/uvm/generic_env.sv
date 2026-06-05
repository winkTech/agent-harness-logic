// ============================================================================
// 通用 Environment — 适用于所有 AXI-Stream 算法模块
// 包含: generic_agent + generic_scoreboard
// 子类只需 set_type_override 替换 scoreboard 类型
// ============================================================================

class generic_env extends uvm_env;

    generic_agent       agent;
    generic_scoreboard  sb;

    `uvm_component_utils(generic_env)

    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        agent = generic_agent::type_id::create("agent", this);
        sb    = generic_scoreboard::type_id::create("sb", this);
    endfunction

    function void connect_phase(uvm_phase phase);
        agent.out_mon.item_collected_port.connect(sb.output_export);
    endfunction

endclass