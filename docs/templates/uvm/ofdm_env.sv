// ============================================================================
// OFDM Environment
// 包含: agent + scoreboard
// 连接: agent.in_mon → scoreboard (可选)
//       agent.out_mon → scoreboard (必选, 用于输出比对)
// ============================================================================

class ofdm_env extends uvm_env;

    // ---- 子组件 ----
    ofdm_agent       agent;       // AXI-Stream agent
    ofdm_scoreboard  sb;          // 记分板

    `uvm_component_utils(ofdm_env)

    // ---- Constructor ----
    function new(string name, uvm_component parent);
        super.new(name, parent);
    endfunction

    // ---- Build phase ----
    function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        agent = ofdm_agent::type_id::create("agent", this);
        sb    = ofdm_scoreboard::type_id::create("sb", this);
    endfunction

    // ---- Connect phase ----
    function void connect_phase(uvm_phase phase);
        // 输出 monitor → scoreboard (DUT 输出 vs golden)
        agent.out_mon.item_collected_port.connect(sb.output_export);
    endfunction

endclass
