// ============================================================================
// RRC Base Test — 配置 RRC 特定参数 + type override
// ============================================================================

class rrc_base_test extends generic_base_test;

    `uvm_component_utils(rrc_base_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        s_axis_width = 32;   // RRC 输入 {Q[15:0], I[15:0]}
        m_axis_width = 32;   // RRC 输出 {Q[15:0], I[15:0]}
        vec_dir = "../golden_model/vectors";
    endfunction

    function void build_phase(uvm_phase phase);
        // 用 rrc_scoreboard 替换 generic_scoreboard
        generic_scoreboard::type_id::set_type_override(rrc_scoreboard::get_type());
        super.build_phase(phase);
    endfunction

endclass