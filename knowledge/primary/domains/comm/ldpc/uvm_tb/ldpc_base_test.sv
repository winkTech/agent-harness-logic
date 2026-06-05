// ============================================================================
// LDPC Decoder Base Test
// ============================================================================

class ldpc_base_test extends generic_base_test;

    `uvm_component_utils(ldpc_base_test)

    // LDPC 环境
    generic_env #(.DATA_W(1)) m_env;

    function new(string name = "ldpc_base_test", uvm_component parent = null);
        super.new(name, parent);
    endfunction : new

    virtual function void build_phase(uvm_phase phase);
        super.build_phase(phase);
        // 创建 LDPC 环境 (1-bit 输出接口)
        m_env = generic_env #(.DATA_W(1))::type_id::create("m_env", this);
    endfunction : build_phase

endclass : ldpc_base_test
