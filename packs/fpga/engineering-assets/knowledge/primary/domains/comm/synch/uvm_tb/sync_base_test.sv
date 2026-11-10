// ============================================================================
// Sync Base Test
// ============================================================================

class sync_base_test extends generic_base_test;

    `uvm_component_utils(sync_base_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        s_axis_width = 32;
        m_axis_width = 32;
        vec_dir = "../golden_model/vectors";
    endfunction

    function void build_phase(uvm_phase phase);
        generic_scoreboard::type_id::set_type_override(sync_scoreboard::get_type());
        super.build_phase(phase);
    endfunction

endclass