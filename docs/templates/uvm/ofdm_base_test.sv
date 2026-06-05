// ============================================================================
// OFDM Base Test — 继承通用基类, OFDM 特定参数 + factory override
// ============================================================================

class ofdm_base_test extends generic_base_test;

    `uvm_component_utils(ofdm_base_test)

    int fft_len   = 64;
    int cp_len    = 16;
    int mod_type  = 1;     // 0:BPSK, 1:QPSK, 2:16QAM, 3:64QAM
    int num_sym   = 10;

    `uvm_field_int(fft_len,  UVM_DEFAULT)
    `uvm_field_int(cp_len,   UVM_DEFAULT)
    `uvm_field_int(mod_type, UVM_DEFAULT)
    `uvm_field_int(num_sym,  UVM_DEFAULT)

    function new(string name, uvm_component parent);
        super.new(name, parent);
        s_axis_width = 16;   // OFDM s_axis: 调制比特 (低6bit有效)
        m_axis_width = 32;   // OFDM m_axis: {Q[15:0], I[15:0]}
        vec_dir = "../../../../knowledge/primary/domains/comm/ofdm/vectors";
    endfunction

    function void build_phase(uvm_phase phase);
        // 用 ofdm_scoreboard 替换 generic_scoreboard
        generic_scoreboard::type_id::set_type_override(ofdm_scoreboard::get_type());
        super.build_phase(phase);
    endfunction

endclass