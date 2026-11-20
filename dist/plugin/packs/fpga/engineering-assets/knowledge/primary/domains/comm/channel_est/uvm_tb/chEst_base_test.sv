// ============================================================================
// ChEst Base Test
// ============================================================================

class chEst_base_test extends generic_base_test;

    `uvm_component_utils(chEst_base_test)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        s_axis_width = 32;
        m_axis_width = 32;
        vec_dir = "../golden_model/vectors";
    endfunction

    function void build_phase(uvm_phase phase);
        generic_scoreboard::type_id::set_type_override(chEst_scoreboard::get_type());
        super.build_phase(phase);
    endfunction

endclass